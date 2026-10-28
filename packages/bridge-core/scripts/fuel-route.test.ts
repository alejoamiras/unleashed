import { describe, expect, it, vi } from "vitest"
import type { L1Ctx } from "@unleashed/sdk/internal"
import { lifiBook, parseManifestV2 } from "@unleashed/sdk/protocol"
import { mainnetPlaceholderManifest } from "../test/fixtures/frozen-manifests"
import { assertFuelRouteOptions, deployFuelRoute, type FuelRouteOptions, fuelRouteCandidate, planFuelRoute } from "./fuel-route"
import { MAINNET_REGISTRY, PLAN_PINNED_L1_SIGNERS } from "./live-intent"
import { preLifiTestnetManifest } from "./lifi-canary-fixture"
import { CANONICAL_PERMIT2 } from "./script-l1"

// The unit job has no forge build; a plan only hashes the gate's creation code to look it up in the journal.
vi.mock("./script-artifacts", () => ({
	evmArtifact: () => ({
		abi: [{ type: "constructor", stateMutability: "nonpayable", inputs: [{ type: "address" }] }],
		bytecode: "0x00",
	}),
}))

const mainnet = mainnetPlaceholderManifest()
const PINNED = PLAN_PINNED_L1_SIGNERS.mainnet as `0x${string}`
const STRANGER = `0x${"5a".repeat(20)}` as const
/** Mainnet's canonical rollup, and the 5.0.1 one its registry still lists. */
const CANONICAL_ROLLUP = "0xe37a2663cc9c119ba41572c40fab0bbb23a5402f"
const RETIRED_ROLLUP = "0x91ff8bbd8ebb07893010d50a48a1609e5ebd8e34"
const FUEL = { slippageBps: 100, minFuelFj: "1000", fjPerTx: "40" }
const network: FuelRouteOptions["network"] = {
	l1ChainId: 1,
	rollupVersion: 2070860440,
	registry: MAINNET_REGISTRY,
	feeJuicePortal: mainnet.feeJuice.portal as `0x${string}`,
	feeJuice: mainnet.feeJuice.asset as `0x${string}`,
	permit2: CANONICAL_PERMIT2,
}

/** An L1 that answers only the portal and registry reads; any other call is a write path a refusal pre-empts. */
function chain(portalRollup: string, signer: string = PINNED, canonicalPortal: string = network.feeJuicePortal) {
	const touched = vi.fn((what: string) => {
		throw new Error(`touched the chain: ${what}`)
	})
	const reads: Record<string, unknown> = {
		UNDERLYING: network.feeJuice,
		ROLLUP: portalRollup,
		VERSION: BigInt(network.rollupVersion),
		getCanonicalRollup: CANONICAL_ROLLUP,
		getFeeAssetPortal: canonicalPortal,
	}
	const pub = new Proxy(
		{ readContract: async ({ functionName }: { functionName: string }) => reads[functionName] ?? touched(functionName) },
		{ get: (t, k) => (k === "readContract" ? t.readContract : () => touched(String(k))) },
	)
	const l1 = { account: { address: signer }, pub, wallet: new Proxy({}, { get: (_, k) => () => touched(String(k)) }) }
	return { l1: l1 as unknown as L1Ctx, touched }
}

const options = (over: Partial<FuelRouteOptions> = {}): FuelRouteOptions => ({
	l1: chain(CANONICAL_ROLLUP).l1,
	network,
	journalPath: "/nonexistent/journal.jsonl",
	base: mainnet,
	fuel: FUEL,
	candidatePath: "/nonexistent/candidate.json",
	...over,
})

describe("the fuel route's conductor refuses before anything is sent", () => {
	it("on another chain, with another signer, with swapper rates on mainnet, or over a base that is not this network's placeholder", () => {
		expect(() => assertFuelRouteOptions(options())).not.toThrow()
		const sepolia = { ...network, l1ChainId: 11155111 }
		expect(() => assertFuelRouteOptions(options({ network: sepolia, base: { ...mainnet, l1ChainId: 11155111 } }))).toThrow(
			/Ethereum mainnet or the sandbox, not chain 11155111/,
		)
		expect(() => assertFuelRouteOptions(options({ l1: chain(CANONICAL_ROLLUP, STRANGER).l1 }))).toThrow(/pinned mainnet signer/)
		expect(() => assertFuelRouteOptions(options({ rates: { [STRANGER]: 1n } }))).toThrow(/takes no swapper rates/)
		const bridged = { ...mainnet, bridge: preLifiTestnetManifest().bridge }
		expect(() => assertFuelRouteOptions(options({ base: bridged }))).toThrow(/carries a bridge/)
		expect(() => assertFuelRouteOptions(options({ network: { ...network, feeJuicePortal: STRANGER } }))).toThrow(/feeJuice.portal/)
	})

	it("when the portal belongs to a rollup the registry no longer names canonical, or the canonical rollup names another", async () => {
		const stale = chain(RETIRED_ROLLUP)
		await expect(deployFuelRoute(options({ l1: stale.l1 }))).rejects.toThrow(/feeJuicePortal.rollup/)
		await expect(planFuelRoute(options({ l1: stale.l1 }))).rejects.toThrow(/feeJuicePortal.rollup/)
		expect(stale.touched).not.toHaveBeenCalled()
		// A lookalike that answers the portal's reads correctly is still not the portal the rollup names.
		const lookalike = chain(CANONICAL_ROLLUP, PINNED, STRANGER)
		await expect(deployFuelRoute(options({ l1: lookalike.l1 }))).rejects.toThrow(/getFeeAssetPortal/)
		expect(lookalike.touched).not.toHaveBeenCalled()

		const lines = await planFuelRoute(options())
		expect(lines).toContain(`gate: deploy FuelOnlyGate(${PINNED.toLowerCase()})`)
		expect(lines).toContain(`swap target: LI.FI's Diamond ${lifiBook(1).diamond.toLowerCase()}`)
	})
})

describe("fuelRouteCandidate", () => {
	const route = {
		depositRouter: `0x${"d1".repeat(20)}`,
		gate: `0x${"6a".repeat(20)}`,
		guardian: PINNED.toLowerCase(),
		registry: MAINNET_REGISTRY,
		permit2: CANONICAL_PERMIT2,
		fuel: FUEL,
	}

	it("adds the route to the placeholder and changes nothing else; a base with a bridge is refused", () => {
		const candidate = fuelRouteCandidate(mainnet, route)
		expect(parseManifestV2(candidate)).toEqual(candidate)
		expect({ ...candidate, fuelRoute: undefined }).toEqual({ ...mainnet, fuelRoute: undefined })
		expect(() => fuelRouteCandidate(preLifiTestnetManifest(), route)).toThrow(/carries a bridge/)
	})
})
