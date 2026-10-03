/**
 * Conformance mirror: `buildFuelRoute` output — and every route `discoverFuelRoute` emits — must
 * satisfy every rule `_validateRoute` enforces
 * (contracts/bridge/evm/src/UniswapFuelSwap.sol) — first-sell, last-out, hookless, continuity
 * with the WETH↔native unwrap confined to the final boundary, in that one direction only.
 *
 * Scope, precisely: this covers the ONE fixed two-hop shape the builder emits, not the general
 * N-hop grammar `RouteGrammarFuzz.t.sol` fuzzes on the Solidity side. It is a restatement of the
 * contract's rules in TypeScript, not a differential test — nothing here executes
 * `_validateRoute`, so a change made on the Solidity side without updating this file will not be
 * caught. Keeping the two in step is a review obligation, and the contract remains the authority.
 *
 * The oracle takes a route rather than a config so its rejection branches are reachable: every
 * config the builder accepts produces a conformant route by construction, so a config-driven
 * oracle can only ever exercise the success path — which is how the original version of this
 * file left all eight rejection branches untested and two of them unreachable.
 */
import { describe, expect, it } from "vitest"
import { type Address, encodeFunctionResult } from "viem"
import type { PoolKey } from "./l1"
import { type BatchQuoteClient, QUOTER_ABI } from "./quote"
import { assertRouteGrammar, type DiscoverRouteOptions, discoverFuelRoute } from "./route-discovery"
import { buildFuelRoute, type FuelRoute, type FuelRouteConfig } from "./route"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const NATIVE = "0x0000000000000000000000000000000000000000" as Address

function conformsToRouterRules(route: FuelRoute, cfg: FuelRouteConfig): string | null {
	const { path, zeroForOnes } = route

	if (path.length !== 2) return "builder must emit exactly the two-hop production shape"

	for (const k of path) if (k.hooks !== NATIVE) return "hooked pool"

	const h1In = zeroForOnes[0] ? path[0].currency0 : path[0].currency1
	if (h1In.toLowerCase() !== cfg.token.toLowerCase()) return "first hop does not sell the token"

	if (zeroForOnes[1] !== true) return "final hop must sell native"
	if (path[1].currency0 !== NATIVE) return "final pool is not the native pair"
	if (path[1].currency1.toLowerCase() !== cfg.feeJuice.toLowerCase()) return "final hop does not output FeeJuice"

	// Continuity across the single boundary is exactly the sanctioned WETH→native unwrap. The
	// reverse direction is rejected by the contract too: settlement can unwrap WETH into native
	// but never wraps native back, so a native→WETH boundary would be unsettleable.
	const out1 = zeroForOnes[0] ? path[0].currency1 : path[0].currency0
	if (out1.toLowerCase() !== cfg.weth.toLowerCase()) return "boundary is not WETH→native"

	return null
}

const BASE: FuelRouteConfig = {
	token: addr(0x1111),
	weth: addr(0xeeee),
	feeJuice: addr(0xf00d),
	tokenWeth: { fee: 500, tickSpacing: 10 },
	ethFj: { fee: 10000, tickSpacing: 200 },
}

/** Structured clone so a mutation cannot leak into the next case. */
const build = (cfg: FuelRouteConfig): FuelRoute => {
	const r = buildFuelRoute(cfg)
	return { path: r.path.map((k) => ({ ...k })), zeroForOnes: [...r.zeroForOnes] }
}

describe("buildFuelRoute conforms to _validateRoute grammar", () => {
	it("token below WETH (live mainnet ordering)", () => {
		expect(conformsToRouterRules(build(BASE), BASE)).toBeNull()
	})

	it("token above WETH (flipped ordering)", () => {
		const cfg = { ...BASE, token: addr(0xffff), weth: addr(0x2222), tokenWeth: { fee: 3000, tickSpacing: 60 } }
		expect(conformsToRouterRules(build(cfg), cfg)).toBeNull()
	})

	it("feeJuice sorting either side of WETH keeps the route conformant", () => {
		for (const fj of [addr(0x01), addr(0xfe)]) {
			const cfg = { ...BASE, token: addr(0x3333), weth: addr(0x4444), feeJuice: fj }
			expect(conformsToRouterRules(build(cfg), cfg)).toBeNull()
		}
	})
})

/**
 * One violated rule per case. Without these the oracle could be silently wrong — a flipped
 * comparison would keep every conformance case green, since a route that satisfies the rules
 * also satisfies a broken check that accepts everything.
 */
describe("the oracle rejects each rule violation", () => {
	it("rejects a hooked pool", () => {
		const route = build(BASE)
		route.path[0].hooks = addr(0xbadbad)
		expect(conformsToRouterRules(route, BASE)).toBe("hooked pool")
	})

	it("rejects a first hop that does not sell the bridged token", () => {
		const route = build(BASE)
		route.zeroForOnes[0] = !route.zeroForOnes[0]
		expect(conformsToRouterRules(route, BASE)).toBe("first hop does not sell the token")
	})

	it("rejects a final hop that does not sell native", () => {
		const route = build(BASE)
		route.zeroForOnes[1] = false
		expect(conformsToRouterRules(route, BASE)).toBe("final hop must sell native")
	})

	it("rejects a final pool that is not the native pair", () => {
		const route = build(BASE)
		route.path[1].currency0 = addr(0xabcabc)
		expect(conformsToRouterRules(route, BASE)).toBe("final pool is not the native pair")
	})

	it("rejects a final hop that does not output FeeJuice", () => {
		const route = build(BASE)
		route.path[1].currency1 = addr(0xdeadbe)
		expect(conformsToRouterRules(route, BASE)).toBe("final hop does not output FeeJuice")
	})

	it("rejects a boundary that is not the WETH→native unwrap", () => {
		const route = build(BASE)
		route.path[0].currency1 = addr(0xc0ffee)
		expect(conformsToRouterRules(route, BASE)).toBe("boundary is not WETH→native")
	})

	it("rejects a route that is not the two-hop production shape", () => {
		const route = build(BASE)
		route.path = [route.path[0]]
		expect(conformsToRouterRules(route, BASE)).toBe("builder must emit exactly the two-hop production shape")
	})
})

/** Every hop quotes the same non-zero amount, so discovery always lands on a route to inspect. */
const alwaysQuotes: BatchQuoteClient = {
	readContract: async ({ args }) =>
		args[0].map(() => ({
			success: true,
			returnData: encodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", result: [1_000n, 0n] }),
		})),
}

async function discovered(over: Partial<DiscoverRouteOptions> = {}): Promise<FuelRoute> {
	const outcome = await discoverFuelRoute({
		client: alwaysQuotes,
		quoter: addr(0x99),
		multicall3: addr(0xca11),
		token: BASE.token,
		feeAsset: addr(0xfee5),
		weth: BASE.weth,
		feeJuice: BASE.feeJuice,
		tiers: [BASE.tokenWeth],
		ethFj: BASE.ethFj,
		probeAmount: 1_000n,
		...over,
	})
	if (outcome.kind !== "route") throw new Error(`expected a route, got ${outcome.kind}`)
	return outcome.route
}

describe("discoverFuelRoute emits only conformant routes", () => {
	it("the tiered two-hop candidate passes the same oracle as the builder", async () => {
		const route = await discovered()
		expect(conformsToRouterRules(route, BASE)).toBeNull()
		expect(() => assertRouteGrammar(route, BASE.token, BASE.weth, BASE.feeJuice)).not.toThrow()
	})

	it("the WETH one-hop candidate sells native into FeeJuice", async () => {
		const route = await discovered({ token: BASE.weth })
		expect(route).toEqual({
			path: [
				{ currency0: NATIVE, currency1: BASE.feeJuice, fee: BASE.ethFj.fee, tickSpacing: BASE.ethFj.tickSpacing, hooks: NATIVE },
			],
			zeroForOnes: [true],
		})
		expect(() => assertRouteGrammar(route, BASE.weth, BASE.weth, BASE.feeJuice)).not.toThrow()
	})
})

const pool = (currency0: Address, currency1: Address): PoolKey => ({ currency0, currency1, fee: 500, tickSpacing: 10, hooks: NATIVE })

describe("assertRouteGrammar rejects what the router would revert on", () => {
	it("a hooked pool", () => {
		const route = build(BASE)
		route.path[0].hooks = addr(0xbadbad)
		expect(() => assertRouteGrammar(route, BASE.token, BASE.weth, BASE.feeJuice)).toThrow("UniswapFuelSwap: hooks not allowed")
	})

	it("a last hop that outputs something other than FeeJuice", () => {
		const route = build(BASE)
		route.path[1].currency1 = addr(0xdeadbe)
		expect(() => assertRouteGrammar(route, BASE.token, BASE.weth, BASE.feeJuice)).toThrow(
			"UniswapFuelSwap: last hop must output feeJuice",
		)
	})

	it("a native first hop whose input token is not WETH", () => {
		const route: FuelRoute = { path: [pool(NATIVE, BASE.feeJuice)], zeroForOnes: [true] }
		expect(() => assertRouteGrammar(route, BASE.token, BASE.weth, BASE.feeJuice)).toThrow(
			"UniswapFuelSwap: native route requires WETH input",
		)
	})

	it("a native→WETH boundary — settlement unwraps, it never wraps back", () => {
		const route: FuelRoute = {
			path: [pool(NATIVE, BASE.token), pool(BASE.weth, BASE.feeJuice)],
			zeroForOnes: [false, true],
		}
		expect(() => assertRouteGrammar(route, BASE.token, BASE.weth, BASE.feeJuice)).toThrow("UniswapFuelSwap: hop discontinuity")
	})

	it("an unwrap that is not on the final boundary", () => {
		const mid = addr(0xaaaa)
		const route: FuelRoute = {
			path: [pool(BASE.token, BASE.weth), pool(NATIVE, mid), pool(mid, BASE.feeJuice)],
			zeroForOnes: [true, true, true],
		}
		expect(() => assertRouteGrammar(route, BASE.token, BASE.weth, BASE.feeJuice)).toThrow("UniswapFuelSwap: hop discontinuity")
	})
})
