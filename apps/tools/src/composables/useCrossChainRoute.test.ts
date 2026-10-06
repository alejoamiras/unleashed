// @vitest-environment node
import { Fr } from "@aztec-labs/aztec.js/fields"
import { acrossMessageOf, lifiBook, testnetSwapperFuelProvider } from "@unleashed/bridge-core"
import type { Address } from "viem"
import { describe, expect, it, vi } from "vitest"
import { NO_GAS_ROUTE } from "@/lib/send-model"
import { type CrossChainAsk, quoteCrossChainRoute, ROUTE_TTL_MS, type RouteDeps, useCrossChainRoute } from "./useCrossChainRoute"

const BASE_SEPOLIA = 84532
const SEPOLIA = 11155111
const NOW_S = 1_800_000_000
const OUT = 4_900_000n
const SRC_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
const DEST_USDC: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"

const ask = (over: Partial<CrossChainAsk> = {}): CrossChainAsk => ({
	srcChainId: BASE_SEPOLIA,
	rail: "acrossV4",
	srcToken: { address: SRC_USDC, decimals: 6, destToken: DEST_USDC },
	srcAmount: 5_000_000n,
	user: "0x51Cd54Fab6Bc72c4c313C7d2DD4E0bE1A4390f44",
	intent: "token+gas",
	isPrivate: false,
	recipient: `0x${"0a".repeat(32)}`,
	...over,
})

/** Across's `/suggested-fees`, answering every request for `OUT` (or with its own error code). */
function acrossApi(answer: "quote" | "error" = "quote") {
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

type Venue = "swapper" | "reverts" | "down" | "answers-another-slice"

function deps(o: { venue?: Venue; across?: ReturnType<typeof acrossApi> } = {}): RouteDeps {
	const venue = o.venue ?? "swapper"
	const quote = async (_: Address, amountIn: bigint) => {
		if (venue === "reverts" || venue === "down") throw new Error(venue)
		return amountIn * 10n ** 12n
	}
	return {
		bindings: {
			l1ChainId: SEPOLIA,
			router: "0x0a10b46de02a303c922d2c0cb47bfe79c073dc0f",
			feeAsset: "0x5e13ad06a772cd0f9f3785bc98c4b36254661171",
		},
		across: (o.across ?? acrossApi()).client,
		fuel: (lifiTxId) => {
			const provider = testnetSwapperFuelProvider({
				reader: { quote },
				swapper: `0x${"5e".repeat(20)}`,
				router: "0x0a10b46de02a303c922d2c0cb47bfe79c073dc0f",
				feeAsset: "0x5e13ad06a772cd0f9f3785bc98c4b36254661171",
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
	}
}

describe("quoteCrossChainRoute", () => {
	it("prices our exact message, then builds and verifies the deposit for what Across delivers", async () => {
		const across = acrossApi()
		const { answer } = await quoteCrossChainRoute(ask(), deps({ across }))
		if (answer.kind !== "route") throw new Error(`expected a route, got ${JSON.stringify(answer)}`)
		const { route } = answer
		expect([route.minReceived, route.maxPull]).toEqual([OUT, OUT])
		// The slice is sized from the delivery, not from what left the source chain.
		expect(route.gas?.fuelAmount).toBe(OUT / 10n)
		expect(route.intent.aztecRecipient).toBe(ask().recipient)
		expect(route.tx.to).toBe(lifiBook(BASE_SEPOLIA).diamond)
		expect(route.tx.approval.amount).toBe(5_000_000n)
		// The message Across priced has the signed one's length, so the relayer's gas estimate holds.
		expect(across.asked).toHaveLength(1)
		expect(across.asked[0].searchParams.get("message")?.length).toBe(acrossMessageOf(route.x).length)
	})

	it("never offers bytes the decoder refuses: a venue answering for another slice", async () => {
		const { answer } = await quoteCrossChainRoute(ask(), deps({ venue: "answers-another-slice" }))
		expect(answer).toMatchObject({ kind: "refused", field: "fuelSwap._swapData.fromAmount" })
	})

	it("tells no route from an outage, and routes only the rail it builds", async () => {
		const outcome = async (a: CrossChainAsk, d: RouteDeps) => (await quoteCrossChainRoute(a, d)).answer
		expect(await outcome(ask(), deps({ venue: "reverts" }))).toEqual({ kind: "no-route", reason: NO_GAS_ROUTE })
		expect(await outcome(ask(), deps({ venue: "down" }))).toMatchObject({ kind: "unavailable" })
		expect(await outcome(ask(), deps({ across: acrossApi("error") }))).toMatchObject({
			kind: "no-route",
			reason: expect.stringContaining("AMOUNT_TOO_LOW"),
		})
		expect(await outcome(ask({ rail: "stargateV2" }), deps())).toMatchObject({ kind: "unavailable" })
		// A token-only send never asks the venue.
		const tokenOnly = await outcome(ask({ intent: "token" }), deps({ venue: "down" }))
		expect(tokenOnly.kind === "route" && tokenOnly.route.gas).toBeUndefined()
	})
})

describe("useCrossChainRoute", () => {
	it("publishes only the latest ask, and its route expires after the TTL", async () => {
		let now = 1_000
		const across = acrossApi()
		const q = useCrossChainRoute(deps({ across }), { now: () => now })
		void q.quote(ask({ srcAmount: 4_000_000n }))
		await q.quote(ask())
		expect(across.asked).toHaveLength(1)
		expect(q.quoted.value?.ask.srcAmount).toBe(5_000_000n)
		expect(q.fresh()?.outcome.kind).toBe("route")
		now += ROUTE_TTL_MS + 1
		expect(q.fresh()).toBeNull()
		expect(q.quoted.value).not.toBeNull()
		q.dispose()
	})
})
