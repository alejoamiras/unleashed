import { describe, expect, it, vi } from "vitest"
import type { L1Ctx } from "../src/flows"
import { type ManifestV2, parseManifestV2 } from "../src/manifest-v2"
import {
	DEFAULT_CROSS_CHAIN_SLIPPAGE_BPS,
	deployRouterOnly,
	fuelBudgetsOf,
	inventoryMints,
	parseRates,
	type RouterOnlyOptions,
	routerOnlyCandidate,
} from "./generation-router"
import { preLifiTestnetManifest } from "./lifi-canary-fixture"

const live = preLifiTestnetManifest()
const bridge = live.bridge
if (!bridge) throw new Error("the pre-promotion testnet manifest carries no bridge")
const ROUTER = `0x${"d1".repeat(20)}` as const
const SWAPPER = `0x${"f5".repeat(20)}` as const

describe("router-only candidate", () => {
	it("carries the legacy swap block's budgets into the fuel block, and keeps a base's own fuel block", () => {
		const swap = bridge.l1.swap
		if (!swap) throw new Error("the live testnet manifest carries no swap block")
		const fuel = fuelBudgetsOf(live)
		expect(fuel).toEqual({
			slippageBps: swap.slippageBps,
			crossChainSlippageBps: DEFAULT_CROSS_CHAIN_SLIPPAGE_BPS,
			minFuelFj: swap.minFuelFj,
			fjPerTx: swap.fjPerTx,
			fjRegister: swap.fjRegister,
		})
		const own = { ...fuel, crossChainSlippageBps: 150 }
		expect(fuelBudgetsOf({ ...live, bridge: { ...bridge, l1: { ...bridge.l1, fuel: own } } })).toBe(own)
		expect(() => fuelBudgetsOf({ ...live, bridge: { ...bridge, l1: { ...bridge.l1, swap: undefined } } })).toThrow(
			/neither fuel budgets/,
		)
	})

	it("adds only the additive fields to the live manifest, keeps the legacy router, and still parses", () => {
		const candidate = routerOnlyCandidate(live, { depositRouter: ROUTER, fuelSwapper: SWAPPER, fuel: fuelBudgetsOf(live) })
		expect(parseManifestV2(candidate)).toEqual(candidate)
		expect({ ...candidate.bridge?.l1, depositRouter: undefined, fuelSwapper: undefined, fuel: undefined }).toEqual({
			...bridge.l1,
			depositRouter: undefined,
			fuelSwapper: undefined,
			fuel: undefined,
		})
		expect(candidate.bridge?.l1.router).toBe(bridge.l1.router)
		expect({ ...candidate, bridge: null }).toEqual({ ...live, bridge: null })
	})
})

describe("router-only inputs", () => {
	it("reads a rates file keyed by token, refusing a zero, signed or fractional rate and a malformed address", () => {
		const usdc = bridge.tokens[0]?.erc20 as string
		expect(parseRates({ [usdc.toUpperCase().replace("0X", "0x")]: "32000000000000000000" })).toEqual({ [usdc]: 32n * 10n ** 18n })
		for (const bad of ["0", "-1", "1.5", ""]) expect(() => parseRates({ [usdc]: bad })).toThrow(/rates/)
		expect(() => parseRates({ "0x1234": "1" })).toThrow(/rates/)
	})

	it("sizes the faucet top-up to the floor, and refuses a faucet that pays nothing or a floor out of proportion", () => {
		expect(inventoryMints(500n, 400n, 1000n)).toBe(0n)
		expect(inventoryMints(0n, 2500n, 1000n)).toBe(3n)
		expect(() => inventoryMints(0n, 1n, 0n)).toThrow(/mints nothing/)
		expect(() => inventoryMints(0n, 11_000n, 1000n)).toThrow(/faucet calls/)
	})
})

describe("deployRouterOnly refuses before any write", () => {
	const network = {
		l1ChainId: live.l1ChainId,
		rollupVersion: 1,
		registry: bridge.l1.registry,
		feeJuicePortal: bridge.l1.feeJuicePortal,
		feeJuice: live.feeJuice.asset,
		permit2: bridge.l1.permit2,
	} as RouterOnlyOptions["network"]
	const rates = Object.fromEntries(bridge.tokens.map((t) => [t.erc20, 1n]))
	/** Any chain or file access is a write path the refusal should have pre-empted. */
	const untouchable = () => {
		const fail = vi.fn(() => {
			throw new Error("touched the chain")
		})
		return {
			account: { address: bridge.l1.guardian },
			pub: new Proxy({}, { get: () => fail }),
			wallet: new Proxy({}, { get: () => fail }),
		}
	}
	const run = (over: Partial<RouterOnlyOptions> = {}, base: ManifestV2 = live) =>
		deployRouterOnly({
			l1: untouchable() as unknown as L1Ctx,
			network,
			journalPath: "/nonexistent/journal.jsonl",
			base,
			rates,
			candidatePath: "/nonexistent/candidate.json",
			...over,
		})

	it("when the base disagrees with the network, the signer is not the guardian, a token has no rate, or the chain is mainnet", async () => {
		await expect(run({ network: { ...network, feeJuicePortal: ROUTER } })).rejects.toThrow(/feeJuicePortal/)
		await expect(run({ network: { ...network, permit2: ROUTER } })).rejects.toThrow(/permit2/)
		await expect(run({ network: { ...network, feeAssetHandler: ROUTER } })).rejects.toThrow(/feeAssetHandler/)
		await expect(run({ l1: { ...untouchable(), account: { address: ROUTER } } as unknown as L1Ctx })).rejects.toThrow(/guardian/)
		const [first, ...others] = bridge.tokens
		await expect(run({ rates: Object.fromEntries(others.map((t) => [t.erc20, 1n])) })).rejects.toThrow(
			new RegExp(`no swapper rate for ${first?.displaySymbol}`),
		)
		await expect(run({ network: { ...network, l1ChainId: 1 } }, { ...live, l1ChainId: 1 })).rejects.toThrow(/mainnet/)
	})
})
