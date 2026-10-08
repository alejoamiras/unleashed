// @vitest-environment node
import { acrossMessageOf, lifiBook, TESTNET_FILLER } from "@unleashed/bridge-core"
import { describe, expect, it } from "vitest"
import { NO_GAS_ROUTE } from "@/lib/send-model"
import { acrossApi, ask, BASE_SEPOLIA, NOW_S, OUT, routeDeps } from "@/test/crosschain"
import { type CrossChainAsk, quoteCrossChainRoute, ROUTE_TTL_MS, type RouteDeps, useCrossChainRoute } from "./useCrossChainRoute"

describe("quoteCrossChainRoute", () => {
	it("prices our exact message, then builds and verifies the deposit for what Across delivers", async () => {
		const across = acrossApi()
		const { answer } = await quoteCrossChainRoute(ask(), routeDeps({ across }))
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
		const { answer } = await quoteCrossChainRoute(ask(), routeDeps({ venue: "answers-another-slice" }))
		expect(answer).toMatchObject({ kind: "refused", field: "fuelSwap._swapData.fromAmount" })
	})

	it("tells no route from an outage, and routes only the rail it builds", async () => {
		const outcome = async (a: CrossChainAsk, d: RouteDeps) => (await quoteCrossChainRoute(a, d)).answer
		expect(await outcome(ask(), routeDeps({ venue: "reverts" }))).toEqual({ kind: "no-route", reason: NO_GAS_ROUTE })
		expect(await outcome(ask(), routeDeps({ venue: "down" }))).toMatchObject({ kind: "unavailable" })
		expect(await outcome(ask(), routeDeps({ across: acrossApi("error") }))).toMatchObject({
			kind: "no-route",
			reason: expect.stringContaining("AMOUNT_TOO_LOW"),
		})
		expect(await outcome(ask({ rail: "stargateV2" }), routeDeps())).toMatchObject({ kind: "unavailable" })
		// A token-only send never asks the venue.
		const tokenOnly = await outcome(ask({ intent: "token" }), routeDeps({ venue: "down" }))
		expect(tokenOnly.kind === "route" && tokenOnly.route.gas).toBeUndefined()
	})

	it("off mainnet, builds every deposit on fixed terms held for the testnet filler, without asking Across", async () => {
		const across = acrossApi()
		const { answer } = await quoteCrossChainRoute(ask(), routeDeps({ across, fixedAt: NOW_S }))
		if (answer.kind !== "route") throw new Error(`expected a route, got ${JSON.stringify(answer)}`)
		const { route } = answer
		expect(across.asked).toHaveLength(0)
		expect([route.terms, route.limits, route.minReceived, route.fillDeadline]).toEqual(["fixed", null, 3_750_000n, NOW_S + 7_200])
		expect(route.x.rail).toMatchObject({ outputAmount: 3_750_000n, quoteTimestamp: NOW_S, exclusiveRelayer: TESTNET_FILLER })
		expect(route.gas?.fuelAmount).toBe(375_000n)
	})
})

describe("quoteCrossChainRoute on fixed terms", () => {
	it("carries at most the testnet cap per send, and refuses more as no route naming the cap", async () => {
		const at = (srcAmount: bigint) => quoteCrossChainRoute(ask({ srcAmount }), routeDeps({ fixedAt: NOW_S }))
		expect((await at(8_000_000n)).answer.kind).toBe("route")
		expect((await at(8_000_001n)).answer).toMatchObject({ kind: "no-route", max: 8_000_000n })
	})
})

describe("useCrossChainRoute", () => {
	it("publishes only the latest ask, and its route expires after the TTL", async () => {
		let now = 1_000
		const across = acrossApi()
		const q = useCrossChainRoute(routeDeps({ across }), { now: () => now })
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
