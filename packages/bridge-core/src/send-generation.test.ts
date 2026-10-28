import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { assertSupportedLine, aztecLineOf, lineOf } from "./aztec-line"
import { manifestFuelProvider } from "./fuel-quote"
import type { LifiClient } from "./lifi-api"
import { type ManifestV2, parseManifestV2 } from "./manifest-v2"
import { PRIVATE_FPC_ADDRESS } from "./private-fuel"
import { fuelRouteOf, sendGenerationOf } from "./send-generation"

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "tools", "public")
const shipped = (name: string): ManifestV2 => parseManifestV2(JSON.parse(readFileSync(join(PUBLIC, `${name}-bridge.json`), "utf8")))
const ROUTER = "0x00000000000000000000000000000000000000d1"
const GATE = "0x6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a"

/** Mainnet as shipped (no bridge), plus a router behind a gate. */
const mainnetRoute = (): ManifestV2 =>
	parseManifestV2({
		...shipped("mainnet"),
		fuelRoute: {
			depositRouter: ROUTER,
			gate: GATE,
			guardian: GATE,
			permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
			fuel: { slippageBps: 100, minFuelFj: "7" },
		},
	})

describe("fuelRouteOf", () => {
	it("reads a bridge's router and a fuel-only route into one binding, and nothing from a placeholder", () => {
		const testnet = shipped("testnet")
		const l1 = testnet.bridge?.l1
		const bridged = fuelRouteOf(testnet)
		expect(bridged).toMatchObject({
			router: l1?.depositRouter,
			fuelSwapper: l1?.fuelSwapper,
			feeJuicePortal: testnet.feeJuice.portal,
			chainId: testnet.l1ChainId,
		})
		const { factory: _f, implementation: _i, hub: _h, tokenClassId: _t, ...core } = sendGenerationOf(testnet, testnet.bridge as never)
		expect(bridged).toMatchObject(core)

		const mainnet = mainnetRoute()
		expect(fuelRouteOf(mainnet)).toEqual({
			router: ROUTER,
			permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
			feeJuicePortal: mainnet.feeJuice.portal,
			feeAsset: mainnet.feeJuice.asset,
			chainId: 1,
			slippageBps: 100,
			minFuelFj: 7n,
		})
		expect(fuelRouteOf(shipped("mainnet"))).toBeUndefined()
	})

	it("quotes a fuel-only route on mainnet through LI.FI only when given a client", () => {
		const reads = { readContract: async () => 0n }
		expect(manifestFuelProvider(mainnetRoute(), reads)).toBeUndefined()
		expect(manifestFuelProvider(mainnetRoute(), reads, { lifi: {} as LifiClient })).toBeDefined()
		expect(manifestFuelProvider(shipped("mainnet"), reads, { lifi: {} as LifiClient })).toBeUndefined()
	})
})

describe("the Aztec line table", () => {
	it("runs the installed line on testnet, every sandbox and mainnet's canonical rollup, and refuses another line", () => {
		for (const chain of [11155111, 31337, 1]) {
			expect(aztecLineOf(chain)).toMatchObject({ supported: true, version: "6.0.0", privateFpc: { address: PRIVATE_FPC_ADDRESS } })
			expect(() => assertSupportedLine(chain)).not.toThrow()
		}
		const older = lineOf({ ...aztecLineOf(1).privateFpc, version: "5.0.1" })
		expect(older.supported).toBe(false)
		expect(() => assertSupportedLine(1, older)).toThrow(/L1 chain 1 runs Aztec 5\.0\.1; this client runs 6\.0\.0/)
	})
})
