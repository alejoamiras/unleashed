import { TESTNET_FILLER } from "@unleashed/bridge-core/across-fill"
import { parseManifestV2 } from "@unleashed/sdk/protocol"
import { describe, expect, it } from "vitest"
import manifest from "../../../apps/tools/public/testnet-bridge.json"
import mainnet from "../../../apps/tools/public/mainnet-bridge.json"
import { LEGACY_ROUTER, ROUTER, SEPOLIA_USDC, SOURCE_USDC } from "../test/app-deposit"
import { testnetRoute } from "./route"

const FILLER = TESTNET_FILLER

describe("testnetRoute", () => {
	it("reads the live testnet manifest into the pinned pools, tokens, receiver and routers", () => {
		expect(testnetRoute(manifest, FILLER)).toEqual({
			source: { chainId: 84532, spokePool: "0x82B564983aE7274c86695917BBf8C99ECb6F0F8F", token: SOURCE_USDC },
			destination: {
				chainId: 11155111,
				spokePool: "0x5ef6C01E11889d86803e0B23e3cB3F9E9d97B662",
				token: SEPOLIA_USDC,
				recipient: "0x51Cd54Fab6Bc72c4c313C7d2DD4E0bE1A4390f44",
				routers: [ROUTER, LEGACY_ROUTER],
			},
			filler: FILLER,
			maxInput: 8_000_000n,
		})
	})

	it("reads what the validated manifest says", () => {
		const { bridge } = parseManifestV2(manifest)
		if (!bridge) throw new Error("the testnet manifest has no bridge")
		const route = testnetRoute(manifest, FILLER)
		const source = bridge.routing?.sources.find((s) => s.chainId === 84532)
		expect(route.destination.routers.map((a) => a.toLowerCase())).toEqual(
			[bridge.l1.depositRouter, ...(bridge.l1.legacyRouters ?? [])].map((a) => a?.toLowerCase()),
		)
		expect([route.source.token, route.destination.token].map((a) => a.toLowerCase())).toEqual(
			[source?.tokens[0]?.address, source?.tokens[0]?.destToken].map((a) => a?.toLowerCase()),
		)
	})

	it("refuses a mainnet manifest and one without the Base Sepolia rail", () => {
		expect(() => testnetRoute(mainnet, FILLER)).toThrow(/serves the testnet/)
		const noRail = { ...manifest, bridge: { ...manifest.bridge, routing: null } }
		expect(() => testnetRoute(noRail, FILLER)).toThrow(/routes no single Across token/)
	})
})
