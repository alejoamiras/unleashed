import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import { describe, expect, it } from "vitest"
import { claimCapabilities } from "../capabilities.ts"
import { FUEL_SWAPPER_QUOTE_ABI } from "../execution/fuel-quote.ts"
import { SWAPPER_ABI } from "../execution/trust-roots.ts"
import { MAINNET_MANIFEST, TESTNET_MANIFEST } from "../networks.ts"
import { type AbiEntry, missingFrom } from "./abi-shape.ts"
import { tokenBridgeHubArtifact } from "./artifacts.ts"
import type { PinnedContract } from "./code-hash.ts"
import { DEPOSIT_ROUTER_ABI } from "./deposit-router-abi.ts"
import { PORTAL_FACTORY_ABI, PORTAL_IMPL_CONSTANTS_ABI, TOKEN_PORTAL_ABI } from "./factory-abi.ts"
import { codeOf, keptEvmArtifact, LIVE_RECORDS } from "./generation-record.ts"
import { parseManifestV2 } from "./manifest-v2.ts"

const GENERATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contracts", "bridge", "generations")
const abis = (...list: readonly unknown[]) => list.flatMap((abi) => abi as readonly AbiEntry[])

/** Every ABI the SDK calls each pinned contract through. */
const CALLS: Readonly<Record<PinnedContract, readonly AbiEntry[]>> = {
	DepositRouter: abis(DEPOSIT_ROUTER_ABI),
	PortalFactory: abis(PORTAL_FACTORY_ABI),
	TokenPortalImpl: abis(TOKEN_PORTAL_ABI, PORTAL_IMPL_CONSTANTS_ABI),
	TestnetFuelSwapper: abis(FUEL_SWAPPER_QUOTE_ABI, SWAPPER_ABI),
	FuelOnlyGate: abis(PORTAL_FACTORY_ABI).filter((e) => e.name === "depositsPaused"),
}

/** A hub function as a caller depends on it: kind, staticness, parameters and return types. */
function hubFunctionShape(artifact: ContractArtifact, name: string): string | undefined {
	const f = [...artifact.functions, ...artifact.nonDispatchPublicFunctions].find((fn) => fn.name === name)
	return f && JSON.stringify({ functionType: f.functionType, isStatic: f.isStatic, parameters: f.parameters, returnTypes: f.returnTypes })
}

const manifests = [TESTNET_MANIFEST, MAINNET_MANIFEST].map((raw) => parseManifestV2(raw))

// A live generation keeps running its deployed code after the sources move: every call this release makes must still
// be one that code answers, or a new call waits behind a record-selected path until the generation is promoted.
describe("this release against each live generation's code", () => {
	it.each(LIVE_RECORDS.map((r) => [r.network, r] as const))("%s answers every L1 call the SDK makes", (network, record) => {
		const missing = Object.keys(record.evm).flatMap((contract) => {
			const kept = JSON.parse(readFileSync(join(GENERATIONS, network, keptEvmArtifact(contract as PinnedContract)), "utf8"))
			return missingFrom(CALLS[contract as PinnedContract], kept.abi).map((entry) => `${contract}: ${entry}`)
		})
		expect(missing).toEqual([])
	})

	it.each(manifests.filter((m) => m.bridge).map((m) => [m.network, m] as const))(
		"%s's hub answers every call the SDK's grant names",
		async (_, m) => {
			const hub = m.bridge?.l2.hub.address as string
			const granted = claimCapabilities({ privateFpc: `0x${"0".repeat(63)}1`, hub, l2Tokens: [] })
				.flatMap((c) => (c.type === "transaction" ? c.scope : c.type === "simulation" ? c.transactions.scope : []))
				.filter((s) => s.contract.toString() === hub)
				.map((s) => s.function)
			expect(granted.length).toBeGreaterThan(3)
			const kept = await codeOf(m).hubArtifact()
			const drift = [...new Set(granted)].filter(
				(fn) => !hubFunctionShape(kept, fn) || hubFunctionShape(kept, fn) !== hubFunctionShape(tokenBridgeHubArtifact, fn),
			)
			expect(drift).toEqual([])
		},
	)

	it("would catch a call the kept code lacks", () => {
		const kept = JSON.parse(readFileSync(join(GENERATIONS, "testnet", keptEvmArtifact("DepositRouter")), "utf8"))
		const added = [{ type: "function", name: "depositV2", stateMutability: "nonpayable", inputs: [], outputs: [] }]
		expect(missingFrom([...CALLS.DepositRouter, ...added], kept.abi)).toEqual(["function depositV2"])
	})
})
