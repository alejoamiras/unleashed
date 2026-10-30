// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { ask, NOW_S, OUT, quotedRoute } from "@/test/crosschain"
import { type CrossChainFigures, countdownText, feeCeilingOf, feeShareText, figuresOf, RETRY_WORDS, waitText } from "./crosschain-figures"

describe("RETRY_WORDS", () => {
	it("a testnet retry just tries or signs again; mainnet's keep the boards' quote words", async () => {
		expect(RETRY_WORDS).toEqual({ getNew: "Try again", signAgain: "Sign again." })
		vi.resetModules()
		vi.doMock("@/lib/network", async (original) => ({ ...(await original<typeof import("@/lib/network")>()), IS_MAINNET: true }))
		try {
			const { RETRY_WORDS: mainnet } = await import("./crosschain-figures")
			expect(mainnet).toEqual({ getNew: "Get a new quote", signAgain: "Get a new quote and sign again." })
		} finally {
			vi.doUnmock("@/lib/network")
		}
	})
})

describe("figuresOf", () => {
	it("reads the delivery, the relay fee, the slice and what arrives off a verified route", async () => {
		const route = await quotedRoute()
		const f = figuresOf(ask(), route)
		expect(f.delivered).toBe(OUT)
		expect(f.relayFee).toBe(5_000_000n - OUT)
		expect(feeShareText(f.feeBps)).toBe("2.0 %")
		expect(f.slice).toBe(OUT / 10n)
		expect(f.tokenArrives).toBe(OUT - OUT / 10n)
		expect(f.gasExpected).toBe(route.gas?.expectedOut)
		expect(f.refundAfterSeconds).toBe(route.fillDeadline - NOW_S)
		expect(waitText(f.refundAfterSeconds ?? 0)).toBe("2 hours")
		expect(figuresOf(ask({ intent: "gas" }), route).tokenArrives).toBeNull()
	})
})

describe("feeCeilingOf", () => {
	const over: CrossChainFigures = {
		srcAmount: 5_000_000n,
		delivered: 3_800_000n,
		relayFee: 1_200_000n,
		feeBps: 2400,
		slice: null,
		tokenArrives: 3_800_000n,
		gasExpected: null,
		gasFloor: null,
		etaSeconds: 10,
		refundAfterSeconds: 7200,
		limits: { min: 1_950_000n, max: 8_000_000n },
		fixed: false,
	}

	it("refuses a token send over the ceiling on mainnet only, and never a gas-only one", () => {
		expect(feeCeilingOf(over, 6, { intent: "token", mainnet: true })).toMatchObject({ over: true, blocks: true })
		expect(feeCeilingOf(over, 6, { intent: "token+gas", mainnet: false })).toMatchObject({ over: true, blocks: false })
		expect(feeCeilingOf(over, 6, { intent: "gas", mainnet: true })).toMatchObject({ over: true, blocks: false })
		const under = { ...over, relayFee: 400_000n }
		expect(feeCeilingOf(under, 6, { intent: "token", mainnet: true })).toMatchObject({ over: false, blocks: false })
	})

	it("suggests a typeable minimum over the ceiling, never under the rail's own", () => {
		// 1.20 at 10 % is 12.00, plus the margin, rounded up to whole units.
		expect(feeCeilingOf(over, 6, { intent: "token", mainnet: true }).minimum).toBe(13_000_000n)
		const tiny = { ...over, relayFee: 10_000n, limits: { min: 1_950_000n, max: 8_000_000n } }
		expect(feeCeilingOf(tiny, 6, { intent: "token", mainnet: true }).minimum).toBe(2_000_000n)
	})
})

describe("countdownText", () => {
	it("counts whole seconds up and never below zero", () => {
		expect(countdownText(41_200)).toBe("0:42")
		expect(countdownText(-5)).toBe("0:00")
	})
})
