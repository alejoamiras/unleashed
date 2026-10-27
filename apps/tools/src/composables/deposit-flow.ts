/**
 * Claim-side protocol operations for the send lane, as independently testable module functions.
 * State stays OWNED by the composable layer: `sealKeys` and the wallet singletons are passed in
 * explicitly — this module holds no mutable module state of its own.
 */

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { Gas } from "@aztec-labs/stdlib/gas"
import {
	type BridgeJournalRecord,
	type DepositJournalRecord,
	type EncryptionKey,
	type SendDepositRecord,
	type SendGeneration,
	type SendOpts,
	type SendResult,
	ERC20_ABI,
	PRIVATE_FPC_ADDRESS,
	PRIVATE_HUB_CLAIM_GAS,
	PRIVATE_HUB_REGISTER_GAS,
	awaitL1Receipt,
	depositExpectationOf,
	deriveBridgeSecret,
	emittedBy,
	ensurePermit2Allowance,
	isSealTrusted,
	isSendRecord,
	markSealTrusted,
	ownGasTxs,
	privateFeeJuicePayment,
	privateFpcFeeLimit,
	privateMintAndPayFee,
	publicFeeJuicePayment,
	readLegacySendLeaves,
	readSendInbox,
	readSendReceiptLeaves,
	selfPaidFeeJuicePayment,
	sealDepositRecord,
} from "@unleashed/bridge-core"
import type { Log } from "viem"
import { NETWORK } from "@/lib/network"
import { FUEL, FUEL_MIN_FJ, LEGACY_ROUTERS } from "@/contracts/bridge-generation"
import {
	FUEL_FEE_MARGIN,
	PRIVATE_ATTEMPT_STALE_MS,
	decideFuelClaim,
	decideFuelLadder,
	decideOwnGasSource,
	decidePrivateFuelClaim,
	isPrivateFuelInsufficiency,
} from "@/lib/fuel-claim-state"
import { isWellFormedTxHash } from "@/lib/claim-receipt"
import { feeJuiceMessageNullifier } from "@/lib/message-nullifier"
import { clampGas, walletMaxFees } from "@/lib/wallet-fee-budget"
import { DAPP_SELF_PAY_FEATURE, walletSupports } from "@/lib/wallet-features"
import {
	cacheSecret,
	currentRecord,
	isMsgConsumed,
	isMsgNotReady,
	markApproveOutcome,
	runOnLane,
	setRecordStep,
	updateRecord,
	updateRecordWhen,
} from "./useBridgeJournal"
import { type FuelClaimRetry, buildFuelClaimInteraction } from "./fuelClaim"
import { readBalance } from "./useTokenBalance"

// Verbose tracing while the bridge flows are being hardened - ids, stages, tx hashes ONLY.
const log = (...args: unknown[]) => console.log("[bridge:deposit]", ...args)

const NODE_URL = NETWORK.nodeUrl

/** Human Fee Juice (18 decimals) for user-facing balance/shortfall messages; `null` = unread. */
const fmtFj = (x: bigint | null): string => (x === null ? "?" : `${(Number(x) / 1e18).toFixed(3)} FJ`)

/** Best-effort signer fingerprint for the seal-trust cache (EIP-6963 rdns isn't plumbed for
 *  window.ethereum; injected flags are the practical discriminator). */
export function providerFingerprint(): string {
	if (typeof window === "undefined") return "unknown"
	const eth = (window as Window & { ethereum?: Record<string, unknown> }).ethereum
	if (!eth) return "unknown"
	if (eth.isRabby) return "rabby"
	if (eth.isMetaMask) return "metamask"
	return "injected"
}

/** A claim-side simulate/send pair — the journal engine's interaction contract. */
export interface ClaimInteraction {
	simulate: () => Promise<unknown>
	send: () => Promise<{ txHash: string }>
}

/** A fail-stop {simulate, send} pair that surfaces `why` (used by the private + no-fuel guards).
 *  `sendWhy` preserves the historical wait-stop shape, whose send threw a shorter message. */
export function failStopInteraction(why: string, sendWhy: string = why): ClaimInteraction {
	return {
		simulate: async () => {
			throw new Error(why)
		},
		send: async () => {
			throw new Error(sendWhy)
		},
	}
}

/** L2 height snapshot, best-effort: a dead node just means the gate narrates without the countdown. */
export async function bestEffortL2Block(): Promise<number | undefined> {
	try {
		return Number(await createAztecNodeClient(NODE_URL).getBlockNumber())
	} catch {
		return undefined
	}
}

type FuelBlock = NonNullable<DepositJournalRecord["fuel"]>

/** Whether `live` is the fuel block `captured` describes: the same secret commitment and, once
 *  both know it, the same message key. A re-send under the same id swaps in a block with neither. */
function sameFuelBlock(live: FuelBlock, captured: FuelBlock): boolean {
	if (live.secretHashHex !== captured.secretHashHex) return false
	return !live.messageHash || !captured.messageHash || live.messageHash === captured.messageHash
}

/** Merge explicit fields into the record's PERSISTED fuel block (never a captured copy: the
 *  journal's merge is shallow, so a nested `fuel` write replaces the block, and every claim-path
 *  write runs long after its builder captured the record). The captured block is the fallback when
 *  the record holds no live copy (unit fixtures, a wiped block). A live block that is not the
 *  captured one is another deposit's fuel (a re-send swapped it in under the same id): a patch
 *  computed for the captured block would settle a message nobody consumed, so the write is refused
 *  and `false` says so. Guard, merge and write share one synchronous load. `topLevel` rides in the
 *  same write so a site that also patches record fields keeps its one-write shape. */
export function patchFuel(
	id: string,
	captured: FuelBlock | undefined,
	patch: Partial<FuelBlock>,
	topLevel: Partial<DepositJournalRecord & Pick<SendDepositRecord, "registerTxHash">> = {},
): boolean {
	const liveOf = (rec: BridgeJournalRecord) => (rec as { fuel?: FuelBlock }).fuel
	const written = updateRecordWhen(
		id,
		(rec) => {
			const live = liveOf(rec)
			return !!(live ?? captured) && !(live && captured && !sameFuelBlock(live, captured))
		},
		(rec) => ({ ...topLevel, fuel: { ...(liveOf(rec) ?? captured), ...patch } }) as never,
	)
	if (!written) log("fuel patch refused: the record is gone or holds a different fuel block", id)
	return written !== undefined
}

// The probes read a `TxHash.fromString` throw as "pending" — a corrupted or hand-edited record
// would wait forever with no diagnostic, so the ladders check the shape first and say so.
const MALFORMED_FUEL_HASH =
	"This bridge's recorded gas-claim transaction hash is malformed — restore the record from a backup, or discard it."
const FUEL_CONSUMED_UNCHECKPOINTED =
	"An earlier gas claim could not be confirmed as checkpointed just now — try Claim your gas again in a moment."
const FUEL_CONSUMED_UNREADABLE = "The gas claim's state could not be read just now — try Claim your gas again in a moment."

const FUEL_POLL_MS = 6000
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** How long a settlement poll may run: `tries` reads, `pollMs` apart, each given `readMs` before
 *  a node that accepted the request but never answers counts as unreadable. */
export interface PollBudget {
	tries?: number
	pollMs?: number
	readMs?: number
}

/** `read` raced against `ms`: a transport with no deadline of its own must not hold the caller's
 *  operation span open forever. */
function withDeadline<T>(read: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const expiry = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("read timed out")), ms)
	})
	return Promise.race([read, expiry]).finally(() => clearTimeout(timer))
}

/** Whether the fuel message's own nullifier is CHECKPOINTED, polled at the inclusion cadence. A
 *  consumed-shaped send error proves only a PROPOSED consumption; a block that later drops leaves
 *  the Fee Juice unclaimed, so the latch waits for the checkpoint. `"unknown"` when the record
 *  holds no message key or the node cannot answer — never a latch. */
export async function fuelMessageCheckpointed(fuel: FuelBlock, budget: PollBudget = {}): Promise<boolean | "unknown"> {
	const { tries = 40, pollMs = FUEL_POLL_MS, readMs = 30_000 } = budget
	if (!fuel.messageHash) return "unknown"
	let nullifier: Fr
	try {
		nullifier = await feeJuiceMessageNullifier({ messageHash: fuel.messageHash, secret: fuel.secret })
	} catch {
		return "unknown"
	}
	const node = createAztecNodeClient(NODE_URL)
	for (let i = 0; i < tries; i++) {
		try {
			if ((await withDeadline(node.getNullifierMembershipWitness("checkpointed", nullifier), readMs)) !== undefined) return true
		} catch {
			return "unknown"
		}
		if (i + 1 < tries) await pause(pollMs)
	}
	return false
}

export async function fuelReceiptStatus(txHash: string): Promise<"included" | "dropped" | "pending"> {
	try {
		const receipt = await createAztecNodeClient(NODE_URL).getTxReceipt(TxHash.fromString(txHash))
		const status = String(receipt?.status ?? "pending").toLowerCase()
		// A mined status is inclusion whatever the execution result: a transaction that reverted past
		// its setup still landed, the fee was charged and the Fee Juice message its setup consumed is
		// spent — so it counts as included for the fuel's sake, never as a claim to retry.
		if (/checkpointed|proven|finalized|success|mined/.test(status)) return "included"
		if (status.includes("dropped")) return "dropped"
		return "pending"
	} catch {
		return "pending" // unreachable node reads as not-yet-evidence, never as consumed.
	}
}

/** Poll a just-sent claim tx to INCLUSION (bounded). PROPOSED is not consumption; only an included
 *  receipt confirms the FJ message is settled. Returns "pending" on timeout so the caller leaves
 *  the record unsettled and the recovery action stays offered. */
export async function waitForFuelInclusion(txHash: string, tries = 40): Promise<"included" | "dropped" | "pending"> {
	for (let i = 0; i < tries; i++) {
		const s = await fuelReceiptStatus(txHash)
		if (s !== "pending") return s
		await pause(FUEL_POLL_MS)
	}
	return "pending"
}

/** Claim a fueled deposit's Fee Juice as a standalone SELF-PAID tx (the claim pays its own fee from
 *  the Fee Juice it lands — no sponsor, on any network), INCLUSION-GATED. The FJ message is
 *  recipient-bound, so this is safe whenever fuel isn't known-consumed; an already-consumed message
 *  reverts but still reads INCLUDED (its nullifier exists), which settles it just the same.
 *  `standaloneClaimed` latches ONLY after inclusion - a dropped/timed-out tx leaves it unset so the
 *  card re-offers the action (closes the PROPOSED-latch false-negative). Under a fee spike the
 *  bridged amount cannot cover its own claim and the builder refuses: the Fee Juice stays claimable
 *  on Ethereum's side until fees ease, and the card keeps offering it. */
export async function sendStandaloneFjClaim(
	aztec: unknown,
	recipientAddr: AztecAddress,
	fuel: NonNullable<DepositJournalRecord["fuel"]>,
	id: string,
	budget: PollBudget = {},
): Promise<void> {
	const claimMaxFees = await walletFeesOrNull(aztec, recipientAddr, PRIVATE_HUB_CLAIM_GAS)
	if (claimMaxFees === null) throw new Error(UNPRICED_BY_WALLET)
	const claim = await buildFuelClaimInteraction({ fuel, isPrivate: false } as DepositJournalRecord, {
		aztec,
		recipient: recipientAddr,
		minFloorFj: FUEL_MIN_FJ,
		maxFeesPerGas: { feePerDaGas: claimMaxFees.feePerDaGas, feePerL2Gas: claimMaxFees.feePerL2Gas },
		resolvedSecret: fuel.secret,
	})
	let receiptTxHash: string
	try {
		receiptTxHash = (await claim.send()).txHash
	} catch (e) {
		// A consumed-shaped refusal says an earlier claim spent the message — but only as far as a
		// PROPOSED block; the latch needs the nullifier checkpointed, or a dropped block would hide
		// the recovery affordance for Fee Juice that was never claimed (fund-stranding). Must be the
		// consumed shape, NOT not-ready: a not-yet-anchored message has no nullifier to read.
		if (!isMsgConsumed(e instanceof Error ? e.message : String(e))) throw e
		const settled = await fuelMessageCheckpointed(fuel, budget)
		if (settled !== true) throw new Error(settled === false ? FUEL_CONSUMED_UNCHECKPOINTED : FUEL_CONSUMED_UNREADABLE)
		patchFuel(id, fuel, { standaloneClaimed: true })
		log("standalone FJ claim: message already consumed and checkpointed - gas already in wallet", id)
		return
	}
	if ((await waitForFuelInclusion(receiptTxHash)) !== "included") {
		throw new Error("The gas claim was sent but hasn't confirmed yet — try Claim your gas again in a moment.")
	}
	patchFuel(id, fuel, { standaloneClaimed: true })
	log("standalone FJ claim confirmed", id)
}

/** Read the account's PUBLIC Fee Juice balance - what a wallet that routes a dApp-named payer can pay
 *  a claim from. Uses the FeeJuice contract's `balance_of_public` via the connected wallet (scoped
 *  in the bridge manifest's simulation); mirrors the wallet's own gas-balance reader. */
export async function readPublicFeeJuiceBalance(aztec: unknown, recipient: AztecAddress): Promise<bigint> {
	const { FeeJuiceContract } = await import("@aztec-labs/aztec.js/protocol")
	return readBalance(aztec as never, FeeJuiceContract.withWallet(aztec as never), "balance_of_public", recipient)
}

/** Read the account's PRIVATE Fee Juice balance held at the Wonderland PrivateFPC — the remainder a
 *  prior private fuel claim credited (via `mint_and_pay_fee`). The 2.2 MB artifact is lazily imported
 *  from bridge-core's dedicated code-split entry (never the eager `./artifacts` barrel). `balance_of`
 *  is `abi_utility` — scoped in the combined manifest's `simulation.utilities`. */
export async function readPrivateFeeJuiceBalance(aztec: unknown, recipient: AztecAddress): Promise<bigint> {
	const { PrivateFPCContractArtifact } = await import("@unleashed/bridge-core/private-fpc-artifact")
	const fpc = await Contract.at(AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS), PrivateFPCContractArtifact, aztec as never)
	return readBalance(aztec as never, fpc, "balance_of", recipient)
}

/** Read a Fee Juice balance, mapping a read FAILURE to `null` (≠ a real zero) so the no-fuel fee-source
 *  decision can FAIL CLOSED — never fabricate spendable balance, never a false "no gas" — when a
 *  transient `balance_of` RPC error hides whether the user actually holds gas. */
export async function readFeeJuiceOrNull(label: string, read: () => Promise<bigint>): Promise<bigint | null> {
	try {
		return await read()
	} catch (e) {
		log(`${label} balance read failed (fail-closed → null):`, e instanceof Error ? e.message : String(e))
		return null
	}
}

// ── deposit-leg recovery ─────────────────────────────────────────────────────

/** The reads the recovery needs: the receipt, and the factory's frozen Inbox the leaves are checked against. */
export interface RecoveryL1Client {
	getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<{ status: string; logs: unknown[] } | null>
	readContract: (args: never) => Promise<unknown>
}

/** The leaves a landed send produced. A deposit through a retired router reads that router's own
 *  events; any other must be the deposit router's one `Deposited` for this record, authenticated
 *  leg by leg. A first deposit's receipt also carries the factory's register leaf, so the Inbox
 *  events alone would name the wrong one. */
async function sendLeavesOf(
	rec: SendDepositRecord,
	logs: Log[],
	pub: RecoveryL1Client,
	generation: SendGeneration | undefined,
	legacyRouters: readonly `0x${string}`[],
): Promise<Partial<SendResult>> {
	const hash = rec.depositTxHash as `0x${string}`
	const legacy = legacyRouters.find((router) => emittedBy(router, logs))
	if (legacy && !(generation && emittedBy(generation.router, logs))) return readLegacySendLeaves(legacy, rec.intent, hash, logs)
	if (!generation) throw new Error("This network has no bridge.")
	const inbox = await readSendInbox(pub as never, generation)
	return readSendReceiptLeaves(generation, inbox, depositExpectationOf(rec), hash, logs as never)
}

function recoverSendLeg(rec: SendDepositRecord, leaves: Partial<SendResult>): "recovered" {
	const patch: Partial<SendDepositRecord> = {}
	if (leaves.tokenLeafIndex !== undefined) {
		patch.leafIndex = leaves.tokenLeafIndex.toString()
		patch.messageHash = leaves.tokenMessageHashHex
	}
	if (leaves.fuelLeafIndex !== undefined && rec.fuel) {
		if (rec.intent === "gas") patch.leafIndex = leaves.fuelLeafIndex.toString()
		const written = patchFuel(
			rec.id,
			rec.fuel,
			{
				leafIndex: leaves.fuelLeafIndex.toString(),
				messageHash: leaves.fuelMessageHashHex,
				received: (leaves.fuelReceived ?? 0n).toString(),
			},
			patch as Partial<DepositJournalRecord>,
		)
		if (!written) throw new Error("This bridge record changed while its deposit was being checked — reload and retry.")
		return "recovered"
	}
	updateRecord(rec.id, patch)
	return "recovered"
}

/**
 * Deposit-leg recovery: the leg is chain-recoverable from the recorded depositTxHash alone (every
 * flow persists the hash BEFORE waiting), so a flow that died mid-wait — L1 timeout, closed tab —
 * completes here on Retry instead of stranding a confirmed deposit. Patches the same fields the
 * live flow writes post-receipt; depositL2Block stays unset so the engine skips the display
 * countdown and goes straight to the claim-simulate gate (the recovered deposit is old — its
 * message is likely already consumable).
 */
export async function recoverDepositLeg(
	rec: DepositJournalRecord | SendDepositRecord,
	publicClient: RecoveryL1Client,
	generation?: SendGeneration,
	legacyRouters: readonly `0x${string}`[] = LEGACY_ROUTERS,
): Promise<"pending" | "recovered"> {
	if (!isSendRecord(rec)) {
		throw new Error("This record predates the current bridge — its Ethereum leg cannot be recovered here.")
	}
	const hash = rec.depositTxHash as `0x${string}`
	const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null)
	if (!receipt) return "pending"
	if (receipt.status !== "success") {
		throw new Error("The Ethereum deposit transaction reverted — there is nothing to claim. You can discard this record.")
	}
	return recoverSendLeg(rec, await sendLeavesOf(rec, receipt.logs as Log[], publicClient, generation, legacyRouters))
}

// ── claim builders (the journal engine's claim dep, decomposed) ──────────────

const FUEL_ALREADY_CLAIMED = "The gas claim was already included on Aztec — there is nothing left to claim for this bridge."

/** A gas-only record with a prior claim on its PERSISTED fuel block is rebuilt ONLY once that claim
 *  conclusively dropped: an included one (success, or reverted past setup — the message was consumed
 *  either way) has nothing left to claim, and a pending/unreachable one may still land — simulate is
 *  an authority, not exclusion against a queued tx, and elapsed time is not evidence the tx vanished.
 *  Never steers at DISCARD: on a private record that destroys the only claim secret. */
async function priorFuelClaimStop(id: string, captured: FuelBlock | undefined): Promise<ClaimInteraction | null> {
	const fuel = (currentRecord(id) as { fuel?: FuelBlock } | undefined)?.fuel ?? captured
	if (fuel?.consumed === true) return failStopInteraction(FUEL_ALREADY_CLAIMED)
	if (fuel?.claimTxHash === undefined) return null
	if (!isWellFormedTxHash(fuel.claimTxHash)) return failStopInteraction(MALFORMED_FUEL_HASH)
	const status = await fuelReceiptStatus(fuel.claimTxHash)
	if (status === "included") return failStopInteraction(FUEL_ALREADY_CLAIMED)
	if (status === "dropped") return null
	return failStopInteraction(
		"A gas claim for this bridge is still pending — waiting for its receipt before trying again. Retry later; if you decide to discard this record, back it up first.",
	)
}

/** A gas-only bridge claims Fee Juice directly: no token leg, its own fee ladder. */
export async function buildFeeJuiceClaimDep(
	rec: DepositJournalRecord,
	secretHex: string,
	envelope: { salt?: string } | undefined,
	aztec: unknown,
	retry?: FuelClaimRetry,
): Promise<ClaimInteraction> {
	const prior = await priorFuelClaimStop(rec.id, rec.fuel)
	if (prior) return prior
	const latchFuel = (patch: Partial<FuelBlock>) => patchFuel(rec.id, rec.fuel, patch)
	// V5: pin the claim's maxFeesPerGas to predicted-worst — NO extra padding. BOTH paths now
	// SELF-PAY (public via FeeJuicePaymentMethodWithClaim, private via the embedded FPC): the bridged
	// amount is the whole budget and the setup asserts amount >= gasLimits*maxFeesPerGas with no
	// refund, so any fee headroom inflates max_gas_cost past the bridged amount and reverts "Amount
	// too low to cover gas cost". (The wallet's x1.5 minFeePadding is for refundable txs, not this.)
	// predicted-worst is already a forward-looking ceiling so it still covers base-fee drift through
	// the proving window; a rare spike beyond it fails recoverably (the engine reprices on retry).
	// The figure is the WALLET's, though: it submits under its own max fee, not the app's.
	const claimMaxFees = await walletFeesOrNull(aztec, AztecAddress.fromStringUnsafe(rec.recipient), PRIVATE_HUB_CLAIM_GAS)
	if (claimMaxFees === null) throw new Error(UNPRICED_BY_WALLET)
	return buildFuelClaimInteraction(rec, {
		aztec,
		recipient: AztecAddress.fromStringUnsafe(rec.recipient),
		minFloorFj: FUEL_MIN_FJ,
		maxFeesPerGas: { feePerDaGas: claimMaxFees.feePerDaGas, feePerL2Gas: claimMaxFees.feePerL2Gas },
		// Authoritative claim material from the engine: the unsealed `envelope.salt` (private) and
		// the gated top-level secret (public) — never the plaintext journal copy.
		resolvedSalt: rec.isPrivate ? envelope?.salt : undefined,
		resolvedSecret: rec.isPrivate ? undefined : secretHex,
		onAttempt: () => latchFuel({ claimAttempt: true, claimAttemptAt: Date.now(), setupInsufficiency: false }),
		onTxHash: (txHash: string) => latchFuel({ claimAttempt: true, claimAttemptAt: Date.now(), claimTxHash: txHash }),
		onSetupInsufficiency: () => latchFuel({ setupInsufficiency: true }),
		retry,
	}) as unknown as ClaimInteraction
}

/** The record facts the claim fee ladder reads. Every journal shape satisfies it, so the ladder is
 *  shared by the hub claim and the gas-only claim without either owning the other's type. */
export interface FeeLadderRecord {
	id: string
	isPrivate: boolean
	schema: 1 | 2 | 3
	intent?: "token" | "token+gas" | "gas"
	depositTxHash?: string
	fuel?: DepositJournalRecord["fuel"]
}

type FpcFee = { paymentMethod: unknown; gasSettings: unknown }

/** The private-fuel fee, decoupled from the interaction it pays for. "none" = the record is not
 *  on the private-fuel path at all. "fee" spends the bridged Fee Juice message: on a first-time
 *  token (`registers`) the registration goes first and spends it, sized for a registration, and
 *  `registeredClaimFee` pays the claim that follows from the credit the FPC kept. "credit" is the
 *  claim of a record whose fuel is already spent — paid from that credit alone. */
export type PrivateFuelFee =
	| { kind: "none" }
	| { kind: "stop"; why: string }
	| { kind: "fee"; fee: FpcFee; fuel: FuelBlock; registers: boolean; registeredClaimFee?: FpcFee }
	| { kind: "credit"; fee: FpcFee; registers: boolean; registerFee?: FpcFee; registeredClaimFee?: FpcFee }

/**
 * The salt the private claim is rebuilt from. The envelope's copy is AUTHENTICATED (AES-GCM), the
 * journal's is a mutable display copy: when they disagree the sealed one wins and the record is
 * corrected on the spot, or every retry would derive a secret the deposit never committed to and
 * loop forever on a wrong-secret claim. The value itself never reaches the log.
 */
function reconcileFuelSalt(rec: FeeLadderRecord, sealedSalt?: string): DepositJournalRecord["fuel"] {
	// The PERSISTED block, not the ladder's captured copy: a latch from another tab must survive the restore.
	const fuel = (currentRecord(rec.id) as { fuel?: FuelBlock } | undefined)?.fuel ?? rec.fuel
	if (!sealedSalt || !fuel || fuel.bridgeSecretSalt === sealedSalt) return fuel
	log("journal fuel salt disagreed with the sealed envelope - restoring the sealed copy", { id: rec.id })
	patchFuel(rec.id, fuel, { bridgeSecretSalt: sealedSalt })
	return { ...fuel, bridgeSecretSalt: sealedSalt }
}

/**
 * PRIVATE fuel is a fully SEPARATE path. The fee is ALWAYS the PrivateFPC method (feePayer=FPC);
 * recovery retries ONLY that method. It NEVER touches the public sponsored/fjwc/standalone ladder —
 * doing so would claim the Fee Juice in a publicly visible transaction and deanonymize the bridge.
 */
export async function resolvePrivateFuelFee(
	rec: FeeLadderRecord,
	recipientAddr: AztecAddress,
	sealedSalt?: string,
	/** `registers`: this claim registers the token first, so the registration is the transaction
	 *  that spends the fuel. `aztec`: the wallet, for a claim paid from an already-spent fuel's credit. */
	ctx: { registers?: boolean; aztec?: unknown } = {},
): Promise<PrivateFuelFee> {
	const fuel = reconcileFuelSalt(rec, sealedSalt)
	const incomplete = privateIncompleteReason(rec, fuel)
	if (incomplete) return { kind: "stop", why: incomplete }
	if (!(rec.isPrivate && fuel?.received && fuel.leafIndex && fuel.bridgeSecretSalt)) return { kind: "none" }
	const fb = fuel
	const fuelReceived = BigInt(fuel.received)
	const salt = Fr.fromString(fuel.bridgeSecretSalt)
	const unsafe = privateFuelSafetyReason(fb, fuelReceived)
	if (unsafe) return { kind: "stop", why: unsafe }
	if (fb.claimTxHash !== undefined && !isWellFormedTxHash(fb.claimTxHash)) return { kind: "stop", why: MALFORMED_FUEL_HASH }
	const receiptStatus = fb.claimTxHash ? await fuelReceiptStatus(fb.claimTxHash) : undefined
	if (receiptStatus === "included" && fb.consumed !== true) {
		patchFuel(rec.id, fb, { consumed: true })
	}
	const decision = decidePrivateFuelClaim({
		attempt: fb.claimAttempt === true,
		txHashKnown: typeof fb.claimTxHash === "string",
		receiptStatus,
		consumed: fb.consumed === true || receiptStatus === "included",
		setupInsufficiency: fb.setupInsufficiency === true,
		// Missing timestamp = every pre-fix record ⇒ aged out (their limbo is exactly the bug).
		attemptAgedOut: fb.claimAttemptAt === undefined || Date.now() - fb.claimAttemptAt > PRIVATE_ATTEMPT_STALE_MS,
	})
	log("private fuel claim decision", { id: rec.id, action: decision.action })
	// Spent fuel is never re-minted (a second claim double-spends the FJ message) and never goes
	// public: the claim it was meant to pay for draws on the credit the FPC kept for this account.
	if (decision.action === "consumed") return privateCreditFee(fb, recipientAddr, ctx.aztec, ctx.registers === true)
	if (decision.action !== "private-fpc")
		return { kind: "stop", why: "private fuel claim pending — waiting for its receipt before retrying" }
	return privateFpcFee(fb, fuelReceived, salt, recipientAddr, ctx.registers === true, ctx.aztec)
}

/** The FPC's explicit gas settings: limits sized to the transaction, teardown zero (it keeps
 *  `max_gas_cost` within the bridged amount), fees pinned to the predicted worst case. */
function fpcGasSettings(gas: { daGas: number; l2Gas: number }, maxFees: { feePerDaGas: bigint; feePerL2Gas: bigint }) {
	const cap = { feePerDaGas: maxFees.feePerDaGas, feePerL2Gas: maxFees.feePerL2Gas }
	return {
		gasLimits: Gas.from(clampGas(gas)),
		teardownGasLimits: Gas.from({ daGas: 0, l2Gas: 0 }),
		maxFeesPerGas: cap,
		// The wallet-sdk option schema spells the cap this way; a wallet reading either spelling gets it.
		maxFeePerGas: cap,
	}
}

type MaxFees = { feePerDaGas: bigint; feePerL2Gas: bigint }

const UNPRICED_BY_WALLET = "Your wallet could not price this transaction's fee ceiling just now — please try again in a moment."

/** The max fees the connected wallet will submit under, or null when it cannot say (logged): every
 *  ceiling below is `limits × this`, kept in full by the FPC, so a figure the wallet did not give
 *  is not one to fund an irreversible step on. */
async function walletFeesOrNull(aztec: unknown, account: AztecAddress, gas: { daGas: number; l2Gas: number }): Promise<MaxFees | null> {
	try {
		return await walletMaxFees(aztec, account, gas)
	} catch (e) {
		log("wallet fee quote failed (fail-closed → null):", e instanceof Error ? e.message : String(e))
		return null
	}
}

/** What a claim from held gas sets aside, priced from the CLAMPED limits it is submitted under —
 *  what the FPC actually keeps — never from the declared constants a smaller network cuts down. */
function clampedOwnGasCeiling(shape: { isPrivate: boolean; registers: boolean }, maxFees: MaxFees): bigint {
	const txs = ownGasTxs(shape)
	const claim = privateFpcFeeLimit(clampGas(txs.claim), maxFees)
	return txs.register ? claim + privateFpcFeeLimit(clampGas(txs.register), maxFees) : claim
}

/** A transaction paid from the private Fee Juice this account already holds at the FPC (`pay_fee`),
 *  at the ceiling its limits commit to. */
function fpcCreditFee(fpcAddr: AztecAddress, maxFees: MaxFees, gas: { daGas: number; l2Gas: number } = PRIVATE_HUB_CLAIM_GAS): FpcFee {
	return { paymentMethod: privateFeeJuicePayment(fpcAddr), gasSettings: fpcGasSettings(gas, maxFees) }
}

/** The claim of a record whose fuel is already spent (the registration ahead of it, or a prior
 *  attempt): the FPC holds the remainder as this account's private credit, and `pay_fee` deducts
 *  the committed ceiling of every transaction it pays from it — the claim's, and a registration's
 *  too when the token is still unregistered (a registration that reverted past its setup spent the
 *  fuel without binding the token) — refused here when the credit cannot cover them. */
async function privateCreditFee(fb: FuelBlock, recipientAddr: AztecAddress, aztec: unknown, registers: boolean): Promise<PrivateFuelFee> {
	if (aztec === undefined) return { kind: "stop", why: "Connect your Aztec wallet to pay this claim from your private gas." }
	const fpcAddr = AztecAddress.fromStringUnsafe(fb.fpc ?? PRIVATE_FPC_ADDRESS)
	const [credit, maxFees] = await Promise.all([
		readFeeJuiceOrNull("private FJ", () => readPrivateFeeJuiceBalance(aztec, recipientAddr)),
		walletFeesOrNull(aztec, recipientAddr, PRIVATE_HUB_CLAIM_GAS),
	])
	if (credit === null) return { kind: "stop", why: "Couldn't check your private gas at the fee contract — please try again in a moment." }
	if (maxFees === null) return { kind: "stop", why: UNPRICED_BY_WALLET }
	// Priced from the CLAMPED limits the transactions are submitted under: the FPC keeps exactly that.
	const needed =
		privateFpcFeeLimit(clampGas(PRIVATE_HUB_CLAIM_GAS), maxFees) +
		(registers ? privateFpcFeeLimit(clampGas(PRIVATE_HUB_REGISTER_GAS), maxFees) : 0n)
	if (credit < needed) {
		return {
			kind: "stop",
			why: registers
				? "Your private gas is under the fee ceiling of registering the token and claiming it at current network fees — retry when fees ease, or bridge more gas."
				: "Your private gas is under this claim's fee ceiling at current network fees — retry when fees ease, or bridge more gas.",
		}
	}
	const claim = fpcCreditFee(fpcAddr, maxFees)
	return {
		kind: "credit",
		fee: claim,
		registers,
		...(registers ? { registerFee: fpcCreditFee(fpcAddr, maxFees, PRIVATE_HUB_REGISTER_GAS), registeredClaimFee: claim } : {}),
	}
}

/**
 * teardownGas=0 keeps max_gas_cost within the bridged amount. We pin maxFeesPerGas to the
 * PREDICTED worst-case min fee (not current-min): the FPC asserts amount >= gasLimits*maxFeesPerGas,
 * and the claim lands seconds-to-minutes after it's built, so a current-min cap risks an
 * inclusion-time reject if base fee rises in that window. Predicted-worst bounds the window AND
 * fixes the FPC ceiling so the bridged amount can cover it. Explicit ⇒ the wallet commits it
 * verbatim (no embedded-fpc-cap refetch drift). feePayer=FPC ⇒ FeeJuice.claim + mint_and_pay_fee
 * + the claim run as one EXTERNAL tx.
 * No padding on top of predicted-worst: the FPC credits `amount − max_gas_cost` and refunds nothing,
 * so padding is Fee Juice the claimer forfeits, and predicted-worst already looks past the proving
 * window. A rare cap that still falls under the live fee fails recoverably — each journal-driven
 * retry rebuilds this (re-prices). Same policy as the direct Fee Juice lane (fuelClaim.ts).
 */
async function privateFpcFee(
	fb: FuelBlock,
	fuelReceived: bigint,
	salt: Fr,
	recipientAddr: AztecAddress,
	registers: boolean,
	aztec: unknown,
): Promise<PrivateFuelFee> {
	const fpcAddr = AztecAddress.fromStringUnsafe(fb.fpc ?? PRIVATE_FPC_ADDRESS)
	const fuelLeaf = new Fr(BigInt(fb.leafIndex as string))
	const maxFees = await walletFeesOrNull(aztec, recipientAddr, registers ? PRIVATE_HUB_REGISTER_GAS : PRIVATE_HUB_CLAIM_GAS)
	if (maxFees === null) return { kind: "stop", why: UNPRICED_BY_WALLET }
	// The FPC asserts the bridged amount covers the COMMITTED ceiling (limits × capped fees) of the
	// transaction that spends it, and credits only the remainder: when a registration spends it,
	// that remainder must still cover the claim's own ceiling. A short amount is refused here rather
	// than reverted there; fees are re-priced on every retry.
	const spentBy = registers ? PRIVATE_HUB_REGISTER_GAS : PRIVATE_HUB_CLAIM_GAS
	const ceiling =
		privateFpcFeeLimit(clampGas(spentBy), maxFees) + (registers ? privateFpcFeeLimit(clampGas(PRIVATE_HUB_CLAIM_GAS), maxFees) : 0n)
	if (fuelReceived < ceiling) {
		return {
			kind: "stop",
			why: registers
				? "The bridged gas is under the fee ceiling of registering the token and claiming it privately at current network fees — retry when fees ease."
				: "The bridged gas is under the private claim's fee ceiling at current network fees — retry when fees ease.",
		}
	}
	return {
		kind: "fee",
		fuel: fb,
		registers,
		fee: {
			paymentMethod: privateMintAndPayFee(fpcAddr, fuelReceived, deriveBridgeSecret(salt, recipientAddr), salt, fuelLeaf),
			// Explicit limits: a wallet given none declares the network's per-tx maximum, and the
			// FPC's ceiling is limits × fees — the maximum makes it unpayable by any realistic slice.
			gasSettings: fpcGasSettings(spentBy, maxFees),
		},
		...(registers ? { registeredClaimFee: fpcCreditFee(fpcAddr, maxFees) } : {}),
	}
}

/** Structural fence: a private FUELED record reaches the private ladder or stops here. It must
 *  never fall through to the public/sponsored ladder — that claims the FJ in a publicly-visible tx
 *  and deanonymizes the bridge. Incomplete metadata (an older or partially restored record, or a
 *  tampered one) is exactly the fall-through that must not happen silently. */
function privateIncompleteReason(rec: FeeLadderRecord, fuel: DepositJournalRecord["fuel"]): string | null {
	if (decideFuelLadder({ isPrivate: rec.isPrivate, schema: rec.schema, intent: rec.intent, fuel }) !== "private-incomplete") return null
	// Only advertise a retry where one can actually do something: the engine's receipt
	// rehydration needs a depositTxHash, and only the event-derived fields come back that
	// way. The client-random salt exists nowhere but a backup file.
	return fuel?.bridgeSecretSalt && rec.depositTxHash
		? "This private bridge's gas details couldn't be read from Ethereum yet — retry in a minute. The public gas recovery is deliberately unavailable for private bridges."
		: "This private bridge is missing the data needed to claim its gas privately (an older or partially restored record). Only its backup file can restore that — the public gas recovery is deliberately unavailable for private bridges."
}

/** Kill-switch on a drifted FPC address (never claim to it, never downgrade to public) plus the
 *  fail-closed budget floor, below which the mint_and_pay_fee assert fails anyway. */
function privateFuelSafetyReason(fb: FuelBlock, fuelReceived: bigint): string | null {
	if (fb.fpc && fb.fpc !== PRIVATE_FPC_ADDRESS) {
		return "Private fuel FPC address mismatch (version drift), refusing to claim. Reselect a mode."
	}
	if (FUEL && fuelReceived < BigInt(FUEL.minFuelFj)) {
		return "The bridged gas is below the safe claim floor; the private fuel claim can't self-pay."
	}
	return null
}

/** The public claim's fee resolution, as a strict discriminated result — impossible
 *  combinations (a stop with a fee, standalone with fjwc) cannot be constructed. */
export type PublicClaimFee =
	| { kind: "stop"; why: string; sendWhy?: string }
	| { kind: "fjwc"; fee: { paymentMethod: unknown } }
	/** The private gas the account already holds at the FPC pays the claim. A private first-time
	 *  token sends a registration first, on the register seams; `standalone` is bridged Fee Juice a
	 *  fee spike left for a claim of its own. */
	| { kind: "own-gas"; fee: FpcFee; registerFee?: FpcFee; registeredClaimFee?: FpcFee; standalone?: FuelBlock }

const OWN_GAS_STOPS = {
	none: 'No gas to claim this bridge with: your account holds no Fee Juice the bridge can pay from. Send with "arrive with gas", or bridge gas first.',
	unverifiable: "Couldn't check your gas — please try again in a moment.",
	short: "Your gas is under this claim's fee ceiling at current network fees — retry when fees ease, or bridge more gas.",
} as const
/** A private bridge's claim is never paid from public Fee Juice (see `decideOwnGasSource`). */
const PRIVATE_OWN_GAS_STOPS = {
	none: "A private bridge pays its claim only from private gas, and your account holds none at the fee contract — paying from public Fee Juice would link your account to this bridge. Bridge gas privately first.",
	unverifiable: "Couldn't check your private gas — please try again in a moment.",
	short: "Your private gas is under this claim's fee ceiling at current network fees — retry when fees ease, or bridge more gas privately.",
} as const

/** The account's own public Fee Juice as the transaction's payer, on a wallet that routes it: the
 *  wallet sizes the limits from its own estimate and charges the exact fee; the cap is the
 *  predicted worst fee, so a rise before inclusion cannot reject it. */
const selfPayFee = (payer: AztecAddress, maxFees: MaxFees): FpcFee => ({
	paymentMethod: selfPaidFeeJuicePayment(payer),
	gasSettings: { maxFeesPerGas: { feePerDaGas: maxFees.feePerDaGas, feePerL2Gas: maxFees.feePerL2Gas } },
})

/** A claim with no fresh Fee Juice message of its own pays from gas the account ALREADY holds, and
 *  names its payer: the private balance at the FPC, or — on a wallet that routes a dApp-named payer
 *  — its public Fee Juice. A claim sent without a payer would be left to the wallet's picker, whose
 *  default is the sponsored FPC no bridge path may lean on; a public payer on a wallet that cannot
 *  route it builds an invalid transaction, so the wallet is asked first. Reads are fail-closed
 *  (null = unread). */
export async function ownGasFee(
	rec: FeeLadderRecord,
	recipientAddr: AztecAddress,
	aztec: unknown,
	registers: boolean,
): Promise<PublicClaimFee> {
	const publicAllowed = await walletSupports(aztec, DAPP_SELF_PAY_FEATURE)
	const [pub, credit, maxFees] = await Promise.all([
		publicAllowed ? readFeeJuiceOrNull("public FJ", () => readPublicFeeJuiceBalance(aztec, recipientAddr)) : Promise.resolve(0n),
		readFeeJuiceOrNull("private FJ", () => readPrivateFeeJuiceBalance(aztec, recipientAddr)),
		walletFeesOrNull(aztec, recipientAddr, PRIVATE_HUB_CLAIM_GAS),
	])
	if (maxFees === null) return { kind: "stop", why: UNPRICED_BY_WALLET }
	const shape = { isPrivate: rec.isPrivate, registers }
	const ceiling = clampedOwnGasCeiling(shape, maxFees)
	const source = decideOwnGasSource({
		publicFeeJuice: pub,
		privateFeeJuice: credit,
		ceiling,
		privateBridge: rec.isPrivate,
		publicAllowed,
	})
	log("own-gas source", { id: rec.id, source, registers, publicAllowed, pub: fmtFj(pub), credit: fmtFj(credit), ceiling: fmtFj(ceiling) })
	if (source === "public") return { kind: "own-gas", fee: selfPayFee(recipientAddr, maxFees) }
	if (source !== "private") return { kind: "stop", why: (rec.isPrivate ? PRIVATE_OWN_GAS_STOPS : OWN_GAS_STOPS)[source] }
	const fpc = AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS)
	const txs = ownGasTxs(shape)
	const fee = fpcCreditFee(fpc, maxFees, txs.claim)
	return {
		kind: "own-gas",
		fee,
		...(txs.register ? { registerFee: fpcCreditFee(fpc, maxFees, txs.register), registeredClaimFee: fee } : {}),
	}
}

/** A fee spike: the claim pays from held gas and the bridged Fee Juice lands by a transaction of its own. */
async function ownGasWithStandalone(
	rec: FeeLadderRecord,
	recipientAddr: AztecAddress,
	aztec: unknown,
	registers: boolean,
	fuel: FuelBlock,
): Promise<PublicClaimFee> {
	const own = await ownGasFee(rec, recipientAddr, aztec, registers)
	return own.kind === "own-gas" ? { ...own, standalone: fuel } : own
}

/** Fueled records pick their payment from record-specific evidence only. */
export async function resolvePublicClaimFee(
	rec: FeeLadderRecord,
	recipientAddr: AztecAddress,
	aztec: unknown,
	userOverride: boolean,
	registers: boolean,
): Promise<PublicClaimFee> {
	const fuel = rec.fuel
	if (!(fuel?.received && fuel.leafIndex)) return ownGasFee(rec, recipientAddr, aztec, registers)
	if (fuel.claimTxHash !== undefined && !isWellFormedTxHash(fuel.claimTxHash)) return { kind: "stop", why: MALFORMED_FUEL_HASH }
	const receiptStatus = fuel.claimTxHash ? await fuelReceiptStatus(fuel.claimTxHash) : undefined
	// Promote a prior attempt to INCLUSION-GRADE durable evidence: only an `included`
	// receipt sets `consumed`, so a later unreachable node can trust it - a PROPOSED-time
	// latch would wrongly survive a dropped tx.
	if (receiptStatus === "included" && fuel.consumed !== true) {
		patchFuel(rec.id, fuel, { consumed: true })
	}
	const decision = decideFuelClaim({
		attempt: fuel.claimAttempt === true,
		txHashKnown: typeof fuel.claimTxHash === "string",
		receiptStatus,
		consumed: fuel.consumed === true || receiptStatus === "included",
		fuelReceived: BigInt(fuel.received),
		// The calibrated floor (config) is the fee reference; a live min-fee query is a refinement,
		// not a correctness need - the floor is 2x a real observed fee.
		currentMinFee: FUEL ? BigInt(FUEL.minFuelFj) / FUEL_FEE_MARGIN : undefined,
		persistentFailureCount: 0,
		userOverride,
	})
	log("fuel claim decision", { id: rec.id, action: decision.action })
	if (decision.action === "fjwc") {
		return {
			kind: "fjwc",
			fee: {
				paymentMethod: publicFeeJuicePayment(recipientAddr, {
					claimAmount: BigInt(fuel.received),
					claimSecret: Fr.fromString(fuel.secret),
					messageLeafIndex: BigInt(fuel.leafIndex),
				}),
			},
		}
	}
	if (decision.action === "own-gas-plus-standalone-fj") return ownGasWithStandalone(rec, recipientAddr, aztec, registers, fuel)
	if (decision.action === "wait") {
		// The historical wait stop threw a SHORTER message from send than from simulate — preserved.
		return {
			kind: "stop",
			why: "fuel claim attempt pending — waiting for its receipt before retrying",
			sendWhy: "fuel claim attempt pending",
		}
	}
	// "own-gas" (user override, or a consumed prior attempt): gas the account already holds.
	return ownGasFee(rec, recipientAddr, aztec, registers)
}

/** The journal-side effects a chosen fee owes, run around the wallet call the caller makes. The
 *  latches are journal-FIRST by contract: an attempt is recorded before the wallet is asked. */
export interface HubClaimLatches {
	onAttempt?: () => void
	onTxHash?: (txHash: string) => void
	/** A setup-insufficiency throw means the tx was INVALID and the Fee Juice is unconsumed — the
	 *  one signal that authorises a retry of a private claim. */
	onFailure?: (e: unknown) => void
	/** The fuel rides on the token's registration rather than on the claim: the attempt and its hash
	 *  latch against THAT transaction, and `onRegistered` journals the registration's hash as the
	 *  fuel's in one write. A registration someone else won leaves the fuel on the claim after all. */
	fuelOnRegister?: boolean
	onRegistered?: (registerTxHash: string) => void
	/** Present when the ladder left the bridged Fee Juice for a claim of its own: the caller fires
	 *  that best-effort self-paid claim after the hub claim is away. */
	standalone?: FuelBlock
}

export type HubClaimFee = ({ kind: "stop"; why: string; sendWhy?: string } | { kind: "opts"; opts: SendOpts }) & Partial<HubClaimLatches>

const fjwcLatches = (id: string, fuel?: DepositJournalRecord["fuel"]): HubClaimLatches =>
	fuel
		? {
				onAttempt: () => patchFuel(id, fuel, { claimAttempt: true, claimAttemptAt: Date.now() }),
				// PROPOSED is NOT inclusion: latch the attempt + hash only; `consumed` is set later,
				// inclusion-grade, from the receipt probe.
				onTxHash: (txHash: string) => patchFuel(id, fuel, { claimAttempt: true, claimTxHash: txHash }),
			}
		: {}

const privateLatches = (id: string, fuel: FuelBlock, fuelOnRegister: boolean): HubClaimLatches => {
	const latchHash = (txHash: string, topLevel: Parameters<typeof patchFuel>[3] = {}) =>
		patchFuel(id, fuel, { claimAttempt: true, claimAttemptAt: Date.now(), claimTxHash: txHash, setupInsufficiency: false }, topLevel)
	return {
		fuelOnRegister,
		onAttempt: () => patchFuel(id, fuel, { claimAttempt: true, claimAttemptAt: Date.now(), setupInsufficiency: false }),
		onTxHash: (txHash: string) => latchHash(txHash),
		...(fuelOnRegister ? { onRegistered: (txHash: string) => latchHash(txHash, { registerTxHash: txHash }) } : {}),
		onFailure: (e: unknown) => {
			// The FPC's insufficiency assert and a message the wallet cannot consume yet both refuse
			// the transaction before it exists, and a dropped transaction was never included: the
			// fuel is provably unspent and a retry is safe. Any OTHER throw leaves setupInsufficiency
			// unset ⇒ the next decision WAITS (fail-closed).
			const msg = e instanceof Error ? e.message : String(e)
			if (isPrivateFuelInsufficiency(msg) || isMsgNotReady(msg) || /\bdropped\b/i.test(msg)) {
				patchFuel(id, fuel, { claimAttempt: true, claimAttemptAt: Date.now(), setupInsufficiency: true })
			}
		},
	}
}

function publicHubFee(rec: FeeLadderRecord, base: SendOpts, resolved: PublicClaimFee): HubClaimFee {
	if (resolved.kind === "stop") return { kind: "stop", why: resolved.why, sendWhy: resolved.sendWhy }
	if (resolved.kind === "fjwc") return { kind: "opts", opts: { ...base, fee: resolved.fee }, ...fjwcLatches(rec.id, rec.fuel) }
	const { fee, registerFee, registeredClaimFee, standalone } = resolved
	const seams = registerFee ? { registerFee, registeredClaimFee } : {}
	return { kind: "opts", opts: { ...base, fee, ...seams }, ...(standalone ? { standalone } : {}) }
}

/**
 * The send options a hub claim carries: the same evidence-driven fee ladder the token-bridge
 * claim uses, resolved without building that claim's interaction. Every mode pays from Fee Juice
 * the user bridged or already holds — the bridged Fee Juice paying for its own claim, the
 * PrivateFPC paying as a third party from a fresh claim or from the credit it kept, or the
 * wallet's own gas. Nothing is ever sponsored, on any network.
 */
export async function resolveHubClaimSendOpts(ctx: {
	rec: FeeLadderRecord
	recipientAddr: AztecAddress
	aztec: unknown
	userOverride: boolean
	/** The gas salt from this record's unsealed envelope, when the claim opened one. */
	sealedSalt?: string
	/** This claim registers the token first (the hub does not know it yet). */
	registers?: boolean
}): Promise<HubClaimFee> {
	const { rec, recipientAddr, aztec, userOverride } = ctx
	const base: SendOpts = { from: recipientAddr, wait: { waitForStatus: TxStatus.PROPOSED } }
	const priv = await resolvePrivateFuelFee(rec, recipientAddr, ctx.sealedSalt, { registers: ctx.registers === true, aztec })
	if (priv.kind === "stop") return { kind: "stop", why: priv.why }
	if (priv.kind === "credit") {
		// Spent fuel pays from the credit it left; a still-unregistered token registers from it too.
		const seams = priv.registers ? { registerFee: priv.registerFee, registeredClaimFee: priv.registeredClaimFee } : {}
		return { kind: "opts", opts: { ...base, fee: priv.fee, ...seams } }
	}
	if (priv.kind === "fee") {
		// The fuel fee consumes the bridged Fee Juice message, which only one transaction can do: on
		// a first-time token the registration goes first and spends it, and the claim that follows
		// draws on the credit the FPC kept; on a registered token the claim spends it directly.
		const seams = priv.registers ? { registerFee: priv.fee, registeredClaimFee: priv.registeredClaimFee } : {}
		return { kind: "opts", opts: { ...base, fee: priv.fee, ...seams }, ...privateLatches(rec.id, priv.fuel, priv.registers) }
	}
	return publicHubFee(rec, base, await resolvePublicClaimFee(rec, recipientAddr, aztec, userOverride, ctx.registers === true))
}

// ── the L1 legs a send performs before its claim ─────────────────────────────

/** The L1 wallet surface those legs need (viem clients passed as-is). */
export interface DepositL1Ctx {
	publicClient: RecoveryL1Client & {
		readContract: (args: unknown) => Promise<unknown>
		waitForTransactionReceipt: (args: { hash: `0x${string}`; timeout?: number }) => Promise<unknown>
	}
	wallet: {
		signMessage: (args: unknown) => Promise<unknown>
		signTypedData: (args: unknown) => Promise<unknown>
		writeContract: (args: unknown) => Promise<unknown>
	}
	from: string
}

/** Trust-aware seal of the bearer secret + metadata BEFORE the first L1 tx (1 signature
 *  steady-state, 2 on a wallet's first private bridge), with a write-and-verify of the
 *  envelope patch: the record was created pre-seal, so a silent storage failure here would
 *  leave a private record without its only recovery blob. */
export async function sealPrivateRecord(ctx: {
	id: string
	secretStr: string
	/** The gas leg's own salt, when the send bought gas. The PrivateFPC re-derives the Fee Juice
	 *  secret from it, and the plaintext journal copy is the only other place it exists — a record
	 *  restored from a file without it can never claim its gas privately. */
	fuelSaltStr?: string
	recipient: string
	tokenAmountStr: string
	from: string
	wallet: DepositL1Ctx["wallet"]
	sealKeys: Map<string, EncryptionKey>
	readBack: () => DepositJournalRecord | undefined
	/** The recovery-key domain: a send binds to ITS token's clone and the hub, so the key is per-token. */
	binding: { chainId: number; portal: string; bridge: string }
}): Promise<void> {
	const { id, secretStr, recipient, tokenAmountStr, from, wallet, sealKeys, readBack, binding } = ctx
	const provider = providerFingerprint()
	const trusted = isSealTrusted(localStorage, NETWORK.l1ChainId, from, provider)
	log(trusted ? "seal: trusted wallet - one signature" : "seal: first private bridge for this wallet - two signatures")
	setRecordStep(
		id,
		"sealing",
		trusted ? "one Ethereum signature — encrypts the recovery secret" : "two Ethereum signatures — encrypt + verify determinism",
	)
	const sign = (m: string) => runOnLane("l1", () => wallet.signMessage({ account: from, message: m } as never) as Promise<string>)
	const envelope = {
		secret: secretStr,
		recipient,
		amount: tokenAmountStr,
		sealerL1: from,
		...(ctx.fuelSaltStr ? { salt: ctx.fuelSaltStr } : {}),
	}
	const { blob, key } = await sealDepositRecord({ sign, binding: { ...binding, secretHashHex: id }, envelope, trusted })
	if (!trusted) markSealTrusted(localStorage, NETWORK.l1ChainId, from, provider)
	sealKeys.set(id, key)
	cacheSecret(id, secretStr, { v: 2, ...envelope })
	updateRecord(id, { sealedEnvelope: blob, sealerL1: from })
	const sealed = readBack()
	if (!sealed?.sealedEnvelope) {
		throw new Error("Could not persist the sealed recovery secret — aborting before the deposit (storage full?).")
	}
}

/** Most ERC-20s start at ZERO Permit2 allowance, so a send must do a one-time approve(Permit2, max)
 *  before the witness transfer; a token that pre-grants Permit2 short-circuits with no transaction.
 *  The approval hash is JOURNALED the moment it exists, so a row that outlives a later failure
 *  carries the allowance it granted. A refusal of the witness deletes the row instead: the max
 *  allowance stands, as it does for every Permit2 user, and no deposit was ever sent. */
export async function ensurePermit2Approval(
	permit2: `0x${string}`,
	needed: bigint,
	recordId: string,
	l1: DepositL1Ctx,
	/** The token being pulled — any ERC-20 the wizard sends. */
	erc20: `0x${string}`,
): Promise<void> {
	await ensurePermit2Allowance({
		allowance: async () =>
			(await l1.publicClient.readContract({
				address: erc20,
				abi: ERC20_ABI,
				functionName: "allowance",
				args: [l1.from, permit2],
			})) as bigint,
		approveMax: async () =>
			(await runOnLane("l1", () =>
				l1.wallet.writeContract({
					address: erc20,
					abi: ERC20_ABI,
					functionName: "approve",
					args: [permit2, (1n << 256n) - 1n],
					chain: NETWORK.viemChain,
					account: l1.from,
				}),
			)) as `0x${string}`,
		waitReceipt: async (hash) =>
			await awaitL1Receipt(l1.publicClient as never, hash, {
				onStillWaiting: (attempt) => setRecordStep(recordId, "approving", `still waiting for the approval (round ${attempt})`),
			}),
		needed,
		onStatus: (status, txHash) => {
			if (status === "approving") setRecordStep(recordId, "approving", "first time only: approve Permit2 in your Ethereum wallet")
			if (status === "waiting" && txHash) updateRecord(recordId, { approveTxHash: txHash })
			if (status === "approved") markApproveOutcome(recordId, "done")
		},
	})
}
