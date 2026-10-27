/**
 * Fuel quotes for the router's swap leg: what a slice of the deposit token buys in the fee asset, and the
 * `swapData` the router hands its `SWAP_TARGET`. Two providers answer one shape: LI.FI's same-chain quote (mainnet)
 * and `TestnetFuelSwapper`'s fixed rate (everywhere else). The floor is always `signedMinFuelOutput` of the quote and
 * is written into the call's `_minAmountOut`, so the facet checks the floor the router checks (LI.FI's own
 * `toAmountMin` can never equal it: the floor never drops below the claim minimum). I/O is injected.
 */
import { type Address, concat, encodeFunctionData, type Hex, numberToHex, pad, parseAbi, size, slice, zeroHash } from "viem"
import { signedMinFuelOutput } from "./gas-share"
import { FUEL_SWAP_SELECTORS, SWAP_TOKENS_SINGLE_V3_ABI } from "./lifi-abi"
import { lifiBook } from "./lifi-addresses"
import { LIFI_INTEGRATOR, type LifiClient, type LifiQuote, type LifiRefusal, lifiSameChainQuote } from "./lifi-api"
import { LIFI_ALLOW_EXCHANGES } from "./lifi-gas"
import type { ManifestV2 } from "./manifest-v2"

/**
 * Both pinned functions open with `(bytes32, string, string, address _receiver, uint256 _minAmountOut, …)`, so the two
 * words sit at the same calldata offsets in either: selector + three head words, and + four.
 */
const RECEIVER_OFFSET = 100
const MIN_AMOUNT_OUT_OFFSET = 132
const HEAD_END = 164

const UINT256_MAX = (1n << 256n) - 1n

interface FuelQuoteBase {
	/** The bytes the router passes to its `SWAP_TARGET`, `_minAmountOut` already equal to `minOut`. */
	swapData: Hex
	/** The slice, in deposit-token base units. */
	amountIn: bigint
	/** The provider's estimate, in fee-asset base units; display and floor input only. */
	expectedOut: bigint
	/** `signedMinFuelOutput(expectedOut, …)`: the intent's `minFuelOutput` and the call's `_minAmountOut`. */
	minOut: bigint
}

export type FuelQuote = (FuelQuoteBase & { provider: "lifi"; tool: string }) | (FuelQuoteBase & { provider: "testnetSwapper" })

/** A dust quote, the rate `proposeGasShare` sizes the slice from. */
export interface FuelProbe {
	probeIn: bigint
	probeOut: bigint
	/** LI.FI's venue for the probe; display only, the quote at the slice names its own. */
	tool?: string
}

export type FuelQuoteRefusal =
	/** The provider gave no quote: LI.FI's refusal when it was LI.FI, else the reader's error. */
	| { ok: false; reason: "provider"; message: string; lifi?: LifiRefusal }
	/** The quote's bytes or fields break a pin; `field` names the first. */
	| { ok: false; reason: "unsafe"; field: string }
	/** The slice cannot buy a positive floor: the quote is zero, the floor rounds to zero, or the floor exceeds it. */
	| { ok: false; reason: "floor"; expectedOut: bigint; floor: bigint }

export type FuelResult<T> = ({ ok: true } & T) | FuelQuoteRefusal

export interface FuelQuoteProvider {
	probe(token: Address, probeIn: bigint): Promise<FuelResult<{ probe: FuelProbe }>>
	/** A quote at exactly `amountIn`, with the floor already written into `swapData`. */
	quote(token: Address, amountIn: bigint): Promise<FuelResult<{ quote: FuelQuote }>>
}

/** The fee budgets both providers floor against, from the manifest's `l1.fuel`. */
export interface FuelFloorPolicy {
	slippageBps: number
	minFuelFj: bigint
}

type SwapCallFields = { receiver: Hex; minAmountOut: bigint }

function swapCallFields(swapData: Hex): SwapCallFields | { field: string } {
	if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(swapData) || size(swapData) < HEAD_END) return { field: "swapData" }
	const selector = slice(swapData, 0, 4).toLowerCase() as Hex
	if (!FUEL_SWAP_SELECTORS.includes(selector)) return { field: "selector" }
	return {
		receiver: slice(swapData, RECEIVER_OFFSET, MIN_AMOUNT_OUT_OFFSET).toLowerCase() as Hex,
		minAmountOut: BigInt(slice(swapData, MIN_AMOUNT_OUT_OFFSET, HEAD_END)),
	}
}

/**
 * Returns `swapData` with its `_minAmountOut` word replaced by `floor`, every other byte unchanged. Throws unless
 * `swapData` is a call to one of `FUEL_SWAP_SELECTORS` at least as long as their fixed head, and `floor` fits a uint256.
 */
export function withFuelFloor(swapData: Hex, floor: bigint): Hex {
	const fields = swapCallFields(swapData)
	if ("field" in fields) throw new Error(`fuel-quote: refusing to rewrite swapData (${fields.field})`)
	if (floor < 0n || floor > UINT256_MAX) throw new Error("fuel-quote: floor out of uint256 range")
	return concat([slice(swapData, 0, MIN_AMOUNT_OUT_OFFSET), numberToHex(floor, { size: 32 }), slice(swapData, HEAD_END)])
}

function floorFor(expectedOut: bigint, p: FuelFloorPolicy): bigint | FuelQuoteRefusal {
	if (expectedOut <= 0n) return { ok: false, reason: "floor", expectedOut, floor: p.minFuelFj }
	const floor = signedMinFuelOutput(expectedOut, p.slippageBps, p.minFuelFj)
	// The router requires a positive floor whenever a swap runs, and a floor above the quote would revert by design.
	if (floor <= 0n || floor > expectedOut) return { ok: false, reason: "floor", expectedOut, floor }
	return floor
}

function assertSlice(amountIn: bigint): void {
	if (amountIn <= 0n) throw new Error("fuel-quote: the slice must be positive")
}

export interface LifiFuelProviderOptions extends FuelFloorPolicy {
	client: LifiClient
	/** The destination L1 the router lives on. */
	chainId: number
	/** The router's `SWAP_TARGET`: a quote that calls or needs an approval for anything else is refused. */
	diamond: Address
	/** Payer and receiver of the swap; the `_receiver` word must name it. */
	router: Address
	feeAsset: Address
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The pins a LI.FI fuel quote must meet before its bytes are used; returns the first field that breaks one. */
function unsafeLifiField(o: LifiFuelProviderOptions, q: LifiQuote): string | undefined {
	const allowed: readonly string[] = LIFI_ALLOW_EXCHANGES
	const venues = [q.tool, ...q.includedSteps.filter((s) => s.type === "swap").map((s) => s.tool)]
	if (!venues.every((t) => allowed.includes(t))) return "tool"
	if (!sameAddress(q.transactionRequest.to, o.diamond)) return "transactionRequest.to"
	if (!sameAddress(q.estimate.approvalAddress, o.diamond)) return "estimate.approvalAddress"
	if (q.transactionRequest.value !== 0n) return "transactionRequest.value"
	const fields = swapCallFields(q.transactionRequest.data)
	if ("field" in fields) return fields.field
	if (fields.receiver !== pad(o.router.toLowerCase() as Hex)) return "_receiver"
	// The bytes and the estimate describe the same quote only if LI.FI wrote its own minimum into the call.
	if (fields.minAmountOut !== q.estimate.toAmountMin) return "_minAmountOut"
	return undefined
}

async function lifiQuoteChecked(o: LifiFuelProviderOptions, token: Address, amountIn: bigint): Promise<FuelResult<{ quote: LifiQuote }>> {
	assertSlice(amountIn)
	const res = await lifiSameChainQuote(o.client, {
		chainId: o.chainId,
		fromToken: token,
		toToken: o.feeAsset,
		fromAmount: amountIn,
		router: o.router,
		slippageBps: o.slippageBps,
	})
	if (!res.ok) return { ok: false, reason: "provider", message: `LI.FI refused: ${res.reason}`, lifi: res }
	const field = unsafeLifiField(o, res.value)
	return field === undefined ? { ok: true, quote: res.value } : { ok: false, reason: "unsafe", field }
}

/**
 * LI.FI's same-chain quote, paid and received by the router. A quote is refused unless every swap on it runs on a
 * `LIFI_ALLOW_EXCHANGES` venue, it calls and needs approval for `diamond` alone, carries no value, uses a pinned
 * selector, names the router as `_receiver` and agrees with its own estimate; the returned `swapData` differs from
 * LI.FI's bytes only in the `_minAmountOut` word.
 */
export function lifiFuelProvider(o: LifiFuelProviderOptions): FuelQuoteProvider {
	return {
		async probe(token, probeIn) {
			const res = await lifiQuoteChecked(o, token, probeIn)
			return res.ok ? { ok: true, probe: { probeIn, probeOut: res.quote.estimate.toAmount, tool: res.quote.tool } } : res
		},
		async quote(token, amountIn) {
			const res = await lifiQuoteChecked(o, token, amountIn)
			if (!res.ok) return res
			const q = res.quote
			const floor = floorFor(q.estimate.toAmount, o)
			if (typeof floor !== "bigint") return floor
			const swapData = withFuelFloor(q.transactionRequest.data, floor)
			return {
				ok: true,
				quote: { provider: "lifi", tool: q.tool, swapData, amountIn, expectedOut: q.estimate.toAmount, minOut: floor },
			}
		},
	}
}

/** `TestnetFuelSwapper.quote(token, amountIn)`, read from the chain; rejects for a token without a rate. */
export interface FuelSwapperReader {
	quote(token: Address, amountIn: bigint): Promise<bigint>
}

export interface TestnetSwapperProviderOptions extends FuelFloorPolicy {
	reader: FuelSwapperReader
	swapper: Address
	router: Address
	feeAsset: Address
	/** Only the swapper's `Swapped` event carries it; a cross-chain send passes its `lifiTxId`. */
	transactionId?: Hex
}

async function readSwapperQuote(o: TestnetSwapperProviderOptions, token: Address, amountIn: bigint): Promise<FuelResult<{ out: bigint }>> {
	assertSlice(amountIn)
	try {
		return { ok: true, out: await o.reader.quote(token, amountIn) }
	} catch (e) {
		return { ok: false, reason: "provider", message: e instanceof Error ? e.message : String(e) }
	}
}

/** The fixed-rate swapper, called with LI.FI's single-swap ABI exactly as the router calls the Diamond. */
export function testnetSwapperFuelProvider(o: TestnetSwapperProviderOptions): FuelQuoteProvider {
	return {
		async probe(token, probeIn) {
			const res = await readSwapperQuote(o, token, probeIn)
			return res.ok ? { ok: true, probe: { probeIn, probeOut: res.out } } : res
		},
		async quote(token, amountIn) {
			const res = await readSwapperQuote(o, token, amountIn)
			if (!res.ok) return res
			const floor = floorFor(res.out, o)
			if (typeof floor !== "bigint") return floor
			const swapData = encodeFunctionData({
				abi: SWAP_TOKENS_SINGLE_V3_ABI,
				functionName: "swapTokensSingleV3ERC20ToERC20",
				args: [
					o.transactionId ?? zeroHash,
					LIFI_INTEGRATOR,
					"",
					o.router,
					floor,
					{
						callTo: o.swapper,
						approveTo: o.swapper,
						sendingAssetId: token,
						receivingAssetId: o.feeAsset,
						fromAmount: amountIn,
						callData: "0x",
						requiresDeposit: true,
					},
				],
			})
			return { ok: true, quote: { provider: "testnetSwapper", swapData, amountIn, expectedOut: res.out, minOut: floor } }
		},
	}
}

/** `TestnetFuelSwapper.quote`, the one read its provider makes. */
export const FUEL_SWAPPER_QUOTE_ABI = parseAbi(["function quote(address token, uint256 amountIn) view returns (uint256)"])

/** The Ethereum read a manifest's providers make (a viem public client's `readContract`). */
export interface FuelQuoteReads {
	readContract(args: {
		address: Address
		abi: typeof FUEL_SWAPPER_QUOTE_ABI
		functionName: "quote"
		args: readonly [Address, bigint]
	}): Promise<unknown>
}

/**
 * The provider a manifest's deposit router swaps through, floored by its `l1.fuel` budgets: the pinned
 * `TestnetFuelSwapper` wherever one is listed, otherwise LI.FI on the manifest's L1 through `o.lifi`.
 * Undefined for a bridge without a deposit router, or on LI.FI without a client.
 */
export function manifestFuelProvider(
	m: ManifestV2,
	reads: FuelQuoteReads,
	o: { lifi?: LifiClient; transactionId?: Hex } = {},
): FuelQuoteProvider | undefined {
	const l1 = m.bridge?.l1
	if (!l1?.depositRouter || !l1.fuel) return undefined
	const policy = { slippageBps: l1.fuel.slippageBps, minFuelFj: BigInt(l1.fuel.minFuelFj) }
	const router = l1.depositRouter as Address
	const feeAsset = m.feeJuice.asset as Address
	const swapper = l1.fuelSwapper as Address | undefined
	if (swapper) {
		const quote = async (token: Address, amountIn: bigint) =>
			(await reads.readContract({
				address: swapper,
				abi: FUEL_SWAPPER_QUOTE_ABI,
				functionName: "quote",
				args: [token, amountIn],
			})) as bigint
		return testnetSwapperFuelProvider({ reader: { quote }, swapper, router, feeAsset, transactionId: o.transactionId, ...policy })
	}
	if (!o.lifi) return undefined
	return lifiFuelProvider({ client: o.lifi, chainId: m.l1ChainId, diamond: lifiBook(m.l1ChainId).diamond, router, feeAsset, ...policy })
}
