/**
 * Runs the canary matrix. Every run plans the rows, refuses before any send (chains, pinned address,
 * router wiring, caps, funding), and builds and verifies each row's transactions right before its turn.
 * A live run then sends the row, waits out an organic-fill window, self-fills what no relayer filled,
 * reads the outcome back (discovery for cross-chain rows, the router's `Deposited` for Ethereum-origin
 * ones) and claims on Aztec. Every L1 transaction a live row sends carries explicit gas and fee caps
 * whose worst case fits what that chain's cap has left. A dry run has no way to send: its dependencies
 * carry no signer.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { type Abi, type Address, type Hex, parseAbi } from "viem"
import { acrossV4Call } from "../src/across-v4"
import {
	type CrossChainDiscovery,
	type CrossChainDiscoveryContext,
	type DiscoveryReads,
	discoverCrossChain,
	readRouterDeposit,
	type InboxEventShape,
} from "../src/crosschain-discovery"
import { DEPOSIT_ROUTER_ABI } from "../src/deposit-router-abi"
import type { L1Ctx } from "../src/flows"
import type { CrossChainDepositRecord } from "../src/journal"
import { type FuelQuoteProvider, testnetSwapperFuelProvider } from "../src/fuel-quote"
import { hashDepositWitness, PERMIT_DEADLINE_SECONDS } from "../src/l1"
import { acrossDepositFor, type RouteExpectation, type RouterIntent, type RouteTx } from "../src/lifi-decode"
import type { ManifestV2 } from "../src/manifest-v2"
import { PRIVATE_FPC_ADDRESS } from "../src/private-fuel"
import { type AcrossClient, type AcrossLimits, acrossSuggestedFees } from "./lifi-canary-across"
import {
	bridgeFromCallerCall,
	bridgeWithPermitCall,
	crossChainExpectation,
	crossChainTx,
	type FuelLeg,
	fuelLegFor,
	type PermitTerms,
	permitPayload,
	type RailTerms,
	type RowLegs,
	routerIntent,
	rowLegs,
	SELF_BUILT_FILL_WINDOW_S,
	selfBuiltTerms,
	verifiedRoute,
} from "./lifi-canary-build"
import type { CanaryL2 } from "./lifi-canary-l2"
import {
	type CanaryAmounts,
	type CanaryBindings,
	type CanaryCaps,
	type CanaryFacts,
	type CanaryRecord,
	CanaryRefusal,
	type CanaryRow,
	assertCanaryIdentity,
	assertCanaryPreconditions,
	assertGasHeadroom,
	assertGasReconciled,
	assertWithinCaps,
	canaryBindings,
	type FillWay,
	fundingShortfalls,
	type GasBudget,
	type GasBurn,
	type GasPerRow,
	planCanaryRows,
	type RailRecord,
	type RowBudgets,
	type RowRecord,
	rowBudgets,
} from "./lifi-canary-plan"
import {
	approveExact,
	boundedGasTerms,
	ERC20_MIN_ABI,
	ensureRouterPermit2,
	FACTORY_CONSTANTS_ABI,
	type GasPricing,
	type GasTermsFor,
	withGasTerms,
} from "./script-l1"

const SWAPPER_QUOTE_ABI = parseAbi(["function quote(address token, uint256 amountIn) view returns (uint256)"])

/** The read surface each chain needs (a viem public client's shape). */
export interface ChainReads {
	getChainId(): Promise<number>
	getBlock(args: { blockTag: "latest" }): Promise<{ number: bigint; timestamp: bigint }>
	getBalance(args: { address: Address }): Promise<bigint>
	readContract(args: {
		address: Address
		abi: Abi
		functionName: string
		args?: readonly unknown[]
		blockNumber?: bigint
	}): Promise<unknown>
}

/** Every network binding a run uses, resolved at the CLI edge so another network's bindings drive the same rows. */
export interface CanaryConfig {
	manifest: ManifestV2
	sourceChainId: number
	/** LI.FI and Across on the source chain and on Ethereum. */
	lifi: {
		diamond: Address
		sourceSpokePool: Address
		destinationSpokePool: Address
		receiverAcrossV4: Address
		executor: Address
	}
	/** What discovery needs beyond the manifest to recompute an Inbox leaf on this network's Aztec line. */
	inbox: { shape: InboxEventShape; feeJuice: { l2: Hex; l1Sender: Address } }
	canary: Address
	pinned: Address | null
	caps: CanaryCaps
	amounts: CanaryAmounts
	gasPerRow: GasPerRow
	windows: {
		/** How long a deposit waits for a relayer before the canary fills it itself. */
		organicFillMs: number
		/** How long discovery may take to see a fill the canary knows happened. */
		settleMs: number
		pollMs: number
	}
}

export interface SelfFill {
	fillTxHash: Hex | null
	relayHash: Hex
	alreadyFilled: boolean
}

/** What only a live run holds: signers on both chains, discovery's reads, the Aztec side and the filler. */
export interface CanaryLive {
	kind: "live"
	source: L1Ctx
	ethereum: L1Ctx
	discovery: DiscoveryReads
	l2: CanaryL2
	/** Fills the relay `srcTxHash` started, its approve and fill both carrying terms from `gas`. */
	selfFill: (srcTxHash: Hex, gas: GasTermsFor) => Promise<SelfFill>
}

export interface CanaryDeps {
	reads: { source: ChainReads; ethereum: ChainReads }
	across: AcrossClient
	/** Every secret, salt, LI.FI transaction id and Permit2 nonce comes from here. */
	random: () => Fr
	/** The Aztec account every row deposits to. */
	recipient: AztecAddress
	now: () => number
	sleep: (ms: number) => Promise<void>
	log: (line: string) => void
	mode: { kind: "dry-run" } | CanaryLive
}

interface RowCtx {
	cfg: CanaryConfig
	b: CanaryBindings
	deps: CanaryDeps
}

interface LiveRun extends RowCtx {
	live: CanaryLive
	discovery: CrossChainDiscoveryContext
}

/** One live row: `live`'s signers bounded by the row's budgets. */
interface LiveCtx extends LiveRun {
	/** The Ethereum budget's terms, which the self-fill's transactions carry. */
	fillGas: GasTermsFor
}

const nowSec = (ctx: RowCtx) => Math.floor(ctx.deps.now() / 1000)

function fuelProvider(ctx: RowCtx, transactionId?: Hex): FuelQuoteProvider {
	const { b, deps } = ctx
	const quote = async (token: Address, amountIn: bigint) =>
		(await deps.reads.ethereum.readContract({
			address: b.fuelSwapper,
			abi: SWAPPER_QUOTE_ABI,
			functionName: "quote",
			args: [token, amountIn],
		})) as bigint
	const policy = { slippageBps: b.fuel.slippageBps, minFuelFj: b.fuel.minFuelFj }
	return testnetSwapperFuelProvider({
		reader: { quote },
		swapper: b.fuelSwapper,
		router: b.depositRouter,
		feeAsset: b.feeAsset,
		transactionId,
		...policy,
	})
}

const balanceOf = async (r: ChainReads, token: Address, of: Address, blockNumber?: bigint) =>
	(await r.readContract({
		address: token,
		abi: ERC20_MIN_ABI,
		functionName: "balanceOf",
		args: [of],
		...(blockNumber === undefined ? {} : { blockNumber }),
	})) as bigint

async function readFacts(ctx: RowCtx): Promise<CanaryFacts> {
	const { cfg, b, deps } = ctx
	const { source, ethereum } = deps.reads
	const swapTarget = await ethereum.readContract({ address: b.depositRouter, abi: DEPOSIT_ROUTER_ABI, functionName: "SWAP_TARGET" })
	return {
		live: deps.mode.kind === "live",
		chainIds: { source: await source.getChainId(), ethereum: await ethereum.getChainId() },
		canary: cfg.canary,
		pinned: cfg.pinned,
		routerSwapTarget: swapTarget as Address,
		balances: {
			sourceToken: await balanceOf(source, b.source.token, cfg.canary),
			sourceNative: await source.getBalance({ address: cfg.canary }),
			ethereumToken: await balanceOf(ethereum, b.destToken.erc20 as Address, cfg.canary),
			ethereumNative: await ethereum.getBalance({ address: cfg.canary }),
		},
	}
}

// ── cross-chain rows ─────────────────────────────────────────────────────────

interface RouterCall {
	intent: RouterIntent
	fuel?: FuelLeg
	routerCall: Hex
}

/** The router call for `row` when the rail delivers exactly `delivered`. */
async function routerCallFor(ctx: RowCtx, row: CanaryRow, legs: RowLegs, lifiTxId: Hex, delivered: bigint): Promise<RouterCall> {
	const token = { erc20: ctx.b.destToken.erc20 as Address, decimals: ctx.b.destToken.decimals }
	const recovery = row.expect === "delivered-to-wallet"
	const fuel = row.fuel === "none" ? undefined : await fuelLegFor(fuelProvider(ctx, lifiTxId), ctx.b, token, delivered, recovery)
	const intent = routerIntent(token.erc20, row.isPrivate, legs, fuel)
	return { intent, fuel, routerCall: bridgeFromCallerCall(intent, fuel?.swapData ?? "0x", delivered) }
}

function expectationFor(ctx: RowCtx, row: CanaryRow, lifiTxId: Hex, call: RouterCall, terms: RailTerms): RouteExpectation {
	return crossChainExpectation(ctx.b, {
		user: ctx.cfg.canary,
		srcAmount: row.amount,
		lifiTxId,
		routerCall: call.routerCall,
		hasFuel: call.fuel !== undefined,
		terms,
	})
}

/** The LI.FI message a deposit of `row.amount` carries; its length, and so the relayer's gas, never depends on the amounts. */
async function draftMessage(ctx: RowCtx, row: CanaryRow, legs: RowLegs, lifiTxId: Hex): Promise<Hex> {
	const call = await routerCallFor(ctx, row, legs, lifiTxId, row.amount)
	const t = nowSec(ctx)
	const draft = {
		quote: "self-built" as const,
		outputAmount: row.amount,
		quoteTimestamp: t,
		fillDeadline: t + SELF_BUILT_FILL_WINDOW_S,
		etaSeconds: 0,
	}
	return acrossV4Call(acrossDepositFor(expectationFor(ctx, row, lifiTxId, call, draft))).acrossData.message
}

async function quoteFor(ctx: RowCtx, amount: bigint, message: Hex) {
	const { cfg, b } = ctx
	return acrossSuggestedFees(
		ctx.deps.across,
		{
			originChainId: b.source.chainId,
			destinationChainId: b.l1ChainId,
			inputToken: b.source.token,
			outputToken: b.destToken.erc20 as Address,
			amount,
			recipient: cfg.lifi.receiverAcrossV4,
			message,
			spokePool: cfg.lifi.sourceSpokePool,
			destinationSpokePool: cfg.lifi.destinationSpokePool,
		},
		nowSec(ctx),
	)
}

/** Across's limits for the matrix's message, read once before the plan; `undefined` when Across quotes none. */
async function acrossLimits(ctx: RowCtx, rows: readonly CanaryRow[]): Promise<AcrossLimits | undefined> {
	const row = rows.find((r) => r.origin === "crosschain")
	if (!row) return undefined
	const legs = await rowLegs(row, ctx.deps.recipient, ctx.deps.random)
	const q = await quoteFor(ctx, row.amount, await draftMessage(ctx, row, legs, ctx.deps.random().toString() as Hex))
	if (q.ok) return q.quote.limits
	ctx.deps.log(`Across quotes nothing for the canary's message (${q.reason}): every cross-chain row is self-built and self-filled`)
	return undefined
}

async function railTerms(ctx: RowCtx, row: CanaryRow, message: Hex): Promise<RailTerms> {
	const q = await quoteFor(ctx, row.amount, message)
	if (q.ok) {
		const { outputAmount, quoteTimestamp, fillDeadline, estimatedFillTimeSec } = q.quote
		return { quote: "across", outputAmount, quoteTimestamp, fillDeadline, etaSeconds: estimatedFillTimeSec }
	}
	ctx.deps.log(`${row.kind}: Across quotes nothing (${q.reason}); self-built terms`)
	const head = await ctx.deps.reads.source.getBlock({ blockTag: "latest" })
	return selfBuiltTerms(row.amount, Number(head.timestamp))
}

interface CrossChainBuilt extends RouterCall {
	row: CanaryRow
	legs: RowLegs
	lifiTxId: Hex
	terms: RailTerms
	x: RouteExpectation
	tx: RouteTx
}

/** Quote the message, then build the deposit for what Across delivers, and verify the exact bytes. */
async function buildCrossChain(ctx: RowCtx, row: CanaryRow): Promise<CrossChainBuilt> {
	const legs = await rowLegs(row, ctx.deps.recipient, ctx.deps.random)
	const lifiTxId = ctx.deps.random().toString() as Hex
	const terms = await railTerms(ctx, row, await draftMessage(ctx, row, legs, lifiTxId))
	const call = await routerCallFor(ctx, row, legs, lifiTxId, terms.outputAmount)
	const x = expectationFor(ctx, row, lifiTxId, call, terms)
	const tx = crossChainTx(x)
	verifiedRoute(tx, x)
	return { row, legs, lifiTxId, terms, x, tx, ...call }
}

const railRecord = (c: CrossChainBuilt): RailRecord => ({
	quote: c.terms.quote,
	srcAmount: c.row.amount.toString(),
	outputAmount: c.terms.outputAmount.toString(),
})

function builtCrossChainRecord(c: CrossChainBuilt): RowRecord {
	const fuel = c.fuel ? `; fuel slice ${c.fuel.slice}, floor ${c.fuel.minOut} of quote ${c.fuel.expectedOut}` : ""
	const r = railRecord(c)
	const detail = `${r.srcAmount} in, ${r.outputAmount} out (${r.quote})${fuel}`
	return { kind: c.row.kind, status: "built", to: c.tx.to, selector: c.tx.data.slice(0, 10) as Hex, detail }
}

/** The schema-4 record discovery reads; in memory only, so it carries no secret. */
function discoveryRecord(
	ctx: LiveCtx,
	c: CrossChainBuilt,
	sent: { srcTxHash: Hex; srcScanFromBlock: bigint; scanFromBlock: bigint },
): CrossChainDepositRecord {
	const { b, cfg } = ctx
	const t = b.destToken
	const delivered = c.terms.outputAmount.toString()
	return {
		schema: 4,
		id: c.legs.tokenSecretHash,
		direction: "deposit",
		isPrivate: c.row.isPrivate,
		amount: (c.terms.outputAmount - c.intent.fuelSlice).toString(),
		createdAt: 0,
		updatedAt: 0,
		chainId: b.l1ChainId,
		portal: t.portal,
		bridge: b.hub,
		recipient: ctx.deps.recipient.toString(),
		secretHashHex: c.legs.tokenSecretHash,
		intent: "token+gas",
		token: {
			erc20: t.erc20,
			portal: t.portal,
			l2Token: t.l2Token,
			nameWord: t.nameWord,
			symbolWord: t.symbolWord,
			decimals: t.decimals,
			displaySymbol: t.displaySymbol,
		},
		fuel: {
			amount: c.intent.fuelSlice.toString(),
			secret: "",
			secretHashHex: c.legs.fuelSecretHash,
			minOutput: c.intent.minFuelOutput.toString(),
			...(c.row.fuel === "private" ? { fpc: PRIVATE_FPC_ADDRESS } : {}),
		},
		route: {
			provider: "lifi",
			rail: "acrossV4",
			srcChainId: b.source.chainId,
			srcToken: b.source.token,
			srcAmount: c.row.amount.toString(),
			srcSender: cfg.canary,
			srcScanFromBlock: sent.srcScanFromBlock.toString(),
			srcTxHash: sent.srcTxHash,
			lifiTxId: c.lifiTxId,
			router: b.depositRouter,
			minReceived: delivered,
			maxPull: delivered,
			scanFromBlock: sent.scanFromBlock.toString(),
			etaSeconds: c.terms.etaSeconds,
			fillDeadline: c.terms.fillDeadline,
		},
	}
}

type Settled = Extract<CrossChainDiscovery, { verdict: "deposited" }> | Extract<CrossChainDiscovery, { observation: unknown }>
type Fill = { txHash: Hex; way: FillWay }

const decided = (d: CrossChainDiscovery): d is Settled => d.verdict !== "pending" && d.verdict !== "incomplete"

/** Discovery on the live receipts, re-run until it decides or `windowMs` passes. */
async function discoverWithin(ctx: LiveCtx, rec: CrossChainDepositRecord, windowMs: number): Promise<CrossChainDiscovery> {
	const until = ctx.deps.now() + windowMs
	for (;;) {
		const d = await discoverCrossChain(rec, ctx.discovery, ctx.live.discovery)
		if (decided(d) || ctx.deps.now() >= until) return d
		await ctx.deps.sleep(ctx.cfg.windows.pollMs)
	}
}

/** The fill transaction discovery authenticated, and whether a relayer or the canary sent it. */
async function settleFill(
	ctx: LiveCtx,
	c: CrossChainBuilt,
	rec: CrossChainDepositRecord,
): Promise<{ d: Settled; sourceTx: Hex; fill: Fill }> {
	let d = await discoverWithin(ctx, rec, ctx.cfg.windows.organicFillMs)
	let way: FillWay = "organic"
	let selfTx: Hex | null = null
	if (!decided(d)) {
		ctx.deps.log(`${c.row.kind}: no relayer filled within the window; self-filling`)
		const r = await ctx.live.selfFill(rec.route.srcTxHash as Hex, ctx.fillGas)
		way = r.alreadyFilled ? "organic" : "self"
		selfTx = r.fillTxHash
		d = await discoverWithin(ctx, rec, ctx.cfg.windows.settleMs)
	}
	if (!decided(d) || d.verdict !== c.row.expect)
		throw new CanaryRefusal(`${c.row.kind}: discovery says ${d.verdict}, the row expects ${c.row.expect}`)
	const txHash = "deposit" in d ? d.deposit.depositTxHash : d.observation.txHash
	if (!txHash) throw new CanaryRefusal(`${c.row.kind}: discovery decided without naming the fill transaction`)
	if (way === "self" && selfTx && txHash.toLowerCase() !== selfTx.toLowerCase()) {
		throw new CanaryRefusal(`${c.row.kind}: discovery found the delivery in ${txHash}, the self-fill sent ${selfTx}`)
	}
	return { d, sourceTx: d.srcTxHash ?? (rec.route.srcTxHash as Hex), fill: { txHash, way } }
}

async function sendSource(ctx: LiveCtx, c: CrossChainBuilt): Promise<CrossChainDepositRecord> {
	const { source, ethereum } = ctx.live
	await approveExact(source, c.tx.approval.token, c.tx.approval.spender, c.tx.approval.amount)
	verifiedRoute(c.tx, c.x)
	const srcScanFromBlock = await source.pub.getBlockNumber()
	const scanFromBlock = await ethereum.pub.getBlockNumber()
	const tx = { to: c.tx.to, data: c.tx.data, value: c.tx.value, account: source.account, chain: source.wallet.chain }
	const srcTxHash = await source.wallet.sendTransaction(tx as never)
	const receipt = await source.pub.waitForTransactionReceipt({ hash: srcTxHash })
	if (receipt.status !== "success") throw new CanaryRefusal(`${c.row.kind}: the source transaction ${srcTxHash} reverted`)
	ctx.deps.log(`${c.row.kind}: source transaction ${srcTxHash}`)
	return discoveryRecord(ctx, c, { srcTxHash, srcScanFromBlock, scanFromBlock })
}

async function recoveredRecord(ctx: LiveCtx, c: CrossChainBuilt, s: { d: Settled; sourceTx: Hex; fill: Fill }): Promise<RowRecord> {
	const { d, fill } = s
	if (!("observation" in d) || d.verdict !== "delivered-to-wallet") throw new CanaryRefusal(`${c.row.kind}: not a recovery`)
	const amount = BigInt(d.observation.amount ?? -1)
	if (amount !== c.terms.outputAmount)
		throw new CanaryRefusal(`${c.row.kind}: LI.FI recovered ${amount}, the relay delivered ${c.terms.outputAmount}`)
	const at = d.observation.decidedAt.blockNumber
	const token = ctx.b.destToken.erc20 as Address
	const reads = ctx.deps.reads.ethereum
	const delta = (await balanceOf(reads, token, ctx.cfg.canary, at)) - (await balanceOf(reads, token, ctx.cfg.canary, at - 1n))
	const selfFillPaid = fill.way === "self" ? c.terms.outputAmount : 0n
	if (delta + selfFillPaid !== amount) {
		throw new CanaryRefusal(
			`${c.row.kind}: the canary's balance moved ${delta} across the fill (self-fill paid ${selfFillPaid}), not ${amount}`,
		)
	}
	return {
		kind: c.row.kind,
		status: "recovered",
		rail: railRecord(c),
		sourceTx: s.sourceTx,
		fill,
		recovered: { txHash: fill.txHash, amount: amount.toString() },
		balance: { delta: delta.toString(), selfFillPaid: selfFillPaid.toString() },
		discovery: `${d.verdict} (expected ${c.row.expect})`,
	}
}

async function depositedRecord(ctx: LiveCtx, c: CrossChainBuilt, s: { d: Settled; sourceTx: Hex; fill: Fill }): Promise<RowRecord> {
	const { d, fill } = s
	if (!("deposit" in d) || !d.deposit.token || !d.deposit.fuel) throw new CanaryRefusal(`${c.row.kind}: the deposit lacks a leg`)
	const { token, fuel } = d.deposit
	const claim = await ctx.live.l2.claim({
		label: c.row.kind,
		token: ctx.b.destToken,
		amount: BigInt(token.amount),
		leafIndex: BigInt(token.leafIndex),
		isPrivate: c.row.isPrivate,
		secrets: c.legs.secrets,
		fuel: { received: BigInt(fuel.received), leafIndex: BigInt(fuel.leafIndex) },
	})
	return {
		kind: c.row.kind,
		status: "deposited",
		origin: "crosschain",
		rail: railRecord(c),
		sourceTx: s.sourceTx,
		fill,
		deposited: {
			txHash: d.deposit.depositTxHash,
			received: d.deposit.received,
			token: { amount: token.amount, leafIndex: token.leafIndex },
			fuel: { consumed: fuel.consumed, received: fuel.received, leafIndex: fuel.leafIndex },
		},
		claim,
		discovery: `${d.verdict} (expected ${c.row.expect})`,
	}
}

async function runCrossChain(ctx: RowCtx, live: LiveCtx | undefined, row: CanaryRow): Promise<RowRecord> {
	const c = await buildCrossChain(ctx, row)
	if (!live) return builtCrossChainRecord(c)
	const rec = await sendSource(live, c)
	const settled = await settleFill(live, c, rec)
	return row.expect === "deposited" ? depositedRecord(live, c, settled) : recoveredRecord(live, c, settled)
}

// ── Ethereum-origin rows ─────────────────────────────────────────────────────

interface EthereumBuilt {
	row: CanaryRow
	legs: RowLegs
	intent: RouterIntent
	fuel?: FuelLeg
	swapData: Hex
	permit: PermitTerms
	typedData: ReturnType<typeof permitPayload>["typedData"]
}

/** The intent and the Permit2 payload, with the router's own `hashWitness` agreeing with ours. */
async function buildEthereum(ctx: RowCtx, row: CanaryRow): Promise<EthereumBuilt> {
	const { b, deps } = ctx
	const token = { erc20: b.destToken.erc20 as Address, decimals: b.destToken.decimals }
	const legs = await rowLegs(row, deps.recipient, deps.random)
	const fuel = row.fuel === "none" ? undefined : await fuelLegFor(fuelProvider(ctx), b, token, row.amount, false)
	const intent = routerIntent(token.erc20, row.isPrivate, legs, fuel)
	const swapData = fuel?.swapData ?? "0x"
	const permit = { nonce: deps.random().toBigInt(), deadline: BigInt(nowSec(ctx)) + PERMIT_DEADLINE_SECONDS }
	const { witness, typedData } = permitPayload(b, { intent, swapData, amount: row.amount, permit })
	const onChain = await deps.reads.ethereum.readContract({
		address: b.depositRouter,
		abi: DEPOSIT_ROUTER_ABI,
		functionName: "hashWitness",
		args: [intent, swapData],
	})
	if (onChain !== hashDepositWitness(witness)) throw new CanaryRefusal(`${row.kind}: the router hashes this witness as ${onChain}`)
	return { row, legs, intent, fuel, swapData, permit, typedData }
}

function builtEthereumRecord(ctx: RowCtx, e: EthereumBuilt): RowRecord {
	const data = bridgeWithPermitCall(e.intent, e.swapData, e.row.amount, { ...e.permit, signature: "0x" })
	const fuel = e.fuel ? `; fuel slice ${e.fuel.slice}, floor ${e.fuel.minOut} of quote ${e.fuel.expectedOut}` : ""
	const detail = `${e.row.amount} in, witness hash matches the router's, unsigned${fuel}`
	return { kind: e.row.kind, status: "built", to: ctx.b.depositRouter, selector: data.slice(0, 10) as Hex, detail }
}

async function sendEthereum(ctx: LiveCtx, e: EthereumBuilt): Promise<RowRecord> {
	const { b, deps } = ctx
	const l1 = ctx.live.ethereum
	const token = b.destToken.erc20 as Address
	const mins = () => e.row.kind
	await ensureRouterPermit2(l1, { usdc: token, usdcAbi: ERC20_MIN_ABI, permit2: b.permit2, needed: e.row.amount, mins })
	const signature = await l1.wallet.signTypedData({ account: l1.account, ...e.typedData } as never)
	const data = bridgeWithPermitCall(e.intent, e.swapData, e.row.amount, { ...e.permit, signature })
	const hash = await l1.wallet.sendTransaction({ to: b.depositRouter, data, account: l1.account, chain: l1.wallet.chain } as never)
	const receipt = await l1.pub.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new CanaryRefusal(`${e.row.kind}: bridgeWithPermit reverted in ${hash}`)
	deps.log(`${e.row.kind}: Ethereum transaction ${hash}`)
	const { intent } = e
	const facts = await readRouterDeposit(receipt.logs, hash, ctx.discovery.ethereum, {
		l1ChainId: b.l1ChainId,
		isPrivate: intent.isPrivate,
		recipient: intent.aztecRecipient,
		token: { erc20: token, secretHash: intent.tokenSecretHash },
		...(e.fuel ? { fuel: { secretHash: intent.fuelSecretHash, fpc: intent.isPrivate ? intent.fuelRecipient : undefined } } : {}),
	})
	const tokenLeg = facts.token as NonNullable<typeof facts.token>
	const claim = await ctx.live.l2.claim({
		label: e.row.kind,
		token: b.destToken,
		amount: BigInt(tokenLeg.amount),
		leafIndex: BigInt(tokenLeg.leafIndex),
		isPrivate: e.row.isPrivate,
		secrets: e.legs.secrets,
		...(facts.fuel ? { fuel: { received: BigInt(facts.fuel.received), leafIndex: BigInt(facts.fuel.leafIndex) } } : {}),
	})
	const fuel = facts.fuel
		? { fuel: { consumed: facts.fuel.consumed, received: facts.fuel.received, leafIndex: facts.fuel.leafIndex } }
		: {}
	return {
		kind: e.row.kind,
		status: "deposited",
		origin: "ethereum",
		ethereumTx: hash,
		deposited: {
			txHash: hash,
			received: facts.received,
			token: { amount: tokenLeg.amount, leafIndex: tokenLeg.leafIndex },
			...fuel,
		},
		claim,
	}
}

async function runEthereum(ctx: RowCtx, live: LiveCtx | undefined, row: CanaryRow): Promise<RowRecord> {
	const e = await buildEthereum(ctx, row)
	return live ? sendEthereum(live, e) : builtEthereumRecord(ctx, e)
}

// ── the run ──────────────────────────────────────────────────────────────────

/** Native gas the run burned so far: no row moves the canary's ether except as gas. */
async function gasBurned(ctx: RowCtx, start: CanaryFacts): Promise<GasBurn> {
	const { reads } = ctx.deps
	return {
		source: start.balances.sourceNative - (await reads.source.getBalance({ address: ctx.cfg.canary })),
		ethereum: start.balances.ethereumNative - (await reads.ethereum.getBalance({ address: ctx.cfg.canary })),
	}
}

async function discoveryContext(ctx: RowCtx): Promise<CrossChainDiscoveryContext> {
	const { b, cfg, deps } = ctx
	const factory = (functionName: "INBOX" | "ROLLUP_VERSION") =>
		deps.reads.ethereum.readContract({ address: b.factory, abi: FACTORY_CONSTANTS_ABI, functionName })
	return {
		source: { chainId: b.source.chainId, diamond: cfg.lifi.diamond },
		ethereum: {
			chainId: b.l1ChainId,
			router: b.depositRouter,
			executor: cfg.lifi.executor,
			feeJuicePortal: b.feeJuicePortal,
			tokenPortal: b.destToken.portal as Address,
			inbox: {
				address: (await factory("INBOX")) as Address,
				shape: cfg.inbox.shape,
				rollupVersion: (await factory("ROLLUP_VERSION")) as bigint,
				l2Hub: b.hub as Hex,
				feeJuice: cfg.inbox.feeJuice,
			},
		},
		rail: {
			kind: "acrossV4",
			sourceSpokePool: cfg.lifi.sourceSpokePool,
			destinationSpokePool: cfg.lifi.destinationSpokePool,
			receiver: cfg.lifi.receiverAcrossV4,
		},
	}
}

/** `l1` with every send it makes bounded by `budget`, and the terms it charges, for a send made through another wallet. */
export function boundedSigner(l1: L1Ctx, budget: GasBudget, label: string): { l1: L1Ctx; terms: GasTermsFor } {
	const terms = boundedGasTerms(l1.pub as unknown as GasPricing, (worstWei, r) =>
		budget.charge(worstWei, `${label}: a send to ${r.to ?? "a new contract"}`),
	)
	return { l1: { ...l1, wallet: withGasTerms(l1.wallet, terms) }, terms }
}

function boundedRow(run: LiveRun, row: CanaryRow, budgets: RowBudgets): LiveCtx {
	const source = boundedSigner(run.live.source, budgets.source, row.kind)
	const ethereum = boundedSigner(run.live.ethereum, budgets.ethereum, row.kind)
	return { ...run, live: { ...run.live, source: source.l1, ethereum: ethereum.l1 }, fillGas: ethereum.terms }
}

export interface LiveGas {
	caps: CanaryCaps
	perRow: GasPerRow
	/** What the run has burned so far, read fresh from the chains. */
	burned: () => Promise<GasBurn>
}

/**
 * A live run's rows, in order. Before each, one more row's gas must fit under the caps; each row signs under budgets
 * of what the caps have left; after each, the last included, what the run burned is reconciled against the caps.
 *
 * @throws CanaryRefusal at the first row without headroom, the first send over its budget, or the first
 *   reconciliation over a cap; nothing after it runs.
 */
export async function runLiveRows(
	rows: readonly CanaryRow[],
	gas: LiveGas,
	run: (row: CanaryRow, budgets: RowBudgets) => Promise<RowRecord>,
): Promise<{ records: RowRecord[]; burned: GasBurn }> {
	const records: RowRecord[] = []
	let burned = await gas.burned()
	for (const row of rows) {
		assertGasHeadroom(row, burned, gas.perRow, gas.caps)
		records.push(await run(row, rowBudgets(burned, gas.caps)))
		burned = await gas.burned()
		assertGasReconciled(row, burned, gas.caps)
	}
	return { records, burned }
}

const runRow = (ctx: RowCtx, live: LiveCtx | undefined, row: CanaryRow): Promise<RowRecord> =>
	row.origin === "crosschain" ? runCrossChain(ctx, live, row) : runEthereum(ctx, live, row)

async function runDryRows(ctx: RowCtx, rows: readonly CanaryRow[]): Promise<RowRecord[]> {
	const records: RowRecord[] = []
	for (const row of rows) {
		ctx.deps.log(`${row.kind}: ${row.amount}`)
		records.push(await runRow(ctx, undefined, row))
	}
	return records
}

/**
 * Plans the matrix, refuses before any send, then runs each row in order and returns the record to print.
 *
 * @throws CanaryRefusal on any precondition, cap or verification failure, and on a live row whose outcome
 *   contradicts what it sent; nothing after the throwing row runs.
 */
export async function runCanary(cfg: CanaryConfig, deps: CanaryDeps): Promise<CanaryRecord> {
	const b = canaryBindings(cfg.manifest, cfg.sourceChainId)
	const ctx: RowCtx = { cfg, b, deps }
	const facts = await readFacts(ctx)
	assertCanaryIdentity(b, facts)
	const rows = planCanaryRows(cfg.amounts, await acrossLimits(ctx, planCanaryRows(cfg.amounts)))
	const spend = assertWithinCaps(rows, cfg.caps, b.source.chainId, cfg.gasPerRow)
	assertCanaryPreconditions(b, spend, facts)
	const record = { mode: deps.mode.kind, canary: cfg.canary, spend, caps: cfg.caps, funding: fundingShortfalls(spend, facts) }
	if (deps.mode.kind !== "live") return { ...record, rows: await runDryRows(ctx, rows) }

	const live: LiveRun = { ...ctx, live: deps.mode, discovery: await discoveryContext(ctx) }
	const gas: LiveGas = { caps: cfg.caps, perRow: cfg.gasPerRow, burned: () => gasBurned(ctx, facts) }
	const { records, burned } = await runLiveRows(rows, gas, (row, budgets) => {
		deps.log(`${row.kind}: ${row.amount}`)
		return runRow(ctx, boundedRow(live, row, budgets), row)
	})
	return { ...record, rows: records, burned }
}
