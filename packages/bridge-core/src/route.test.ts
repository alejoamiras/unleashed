import { describe, expect, it } from "vitest"
import { buildFuelRoute, type FuelRouteConfig } from "./route"

// The LIVE Sepolia addresses - ordering and directions are pinned against reality.
const LIVE: FuelRouteConfig = {
	token: "0xA40A2FE147b7e96325d7c7D974B1f11C3ED82c68", // AZLO
	weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
	feeJuice: "0x762C132040fdA6183066Fa3B14d985ee55aA3C18",
	tokenWeth: { fee: 500, tickSpacing: 10 },
	ethFj: { fee: 987, tickSpacing: 10 },
}

describe("buildFuelRoute", () => {
	it("live addresses: AZLO sorts below WETH, both hops zeroForOne", () => {
		const r = buildFuelRoute(LIVE)
		expect(r.path).toHaveLength(2)
		expect(r.path[0].currency0).toBe(LIVE.token)
		expect(r.path[0].currency1).toBe(LIVE.weth)
		expect(r.path[0].fee).toBe(500)
		expect(r.path[0].tickSpacing).toBe(10)
		expect(r.zeroForOnes).toEqual([true, true])
	})

	it("the final hop is native-ETH -> FeeJuice (currency0 = address(0))", () => {
		const r = buildFuelRoute(LIVE)
		expect(r.path[1].currency0).toBe("0x0000000000000000000000000000000000000000")
		expect(r.path[1].currency1).toBe(LIVE.feeJuice)
		expect(r.path[1].fee).toBe(987)
	})

	it("a token sorting ABOVE WETH flips hop-1 ordering and direction", () => {
		const r = buildFuelRoute({ ...LIVE, token: "0xffFFfFff00000000000000000000000000000001" })
		expect(r.path[0].currency0).toBe(LIVE.weth)
		expect(r.path[0].currency1).toBe("0xffFFfFff00000000000000000000000000000001")
		expect(r.zeroForOnes).toEqual([false, true])
	})

	it("hooks are always zero - the router validates hookless routes", () => {
		const r = buildFuelRoute(LIVE)
		expect(r.path.every((k) => k.hooks === "0x0000000000000000000000000000000000000000")).toBe(true)
	})

	it("rejects token == WETH and a native feeJuice", () => {
		expect(() => buildFuelRoute({ ...LIVE, token: LIVE.weth })).toThrow(/same address/)
		expect(() => buildFuelRoute({ ...LIVE, feeJuice: "0x0000000000000000000000000000000000000000" })).toThrow(/native/)
	})
})
