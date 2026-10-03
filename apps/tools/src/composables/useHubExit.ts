/**
 * The exit: burn on Aztec under an authwit the hub consumes, then finish on Ethereum against the
 * TOKEN's own portal clone.
 *
 * The burn happens before the funds are released, so every refusal that can be read runs BEFORE any
 * authwit is spent — the L1 factory's `withdrawsPaused` and the hub's `exits_paused` (pausing only
 * one leaves a window where a burn lands and cannot be finished), the hub's binding, and the
 * balance. The exit's own simulate is NOT among them on the public path: `exit_to_l1_public` burns
 * through `burn_public`, which the Token refuses until the public authwit transaction exists, so
 * there the authwit comes first and the simulate is what proves it took.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import { OutboxContract } from "@aztec-labs/ethereum/contracts"
import { computeL2ToL1MembershipWitness } from "@aztec-labs/stdlib/messaging"
import { TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import {
	type JournalTokenBlock,
	type L1Ctx,
	PORTAL_FACTORY_ABI,
	PRIVATE_FPC_ADDRESS,
	PRIVATE_HUB_EXIT_GAS,
	type SendWithdrawRecord,
	TOKEN_PORTAL_ABI,
	awaitL1Receipt,
	consumeWithdrawal,
	exitViaHub,
	hubAt,
	hubExitsPaused,
	hubTokenFor,
	isOutboxMessageConsumed,
	makeProvisionalWithdrawId,
	preflightHubExit,
	privateFeeJuicePayment,
	privateFpcFeeLimit,
} from "@unleashed/bridge-core"
import { decodeFunctionData } from "viem"
import { type Ref, ref } from "vue"
import { HUB, SEND_GENERATION } from "@/contracts/bridge-generation"
import { clampGas, walletMaxFees } from "@/lib/wallet-fee-budget"
import { NETWORK } from "@/lib/network"
import { webJournalLocks } from "@/lib/journal-locks"
import { PROMPT_WAIT_MS, PROMPTS_STALLED, promptsSettled } from "@/lib/prompt-queue"
import { resolveToolsTarget } from "@/lib/network-targets"
import { findVerifiedExitTx } from "./exit-attach"
import type { ExitPlan } from "@/lib/send-model"
import { normalizeError } from "@/lib/errors"
import { humanizeWalletError, isUserRejection } from "@/lib/wallet-errors"
import {
	type ConsumeOutcome,
	addRecord,
	connectJournalDeps,
	discard,
	flagRecordError,
	markSessionLive,
	attachAndConsume,
	runOnLane,
	setRecordStep,
	updateRecord,
	useBridgeJournal,
} from "./useBridgeJournal"
import { useBridgeWallet } from "./useBridgeWallet"
import { contractsReadinessRefusal, retryOnUnregistered } from "./useWalletConnection"
import { useL1Wallet } from "./useL1Wallet"
import { withOperation } from "./useOpsInFlight"
import { readBalance } from "./useTokenBalance"
import { useTokenGrant } from "./useTokenGrant"
import { readFeeJuiceOrNull, readPrivateFeeJuiceBalance } from "./deposit-flow"
import { assertL1Chain, sendBindingOf, validateTokenBlock } from "./useSend"

// Ids and tx hashes ONLY - amounts, addresses and witnesses never reach this log.
const log = (...args: unknown[]) => console.log("[bridge:exit]", ...args)

const NODE_URL = NETWORK.nodeUrl
const PROVEN_TIMEOUT_SEC = 1800
const ZERO_L1 = "0x0000000000000000000000000000000000000000"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A PUBLIC exit carries no app-set fee: the connected wallet pays its own default. The public
 *  authwit transaction and the public exit both go through this builder, so a fee cannot be
 *  reintroduced on one of them. A PRIVATE exit is the exception, and names its payer explicitly —
 *  see {@link privateExitFee}. Do NOT add a `fee`/`paymentMethod` field here. */
export function buildExitSendOpts(from: AztecAddress) {
	return { from, wait: { waitForStatus: TxStatus.PROPOSED } }
}

/** A private exit's fee payer is the PrivateFPC, paid from the credit the account holds there.
 *  The wallet's own default would name a public payer — the sponsor, or the account itself — under
 *  a transaction whose L2→L1 message states the L1 recipient and amount; the account as payer
 *  links the two. Refused before any authwit exists when the credit is under the committed
 *  ceiling (limits × predicted worst fees; the FPC keeps the whole ceiling). */
export async function privateExitFee(aztec: unknown, from: AztecAddress, approvedCeiling?: bigint) {
	const [credit, maxFees] = await Promise.all([
		readFeeJuiceOrNull("private FJ", () => readPrivateFeeJuiceBalance(aztec, from)),
		walletMaxFees(aztec, from, PRIVATE_HUB_EXIT_GAS).catch(() => null),
	])
	if (maxFees === null) throw new ExitNeedsPrivateGasError("unverifiable")
	const limits = clampGas(PRIVATE_HUB_EXIT_GAS)
	const ceiling = privateFpcFeeLimit(limits, maxFees)
	// The FPC keeps the whole ceiling: a price above what the review showed is a fee nobody approved.
	if (approvedCeiling !== undefined && ceiling > approvedCeiling) throw new ExitNeedsPrivateGasError("repriced")
	if (credit === null) throw new ExitNeedsPrivateGasError("unverifiable")
	if (credit < ceiling) throw new ExitNeedsPrivateGasError(credit === 0n ? "none" : "short")
	return {
		paymentMethod: privateFeeJuicePayment(AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS)),
		gasSettings: {
			gasLimits: limits,
			teardownGasLimits: { daGas: 0, l2Gas: 0 },
			maxFeesPerGas: { feePerDaGas: maxFees.feePerDaGas, feePerL2Gas: maxFees.feePerL2Gas },
			maxFeePerGas: { feePerDaGas: maxFees.feePerDaGas, feePerL2Gas: maxFees.feePerL2Gas },
		},
	}
}

const PRIVATE_EXIT_STOPS = {
	none: "A private withdrawal pays its fee only from private gas, and your account holds none at the fee contract — your wallet's default could name your account as the public fee payer. Bridge gas privately first. Nothing was sent.",
	short: "Your private gas is under what a private withdrawal sets aside at current network fees — retry when fees ease, or bridge more gas privately. Nothing was sent.",
	unverifiable: "Couldn't check your private gas — please try again in a moment. Nothing was sent.",
	repriced: "Aztec's network fees rose past what the review showed for this withdrawal. Review it again. Nothing was sent.",
} as const

export class ExitNeedsPrivateGasError extends Error {
	constructor(readonly reason: keyof typeof PRIVATE_EXIT_STOPS) {
		super(PRIVATE_EXIT_STOPS[reason])
		this.name = "ExitNeedsPrivateGasError"
	}
}

/** The hub has not bound this ERC-20 to an L2 token, so it holds nothing of it to burn. A portal on
 *  Ethereum is not enough: the registration message may exist and never have been consumed. */
export const EXIT_TOKEN_NOT_REGISTERED = "The bridge hasn't registered this token on Aztec yet, so there is nothing here to withdraw."

export class ExitTokenNotRegisteredError extends Error {
	constructor() {
		super(EXIT_TOKEN_NOT_REGISTERED)
		this.name = "ExitTokenNotRegisteredError"
	}
}

export class ExitPausedError extends Error {
	constructor(readonly side: "l1" | "l2") {
		super(
			side === "l1"
				? "Withdrawals to Ethereum are paused right now. Your balance is untouched — try again later."
				: "Exits from Aztec are paused right now. Your balance is untouched — try again later.",
		)
		this.name = "ExitPausedError"
	}
}

function generation() {
	if (!SEND_GENERATION || !HUB) throw new Error("This network has no bridge.")
	return SEND_GENERATION
}

/** The block an exit is bound to. Only a token the HUB has registered can be exited: the burn runs
 *  against the hub's own binding, and without one there is no L2 balance to spend, no ceiling the
 *  wizard could check the amount against, and nothing a resumed exit could validate. */
function exitTokenBlock(plan: ExitPlan): JournalTokenBlock {
	if (plan.token.state.kind !== "registered") throw new ExitTokenNotRegisteredError()
	const reg = plan.token.registration
	if (!reg) throw new Error("This token has no registration on Ethereum yet — there is nothing to withdraw.")
	return {
		erc20: plan.token.address.toLowerCase(),
		portal: plan.token.portal.toLowerCase(),
		l2Token: plan.token.l2Token,
		nameWord: reg.nameWord,
		symbolWord: reg.symbolWord,
		decimals: reg.decimals,
		displaySymbol: plan.token.symbol,
		registerKey: reg.registerKey,
		registerIndex: reg.registerIndex.toString(),
	}
}

let depsWired = false

/** Test-only: let a case re-wire the engine after resetting it. */
export function __resetHubExitDepsForTests(): void {
	depsWired = false
}

/** The attach's search over a node adapter: `getTxEffect` takes a parsed hash, the finder speaks strings. */
function findExitCandidate(rec: SendWithdrawRecord, taken: ReadonlySet<string>) {
	const node = createAztecNodeClient(NODE_URL)
	const target = resolveToolsTarget()
	return findVerifiedExitTx(
		rec,
		{
			getNodeInfo: () => node.getNodeInfo(),
			getBlockNumber: async () => Number(await node.getBlockNumber()),
			getBlocks: (from, limit, options) => node.getBlocks(from as never, limit, options) as never,
			getTxEffect: (hash) => node.getTxEffect(TxHash.fromString(hash)) as never,
		},
		taken,
		{ chainId: target.l1ChainId, rollupVersion: target.rollupVersion },
	)
}

/** Recompute THIS exit's witness - the identity anchor a finish transaction must match. */
async function expectedWitness(l1: ReturnType<typeof useL1Wallet>, exitTxHash: string) {
	const node = createAztecNodeClient(NODE_URL)
	const txHash = TxHash.fromString(exitTxHash)
	const eff = await node.getTxEffect(txHash as never)
	if (!eff) throw new Error("no tx effect for the exit")
	const messageHash = eff.data.l2ToL1Msgs[0]
	if (!messageHash) throw new Error("no L2→L1 message in the exit tx")
	const { l1ContractAddresses } = await node.getNodeInfo()
	const outbox = new OutboxContract(l1.publicClient as never, l1ContractAddresses.outboxAddress)
	const wit = await computeL2ToL1MembershipWitness(node as never, outbox, messageHash, txHash as never, 0)
	if (!wit) throw new Error("L2→L1 witness not available")
	return wit
}

type AztecNode = ReturnType<typeof createAztecNodeClient>
type ExitProgress = (p: { provenBlock?: number; targetBlock?: number }) => void

/** The exit's PROPOSED receipt has no blockNumber; poll the node until it is mined. */
async function awaitExitBlock(node: AztecNode, rec: SendWithdrawRecord, onProgress: ExitProgress) {
	const txHash = TxHash.fromString(rec.exitTxHash as string)
	let receipt = await node.getTxReceipt(txHash).catch(() => undefined)
	for (let i = 0; i < 120 && !receipt?.blockNumber; i++) {
		log(`exit not yet in an L2 block (poll ${i + 1}) - waiting 5s`, rec.id)
		await sleep(5000)
		receipt = await node.getTxReceipt(txHash).catch(() => undefined)
	}
	if (!receipt?.blockNumber) throw new Error("the exit tx never landed in an L2 block — finish it from the journal later")
	onProgress({ targetBlock: Number(receipt.blockNumber) })
	return receipt
}

/** A consume can fail because the message is already gone: `callerOnL1` is the zero address, so ANY
 *  caller may finish this exit, and one that got there first left nothing to send. The Outbox is
 *  asked directly rather than the revert text, which is not ours to depend on; an unreadable answer
 *  is a NO, so the original failure surfaces as itself instead of a false completion. */
async function consumedElsewhere(l1: L1Ctx, node: AztecNode, receipt: { txHash: unknown }): Promise<boolean> {
	try {
		return await isOutboxMessageConsumed(l1, node as never, receipt)
	} catch {
		return false
	}
}

async function runSendConsume(
	l1: ReturnType<typeof useL1Wallet>,
	rec: SendWithdrawRecord,
	onProgress: ExitProgress,
): Promise<ConsumeOutcome> {
	const wallet = l1.ensureWalletClient()
	const account = l1.address.value
	if (!wallet || !account) throw new Error("Connect your Ethereum wallet to finish the withdraw.")
	await assertL1Chain(l1)
	const node = createAztecNodeClient(NODE_URL)
	const receipt = await awaitExitBlock(node, rec, onProgress)
	const pollTimer = setInterval(() => {
		node.getBlockNumber("proven")
			.then((n) => onProgress({ provenBlock: Number(n) }))
			.catch(() => {})
	}, 5000)
	const ctx = { pub: l1.publicClient, wallet, account } as unknown as L1Ctx
	try {
		// The consume runs against THIS token's clone: one portal per ERC-20, and a message from
		// one clone can never be finished on another.
		return await consumeWithdrawal(ctx, node as never, receipt, {
			recipientL1: rec.recipientL1 as `0x${string}`,
			amount: BigInt(rec.amount),
			portal: rec.token.portal as `0x${string}`,
			portalAbi: TOKEN_PORTAL_ABI as never,
			provenTimeoutSec: PROVEN_TIMEOUT_SEC,
			onSent: (hash) => updateRecord(rec.id, { consumeTxHash: hash }),
		})
	} catch (e) {
		if (await consumedElsewhere(ctx, node, receipt)) return { consumedByOther: true }
		throw e
	} finally {
		clearInterval(pollTimer)
	}
}

/** Conservative by construction: an unverifiable finish never marks the record done. */
async function verifySendConsume(l1: ReturnType<typeof useL1Wallet>, rec: SendWithdrawRecord, txHash: string): Promise<boolean> {
	try {
		const tx = await l1.publicClient.getTransaction({ hash: txHash as `0x${string}` })
		if (!tx || tx.to?.toLowerCase() !== rec.token.portal.toLowerCase()) return false
		const decoded = decodeFunctionData({ abi: TOKEN_PORTAL_ABI, data: tx.input })
		if (decoded.functionName !== "withdraw") return false
		const [recipient, amount, , epoch, , leafIndex] = decoded.args as readonly [
			string,
			bigint,
			boolean,
			bigint,
			bigint,
			bigint,
			unknown,
		]
		if (recipient.toLowerCase() !== rec.recipientL1.toLowerCase() || amount !== BigInt(rec.amount)) return false
		// Bind to THIS exit, not just same-recipient-same-amount.
		const wit = await expectedWitness(l1, rec.exitTxHash as string)
		return BigInt(wit.epochNumber) === epoch && BigInt(wit.leafIndex) === leafIndex
	} catch {
		return false
	}
}

/** Wire the send lane's exit-side chain deps (idempotent; real clients only). */
export function ensureHubExitDeps(): void {
	if (depsWired) return
	depsWired = true
	const l1 = useL1Wallet()
	connectJournalDeps({
		// The generation binding + block check are the same on both lanes: an exit resumed from a
		// session that never opened the deposit side still validates against the factory.
		sendBinding: sendBindingOf,
		locks: webJournalLocks(),
		findExitTx: (rec, taken) => findExitCandidate(rec, taken),
		validateTokenBlock: (token) => validateTokenBlock(token, l1),
		consumeSend: (rec, onProgress) => runSendConsume(l1, rec, onProgress),
		verifyConsumeIdentitySend: (rec, txHash) => verifySendConsume(l1, rec, txHash),
		waitConsumeReceipt: async (txHash) => {
			try {
				return (await awaitL1Receipt(l1.publicClient, txHash as `0x${string}`)).status === "success"
			} catch {
				return false
			}
		},
	})
}

/** Both switches, read before anything is authorised. */
async function assertExitsOpen(l1: ReturnType<typeof useL1Wallet>, aztec: unknown, from: string): Promise<void> {
	const paused = (await l1.publicClient.readContract({
		address: generation().factory,
		abi: PORTAL_FACTORY_ABI,
		functionName: "withdrawsPaused",
	})) as boolean
	if (paused) throw new ExitPausedError("l1")
	if (await hubExitsPaused(hubAt(aztec as never, (HUB as AztecAddress).toString()), from)) throw new ExitPausedError("l2")
}

interface ExitCtx {
	aztec: unknown
	/** The session the wallet came from, so a `CONTRACT_NOT_REGISTERED` retry re-registers against it
	 *  and never against a wallet a reconnect swapped in mid-exit. */
	session: ReturnType<typeof useBridgeWallet>
	from: string
	fromAddr: AztecAddress
	plan: ExitPlan
	approvedCeiling?: bigint
	nonce: Fr
	sendOpts: ReturnType<typeof buildExitSendOpts>
	/** The private exit's payer, read in the preflight; a public exit has none. */
	fee?: Awaited<ReturnType<typeof privateExitFee>>
	token: Contract
}

const hubOf = (ctx: ExitCtx) => hubAt(ctx.aztec as never, (HUB as AztecAddress).toString())

type ExitAuth = { authWitnesses?: unknown[] }

/** The off-chain witness a PRIVATE burn is authorized by. Its consumer is the TOKEN, with the hub as
 *  the inner sender, so a witness for one token can never be replayed against another. It costs
 *  nothing until a transaction spends it, which is why the simulate may be handed it. */
async function privateBurnWitness(ctx: ExitCtx): Promise<ExitAuth> {
	const { aztec, fromAddr, plan, nonce, token } = ctx
	const burnAuthwit = await retryOnUnregistered(ctx.session, aztec as Wallet, async () =>
		(aztec as { createAuthWit: (a: AztecAddress, i: unknown) => Promise<unknown> }).createAuthWit(fromAddr, {
			caller: HUB as AztecAddress,
			call: await token.methods.burn_private(fromAddr, plan.amount, nonce).getFunctionCall(),
		}),
	)
	return { authWitnesses: [burnAuthwit] }
}

/** A PUBLIC burn is authorized by an Aztec transaction of its own — which is why every check that
 *  can refuse the exit runs before this is sent. */
async function sendPublicBurnAuthwit(ctx: ExitCtx): Promise<void> {
	const { aztec, fromAddr, plan, nonce, sendOpts, token } = ctx
	const authwit = await SetPublicAuthwitContractInteraction.create(
		aztec as never,
		fromAddr,
		{ caller: HUB as AztecAddress, action: token.methods.burn_public(fromAddr, plan.amount, nonce) } as never,
		true,
	)
	await runOnLane("aztec", () => authwit.send(sendOpts as never))
}

function exitRecord(id: string, plan: ExitPlan, sender: string): SendWithdrawRecord {
	const now = Date.now()
	return {
		schema: 3,
		id,
		direction: "withdraw",
		isPrivate: plan.isPrivate,
		intent: "token",
		token: exitTokenBlock(plan),
		amount: plan.amount.toString(),
		createdAt: now,
		updatedAt: now,
		chainId: NETWORK.l1ChainId,
		portal: plan.token.portal.toLowerCase(),
		bridge: (HUB as AztecAddress).toString(),
		recipientL1: plan.recipientL1,
		sender,
	}
}

const exitParams = (ctx: ExitCtx) => ({
	l2Token: ctx.plan.token.l2Token,
	recipientL1: ctx.plan.recipientL1,
	amount: ctx.plan.amount,
	callerOnL1: ZERO_L1,
	authwitNonce: ctx.nonce,
	isPrivate: ctx.plan.isPrivate,
})

async function submitExit(ctx: ExitCtx, auth: ExitAuth): Promise<{ txHash: unknown; blockNumber?: number }> {
	const opts = { ...ctx.sendOpts, ...auth, ...(ctx.fee ? { fee: ctx.fee } : {}) }
	const sent = (await runOnLane("aztec", () => exitViaHub(hubOf(ctx), exitParams(ctx), opts))) as {
		receipt: { txHash: unknown; blockNumber?: number }
	}
	return sent.receipt
}

/** The hub's LIVE binding, not the wizard's copy of it: a token the hub never registered holds
 *  nothing of this ERC-20 to burn, and one bound to another L2 token would burn the wrong asset. */
async function assertHubBinding(ctx: ExitCtx): Promise<void> {
	const bound = await hubTokenFor(hubOf(ctx), ctx.plan.token.address, ctx.from)
	if (!bound) throw new ExitTokenNotRegisteredError()
	if (bound.toLowerCase() !== ctx.plan.token.l2Token.toLowerCase()) {
		throw new Error("The bridge binds this Ethereum token to a different Aztec token than this screen shows — nothing was sent.")
	}
}

/** The balance the burn spends, read on the side it will be spent from. */
async function assertExitBalance(ctx: ExitCtx): Promise<void> {
	const fn = ctx.plan.isPrivate ? "balance_of_private" : "balance_of_public"
	const held = await readBalance(ctx.aztec as never, ctx.token, fn, ctx.fromAddr)
	if (held < ctx.plan.amount) throw new Error("Your Aztec balance is smaller than this withdrawal — nothing was sent.")
}

/**
 * Everything that can refuse the exit while it is still free: the chain the generation's addresses
 * live on, both pause switches, the hub's binding, the balance, and — for a private exit — the
 * private gas its fee is paid from. A PUBLIC burn's authorization is an Aztec TRANSACTION, so
 * these have to answer BEFORE it — the exit's own simulate cannot, because the Token refuses
 * `burn_public` until that authwit exists.
 */
async function readOnlyPreflight(ctx: ExitCtx, l1: ReturnType<typeof useL1Wallet>): Promise<void> {
	await assertL1Chain(l1)
	await assertExitsOpen(l1, ctx.aztec, ctx.from)
	await assertHubBinding(ctx)
	await assertExitBalance(ctx)
	if (ctx.plan.isPrivate) ctx.fee = await privateExitFee(ctx.aztec, ctx.fromAddr, ctx.approvedCeiling)
}

/**
 * The authorization, in the order the chain forces. A PRIVATE burn is authorized by an off-chain
 * witness, which costs nothing until a transaction spends it — so its simulate runs first and the
 * record is opened only once the exit is about to be sent. A PUBLIC burn is authorized by a
 * transaction of its own, so the record is opened before that transaction and the simulate runs
 * after it: the same call rejected as unauthorized beforehand is what confirms the authwit took.
 */
async function authorizeExit(ctx: ExitCtx, open: () => void): Promise<ExitAuth> {
	// preflightHubExit only simulates (`hub-l2.ts`), so a `CONTRACT_NOT_REGISTERED` from it is safe to
	// re-register-and-retry once even on the public path, after the authwit transaction has landed.
	if (ctx.plan.isPrivate) {
		const auth = await privateBurnWitness(ctx)
		await retryOnUnregistered(ctx.session, ctx.aztec as Wallet, () =>
			preflightHubExit(hubOf(ctx), exitParams(ctx), ctx.from, { ...auth, ...(ctx.fee ? { fee: ctx.fee } : {}) }),
		)
		open()
		return auth
	}
	open()
	await sendPublicBurnAuthwit(ctx)
	await retryOnUnregistered(ctx.session, ctx.aztec as Wallet, () => preflightHubExit(hubOf(ctx), exitParams(ctx), ctx.from))
	return {}
}

export interface HubExitComposable {
	/** The record id, or "" when the exit was refused before anything was authorised (see `error`).
	 *  `approvedCeiling`: the private gas the review showed set aside; a higher price at send refuses. */
	exit(plan: ExitPlan, approvedCeiling?: bigint): Promise<string>
	busy: Ref<boolean>
	error: Ref<string | null>
	/** Which side refused the exit before anything was authorised — a state the user waits out, not a failure. */
	paused: Ref<"l1" | "l2" | null>
	dispose(): void
}

interface ExitDeps {
	l1: ReturnType<typeof useL1Wallet>
	bridgeWallet: ReturnType<typeof useBridgeWallet>
	journal: ReturnType<typeof useBridgeJournal>
	busy: Ref<boolean>
	error: Ref<string | null>
	paused: Ref<"l1" | "l2" | null>
}

/** The row every exit leg narrates into, opened at the last moment before the first chain write. */
function openExitRecord(base: SendWithdrawRecord, isPrivate: boolean): void {
	addRecord(base)
	markSessionLive(base.id)
	setRecordStep(
		base.id,
		"exiting",
		isPrivate ? "confirm the exit in your Aztec wallet" : "two Aztec signatures: the authorization, then the exit",
	)
}

/** The grant is raised when the token is picked; a wallet that declined it, or a newer selection
 *  that replaced it, must refuse here rather than at the authwit. */
export const EXIT_NOT_GRANTED = "Your wallet hasn't granted access to this token — pick it again to request access. Nothing was sent."

/** The pre-exit refusals that do not depend on the Aztec wallet handle, in order: L1 connected,
 *  token granted, then the app's contracts registered (the setup-pending window). */
function exitGuardRefusal(plan: ExitPlan, d: ExitDeps): string | undefined {
	if (!d.l1.address.value) return "Connect your Ethereum wallet first."
	if (!useTokenGrant().isGranted(plan.token.l2Token)) return EXIT_NOT_GRANTED
	return contractsReadinessRefusal(d.bridgeWallet)
}

async function performExit(plan: ExitPlan, d: ExitDeps, approvedCeiling?: bigint): Promise<string> {
	d.error.value = null
	// A re-grant still queued holds the contracts unregistered until it lands: its outcome decides, not the press.
	if (!(await promptsSettled(PROMPT_WAIT_MS))) return failWith(d.error, PROMPTS_STALLED)
	const aztec = d.bridgeWallet.wallet.value
	const from = d.bridgeWallet.selectedAccount.value
	if (!aztec || !from) return failWith(d.error, "Connect your Aztec wallet first.")
	const refusal = exitGuardRefusal(plan, d)
	if (refusal) return failWith(d.error, refusal)
	d.busy.value = true
	const provisionalId = makeProvisionalWithdrawId()
	let finalId = provisionalId
	try {
		const ctx: ExitCtx = {
			aztec,
			session: d.bridgeWallet,
			from,
			fromAddr: AztecAddress.fromStringUnsafe(from),
			plan,
			approvedCeiling,
			nonce: Fr.random(),
			sendOpts: buildExitSendOpts(AztecAddress.fromStringUnsafe(from)),
			token: await Contract.at(AztecAddress.fromStringUnsafe(plan.token.l2Token), TokenContractArtifact, aztec as never),
		}
		const base = exitRecord(provisionalId, plan, from)
		await readOnlyPreflight(ctx, d.l1)
		const auth = await authorizeExit(ctx, () => openExitRecord(base, plan.isPrivate))
		const receipt = await submitExit(ctx, auth)
		finalId = String(receipt.txHash)
		setRecordStep(provisionalId, undefined, undefined) // the engine narrates from here
		// The same handoff an attach uses, so a live exit and a concurrent attach of this hash contend
		// on the hash's lock and exactly one consumes. The provisional record is dropped only once the
		// hash IS a record (another tab attached it first); contention alone proves nothing, and the
		// provisional copy stays attachable.
		const outcome = await attachAndConsume(
			provisionalId,
			{ ...base, id: finalId, exitTxHash: finalId, exitBlock: receipt.blockNumber, updatedAt: Date.now() },
			(_live, all) => !all.some((r) => r.id === finalId),
		)
		if (outcome !== "attached") {
			log("exit handoff not taken:", outcome)
			if (d.journal.records.value.some((r) => r.id === finalId)) discard(provisionalId)
			else {
				// The provisional record is what survives; the wizard follows it, not the absent hash.
				finalId = provisionalId
				flagRecordError(
					provisionalId,
					outcome === "moved"
						? "This exit's record changed while it was sent — press Finish to look for it on Aztec."
						: "Another tab is finishing this exit — try again in a moment.",
				)
			}
		}
	} catch (e) {
		handleExitFailure(e, { provisionalId, finalId }, d)
	} finally {
		d.busy.value = false
	}
	return finalId === provisionalId && !d.journal.records.value.some((r) => r.id === provisionalId) ? "" : finalId
}

const failWith = (error: Ref<string | null>, message: string): string => {
	error.value = message
	return ""
}

/** The two structured envelope categories get their own copy; everything else keeps today's path
 *  (a confirmation-window timeout translated, unknowns passed through). */
function exitFailureCopy(e: unknown): string {
	const n = normalizeError(e)
	if (n.category === "contract-not-registered" || n.category === "chain-desync") return n.message
	return humanizeWalletError(e instanceof Error ? e.message : "Withdraw failed")
}

/** Only an EXPLICIT rejection before the exit transaction discards the record; every ambiguous
 *  failure keeps it, because a burn that may have landed must stay finishable. */
function handleExitFailure(e: unknown, ids: { provisionalId: string; finalId: string }, d: ExitDeps): void {
	log("FAILED:", e instanceof Error ? e.name : "unknown")
	if (e instanceof ExitPausedError) {
		d.paused.value = e.side
		discard(ids.provisionalId)
		return
	}
	if (e instanceof ExitNeedsPrivateGasError) {
		d.error.value = e.message
		discard(ids.provisionalId)
		return
	}
	const msg = exitFailureCopy(e)
	d.error.value = msg
	const rec = d.journal.records.value.find((r) => r.id === ids.finalId) as SendWithdrawRecord | undefined
	if (rec && !rec.exitTxHash && isUserRejection(e)) {
		discard(ids.provisionalId)
		d.error.value = "Rejected in your wallet — nothing was sent."
	} else if (rec) {
		flagRecordError(ids.finalId, `${msg}. If the exit never reached Aztec, nothing left your balance.`)
	}
}

export function useHubExit(): HubExitComposable {
	ensureHubExitDeps()
	const busy = ref(false)
	const error = ref<string | null>(null)
	const paused = ref<"l1" | "l2" | null>(null)
	const deps: ExitDeps = { l1: useL1Wallet(), bridgeWallet: useBridgeWallet(), journal: useBridgeJournal(), busy, error, paused }
	let disposed = false

	return {
		exit: (plan: ExitPlan, approvedCeiling?: bigint) => {
			paused.value = null
			return disposed ? Promise.resolve("") : withOperation(() => performExit(plan, deps, approvedCeiling))
		},
		busy,
		error,
		paused,
		dispose: () => {
			disposed = true
		},
	}
}
