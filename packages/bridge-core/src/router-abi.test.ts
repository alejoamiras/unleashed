import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { SWAP_BRIDGE_ROUTER_ABI } from "./router-abi"

const ARTIFACT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"contracts",
	"bridge",
	"evm",
	"out",
	"SwapBridgeRouter.sol",
	"SwapBridgeRouter.json",
)

type AbiParam = { name: string; type: string; indexed?: boolean; components?: AbiParam[] }
const shape = (p: AbiParam): unknown => ({
	name: p.name,
	type: p.type,
	...(p.indexed !== undefined ? { indexed: p.indexed } : {}),
	...(p.components ? { components: p.components.map(shape) } : {}),
})

// The minimal const must match the COMPILED router - drift fails here, not at runtime. The read is
// LAZY (inside each `it`), never at the describe-factory top level: `skipIf` still runs the factory
// at collection time, so a top-level readFileSync would ENOENT-crash collection wherever forge's
// `out/` isn't built (CI's unit-test job - it doesn't compile contracts). Skipped its never read.
const loadArtifact = () => JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: (AbiParam & { type: string })[] }
const inputsOf = (abi: AbiParam[], name: string) =>
	(abi.find((e) => (e as { name?: string }).name === name) as unknown as { inputs: AbiParam[] }).inputs

describe.skipIf(!existsSync(ARTIFACT))("router-abi pin (forge artifact)", () => {
	it("bridgeWithFuel inputs match the artifact", () => {
		const real = inputsOf(loadArtifact().abi, "bridgeWithFuel")
		const ours = inputsOf(SWAP_BRIDGE_ROUTER_ABI as unknown as AbiParam[], "bridgeWithFuel")
		expect(ours.map(shape)).toEqual(real.map(shape))
	})

	it("BridgeWithFuel event matches the artifact", () => {
		const real = inputsOf(loadArtifact().abi, "BridgeWithFuel")
		const ours = inputsOf(SWAP_BRIDGE_ROUTER_ABI as unknown as AbiParam[], "BridgeWithFuel")
		expect(ours.map(shape)).toEqual(real.map(shape))
	})

	it("bridge inputs match the artifact", () => {
		const real = inputsOf(loadArtifact().abi, "bridge")
		const ours = inputsOf(SWAP_BRIDGE_ROUTER_ABI as unknown as AbiParam[], "bridge")
		expect(ours.map(shape)).toEqual(real.map(shape))
	})

	it("Bridge event matches the artifact", () => {
		const real = inputsOf(loadArtifact().abi, "Bridge")
		const ours = inputsOf(SWAP_BRIDGE_ROUTER_ABI as unknown as AbiParam[], "Bridge")
		expect(ours.map(shape)).toEqual(real.map(shape))
	})

	it("every readback + error entry matches the artifact's whole entry", () => {
		type Entry = { type: string; name?: string; stateMutability?: string; inputs?: AbiParam[]; outputs?: AbiParam[] }
		const whole = (e: Entry) => ({
			type: e.type,
			name: e.name,
			stateMutability: e.stateMutability,
			inputs: (e.inputs ?? []).map(shape),
			outputs: (e.outputs ?? []).map(shape),
		})
		const real = loadArtifact().abi as unknown as Entry[]
		const rest = (SWAP_BRIDGE_ROUTER_ABI as unknown as Entry[]).filter(
			(e) => !["bridgeWithFuel", "BridgeWithFuel", "bridge", "Bridge"].includes(e.name ?? ""),
		)
		expect(rest.length).toBeGreaterThan(0)
		for (const entry of rest) {
			const match = real.find((r) => r.type === entry.type && r.name === entry.name)
			expect(match, `${entry.type} ${entry.name} missing from the artifact`).toBeDefined()
			expect(whole(entry)).toEqual(whole(match as Entry))
		}
	})
})
