import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { DEPOSIT_ROUTER_ABI } from "./deposit-router-abi"

const ARTIFACT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"contracts",
	"bridge",
	"evm",
	"out",
	"DepositRouter.sol",
	"DepositRouter.json",
)

type AbiParam = { name: string; type: string; indexed?: boolean; components?: AbiParam[] }
type Entry = {
	type: string
	name?: string
	stateMutability?: string
	anonymous?: boolean
	inputs?: AbiParam[]
	outputs?: AbiParam[]
}

const shape = (p: AbiParam): unknown => ({
	name: p.name,
	type: p.type,
	...(p.indexed !== undefined ? { indexed: p.indexed } : {}),
	...(p.components ? { components: p.components.map(shape) } : {}),
})
const whole = (e: Entry) => ({
	type: e.type,
	name: e.name,
	stateMutability: e.stateMutability,
	anonymous: e.anonymous,
	inputs: (e.inputs ?? []).map(shape),
	outputs: (e.outputs ?? []).map(shape),
})

// Read lazily inside each `it`: `skipIf` still runs the describe factory at collection time, and the unit-test
// job has no forge `out/`.
const loadAbi = () => (JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Entry[] }).abi
const ours = DEPOSIT_ROUTER_ABI as unknown as Entry[]

describe.skipIf(!existsSync(ARTIFACT))("deposit-router-abi pin (forge artifact)", () => {
	it("every entry matches the artifact's whole entry", () => {
		const real = loadAbi()
		for (const entry of ours) {
			const match = real.find((r) => r.type === entry.type && r.name === entry.name)
			expect(match, `${entry.type} ${entry.name} missing from the artifact`).toBeDefined()
			expect(whole(entry)).toEqual(whole(match as Entry))
		}
	})

	it("carries every error the router can raise", () => {
		const names = (abi: Entry[]) =>
			abi
				.filter((e) => e.type === "error")
				.map((e) => e.name)
				.sort()
		expect(names(ours)).toEqual(names(loadAbi()))
	})
})
