import { Fr } from "@aztec-labs/aztec.js/fields"
import { lifiBook, TESTNET_FILLER, testnetSwapperFuelProvider } from "@unleashed/bridge-core"
import { type Address, type Hex, keccak256, toBytes } from "viem"
import { vi } from "vitest"
import { type CrossChainAsk, type CrossChainRoute, quoteCrossChainRoute, type RouteDeps } from "@/composables/useCrossChainRoute"
import type { ResolvedToken } from "@/lib/send-model"

export const BASE_SEPOLIA = 84532
export const SEPOLIA = 11155111
export const NOW_S = 1_800_000_000
/** What the stub Across delivers for every deposit. */
export const OUT = 4_900_000n
export const SRC_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
export const DEST_USDC: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
export const USER: Address = "0x51Cd54Fab6Bc72c4c313C7d2DD4E0bE1A4390f44"
const ROUTER: Address = "0x0a10b46de02a303c922d2c0cb47bfe79c073dc0f"
const FEE_ASSET: Address = "0x5e13ad06a772cd0f9f3785bc98c4b36254661171"

export const ask = (over: Partial<CrossChainAsk> = {}): CrossChainAsk => ({
	srcChainId: BASE_SEPOLIA,
	rail: "acrossV4",
	srcToken: { address: SRC_USDC, decimals: 6, destToken: DEST_USDC },
	srcAmount: 5_000_000n,
	user: USER,
	intent: "token+gas",
	isPrivate: false,
	recipient: `0x${"0a".repeat(32)}`,
	...over,
})

/** The manifest token the stub route delivers. */
export const DEST_TOKEN: ResolvedToken = {
	chainId: SEPOLIA,
	address: DEST_USDC.toLowerCase() as Address,
	symbol: "USDC",
	name: "USDC",
	decimals: 6,
	source: "manifest",
	logoKey: `${SEPOLIA}:${DEST_USDC.toLowerCase()}`,
	state: { kind: "first-time" },
	portal: "0x00000000000000000000000000000000000c1013",
	words: { nameWord: `0x${"1".repeat(64)}`, symbolWord: `0x${"2".repeat(64)}` },
	l2Token: `0x${"c".repeat(64)}`,
}

/** Across's `/suggested-fees`, answering every request for `OUT` (or with its own error code). */
export function acrossApi(answer: "quote" | "error" = "quote") {
	const asked: URL[] = []
	const fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input))
		asked.push(url)
		if (answer === "error") return Response.json({ code: "AMOUNT_TOO_LOW" }, { status: 400 })
		return Response.json({
			outputAmount: OUT.toString(),
			timestamp: String(NOW_S),
			fillDeadline: String(NOW_S + 7_200),
			isAmountTooLow: false,
			estimatedFillTimeSec: 90,
			spokePoolAddress: lifiBook(BASE_SEPOLIA).acrossSpokePool,
			destinationSpokePoolAddress: lifiBook(SEPOLIA).acrossSpokePool,
			inputToken: { address: url.searchParams.get("inputToken"), chainId: BASE_SEPOLIA },
			outputToken: { address: url.searchParams.get("outputToken"), chainId: SEPOLIA },
			limits: { minDeposit: "1000", maxDeposit: "100000000" },
		})
	})
	return { client: { fetch: fetch as unknown as typeof globalThis.fetch, base: "https://across.test/api" }, asked }
}

export type Venue = "swapper" | "reverts" | "down" | "answers-another-slice"

/** A fixed-rate swapper venue and a stub Across; the slice is a tenth of the delivery. */
export function routeDeps(o: { venue?: Venue; across?: ReturnType<typeof acrossApi>; fixedAt?: number } = {}): RouteDeps {
	const venue = o.venue ?? "swapper"
	const quote = async (_: Address, amountIn: bigint) => {
		if (venue === "reverts" || venue === "down") throw new Error(venue)
		return amountIn * 10n ** 12n
	}
	return {
		bindings: { l1ChainId: SEPOLIA, router: ROUTER, feeAsset: FEE_ASSET },
		across: (o.across ?? acrossApi()).client,
		fuel: (lifiTxId) => {
			const provider = testnetSwapperFuelProvider({
				reader: { quote },
				swapper: `0x${"5e".repeat(20)}`,
				router: ROUTER,
				feeAsset: FEE_ASSET,
				transactionId: lifiTxId,
				slippageBps: 300,
				minFuelFj: 1n,
			})
			// A venue that prices the slice it was asked for but returns the swap for another amount.
			const answered =
				venue === "answers-another-slice" ? { ...provider, quote: (t: Address, a: bigint) => provider.quote(t, a + 1n) } : provider
			return { provider: answered, reverted: () => venue === "reverts" }
		},
		slice: (_, delivered) => delivered / 10n,
		random: Fr.random,
		nowSec: () => NOW_S,
		...(o.fixedAt === undefined ? {} : { fixedTerms: { filler: TESTNET_FILLER, sourceHeadSec: async () => o.fixedAt as number } }),
	}
}

/** A verified route for `a` from the stubs. */
export async function quotedRoute(a: CrossChainAsk = ask()): Promise<CrossChainRoute> {
	const { answer } = await quoteCrossChainRoute(a, routeDeps())
	if (answer.kind !== "route") throw new Error(`the stubs route every ask, got ${answer.kind}`)
	return answer.route
}

/** A deterministic 65-byte signature per message, so a seal's self-test signs the same thing twice. */
export const signatureOf = (message: string): Hex => {
	const h = keccak256(toBytes(message))
	return `${h}${h.slice(2)}1b` as Hex
}

/** A storage stub for code that reads `localStorage` directly. */
export function memoryStorage(): Storage {
	const store = new Map<string, string>()
	return {
		get length() {
			return store.size
		},
		clear: () => store.clear(),
		getItem: (k) => store.get(k) ?? null,
		key: (i) => [...store.keys()][i] ?? null,
		removeItem: (k) => void store.delete(k),
		setItem: (k, v) => void store.set(k, v),
	}
}
