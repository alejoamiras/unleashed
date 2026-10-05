/**
 * The live canary's matrix as data, and every refusal a run makes before it sends: which rows run, in
 * which order, at what amounts, within which caps, against which manifest and which pinned canary
 * address; and the record a run prints. Pure: the CLI reads the chains and hands the facts in.
 */
import { type Address, getAddress, type Hex } from "viem"
import type { ManifestToken, ManifestV2 } from "../src/manifest-v2"
import { enabledSources } from "../src/source-chains"
import type { AcrossLimits } from "./lifi-canary-across"

/** A refusal before any send, or a contradiction a live row found; the run stops on it. */
export class CanaryRefusal extends Error {
	constructor(message: string) {
		super(`${message} — STOP`)
	}
}

function refuse(message: string): never {
	throw new CanaryRefusal(message)
}

export type CanaryRowKind = "crosschain-public" | "crosschain-private" | "ethereum-plain" | "ethereum-fueled" | "crosschain-recovery"

export interface CanaryRowShape {
	kind: CanaryRowKind
	/** Base Sepolia through Across into `bridgeFromCaller`, or an Ethereum EOA through `bridgeWithPermit`. */
	origin: "crosschain" | "ethereum"
	isPrivate: boolean
	/** Where the fuel slice's Fee Juice goes: the recipient, the PrivateFPC, or nowhere. */
	fuel: "none" | "public" | "private"
	/** The discovery verdict the row must end in. */
	expect: "deposited" | "delivered-to-wallet"
}

/** The rows, in the order a run sends them. The recovery row's floor sits above the swapper's quote, so
 *  the router reverts inside the fill and LI.FI's receiver hands the delivery to the canary on Sepolia. */
export const CANARY_MATRIX: readonly CanaryRowShape[] = [
	{ kind: "crosschain-public", origin: "crosschain", isPrivate: false, fuel: "public", expect: "deposited" },
	{ kind: "crosschain-private", origin: "crosschain", isPrivate: true, fuel: "private", expect: "deposited" },
	{ kind: "ethereum-plain", origin: "ethereum", isPrivate: false, fuel: "none", expect: "deposited" },
	{ kind: "ethereum-fueled", origin: "ethereum", isPrivate: true, fuel: "private", expect: "deposited" },
	{ kind: "crosschain-recovery", origin: "crosschain", isPrivate: false, fuel: "public", expect: "delivered-to-wallet" },
]

export interface CanaryRow extends CanaryRowShape {
	/** Base units of the row's input: the source token cross-chain, the Ethereum token otherwise. */
	amount: bigint
}

/** What a run asks for before Across's limits apply, in base units. */
export interface CanaryAmounts {
	crossChain: bigint
	ethereumPlain: bigint
	ethereumFueled: bigint
}

/**
 * The matrix at its amounts. A cross-chain row is capped at `limits.maxDeposit` when Across quoted one
 * (the testnet cap, A10); without a quote the canary self-fills and only the caps bound it.
 *
 * @throws CanaryRefusal when an amount is not positive, or the capped amount falls under `limits.minDeposit`.
 */
export function planCanaryRows(amounts: CanaryAmounts, limits?: AcrossLimits): CanaryRow[] {
	for (const [name, v] of Object.entries(amounts)) if (v <= 0n) refuse(`the ${name} amount must be positive`)
	const crossChain = limits && limits.maxDeposit < amounts.crossChain ? limits.maxDeposit : amounts.crossChain
	if (limits && crossChain < limits.minDeposit) {
		refuse(`a cross-chain row of ${crossChain} is under Across's minDeposit ${limits.minDeposit}`)
	}
	const amountOf = (r: CanaryRowShape) =>
		r.origin === "crosschain" ? crossChain : r.fuel === "none" ? amounts.ethereumPlain : amounts.ethereumFueled
	return CANARY_MATRIX.map((r) => ({ ...r, amount: amountOf(r) }))
}

/** Spend ceilings for one canary run: tokens in base units, gas in wei. */
export interface CanaryCaps {
	/** The source chain these caps govern. */
	sourceChainId: number
	/** The most one cross-chain row may send. */
	sourcePerRow: bigint
	/** The most the whole matrix may send from the source chain. */
	sourceTotal: bigint
	/** The most the canary may spend in the Ethereum token: Ethereum-origin rows plus every self-fill. */
	ethereumTotal: bigint
	/** The intent's native-gas ceiling on each chain the canary signs on. */
	gasWei: { source: bigint; ethereum: bigint }
}

/** The most gas one row may burn on each chain it signs on, approvals included, in wei. */
export interface GasPerRow {
	source: bigint
	ethereum: bigint
}

export interface CanarySpend {
	source: bigint
	/** Worst case: every cross-chain row self-filled, and a fill never pays more than the deposit's input. */
	ethereum: bigint
	/** Worst case: every row signs on Ethereum (a cross-chain one through its self-fill). */
	gas: { source: bigint; ethereum: bigint }
}

export function canarySpend(rows: readonly CanaryRow[], gasPerRow: GasPerRow): CanarySpend {
	const sum = (pick: (r: CanaryRow) => boolean) => rows.filter(pick).reduce((s, r) => s + r.amount, 0n)
	const crossChain = (r: CanaryRow) => r.origin === "crosschain"
	const source = sum(crossChain)
	const gas = { source: BigInt(rows.filter(crossChain).length) * gasPerRow.source, ethereum: BigInt(rows.length) * gasPerRow.ethereum }
	return { source, ethereum: source + sum((r) => !crossChain(r)), gas }
}

/** @throws CanaryRefusal when the caps govern another source chain, or any row, total or gas budget exceeds them. */
export function assertWithinCaps(rows: readonly CanaryRow[], caps: CanaryCaps, sourceChainId: number, gasPerRow: GasPerRow): CanarySpend {
	if (caps.sourceChainId !== sourceChainId) refuse(`the caps govern source chain ${caps.sourceChainId}, not ${sourceChainId}`)
	for (const r of rows) {
		if (r.origin === "crosschain" && r.amount > caps.sourcePerRow)
			refuse(`${r.kind} sends ${r.amount}, over the per-row cap ${caps.sourcePerRow}`)
	}
	const spend = canarySpend(rows, gasPerRow)
	if (spend.source > caps.sourceTotal) refuse(`the matrix sends ${spend.source} from the source chain, over its cap ${caps.sourceTotal}`)
	if (spend.ethereum > caps.ethereumTotal)
		refuse(`the matrix may spend ${spend.ethereum} on Ethereum, over its cap ${caps.ethereumTotal}`)
	if (spend.gas.source > caps.gasWei.source)
		refuse(`the matrix may burn ${spend.gas.source} wei on the source chain, over its cap ${caps.gasWei.source}`)
	if (spend.gas.ethereum > caps.gasWei.ethereum)
		refuse(`the matrix may burn ${spend.gas.ethereum} wei on Ethereum, over its cap ${caps.gasWei.ethereum}`)
	return spend
}

/**
 * The live check before each row, on what the run actually burned so far (native balance at start minus now).
 *
 * @throws CanaryRefusal when one more row's gas could pass a chain's cap.
 */
export function assertGasHeadroom(row: CanaryRow, burned: { source: bigint; ethereum: bigint }, perRow: GasPerRow, caps: CanaryCaps): void {
	const over = (chain: "source" | "ethereum") => burned[chain] + perRow[chain] > caps.gasWei[chain]
	if (row.origin === "crosschain" && over("source"))
		refuse(`${row.kind}: ${burned.source} wei burned on the source chain leaves no room under ${caps.gasWei.source}`)
	if (over("ethereum")) refuse(`${row.kind}: ${burned.ethereum} wei burned on Ethereum leaves no room under ${caps.gasWei.ethereum}`)
}

/** Everything the rows read from the manifest, resolved once. */
export interface CanaryBindings {
	l1ChainId: number
	depositRouter: Address
	fuelSwapper: Address
	feeAsset: Address
	feeJuicePortal: Address
	permit2: Address
	factory: Address
	hub: string
	fuel: { slippageBps: number; minFuelFj: bigint; fjPerTx: bigint; fjRegister: bigint }
	source: { chainId: number; token: Address; symbol: string; decimals: number }
	/** The rail asset on Ethereum: what Across delivers, what every row deposits, and what a self-fill pays. */
	destToken: ManifestToken
}

/**
 * The manifest's router, swapper, fuel budgets and the Across route from `sourceChainId`.
 *
 * @throws CanaryRefusal when the manifest has no bridge, no `depositRouter`, `fuelSwapper` or `fuel`, does not
 *   route `sourceChainId` over Across.
 */
export function canaryBindings(m: ManifestV2, sourceChainId: number): CanaryBindings {
	const bridge = m.bridge ?? refuse(`the ${m.network} manifest carries no bridge`)
	const { depositRouter, fuelSwapper, fuel } = bridge.l1
	if (!depositRouter || !fuelSwapper || !fuel) refuse("the manifest carries no depositRouter, fuelSwapper and fuel block")
	const source =
		enabledSources(m).find((s) => s.chainId === sourceChainId) ?? refuse(`the manifest routes nothing from chain ${sourceChainId}`)
	if (source.rail !== "acrossV4") refuse(`chain ${sourceChainId} routes over ${source.rail}, not Across`)
	const srcToken = source.tokens[0]
	const destToken =
		bridge.tokens.find((t) => t.erc20.toLowerCase() === srcToken.destToken.toLowerCase()) ??
		refuse(`the routing destToken ${srcToken.destToken} is not a manifest token`)
	return {
		l1ChainId: m.l1ChainId,
		depositRouter: getAddress(depositRouter),
		fuelSwapper: getAddress(fuelSwapper),
		feeAsset: getAddress(m.feeJuice.asset),
		feeJuicePortal: getAddress(bridge.l1.feeJuicePortal),
		permit2: getAddress(bridge.l1.permit2),
		factory: getAddress(bridge.l1.factory),
		hub: bridge.l2.hub.address,
		fuel: {
			slippageBps: fuel.slippageBps,
			minFuelFj: BigInt(fuel.minFuelFj),
			fjPerTx: BigInt(fuel.fjPerTx),
			fjRegister: BigInt(fuel.fjRegister),
		},
		source: { chainId: sourceChainId, token: getAddress(srcToken.address), symbol: srcToken.symbol, decimals: srcToken.decimals },
		destToken,
	}
}

/** What the CLI read from the chains before planning; every field is checked before any send. */
export interface CanaryFacts {
	live: boolean
	chainIds: { source: number; ethereum: number }
	canary: Address
	/** The canary address the intent tooling pins; `null` until the disposable key exists. */
	pinned: Address | null
	/** The router's immutable `SWAP_TARGET`: the swapper the fuel quotes read must be the one it calls. */
	routerSwapTarget: Address
	balances: { sourceToken: bigint; sourceNative: bigint; ethereumToken: bigint; ethereumNative: bigint }
}

/** The balances the matrix needs and does not have; empty when funded. */
export function fundingShortfalls(spend: CanarySpend, f: CanaryFacts): string[] {
	const needs: [string, bigint, bigint][] = [
		["source token", f.balances.sourceToken, spend.source],
		["source native", f.balances.sourceNative, spend.gas.source],
		["Ethereum token", f.balances.ethereumToken, spend.ethereum],
		["Ethereum native", f.balances.ethereumNative, spend.gas.ethereum],
	]
	return needs.filter(([, have, need]) => have < need).map(([what, have, need]) => `${what}: has ${have}, needs ${need}`)
}

/**
 * @throws CanaryRefusal when either RPC answers another chain, the canary is not the pinned address (a live
 *   run refuses while nothing is pinned), or the router swaps through another target than the manifest's swapper.
 */
export function assertCanaryIdentity(b: CanaryBindings, f: CanaryFacts): void {
	if (f.chainIds.source !== b.source.chainId) refuse(`the source RPC answers chain ${f.chainIds.source}, not ${b.source.chainId}`)
	if (f.chainIds.ethereum !== b.l1ChainId) refuse(`the Ethereum RPC answers chain ${f.chainIds.ethereum}, not ${b.l1ChainId}`)
	if (f.pinned === null && f.live) refuse("no canary address is pinned yet; a live run waits for the pin")
	if (f.pinned !== null && getAddress(f.pinned) !== getAddress(f.canary)) refuse(`the canary ${f.canary} is not the pinned ${f.pinned}`)
	if (getAddress(f.routerSwapTarget) !== b.fuelSwapper)
		refuse(`the router swaps through ${f.routerSwapTarget}, not the manifest's swapper`)
}

/** `assertCanaryIdentity`, and a live run funded for its matrix's tokens and gas. @throws CanaryRefusal on either. */
export function assertCanaryPreconditions(b: CanaryBindings, spend: CanarySpend, f: CanaryFacts): void {
	assertCanaryIdentity(b, f)
	const short = fundingShortfalls(spend, f)
	if (f.live && short.length > 0) refuse(`the canary is not funded for the matrix (${short.join("; ")})`)
}

/** The recovery row's signed floor: unreachable for the swapper's quote, so the fill's router call reverts. */
export function recoveryFloor(quote: bigint): bigint {
	if (quote <= 0n) refuse("the swapper quoted nothing for the recovery row's slice")
	return quote * 2n
}

// ── the printed record ───────────────────────────────────────────────────────

export type FillWay = "organic" | "self"

export interface DepositedRecord {
	txHash: Hex
	received: string
	token?: { amount: string; leafIndex: string }
	fuel?: { consumed: string; received: string; leafIndex: string }
}

export interface ClaimRecord {
	path: string
	claimTxHash: string
	registerTxHash?: string
}

export interface RailRecord {
	quote: "across" | "self-built"
	srcAmount: string
	outputAmount: string
}

export type RowRecord =
	| { kind: CanaryRowKind; status: "built"; to: Address; selector: Hex; detail: string }
	| {
			kind: CanaryRowKind
			status: "deposited"
			origin: "crosschain"
			rail: RailRecord
			sourceTx: Hex
			fill: { txHash: Hex; way: FillWay }
			deposited: DepositedRecord
			claim: ClaimRecord
			discovery: string
	  }
	| { kind: CanaryRowKind; status: "deposited"; origin: "ethereum"; ethereumTx: Hex; deposited: DepositedRecord; claim: ClaimRecord }
	| {
			kind: CanaryRowKind
			status: "recovered"
			rail: RailRecord
			sourceTx: Hex
			fill: { txHash: Hex; way: FillWay }
			recovered: { txHash: Hex; amount: string }
			/** The canary's Sepolia token balance across the fill transaction, and what a self-fill paid in it. */
			balance: { delta: string; selfFillPaid: string }
			discovery: string
	  }

export interface CanaryRecord {
	mode: "dry-run" | "live"
	canary: Address
	spend: CanarySpend
	caps: CanaryCaps
	funding: string[]
	rows: RowRecord[]
}

const deposited = (d: DepositedRecord): string => {
	const legs = [
		d.token ? `token ${d.token.amount} leaf ${d.token.leafIndex}` : undefined,
		d.fuel ? `fuel ${d.fuel.consumed} → ${d.fuel.received} FJ leaf ${d.fuel.leafIndex}` : undefined,
	].filter(Boolean)
	return `${d.txHash} (received ${d.received}; ${legs.join("; ")})`
}

const claim = (c: ClaimRecord): string => `${c.claimTxHash} (${c.path}${c.registerTxHash ? `, registered in ${c.registerTxHash}` : ""})`

const rail = (r: RailRecord): string =>
	`${r.srcAmount} in, ${r.outputAmount} out (${r.quote === "across" ? "Across quote" : "self-built, no quote"})`

function rowLines(r: RowRecord): [string, string][] {
	if (r.status === "built") return [["built", `${r.selector} → ${r.to}, verified, not sent (${r.detail})`]]
	if (r.status === "recovered") {
		return [
			["rail", rail(r.rail)],
			["source tx", r.sourceTx],
			["Ethereum fill", `${r.fill.txHash} (${r.fill.way})`],
			["LiFiTransferRecovered", `${r.recovered.txHash} (amount ${r.recovered.amount})`],
			["Sepolia balance Δ", `${r.balance.delta} across the fill (self-fill paid ${r.balance.selfFillPaid})`],
			["discovery", r.discovery],
		]
	}
	if (r.origin === "ethereum") {
		return [
			["Ethereum tx", r.ethereumTx],
			["Deposited", deposited(r.deposited)],
			["L2 claim", claim(r.claim)],
		]
	}
	return [
		["rail", rail(r.rail)],
		["source tx", r.sourceTx],
		["Ethereum fill", `${r.fill.txHash} (${r.fill.way})`],
		["Deposited", deposited(r.deposited)],
		["L2 claim", claim(r.claim)],
		["discovery", r.discovery],
	]
}

/** The block a run prints for `lessons/phase-6.md`: chain facts only, no timestamps, commit ids or secrets. */
export function formatCanaryRecord(rec: CanaryRecord): string {
	const out = [
		`#### LI.FI canary (${rec.mode})`,
		"",
		`- canary: ${rec.canary}`,
		`- spend: source ${rec.spend.source} of cap ${rec.caps.sourceTotal} (chain ${rec.caps.sourceChainId}); Ethereum at most ${rec.spend.ethereum} of cap ${rec.caps.ethereumTotal}`,
		`- gas budget: source ${rec.spend.gas.source} of cap ${rec.caps.gasWei.source} wei; Ethereum ${rec.spend.gas.ethereum} of cap ${rec.caps.gasWei.ethereum} wei`,
		...(rec.funding.length > 0 ? [`- funding short: ${rec.funding.join("; ")}`] : []),
	]
	for (const r of rec.rows) {
		out.push(`- **${r.kind}**`)
		for (const [label, value] of rowLines(r)) out.push(`  - ${label}: ${value}`)
	}
	return out.join("\n")
}
