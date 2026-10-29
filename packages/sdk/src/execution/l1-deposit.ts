/**
 * The Ethereum leg every deposit shares, in the order nothing can be lost: the line gate, the wallet's chain, the
 * pause and a fresh quote are checked before any prompt; the secrets are drawn and the record persisted before the
 * first prompt; each transaction hash is persisted before its event, and no abort is honoured between a send and
 * that persist.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Account, Address, Chain, Hex, WalletClient } from "viem"
import { BridgeError, isUserRejection, refusal, type Submission } from "../errors.ts"
import { type Emit, eventEmitter, type Leaves } from "../events.ts"
import { assertNetwork, type Network, type Reads } from "../network.ts"
import { aztecLineOf } from "../protocol/aztec-line.ts"
import { ERC20_ABI } from "../protocol/erc20.ts"
import { PORTAL_FACTORY_ABI } from "../protocol/factory-abi.ts"
import { feeJuiceAddress } from "../protocol/fee-juice.ts"
import { ensurePermit2Allowance, PERMIT_DEADLINE_SECONDS } from "../protocol/l1.ts"
import { deriveBridgeSecret } from "../protocol/private-fuel.ts"
import { randomField } from "../protocol/random-field.ts"
import type { DepositRecord, JournalTokenBlock } from "../records.ts"
import { checkAbort, type DepositSecrets, persistOr, type RunOptions, untilAborted } from "../run.ts"
import type { L1Ctx } from "./flows.ts"
import { swapDataFor } from "./fuel-venue.ts"
import { awaitL1Receipt } from "./l1-receipt.ts"
import {
	confirmSend,
	estimateSend,
	type FuelRoute,
	type PreparedSend,
	prepareSend,
	readSendInbox,
	type SendParams,
	type SendResult,
	signSend,
	writeSend,
} from "./send-flow.ts"

/** What a reviewed quote commits the leg to. */
export interface DepositPlan {
	intent: "token" | "token+gas" | "gas"
	token: Address
	/** The total Permit2 pulls: the token leg plus the gas slice. */
	amount: bigint
	recipient: string
	isPrivate: boolean
	gas?: { fuelAmount: bigint; minFuelOutput: bigint }
	/** Token intents: the preview the record carries until the receipt's frozen registration replaces it. */
	tokenBlock?: JournalTokenBlock
	/** The hub has not registered the token yet: the first claim registers it. */
	registers?: boolean
}

interface Leg {
	net: Network
	r: Reads
	l1: L1Ctx
	route: FuelRoute
	run: RunOptions
	record: DepositRecord
	/** Handed to every persist, so a store that keeps the latest `(record, secrets)` pair never loses them. */
	secrets: DepositSecrets | undefined
	emit: Emit
}

const UINT256_MAX = (1n << 256n) - 1n

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function accountOf(wallet: WalletClient): Promise<Account> {
	if (wallet.account) return wallet.account
	const [address] = await wallet.getAddresses()
	if (!address) throw refusal("invalid-request", "the Ethereum wallet exposes no account", "safe")
	return { address, type: "json-rpc" } as Account
}

async function assertWalletChain(wallet: WalletClient, net: Network, submission: Submission = "none"): Promise<void> {
	const live = await wallet.getChainId()
	if (live === net.l1ChainId) return
	throw new BridgeError("wrong-chain", `the Ethereum wallet is on chain ${live}, not ${net.l1ChainId}`, submission, "safe")
}

/** The chain viem asserts the wallet is on when it sends: the network's, never whatever the wallet reports. */
const chainOf = (net: Network): Chain => ({
	id: net.l1ChainId,
	name: net.name,
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: { default: { http: [] } },
})

/** Refuses (`paused`, nothing sent) when the contract gating `intent`'s deposits has them paused: the factory, or the
 *  fuel gate on a network without a token bridge. A failed read throws as the read failed. */
export async function assertDepositsOpen(net: Network, r: Reads, intent: DepositPlan["intent"]): Promise<void> {
	const gate = (intent === "gas" ? (net.bridge?.factory ?? net.manifest.fuelRoute?.gate) : net.bridge?.factory) as Address
	const paused = await r.l1.readContract({ address: gate, abi: PORTAL_FACTORY_ABI, functionName: "depositsPaused" })
	if (paused) throw refusal("paused", `deposits on ${net.name} are paused`, "after-wait")
}

function routeOf(net: Network, intent: DepositPlan["intent"]): FuelRoute {
	if (intent === "gas") return net.fuel
	if (!net.bridge) throw refusal("invalid-request", `${net.name} has no token bridge`)
	return net.bridge
}

function randomNonce(): bigint {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	return BigInt(`0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`)
}

/** The router's params, and the salts a private leg is claimed with. The deadline is stamped at the signature
 *  (`withDeadline`); until then it is zero, which Permit2 refuses. */
function paramsOf(net: Network, plan: DepositPlan, swapData: Hex): { params: SendParams; secrets: DepositSecrets } {
	const claimer = AztecAddress.fromStringUnsafe(plan.recipient)
	const claimSalt = plan.isPrivate && plan.intent !== "gas" ? randomField() : undefined
	const fuelSalt = plan.isPrivate && plan.gas ? randomField() : undefined
	const gas = plan.gas && {
		fuelAmount: plan.gas.fuelAmount,
		fuelRecipient: (plan.isPrivate ? net.privateFpc : plan.recipient) as Hex,
		minFuelOutput: plan.gas.minFuelOutput,
		swapData,
		...(fuelSalt ? { fuelSecret: deriveBridgeSecret(fuelSalt, claimer) } : {}),
	}
	const params: SendParams = {
		intent: plan.intent,
		erc20: plan.token,
		amount: plan.amount,
		aztecRecipient: plan.recipient as Hex,
		isPrivate: plan.isPrivate,
		...(claimSalt ? { claimSalt } : {}),
		...(gas ? { gas } : {}),
		nonce: randomNonce(),
		deadline: 0n,
	}
	return { params, secrets: { ...(claimSalt ? { claimSalt } : {}), ...(fuelSalt ? { fuelSalt } : {}) } }
}

function fuelBlockOf(net: Network, plan: DepositPlan, s: PreparedSend): DepositRecord["fuel"] {
	if (!plan.gas || !s.fuel) return undefined
	return {
		amount: plan.gas.fuelAmount.toString(),
		...(plan.isPrivate ? { fpc: net.privateFpc } : { secret: s.fuel.secret.toString() }),
		secretHashHex: s.fuel.secretHash,
		minOutput: plan.gas.minFuelOutput.toString(),
	}
}

function recordOf(net: Network, plan: DepositPlan, s: PreparedSend, sender: Address): DepositRecord {
	const id = s.tok?.secretHash ?? s.fuel?.secretHash
	if (!id) throw new Error("a prepared send carries no secret hash")
	const now = Date.now()
	const gasOnly = plan.intent === "gas"
	const fuel = fuelBlockOf(net, plan, s)
	const base = {
		schema: 3 as const,
		id,
		direction: "deposit" as const,
		isPrivate: plan.isPrivate,
		amount: (plan.amount - (gasOnly ? 0n : (plan.gas?.fuelAmount ?? 0n))).toString(),
		createdAt: now,
		updatedAt: now,
		chainId: net.l1ChainId,
		portal: gasOnly ? net.fuel.feeJuicePortal.toLowerCase() : (plan.tokenBlock?.portal ?? ""),
		bridge: gasOnly ? feeJuiceAddress : (net.bridge?.hub ?? ""),
		recipient: plan.recipient,
		sender,
		...(!plan.isPrivate && s.tok ? { secret: s.tok.claimValue.toString() } : {}),
		secretHashHex: id,
		...(fuel ? { fuel } : {}),
		...(plan.registers ? { registers: true as const } : {}),
	}
	if (gasOnly) return { ...base, intent: "gas" }
	if (!plan.tokenBlock) throw new Error("a token deposit needs its token block")
	return { ...base, intent: plan.intent as "token" | "token+gas", token: plan.tokenBlock }
}

async function persistStep(leg: Leg, patch: Partial<DepositRecord>, submission: Submission): Promise<void> {
	leg.record = { ...leg.record, ...patch, updatedAt: Date.now() } as DepositRecord
	await persistOr(leg.run, leg.record, submission, leg.secrets)
}

/** The one-time `approve(Permit2, max)` when the allowance is short: its hash persisted, then reported. */
async function approve(leg: Leg, token: Address, needed: bigint): Promise<void> {
	const { l1, run } = leg
	const allowance = async () =>
		(await l1.pub.readContract({
			address: token,
			abi: ERC20_ABI,
			functionName: "allowance",
			args: [l1.account.address, leg.route.permit2],
		})) as bigint
	const approveMax = async (): Promise<Hex> => {
		let hash: Hex
		try {
			hash = await l1.wallet.writeContract({
				address: token,
				abi: ERC20_ABI,
				functionName: "approve",
				args: [leg.route.permit2, UINT256_MAX],
				account: l1.account,
				chain: chainOf(leg.net),
			})
		} catch (e) {
			if (isUserRejection(e)) throw refusal("user-rejected", "the approval was refused", "safe", e)
			throw new BridgeError("approval-failed", `the Permit2 approval could not be sent: ${messageOf(e)}`, "unknown", "safe", {
				cause: e,
			})
		}
		await persistStep(leg, { approveTxHash: hash }, "none")
		leg.emit({ type: "approval", status: "sent", txHash: hash })
		return hash
	}
	const waitReceipt = (hash: Hex) =>
		untilAborted(
			awaitL1Receipt(l1.pub as never, hash, {
				onStillWaiting: (round) => leg.emit({ type: "approval", status: "waiting", txHash: hash, round }),
			}),
			run,
			"none",
		) as Promise<{ status?: string }>
	const onStatus = (status: string) => {
		if (status === "approving") leg.emit({ type: "approval", status: "requested" })
	}
	let done: { txHash?: Hex }
	try {
		done = await ensurePermit2Allowance({ allowance, approveMax, waitReceipt, needed, onStatus })
	} catch (e) {
		if (e instanceof BridgeError) throw e
		// A reverted approval means the token refuses Permit2, which no retry changes. One not yet confirmed, or an
		// allowance read that lags it, moved nothing either; the next call reads the allowance again.
		const refused = /approval reverted/i.test(messageOf(e))
		throw new BridgeError("approval-failed", messageOf(e), "none", refused ? "never" : "after-wait", { cause: e })
	}
	if (done.txHash) leg.emit({ type: "approval", status: "confirmed", txHash: done.txHash })
}

function leavesOf(res: SendResult): Leaves {
	return {
		...(res.tokenLeafIndex !== undefined && res.tokenMessageHashHex
			? { token: { leafIndex: res.tokenLeafIndex, messageHash: res.tokenMessageHashHex } }
			: {}),
		...(res.fuelLeafIndex !== undefined && res.fuelMessageHashHex
			? { fuel: { leafIndex: res.fuelLeafIndex, messageHash: res.fuelMessageHashHex, received: res.fuelReceived ?? 0n } }
			: {}),
	}
}

function confirmedPatch(leg: Leg, res: SendResult, l2Block: number | undefined): Partial<DepositRecord> {
	const fuel =
		leg.record.fuel && res.fuelLeafIndex !== undefined
			? {
					...leg.record.fuel,
					leafIndex: res.fuelLeafIndex.toString(),
					messageHash: res.fuelMessageHashHex,
					received: res.fuelReceived?.toString(),
				}
			: leg.record.fuel
	return {
		...(res.tokenLeafIndex !== undefined ? { leafIndex: res.tokenLeafIndex.toString(), messageHash: res.tokenMessageHashHex } : {}),
		...(res.token ? { token: res.token, portal: res.token.portal } : {}),
		...(fuel ? { fuel } : {}),
		...(l2Block !== undefined ? { depositL2Block: l2Block } : {}),
	} as Partial<DepositRecord>
}

/** The Permit2 window opens at the signature, on the chain's clock (the one Permit2 reads): a deadline drawn before
 *  the caller's persist and a slow approval could pass before the witness is even signed. */
async function withDeadline(r: Reads, s: PreparedSend): Promise<PreparedSend> {
	const block = await r.l1.getBlock()
	return { ...s, params: { ...s.params, deadline: block.timestamp + PERMIT_DEADLINE_SECONDS } }
}

async function sendDeposit(leg: Leg, prepared: PreparedSend, wallet: WalletClient): Promise<Hex> {
	await assertWalletChain(wallet, leg.net)
	const s = await withDeadline(leg.r, prepared)
	checkAbort(leg.run, "none")
	leg.emit({ type: "signature-requested" })
	let signature: Hex
	try {
		signature = await signSend(leg.l1, leg.route, s)
	} catch (e) {
		// Nothing was signed: a wallet that failed here moved nothing, and the next call signs afresh.
		throw isUserRejection(e)
			? refusal("user-rejected", "the deposit signature was refused", "safe", e)
			: refusal("invalid-request", `the wallet did not sign the deposit: ${messageOf(e)}`, "safe", e)
	}
	let estimate: bigint
	try {
		estimate = await estimateSend(leg.l1, leg.route, s, signature)
	} catch (e) {
		// A simulated revert (an expired permit, a quote the venue no longer honours) sends nothing; the next call
		// quotes and signs again.
		throw refusal("deposit-reverted", `the deposit would revert: ${messageOf(e)}`, "safe", e)
	}
	try {
		return await writeSend(leg.l1, leg.route, s, signature, estimate, chainOf(leg.net))
	} catch (e) {
		if (isUserRejection(e)) throw refusal("user-rejected", "the deposit transaction was refused", "safe", e)
		throw new BridgeError("deposit-reverted", `the deposit could not be sent: ${messageOf(e)}`, "unknown", "never", { cause: e })
	}
}

/** Once the deposit's hash is stored a second deposit call would move the funds again: every failure from here says
 *  never, and the claim entry recovers the rest from the receipt. */
const RESUME = "claimFuel or claimToken recovers it from the receipt"

async function awaitDeposit(leg: Leg, txHash: Hex): Promise<{ status: string; logs: never }> {
	try {
		return (await untilAborted(awaitL1Receipt(leg.l1.pub as never, txHash), leg.run, "submitted")) as never
	} catch (e) {
		const reverted = e instanceof Error && /reverted on-chain/.test(e.message)
		if (reverted)
			throw new BridgeError("deposit-reverted", `the deposit ${txHash} reverted; nothing moved`, "submitted", "safe", { cause: e })
		const code = e instanceof BridgeError ? e.code : "receipt-timeout"
		throw new BridgeError(code, `the deposit ${txHash} is not confirmed yet; ${RESUME}`, "submitted", "never", { cause: e })
	}
}

async function confirmDeposit(leg: Leg, s: PreparedSend, txHash: Hex): Promise<void> {
	const receipt = await awaitDeposit(leg, txHash)
	let inbox: Awaited<ReturnType<typeof readSendInbox>>
	try {
		inbox = await readSendInbox(leg.l1.pub, leg.route)
	} catch (e) {
		throw new BridgeError(
			"read-failed",
			`the deposit ${txHash} landed but its Inbox could not be read; ${RESUME}`,
			"submitted",
			"never",
			{
				cause: e,
			},
		)
	}
	let res: SendResult
	try {
		res = await confirmSend(leg.l1, leg.route, s, txHash, receipt, inbox)
	} catch (e) {
		throw new BridgeError(
			"receipt-mismatch",
			`the deposit ${txHash} could not be matched to this transfer; ${RESUME}`,
			"submitted",
			"never",
			{
				cause: e,
			},
		)
	}
	const l2Block = await leg.r.aztecNode.getBlockNumber().catch(() => undefined)
	await persistStep(leg, confirmedPatch(leg, res, l2Block === undefined ? undefined : Number(l2Block)), "submitted")
	leg.emit({ type: "deposit-confirmed", leaves: leavesOf(res) })
}

/** Runs the Ethereum leg of a reviewed deposit; resolves with the confirmed record. */
export async function depositL1(net: Network, r: Reads, wallet: WalletClient, plan: DepositPlan, run: RunOptions): Promise<DepositRecord> {
	assertNetwork(net)
	if (!aztecLineOf(net.l1ChainId).supported) throw refusal("unsupported-line", `this release does not run ${net.name}'s Aztec line`)
	const route = routeOf(net, plan.intent)
	const account = await accountOf(wallet)
	await assertWalletChain(wallet, net)
	await assertDepositsOpen(net, r, plan.intent)
	const swapData = plan.gas ? await swapDataFor(net, r, plan.token, plan.gas.fuelAmount, plan.gas.minFuelOutput) : "0x"
	const { params, secrets } = paramsOf(net, plan, swapData)
	let s: PreparedSend
	try {
		s = await prepareSend(route, params)
	} catch (e) {
		throw refusal("invalid-request", messageOf(e), "never", e)
	}
	const l1: L1Ctx = { pub: r.l1, wallet, account }
	const record = recordOf(net, plan, s, account.address)
	const leg: Leg = { net, r, l1, route, run, record, secrets, emit: eventEmitter(record.id, run.onEvent) }
	checkAbort(run, "none")
	await persistOr(run, record, "none", secrets)
	leg.emit({ type: "prepared" })
	await approve(leg, plan.token, plan.amount)
	const txHash = await sendDeposit(leg, s, wallet)
	await persistStep(leg, { depositTxHash: txHash }, "submitted")
	leg.emit({ type: "deposit-sent", txHash })
	await confirmDeposit(leg, s, txHash)
	return leg.record
}
