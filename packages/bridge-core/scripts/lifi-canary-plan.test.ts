import { describe, expect, it } from "vitest"
import type { ManifestV2 } from "../src/manifest-v2"
import { ROUTER, routedManifest, SWAPPER } from "./lifi-canary-fixture"
import {
	assertCanaryPreconditions,
	assertGasHeadroom,
	assertWithinCaps,
	type CanaryCaps,
	type CanaryFacts,
	type CanaryRecord,
	canaryBindings,
	canarySpend,
	formatCanaryRecord,
	planCanaryRows,
	recoveryFloor,
} from "./lifi-canary-plan"

const amounts = { crossChain: 6_000_000n, ethereumPlain: 2_000_000n, ethereumFueled: 3_000_000n }
const gasPerRow = { source: 5n, ethereum: 30n }
const caps: CanaryCaps = {
	sourceChainId: 84532,
	sourcePerRow: 8_000_000n,
	sourceTotal: 24_000_000n,
	ethereumTotal: 30_000_000n,
	gasWei: { source: 50n, ethereum: 200n },
}
const CANARY = `0x${"ca".repeat(20)}` as const

describe("planCanaryRows", () => {
	it("runs the five matrix rows in order, each cross-chain row capped at Across's maxDeposit", () => {
		const rows = planCanaryRows(amounts, { minDeposit: 4_890_000n, maxDeposit: 5_000_000n })
		expect(rows.map((r) => [r.kind, r.amount])).toEqual([
			["crosschain-public", 5_000_000n],
			["crosschain-private", 5_000_000n],
			["ethereum-plain", 2_000_000n],
			["ethereum-fueled", 3_000_000n],
			["crosschain-recovery", 5_000_000n],
		])
		expect(rows.find((r) => r.kind === "crosschain-recovery")?.expect).toBe("delivered-to-wallet")
		expect(planCanaryRows(amounts)[0]?.amount).toBe(6_000_000n)
		expect(() => planCanaryRows(amounts, { minDeposit: 7_000_000n, maxDeposit: 9_000_000n })).toThrow(/under Across's minDeposit/)
	})
})

describe("caps", () => {
	it("refuses a row, a total or a gas budget over its cap, and caps written for another chain", () => {
		const rows = planCanaryRows(amounts)
		expect(assertWithinCaps(rows, caps, 84532, gasPerRow)).toEqual({
			source: 18_000_000n,
			ethereum: 23_000_000n,
			gas: { source: 15n, ethereum: 150n },
		})
		expect(() => assertWithinCaps(rows, { ...caps, sourcePerRow: 5_999_999n }, 84532, gasPerRow)).toThrow(/over the per-row cap/)
		expect(() => assertWithinCaps(rows, { ...caps, sourceTotal: 17_999_999n }, 84532, gasPerRow)).toThrow(/from the source chain, over/)
		expect(() => assertWithinCaps(rows, { ...caps, ethereumTotal: 22_999_999n }, 84532, gasPerRow)).toThrow(/on Ethereum, over/)
		expect(() => assertWithinCaps(rows, caps, 84532, { source: 5n, ethereum: 41n })).toThrow(/wei on Ethereum, over/)
		expect(() => assertWithinCaps(rows, caps, 421614, gasPerRow)).toThrow(/govern source chain 84532/)
	})

	it("stops a live row once the gas already burned leaves no room for it", () => {
		const [cross, , plain] = planCanaryRows(amounts)
		expect(() => assertGasHeadroom(cross!, { source: 45n, ethereum: 0n }, gasPerRow, caps)).not.toThrow()
		expect(() => assertGasHeadroom(cross!, { source: 46n, ethereum: 0n }, gasPerRow, caps)).toThrow(/source chain leaves no room/)
		expect(() => assertGasHeadroom(plain!, { source: 50n, ethereum: 171n }, gasPerRow, caps)).toThrow(/Ethereum leaves no room/)
	})
})

describe("canaryBindings", () => {
	const without = (patch: (m: ManifestV2) => void): ManifestV2 => {
		const m = structuredClone(routedManifest())
		patch(m)
		return m
	}

	it("binds the router, swapper and Across route, and refuses a manifest missing any of them", () => {
		const b = canaryBindings(routedManifest(), 84532)
		expect([b.depositRouter.toLowerCase(), b.fuelSwapper.toLowerCase(), b.destToken.erc20]).toEqual([
			ROUTER,
			SWAPPER,
			"0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
		])
		expect(() =>
			canaryBindings(
				without((m) => (m.bridge!.l1.depositRouter = undefined)),
				84532,
			),
		).toThrow(/no depositRouter/)
		expect(() =>
			canaryBindings(
				without((m) => (m.bridge!.l1.fuelSwapper = undefined)),
				84532,
			),
		).toThrow(/no depositRouter, fuelSwapper/)
		expect(() =>
			canaryBindings(
				without((m) => (m.bridge!.l1.fuel = undefined)),
				84532,
			),
		).toThrow(/fuel block/)
		expect(() =>
			canaryBindings(
				without((m) => (m.bridge!.routing = null)),
				84532,
			),
		).toThrow(/routes nothing from chain 84532/)
		expect(() =>
			canaryBindings(
				without((m) => (m.bridge!.routing!.sources[0]!.rail = "stargateV2")),
				84532,
			),
		).toThrow(/not Across/)
		const stranger = without((m) => (m.bridge!.tokens = m.bridge!.tokens.slice(0, -1)))
		expect(() => canaryBindings(stranger, 84532)).toThrow(/not a manifest token/)
	})
})

describe("assertCanaryPreconditions", () => {
	const b = canaryBindings(routedManifest(), 84532)
	const spend = canarySpend(planCanaryRows(amounts), gasPerRow)
	const facts = (patch: Partial<CanaryFacts> = {}): CanaryFacts => ({
		live: true,
		chainIds: { source: 84532, ethereum: 11155111 },
		canary: CANARY,
		pinned: CANARY,
		routerSwapTarget: SWAPPER,
		balances: { sourceToken: 10n ** 9n, sourceNative: 10n ** 18n, ethereumToken: 10n ** 9n, ethereumNative: 10n ** 18n },
		...patch,
	})

	it("refuses another chain, an unpinned or foreign canary, a foreign swap target and an unfunded live run", () => {
		expect(() => assertCanaryPreconditions(b, spend, facts())).not.toThrow()
		expect(() => assertCanaryPreconditions(b, spend, facts({ chainIds: { source: 8453, ethereum: 11155111 } }))).toThrow(
			/source RPC answers chain 8453/,
		)
		expect(() => assertCanaryPreconditions(b, spend, facts({ chainIds: { source: 84532, ethereum: 1 } }))).toThrow(
			/Ethereum RPC answers chain 1,/,
		)
		expect(() => assertCanaryPreconditions(b, spend, facts({ pinned: null }))).toThrow(/no canary address is pinned/)
		expect(() => assertCanaryPreconditions(b, spend, facts({ pinned: `0x${"cb".repeat(20)}` }))).toThrow(/is not the pinned/)
		expect(() => assertCanaryPreconditions(b, spend, facts({ routerSwapTarget: ROUTER }))).toThrow(/not the manifest's swapper/)
		const poor = { sourceToken: 1n, sourceNative: 10n ** 18n, ethereumToken: 10n ** 9n, ethereumNative: 10n ** 18n }
		expect(() => assertCanaryPreconditions(b, spend, facts({ balances: poor }))).toThrow(
			/not funded .*source token: has 1, needs 18000000/,
		)
		expect(() => assertCanaryPreconditions(b, spend, facts({ live: false, pinned: null, balances: poor }))).not.toThrow()
	})
})

describe("the recovery row", () => {
	it("signs a floor above the swapper's quote", () => {
		expect(recoveryFloor(1_000n)).toBeGreaterThan(1_000n)
		expect(() => recoveryFloor(0n)).toThrow(/quoted nothing/)
	})
})

describe("formatCanaryRecord", () => {
	const tx = (n: string) => `0x${n.repeat(64)}` as const
	const claim = { path: "private", claimTxHash: tx("c"), registerTxHash: tx("d") }
	const rail = { quote: "across" as const, srcAmount: "5000000", outputAmount: "3800000" }
	const deposited = {
		txHash: tx("e"),
		received: "3800000",
		token: { amount: "3700000", leafIndex: "41" },
		fuel: { consumed: "100000", received: "10000000000000000000", leafIndex: "42" },
	}
	const rec: CanaryRecord = {
		mode: "live",
		canary: CANARY,
		spend: { source: 15_000_000n, ethereum: 20_000_000n, gas: { source: 15n, ethereum: 150n } },
		caps,
		funding: [],
		rows: [
			{
				kind: "crosschain-public",
				status: "deposited",
				origin: "crosschain",
				rail,
				sourceTx: tx("1"),
				fill: { txHash: tx("e"), way: "organic" },
				deposited,
				claim,
				discovery: "deposited (expected deposited)",
			},
			{
				kind: "ethereum-plain",
				status: "deposited",
				origin: "ethereum",
				ethereumTx: tx("2"),
				deposited: { txHash: tx("2"), received: "2000000", token: { amount: "2000000", leafIndex: "43" } },
				claim,
			},
			{
				kind: "crosschain-recovery",
				status: "recovered",
				rail,
				sourceTx: tx("3"),
				fill: { txHash: tx("4"), way: "self" },
				recovered: { txHash: tx("4"), amount: "3800000" },
				balance: { delta: "0", selfFillPaid: "3800000" },
				discovery: "delivered-to-wallet (expected delivered-to-wallet)",
			},
		],
	}

	it("prints every gate field per row, and no time", () => {
		const out = formatCanaryRecord(rec)
		for (const field of [
			"source tx",
			"Ethereum fill",
			"(organic)",
			"(self)",
			"Deposited",
			"L2 claim",
			"discovery",
			"Ethereum tx",
			"LiFiTransferRecovered",
			"Sepolia balance Δ",
			"gas budget",
		]) {
			expect(out).toContain(field)
		}
		expect(out).toContain(`${tx("4")} (amount 3800000)`)
		expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/)
	})
})
