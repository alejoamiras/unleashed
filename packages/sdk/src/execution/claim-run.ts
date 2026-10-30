/**
 * What every claim shares: the checks before any prompt, the resume of a record that lost its deposit hash or its
 * leaves, the arrival gates reported as events, and the claim's receipt watch. Each new fact is persisted before the
 * event that names it, and persists run one at a time in call order.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { Hex } from "viem"
import { BridgeError, refusal, type Submission } from "../errors.ts"
import { type ClaimLeg as LegKind, type Emit, eventEmitter, type Leaves, type TransferEventBody } from "../events.ts"
import { assertNetwork, type Network, type Reads } from "../network.ts"
import { aztecLineOf } from "../protocol/aztec-line.ts"
import { claimRetired, type DepositRecord } from "../records.ts"
import type { DepositSecrets, RunOptions } from "../run.ts"
import { checkAbort, untilAborted } from "../run.ts"
import {
	type ArrivalGateState,
	awaitClaimSimulate,
	awaitL2BlockCountdown,
	awaitMessageCheckpoints,
	classifyConsumable,
	type GateClock,
	type SpentEvidence,
} from "./arrival.ts"
import { classifyClaimReceipt } from "./claim-receipt.ts"
import { findDepositTx } from "./deposit-reconcile.ts"
import { readDepositLeaves } from "./deposit-recovery.ts"
import { type FeeStop, FeeStopError } from "./fee-stop.ts"
import type { FeeLadderEnv } from "./fee-env.ts"
import { readPrivateFeeJuice, readPublicFeeJuice } from "./fee-juice-balance.ts"
import { awaitL1Receipt } from "./l1-receipt.ts"
import { l1ToL2MessageReadiness } from "./l1-to-l2-readiness.ts"
import type { TokenMessageState } from "./message-nullifier.ts"
import { type FuelRoute, readSendInbox, type SendResult } from "./send-flow.ts"
import { legacyRoutersOf } from "./send-generation.ts"

/** The Aztec side of a claim: the wallet that signs it and the account the deposit names. */
export interface AztecSigner {
	wallet: Wallet
	account: AztecAddress
}

export interface ClaimOptions extends RunOptions {
	/** The salts the deposit's `persist` stored: a private claim needs them, and no record or event carries them. */
	secrets?: DepositSecrets
	/** Never asks the wallet to sign, send or simulate: recovers the deposit's facts, watches a sent claim, waits out an
	 *  interrupted one and reads the messages' nullifiers, then throws `needs-prompt` (retry "safe") where the call would
	 *  next price a fee or prompt. A spent reading settles nothing here: only the wallet's simulate can corroborate it. It
	 *  still reads through the wallet (its network, the token's registration). For a page that resumes its records on
	 *  load. */
	watchOnly?: boolean
	/** Pays a public token + gas claim from gas the account already holds and settles without claiming the bridged
	 *  gas, which `claimFuel` claims later. A private claim's fee comes from its private credit either way. */
	withoutGas?: boolean
}

export interface ClaimOutcome {
	record: DepositRecord
	via: "claim" | "claimed-elsewhere"
	txHash?: string
	/** A token + gas claim settled while no retry could claim its bridged gas: the tokens landed, and this says why
	 *  the Fee Juice message stays unclaimed. */
	gasLeft?: BridgeError
}

export interface ClaimLeg {
	net: Network
	r: Reads
	aztec: AztecSigner
	run: ClaimOptions
	route: FuelRoute
	record: DepositRecord
	emit: Emit
	persisted: Promise<void>
}

/** Every claim follows a submitted deposit: a failure from here on names a transfer that reached a chain. */
const SUBMITTED: Submission = "submitted"
const RECEIPT_POLL_MS = 4000
const RECEIPT_POLLS = 450
const DROPPED_STRIKES = 3

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function assertAztecNetwork(net: Network, aztec: AztecSigner): Promise<void> {
	let info: { chainId: { toBigInt(): bigint }; version: { toBigInt(): bigint } }
	try {
		info = await aztec.wallet.getChainInfo()
	} catch (e) {
		throw refusal("read-failed", `the Aztec wallet did not say which network it is on: ${messageOf(e)}`, "safe", e)
	}
	if (info.chainId.toBigInt() === BigInt(net.l1ChainId) && info.version.toBigInt() === BigInt(net.rollupVersion)) return
	throw refusal("wrong-aztec-network", `the Aztec wallet is not on ${net.name}`, "safe")
}

/** What a call claims: a token deposit, a gas-only one, or the bridged gas a token + gas record's claim left. */
export type ClaimTarget = "token" | "gas" | "gas-leg"

function assertRecordOf(net: Network, rec: DepositRecord, target: ClaimTarget, account: AztecAddress): FuelRoute {
	const gasOnly = rec.intent === "gas"
	if (target === "gas-leg") return assertGasLegOf(net, rec, account)
	if (gasOnly !== (target === "gas")) throw refusal("invalid-request", `this is a ${rec.intent} deposit; claim it with the other entry`)
	if (rec.chainId !== net.l1ChainId) throw refusal("invalid-request", `the record belongs to chain ${rec.chainId}, not ${net.name}`)
	const route = gasOnly ? net.fuel : net.bridge
	const binding = gasOnly ? net.fuel.feeJuicePortal : net.bridge?.hub
	const bound = gasOnly ? rec.portal : rec.bridge
	if (!route || !binding || bound.toLowerCase() !== binding.toLowerCase())
		throw refusal("invalid-request", `the record was not made on ${net.name}'s current deployment`)
	// The claim secret is bound to the recipient: no other account can spend the message.
	if (rec.recipient.toLowerCase() !== account.toString().toLowerCase())
		throw refusal("invalid-request", "the record names another Aztec account as its recipient")
	return route
}

/** A token + gas record's gas is claimed on its own only once its tokens are done: until then the token claim may pay
 *  with it. The token's portal and hub are not checked: the gas message went to the Fee Juice portal, so a record whose
 *  token is distrusted still recovers its gas. */
function assertGasLegOf(net: Network, rec: DepositRecord, account: AztecAddress): FuelRoute {
	if (rec.intent === "gas" || !rec.fuel) throw refusal("invalid-request", "the record carries no bridged gas of a token deposit")
	if (rec.chainId !== net.l1ChainId) throw refusal("invalid-request", `the record belongs to chain ${rec.chainId}, not ${net.name}`)
	if (rec.recipient.toLowerCase() !== account.toString().toLowerCase())
		throw refusal("invalid-request", "the record names another Aztec account as its recipient")
	if (!claimRetired(rec) && !rec.claimedByOther)
		throw refusal("invalid-request", "the tokens are not claimed yet; their claim claims this gas", "safe")
	return net.fuel
}

/** Every check a claim makes before it reads anything else: the network, the line, the record and the wallet. */
export async function openClaim(
	net: Network,
	r: Reads,
	aztec: AztecSigner,
	rec: DepositRecord,
	run: ClaimOptions,
	target: ClaimTarget,
): Promise<ClaimLeg> {
	assertNetwork(net)
	if (!aztecLineOf(net.l1ChainId).supported) throw refusal("unsupported-line", `this release does not run ${net.name}'s Aztec line`)
	const route = assertRecordOf(net, rec, target, aztec.account)
	await assertAztecNetwork(net, aztec)
	return { net, r, aztec, run, route, record: rec, emit: eventEmitter(rec.id, run.onEvent), persisted: Promise.resolve() }
}

/** Applies `patch` and persists it after every earlier persist of this claim. */
export function persistClaim(leg: ClaimLeg, patch: Partial<DepositRecord>): Promise<void> {
	leg.record = { ...leg.record, ...patch, updatedAt: Date.now() } as DepositRecord
	const record = leg.record
	// A claim resumes from whatever the caller last stored, so a refused write never makes the next call unsafe.
	const persisted = leg.persisted.then(async () => {
		try {
			await leg.run.persist(record, leg.run.secrets)
		} catch (e) {
			throw new BridgeError("persist-failed", "the caller's storage refused the record", SUBMITTED, "safe", { cause: e })
		}
	})
	// A latch may persist without awaiting; its failure surfaces at the next awaited persist, never as an unhandled one.
	persisted.catch(() => undefined)
	leg.persisted = persisted
	return persisted
}

/** A record the caller already holds as complete: reported again, nothing read or sent. */
export function settledAlready(leg: ClaimLeg): ClaimOutcome | undefined {
	if (!claimRetired(leg.record)) return undefined
	const via = leg.record.claimedByOther ? "claimed-elsewhere" : "claim"
	leg.emit({ type: "settled", via })
	return { record: leg.record, via }
}

/** The ladder's view of this claim: its store is the claim's record, persisted through the caller in call order. */
export function ladderEnvOf(leg: ClaimLeg): FeeLadderEnv {
	const own = (id: string) => id === leg.record.id
	const budget = leg.net.manifest.bridge?.l1.fuel
	// The ladder rebuilds a private claim from `fuel.bridgeSecretSalt`. It reads the caller's sealed salt there, and no
	// write of it reaches `persist`: the salt travels in `DepositSecrets` alone.
	const salt = leg.run.secrets?.fuelSalt?.toString()
	const view = (): DepositRecord =>
		salt && leg.record.fuel ? { ...leg.record, fuel: { ...leg.record.fuel, bridgeSecretSalt: salt } } : leg.record
	const write = (patch: Partial<DepositRecord>) => {
		if (!patch.fuel) return persistClaim(leg, patch)
		const { bridgeSecretSalt: _sealed, ...fuel } = patch.fuel
		const kept = leg.record.fuel?.bridgeSecretSalt
		return persistClaim(leg, { ...patch, fuel: kept === undefined ? fuel : { ...fuel, bridgeSecretSalt: kept } })
	}
	return {
		records: {
			current: (id) => (own(id) ? view() : undefined),
			mergeWhen: (id, when, patch) => {
				if (!own(id) || !when(view())) return false
				write(patch(view()) as Partial<DepositRecord>)
				return true
			},
			merge: (id, patch) => {
				if (own(id)) write(patch as Partial<DepositRecord>)
			},
		},
		node: leg.r.aztecNode,
		privateFpc: leg.net.privateFpc,
		fuel: budget ? { minFuelFj: budget.minFuelFj } : undefined,
		minFloorFj: BigInt(leg.net.manifest.feeJuice.minFj),
		readPublicFeeJuice,
		readPrivateFeeJuice: (wallet, account) => readPrivateFeeJuice(leg.net.privateFpc, wallet, account),
		log: () => undefined,
	}
}

/** The record settled: persisted complete, then reported. */
export async function settle(leg: ClaimLeg, via: ClaimOutcome["via"], txHash?: string, gasLeft?: BridgeError): Promise<ClaimOutcome> {
	await persistClaim(leg, { completedAt: Date.now(), ...(via === "claimed-elsewhere" ? { claimedByOther: true } : {}) })
	leg.emit({ type: "settled", via, ...(txHash ? { txHash } : {}) })
	return { record: leg.record, via, ...(txHash ? { txHash } : {}), ...(gasLeft ? { gasLeft } : {}) }
}

/** Throws `needs-prompt` in a `watchOnly` call: what comes next prices a fee or asks the wallet. */
export function assertMayPrompt(leg: ClaimLeg, next: string): void {
	if (leg.run.watchOnly) throw new BridgeError("needs-prompt", `${next} needs the wallet`, SUBMITTED, "safe")
}

/** A record that never stored its deposit's hash finds it on Ethereum, verified by calldata and receipt. */
async function recoverDepositTx(leg: ClaimLeg, route: FuelRoute): Promise<void> {
	const { net, r, record } = leg
	leg.emit({ type: "deposit-recovery", stage: "searching" })
	const legacyRouters = record.intent === "gas" || !net.manifest.bridge ? [] : legacyRoutersOf(net.manifest.bridge)
	const found = await findDepositTx(record, r.l1 as never, {
		chainId: net.l1ChainId,
		router: route.router,
		legacyRouters,
		privateFpc: net.privateFpc,
	})
	if (typeof found === "object") return persistClaim(leg, { depositTxHash: found.txHash })
	const retry = found === "ambiguous" ? "never" : "after-wait"
	throw new BridgeError("deposit-not-found", `no single deposit for this record was found on Ethereum (${found})`, "unknown", retry, {
		search: found,
	})
}

function leavesPatch(record: DepositRecord, res: Partial<SendResult>): { patch: Partial<DepositRecord>; leaves: Leaves } {
	const token = res.tokenLeafIndex !== undefined && res.tokenMessageHashHex
	const fuel = res.fuelLeafIndex !== undefined && res.fuelMessageHashHex && record.fuel
	const patch: Partial<DepositRecord> = {
		...(token ? { leafIndex: res.tokenLeafIndex?.toString(), messageHash: res.tokenMessageHashHex } : {}),
		...(fuel
			? {
					fuel: {
						...(record.fuel as NonNullable<DepositRecord["fuel"]>),
						leafIndex: res.fuelLeafIndex?.toString(),
						messageHash: res.fuelMessageHashHex,
						received: (res.fuelReceived ?? 0n).toString(),
					},
					...(record.intent === "gas" ? { leafIndex: res.fuelLeafIndex?.toString() } : {}),
				}
			: {}),
	}
	const leaves: Leaves = {
		...(token ? { token: { leafIndex: res.tokenLeafIndex as bigint, messageHash: res.tokenMessageHashHex as Hex } } : {}),
		...(fuel
			? {
					fuel: {
						leafIndex: res.fuelLeafIndex as bigint,
						messageHash: res.fuelMessageHashHex as Hex,
						received: res.fuelReceived ?? 0n,
					},
				}
			: {}),
	}
	return { patch, leaves }
}

/** A gas leg is claimable only with its leaf, its message key and the exact Fee Juice its message carries. */
const fuelLeaves = (fuel: DepositRecord["fuel"]) => !!fuel?.leafIndex && !!fuel.messageHash && fuel.received !== undefined
const hasLeaves = (rec: DepositRecord) =>
	rec.intent === "gas" ? fuelLeaves(rec.fuel) : !!rec.leafIndex && (rec.fuel === undefined || fuelLeaves(rec.fuel))

/** A record that crashed before its receipt was read takes its leaves from the mined deposit. */
async function recoverLeaves(leg: ClaimLeg, route: FuelRoute): Promise<void> {
	const hash = leg.record.depositTxHash as Hex
	leg.emit({ type: "deposit-recovery", stage: "reading", txHash: hash })
	const l1 = leg.r.l1 as unknown as { getTransactionReceipt(args: { hash: Hex }): Promise<unknown> }
	if ((await l1.getTransactionReceipt({ hash }).catch(() => undefined)) === undefined) {
		leg.emit({ type: "deposit-recovery", stage: "waiting", txHash: hash })
		checkAbort(leg.run, SUBMITTED)
	}
	const receipt = (await untilAborted(awaitL1Receipt(leg.r.l1 as never, hash), leg.run, SUBMITTED).catch((e) => {
		if (e instanceof BridgeError) throw e
		if (e instanceof Error && /reverted on-chain/.test(e.message))
			throw new BridgeError("deposit-reverted", `the deposit ${hash} reverted; nothing moved`, SUBMITTED, "never", { cause: e })
		throw new BridgeError("receipt-timeout", `the deposit ${hash} is not confirmed yet`, SUBMITTED, "after-wait", { cause: e })
	})) as { logs: unknown[] }
	let inbox: Awaited<ReturnType<typeof readSendInbox>>
	try {
		inbox = await readSendInbox(leg.r.l1 as never, route)
	} catch (e) {
		throw new BridgeError("read-failed", `could not read the Inbox the deposit ${hash} wrote to`, SUBMITTED, "after-wait", { cause: e })
	}
	let res: Partial<SendResult>
	try {
		const legacyRouters = leg.net.manifest.bridge ? legacyRoutersOf(leg.net.manifest.bridge) : []
		res = await readDepositLeaves(leg.record, receipt.logs as never, leg.r.l1 as never, route, legacyRouters, inbox)
	} catch (e) {
		throw new BridgeError("receipt-mismatch", `the deposit ${hash} did not carry this transfer`, SUBMITTED, "never", { cause: e })
	}
	const { patch, leaves } = leavesPatch(leg.record, res)
	await persistClaim(leg, patch)
	leg.emit({ type: "deposit-confirmed", leaves })
}

/** The deposit facts a claim stands on, recovered from Ethereum only when the record lost its leaves. `route` is the
 *  one the deposit was sent through: a token + gas deposit's gas leaf is read from its token route's event. */
export async function ensureDepositFacts(leg: ClaimLeg, route: FuelRoute = leg.route): Promise<void> {
	if (hasLeaves(leg.record)) return
	if (!leg.record.depositTxHash) await recoverDepositTx(leg, route)
	await recoverLeaves(leg, route)
}

function clockOf(run: RunOptions): GateClock {
	return {
		wait: (ms) => untilAborted(new Promise<void>((resolve) => setTimeout(resolve, ms)), run, SUBMITTED),
		moved: () => run.signal?.aborted === true,
	}
}

type Arrival = Extract<TransferEventBody, { type: "arrival" }>

/** Reports one gate reading, once per change. */
function arrivalReporter(leg: ClaimLeg) {
	let last = ""
	return (body: Arrival) => {
		const key = JSON.stringify(body)
		if (key === last) return
		last = key
		leg.emit(body)
	}
}

/**
 * Waits through the countdown, the checkpoint gate and the claim simulate. Resolves "ready" once the simulate passes,
 * "claimed-elsewhere" only when the simulate fails on the message `evidence` names and its nullifier, read by
 * `nullifier` ("unknown" when it cannot), is already on chain: the one verdict a spent message settles on. An
 * unnarrated wait emits nothing, for a check whose claim is not the one the caller is narrating.
 */
export async function awaitClaimable(
	leg: ClaimLeg,
	hashes: readonly string[],
	simulate: () => Promise<unknown>,
	nullifier: () => Promise<TokenMessageState>,
	evidence: SpentEvidence,
	narrated = true,
): Promise<"ready" | "claimed-elsewhere"> {
	const { r, run } = leg
	const clock = clockOf(run)
	const emit: Emit = narrated ? leg.emit : () => {}
	const report = narrated ? arrivalReporter(leg) : emit
	const reads = {
		l2BlockNumber: async () => Number(await r.aztecNode.getBlockNumber()),
		messageReadiness: (h: string) => l1ToL2MessageReadiness(r.aztecNode as never, h),
	}
	let gate: ArrivalGateState = { simulateStart: 0, counted: false, preGated: false }
	gate = await awaitL2BlockCountdown(leg.record.depositL2Block, reads, clock, gate, {
		block: (block, left) => report({ type: "arrival", stage: "counting", block, blocksLeft: left }),
	})
	// A lagging node can report a receding anchor: within one call the count shown only falls.
	let lowest: number | undefined
	gate = await awaitMessageCheckpoints(hashes, reads, clock, gate, {
		unfolded: () => report({ type: "arrival", stage: "unfolded" }),
		checkpointsLeft: (left) => {
			lowest = Math.min(lowest ?? left, left)
			report({ type: "arrival", stage: "counting", checkpointsLeft: lowest })
		},
		checkpointsPassed: () => report({ type: "arrival", stage: "counting", checkpointsLeft: 0 }),
	})
	const verdict = await awaitClaimSimulate(simulate, (e) => classifyConsumable(e, nullifier, evidence), clock, gate, {
		consumableWait: (g) => emit({ type: "arrival", stage: "wallet-sync", counted: g.counted }),
	})
	if (verdict === "ready") {
		emit({ type: "claimable" })
		return verdict
	}
	if (verdict === "claimed-elsewhere") return verdict
	if (verdict === "invalid")
		throw new BridgeError("message-invalid", "the record's message is not the one its facts describe", SUBMITTED, "never")
	if (verdict === "moved") throw new BridgeError("aborted", "the caller stopped waiting", SUBMITTED, "after-wait")
	throw new BridgeError("message-timeout", "the deposit's message has not become claimable yet", SUBMITTED, "after-wait")
}

/** What a sent claim's receipt says, with a dropped transaction confirmed by consecutive readings. */
export type ClaimFate = "success" | "reverted" | "dropped"

const UNANSWERED = Symbol("unanswered")

/** A landed claim this call did not send is this record's only once its message's nullifier shows: a stored hash can
 *  name another transaction. "live" keeps the watch going; an unreadable nullifier settles, as no read can do better. */
async function verifiedLanding(leg: ClaimLeg, txHash: string, claim: LegKind, verify: () => Promise<TokenMessageState>): Promise<boolean> {
	leg.emit({ type: "claim-verifying", leg: claim, txHash, stage: "checking" })
	const state = await verify()
	checkAbort(leg.run, SUBMITTED)
	if (state === "invalid")
		throw new BridgeError("message-invalid", "the record's message is not the one its facts describe", SUBMITTED, "never")
	if (state !== "live") return true
	leg.emit({ type: "claim-verifying", leg: claim, txHash, stage: "wallet-sync" })
	return false
}

/** One receipt read of a watched claim: reported before it, and again when it changes the unanswered streak. */
async function readClaimReceipt(
	leg: ClaimLeg,
	txHash: string,
	claim: LegKind,
	poll: number,
	unreachable: number,
): Promise<{ fate: ReturnType<typeof classifyClaimReceipt>; unreachable: number }> {
	checkAbort(leg.run, SUBMITTED)
	leg.emit({ type: "claim-waiting", leg: claim, txHash, poll, unreachable })
	// The event's handler may stop the watch; a stopped watch reads nothing more and settles nothing.
	checkAbort(leg.run, SUBMITTED)
	const receipt = await leg.r.aztecNode.getTxReceipt(TxHash.fromString(txHash)).catch(() => UNANSWERED)
	const streak = receipt === UNANSWERED ? unreachable + 1 : 0
	if (streak !== unreachable) leg.emit({ type: "claim-waiting", leg: claim, txHash, poll, unreachable: streak })
	checkAbort(leg.run, SUBMITTED)
	return { fate: receipt === UNANSWERED ? "pending" : classifyClaimReceipt(receipt as never), unreachable: streak }
}

/**
 * Watches a claim transaction until it lands, reverts or drops. Proposed is reported once and is not settlement. With
 * `verify`, a landing counts only once the message's nullifier shows (a resumed hash). The signal is checked before and
 * after each read, and after each event, so a stopped watch settles nothing.
 */
export async function watchClaim(
	leg: ClaimLeg,
	txHash: string,
	claim: LegKind,
	verify?: () => Promise<TokenMessageState>,
): Promise<ClaimFate> {
	const clock = clockOf(leg.run)
	let dropped = 0
	let unreachable = 0
	let proposed = false
	for (let poll = 1; poll <= RECEIPT_POLLS; poll++) {
		const read = await readClaimReceipt(leg, txHash, claim, poll, unreachable)
		unreachable = read.unreachable
		if (read.fate === "success" && (!verify || (await verifiedLanding(leg, txHash, claim, verify)))) return "success"
		if (read.fate === "reverted") return "reverted"
		dropped = read.fate === "dropped" ? dropped + 1 : 0
		if (dropped >= DROPPED_STRIKES) return "dropped"
		if (read.fate === "proposed" && !proposed) {
			proposed = true
			leg.emit({ type: "claim-proposed", txHash })
		}
		await clock.wait(RECEIPT_POLL_MS)
	}
	throw new BridgeError("receipt-timeout", `the claim ${txHash} has not landed yet`, SUBMITTED, "after-wait")
}

/** Stops no wait can lift: the record or the deployment itself is wrong for this claim. */
const PERMANENT_STOPS: ReadonlySet<FeeStop> = new Set<FeeStop>([
	"malformed-claim-hash",
	"fpc-drift",
	"missing-salt",
	"missing-secret",
	"private-fuel-missing",
	"no-claimable-fuel",
	"floor-unconfigured",
	"fuel-already-claimed",
	"below-claim-floor",
	"below-fuel-floor",
	"record-predates-send",
	"deposit-reverted",
	"no-bridge",
])

/** A fee ladder's stop as the public error, its code kept for the caller's own copy; anything else unchanged. */
export function asBridgeError(e: unknown): unknown {
	if (!(e instanceof FeeStopError)) return e
	const retry = PERMANENT_STOPS.has(e.stop) ? "never" : "after-wait"
	return new BridgeError("fee-stop", `the claim cannot be paid for now: ${e.stop}`, SUBMITTED, retry, { cause: e, stop: e.stop })
}

/** Every claim failure as a `BridgeError`: a stop keeps its code, and an error no step classified is a read that
 *  failed before anything new was sent, so the same call may run again once the chain or the wallet answers. */
export function asClaimError(e: unknown): BridgeError {
	const mapped = asBridgeError(e)
	if (mapped instanceof BridgeError) return mapped
	return new BridgeError("read-failed", `the claim could not be prepared: ${messageOf(e)}`, SUBMITTED, "after-wait", { cause: e })
}
