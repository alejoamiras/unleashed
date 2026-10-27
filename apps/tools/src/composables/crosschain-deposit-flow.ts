/**
 * Sends a quoted cross-chain route. Journal first: the schema-4 record (route, claim material, the amount net
 * of the gas slice) is written and read back, and a private one's v3 envelope sealed, before any source-chain
 * signature. Then on the source chain: the wallet's chain and account asserted, the route verified again,
 * exactly the input approved, and the LI.FI transaction sent, or one atomic batch where the wallet offers it.
 * Every hash the wallet returns, approvals included, or the batch id, is journaled at once; once the deposit's
 * is, discovery decides.
 */
import {
	type CrossChainDepositRecord,
	crossChainAmountWindow,
	ERC20_ABI,
	type EncryptionKey,
	isSealTrusted,
	markSealTrusted,
	sealCrossChainDepositRecord,
	verifyRoute,
} from "@unleashed/bridge-core"
import { type Address, type Chain, encodeFunctionData, type Hex, type PublicClient, type WalletClient } from "viem"
import { approvalConfirmedLine } from "@/lib/crosschain-steps"
import { NETWORK } from "@/lib/network"
import type { ResolvedToken, SendPlan } from "@/lib/send-model"
import { buildSendRecord, sealBindingOf } from "@/lib/send-record"
import { humanizeWalletError, isUserRejection } from "@/lib/wallet-errors"
import { appDiscoveryContext, type CrossChainWatchDeps, watchCrossChain } from "./crosschain-watch"
import { providerFingerprint } from "./deposit-flow"
import {
	addCrossChainRecordVerified,
	currentCrossChainRecord,
	discard,
	flagRecordError,
	logRecordLine,
	markApproveOutcome,
	markSessionLive,
	runDepositClaim,
	runOnLane,
	setRecordStep,
	updateCrossChainRecord,
} from "./useBridgeJournal"
import { type CrossChainAsk, type CrossChainRoute, ROUTE_TTL_MS, routeRecordId } from "./useCrossChainRoute"
import { discoveryReadsFor } from "./useEthereumReader"
import { withOperation } from "./useOpsInFlight"

const log = (...args: unknown[]) => console.log("[bridge:crosschain]", ...args)

export const ROUTE_EXPIRED = "This route's price is more than a minute old — review it again. Nothing was sent."
export const ROUTE_REFUSED = "This route failed its safety check, so the deposit was not sent."
export const ACCOUNT_SWITCHED = "Your Ethereum wallet switched accounts since this route was priced — review it again. Nothing was sent."

export interface CrossChainSend {
	ask: CrossChainAsk
	route: CrossChainRoute
	/** The manifest token the rail delivers, resolved as the Ethereum-origin wizard resolves it. */
	token: ResolvedToken
	/** When the route landed: one older than `ROUTE_TTL_MS` is quoted again, never signed. */
	quotedAt: number
}

export interface SourceCall {
	to: Address
	data: Hex
	value: bigint
}

/** The connected wallet, on whatever chain it is on now. */
export interface CrossChainWallet {
	/** The account this wallet signs as, fixed when it was built. */
	account: Address
	/** The account the wallet answers as now (EIP-1193 `eth_accounts`, which never prompts). */
	liveAccount(): Promise<Address | undefined>
	chainId(): Promise<number>
	signMessage(message: string): Promise<Hex>
	sendTransaction(call: SourceCall): Promise<Hex>
	/** EIP-5792, where the wallet speaks it. */
	batch?: {
		atomic(chainId: number): Promise<boolean>
		send(calls: readonly SourceCall[]): Promise<string>
		/** The hashes of the batch's receipts; empty until the wallet reports them. */
		receipts(id: string): Promise<readonly Hex[]>
	}
}

/** Wallet-free reads: the source chain's allowance, receipts and head, and Ethereum's head. */
export interface CrossChainReads {
	source: Pick<PublicClient, "readContract" | "call" | "getBlockNumber" | "waitForTransactionReceipt">
	ethereum: Pick<PublicClient, "getBlockNumber">
}

export interface CrossChainSendOptions {
	now?: () => number
	wait?: (ms: number) => Promise<void>
	/** Polls of a batch's receipts before discovery is left to find its transaction. */
	batchPolls?: number
	/** Who watches the sent record; `false` leaves it unwatched until the next resume. */
	watch?: CrossChainWatchDeps | false
}

/** Seal keys of this session's private sends: a deposit found while the key is still here is re-sealed exact
 *  without another signature. */
const sealKeys = new Map<string, EncryptionKey>()
/** Records whose approval the wallet was asked for and never answered: it may have broadcast it all the same. */
const approvalsUnanswered = new Set<string>()

export function crossChainSealKey(id: string): EncryptionKey | undefined {
	return sealKeys.get(id)
}

/** The watcher this build runs: its own pins and read clients, and the claim of what this session sent. */
export function appWatchDeps(): CrossChainWatchDeps {
	return {
		context: appDiscoveryContext,
		reads: (rec) => discoveryReadsFor(rec.route.srcChainId),
		sealKey: crossChainSealKey,
		claim: (id) => void runDepositClaim(id),
		now: Date.now,
		wait: (ms) => new Promise((r) => setTimeout(r, ms)),
	}
}

/** The schema-4 record: the schema-3 deposit facts at the floor the route guarantees, and the source leg. */
export function crossChainRecordOf(s: CrossChainSend, heads: { source: bigint; ethereum: bigint }): CrossChainDepositRecord {
	const { ask, route } = s
	const plan: SendPlan = {
		direction: "l1-to-l2",
		intent: ask.intent,
		token: s.token,
		amount: route.minReceived,
		isPrivate: ask.isPrivate,
		...(route.gas
			? {
					gas: {
						fuelAmount: route.gas.fuelAmount,
						fuelFj: 0n,
						quote: route.gas.expectedOut,
						minFuelOutput: route.gas.minFuelOutput,
						venue: route.gas.venue,
						capped: null,
					},
				}
			: {}),
	}
	const fuel = route.secrets.fuel
	const base = buildSendRecord({
		id: routeRecordId(route.secrets),
		plan,
		recipient: ask.recipient,
		sender: ask.user,
		claimValueHex: route.secrets.tokenClaimValue?.toString(),
		fuelSecretHex: fuel?.secret.toString(),
		fuelSecretHashHex: fuel?.secretHash,
		fuelSalt: fuel?.bridgeSalt,
	})
	return {
		...base,
		schema: 4,
		route: {
			provider: "lifi",
			rail: "acrossV4",
			srcChainId: ask.srcChainId,
			srcToken: ask.srcToken.address,
			srcAmount: ask.srcAmount.toString(),
			srcSender: ask.user,
			srcScanFromBlock: heads.source.toString(),
			lifiTxId: route.lifiTxId,
			router: route.x.router,
			minReceived: route.minReceived.toString(),
			maxPull: route.maxPull.toString(),
			scanFromBlock: heads.ethereum.toString(),
			etaSeconds: route.etaSeconds,
			fillDeadline: route.fillDeadline,
			...(route.terms === "fixed" ? { terms: "fixed" } : {}),
		},
	} as CrossChainDepositRecord
}

const sameAddress = (a: string | undefined, b: string): boolean => a?.toLowerCase() === b.toLowerCase()

/** Read from the wallet itself: the client the send was handed keeps the account it was built with after the
 *  user switches. */
async function assertAccount(wallet: CrossChainWallet, ask: CrossChainAsk): Promise<void> {
	if (!sameAddress(wallet.account, ask.user) || !sameAddress(await wallet.liveAccount(), ask.user)) {
		throw new Error(ACCOUNT_SWITCHED)
	}
}

function assertFresh(s: CrossChainSend, o: CrossChainSendOptions): void {
	if ((o.now ?? Date.now)() - s.quotedAt > ROUTE_TTL_MS) throw new Error(ROUTE_EXPIRED)
}

/** Immediately before each source-chain transaction: the route is inside its TTL, and the wallet still answers as
 *  the account it names. */
async function assertSignable(s: CrossChainSend, wallet: CrossChainWallet, o: CrossChainSendOptions): Promise<void> {
	await assertAccount(wallet, s.ask)
	// Last before the wallet is asked: an account read that answers late cannot carry an expired route past it.
	assertFresh(s, o)
}

/** The wallet must sign on the route's chain, as the account the route names as depositor and refund address. */
async function assertSource(wallet: CrossChainWallet, ask: CrossChainAsk): Promise<void> {
	await assertAccount(wallet, ask)
	const live = await wallet.chainId()
	if (live !== ask.srcChainId) {
		throw new Error(
			`Your Ethereum wallet is on chain ${live}, but this route starts on chain ${ask.srcChainId}. Switch networks and try again — nothing was sent.`,
		)
	}
}

function assertVerified(route: CrossChainRoute): void {
	const verdict = verifyRoute(route.tx, route.x)
	if (!verdict.ok) {
		log("verifyRoute refused the route at signing", verdict.field)
		throw new Error(ROUTE_REFUSED)
	}
}

/**
 * The private record's v3 envelope: the credential the claim spends (the token claim salt, or the gas salt when
 * gas is all it bought), the gas salt beside it, and the amount window the deposit can land in. Bound to the
 * Ethereum chain id through the binding, whatever chain the wallet is on.
 */
async function sealCrossChain(rec: CrossChainDepositRecord, s: CrossChainSend, wallet: CrossChainWallet): Promise<void> {
	const salt = s.route.secrets.fuel?.bridgeSalt
	const credential = s.route.secrets.tokenClaimValue ?? salt
	if (!credential) return
	const provider = providerFingerprint()
	const trusted = isSealTrusted(localStorage, NETWORK.l1ChainId, wallet.account, provider)
	setRecordStep(
		rec.id,
		"sealing",
		trusted ? "one Ethereum signature — encrypts the recovery secret" : "two Ethereum signatures — encrypt + verify determinism",
	)
	const window = crossChainAmountWindow(rec)
	const { blob, key } = await sealCrossChainDepositRecord({
		sign: (m) =>
			runOnLane("l1", async () => {
				await assertAccount(wallet, s.ask)
				return wallet.signMessage(m)
			}),
		binding: { ...sealBindingOf({ intent: s.ask.intent, token: s.token } as SendPlan), secretHashHex: rec.id },
		envelope: {
			secret: credential.toString(),
			recipient: s.ask.recipient,
			...window,
			sealerL1: wallet.account,
			...(salt ? { salt: salt.toString() } : {}),
		},
		trusted,
	})
	if (!trusted) markSealTrusted(localStorage, NETWORK.l1ChainId, wallet.account, provider)
	sealKeys.set(rec.id, key)
	updateCrossChainRecord(rec.id, { sealedEnvelope: blob, sealerL1: wallet.account })
	if (!currentCrossChainRecord(rec.id)?.sealedEnvelope) {
		throw new Error("Could not persist the sealed recovery secret — aborting before the deposit (storage full?).")
	}
	setRecordStep(rec.id, "preparing-source")
}

const approveCall = (token: Address, spender: Address, amount: bigint): SourceCall => ({
	to: token,
	data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] }),
	value: 0n,
})

/**
 * The approvals that leave exactly the input approved: none when the allowance already equals it. A larger
 * standing allowance, MAX included, is replaced; a token that refuses to move one non-zero allowance to another
 * goes through 0 first.
 */
async function approvalCalls(reads: CrossChainReads, owner: Address, a: CrossChainRoute["tx"]["approval"]): Promise<SourceCall[]> {
	const current = (await reads.source.readContract({
		address: a.token,
		abi: ERC20_ABI,
		functionName: "allowance",
		args: [owner, a.spender],
	})) as bigint
	if (current === a.amount) return []
	const exact = approveCall(a.token, a.spender, a.amount)
	if (current === 0n) return [exact]
	const direct = await reads.source.call({ account: owner, to: exact.to, data: exact.data }).then(
		() => true,
		() => false,
	)
	return direct ? [exact] : [approveCall(a.token, a.spender, 0n), exact]
}

/** A batch returns an id, not a hash: the hash comes from the wallet's receipts when it reports them, and
 *  otherwise from discovery's scan of the source token's transfers. */
async function adoptBatchHash(id: string, batch: NonNullable<CrossChainWallet["batch"]>, batchId: string, o: CrossChainSendOptions) {
	const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	for (let i = 0; i < (o.batchPolls ?? 20); i++) {
		const hashes = await batch.receipts(batchId).catch(() => [] as readonly Hex[])
		const last = hashes.at(-1)
		if (last) {
			updateCrossChainRecord(id, (current) => ({ route: { ...current.route, srcTxHash: last } }))
			return
		}
		await wait(3_000)
	}
}

/** Approve and send, journaling what the wallet returns at once. `onRequested` fires as the deposit itself is
 *  handed to the wallet: past it, a failure is no longer proof that nothing left. */
async function sendOnSource(
	id: string,
	s: CrossChainSend,
	wallet: CrossChainWallet,
	reads: CrossChainReads,
	o: CrossChainSendOptions,
	onRequested: () => void,
): Promise<void> {
	const approvals = await approvalCalls(reads, wallet.account, s.route.tx.approval)
	const deposit: SourceCall = { to: s.route.tx.to, data: s.route.tx.data, value: s.route.tx.value }
	if (approvals.length > 0 && wallet.batch && (await wallet.batch.atomic(s.ask.srcChainId))) {
		assertVerified(s.route)
		await assertSignable(s, wallet, o)
		setRecordStep(id, "sending-source")
		onRequested()
		const batchId = await wallet.batch.send([...approvals, deposit])
		updateCrossChainRecord(id, (current) => ({ route: { ...current.route, srcBatchId: batchId } }))
		setRecordStep(id, undefined)
		await adoptBatchHash(id, wallet.batch, batchId, o)
		return
	}
	await approveOnSource(id, s, wallet, reads, o, approvals)
	assertVerified(s.route)
	await assertSignable(s, wallet, o)
	setRecordStep(id, "sending-source")
	onRequested()
	const srcTxHash = await wallet.sendTransaction(deposit)
	updateCrossChainRecord(id, (current) => ({ route: { ...current.route, srcTxHash } }))
	setRecordStep(id, undefined)
}

/** Each approval is journaled the moment the wallet returns it, before its receipt: from then on the record is
 *  what remembers that the Diamond may spend from the wallet. */
async function approveOnSource(
	id: string,
	s: CrossChainSend,
	wallet: CrossChainWallet,
	reads: CrossChainReads,
	o: CrossChainSendOptions,
	approvals: readonly SourceCall[],
): Promise<void> {
	let approved: Hex | undefined
	for (const call of approvals) {
		await assertSignable(s, wallet, o)
		setRecordStep(id, "approving-source")
		approvalsUnanswered.add(id)
		try {
			approved = await wallet.sendTransaction(call)
		} catch (e) {
			if (isUserRejection(e)) approvalsUnanswered.delete(id)
			throw e
		}
		// The marker clears only once the hash is journaled: a failed write still leaves the record kept.
		updateCrossChainRecord(id, { approveTxHash: approved })
		approvalsUnanswered.delete(id)
		const receipt = await reads.source.waitForTransactionReceipt({ hash: approved })
		if (receipt.status !== "success") throw new Error("The token approval reverted on the source chain, so the deposit was not sent.")
	}
	if (!approved) return
	markApproveOutcome(id, "done")
	logRecordLine(id, approvalConfirmedLine(s.ask.srcChainId, approved))
}

/** Nothing bridged, but an approval may stand, journaled or asked for and never answered: such a record ends
 *  `not-sent`, whose card reads the allowance and offers the revoke. */
function endUnsent(id: string): void {
	if (!currentCrossChainRecord(id)?.approveTxHash && !approvalsUnanswered.has(id)) {
		discard(id)
		return
	}
	setRecordStep(id, undefined)
	updateCrossChainRecord(id, (current) => ({ route: { ...current.route, outcome: "not-sent" }, completedAt: Date.now() }))
}

/** Nothing bridged when the deposit never reached the wallet, or the wallet refused it: the record goes, unless it
 *  journaled an approval. Any other failure keeps it, since the transfer may be on its way, and watches it at once
 *  so discovery decides. */
function settleFailedSend(id: string, requested: boolean, e: unknown, watcher: CrossChainWatchDeps | undefined): void {
	try {
		if (!requested || isUserRejection(e)) {
			sealKeys.delete(id)
			endUnsent(id)
			return
		}
		flagRecordError(id, humanizeWalletError(e instanceof Error ? e.message : String(e)))
		if (watcher) void watchCrossChain(id, watcher)
	} catch (cleanup) {
		log("failed-send bookkeeping threw", cleanup instanceof Error ? cleanup.message : String(cleanup))
	}
}

/**
 * Journal, seal, verify, sign and persist one cross-chain deposit. Returns the record id once the source
 * transaction (or batch) is journaled; discovery takes it from there.
 *
 * The wallet's live account is checked again before every signature, and the route's age before every source-chain
 * transaction; the whole span holds the operation guard, so the app's Aztec account cannot change under it.
 *
 * @throws before any record exists when the route is stale, refused by the decoder, or the wallet is on another
 * chain or account; after the record exists, with the record discarded when nothing can have left the wallet, or
 * ended `not-sent` when an approval was journaled.
 */
export function sendCrossChain(
	s: CrossChainSend,
	wallet: CrossChainWallet,
	reads: CrossChainReads,
	o: CrossChainSendOptions = {},
): Promise<string> {
	return withOperation(() => journalAndSend(s, wallet, reads, o))
}

async function journalAndSend(
	s: CrossChainSend,
	wallet: CrossChainWallet,
	reads: CrossChainReads,
	o: CrossChainSendOptions,
): Promise<string> {
	assertFresh(s, o)
	await assertSource(wallet, s.ask)
	assertVerified(s.route)
	const heads = { source: await reads.source.getBlockNumber(), ethereum: await reads.ethereum.getBlockNumber() }
	const rec = crossChainRecordOf(s, heads)
	addCrossChainRecordVerified(rec)
	markSessionLive(rec.id)
	// From here until the wallet returns the send, a step is always set: a record without one reads as a send
	// the wallet may have taken without answering.
	setRecordStep(rec.id, "preparing-source")
	const watcher = o.watch === false ? undefined : (o.watch ?? appWatchDeps())
	let requested = false
	try {
		if (s.ask.isPrivate) await sealCrossChain(rec, s, wallet)
		// The seal's prompt can come back on another chain or account.
		await assertSource(wallet, s.ask)
		await sendOnSource(rec.id, s, wallet, reads, o, () => {
			requested = true
		})
		if (watcher) void watchCrossChain(rec.id, watcher)
		return rec.id
	} catch (e) {
		settleFailedSend(rec.id, requested, e, watcher)
		throw e
	} finally {
		approvalsUnanswered.delete(rec.id)
	}
}

/** The injected wallet signing on `chain`: viem refuses a send while the wallet is on another chain. */
export function walletOnChain(client: WalletClient, account: Address, chain: Chain): CrossChainWallet {
	return {
		account,
		liveAccount: async () => (await client.getAddresses())[0],
		chainId: () => client.getChainId(),
		signMessage: (message) => client.signMessage({ account, message }),
		sendTransaction: (c) => client.sendTransaction({ account, chain, to: c.to, data: c.data, value: c.value }),
		batch: {
			atomic: async (chainId) => {
				const caps = await client.getCapabilities({ account, chainId }).catch(() => undefined)
				const status = caps?.atomic?.status
				return status === "supported" || status === "ready"
			},
			send: async (calls) => (await client.sendCalls({ account, chain, calls: [...calls], forceAtomic: true })).id,
			receipts: async (id) => ((await client.getCallsStatus({ id })).receipts ?? []).map((r) => r.transactionHash),
		},
	}
}
