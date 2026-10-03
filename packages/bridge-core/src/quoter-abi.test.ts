import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { QUOTER_ABI } from "./quote"

const ARTIFACT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"contracts",
	"bridge",
	"evm",
	"out",
	"IV4Quoter.sol",
	"IV4Quoter.json",
)

type AbiParam = { name: string; type: string; components?: AbiParam[] }
const shape = (p: AbiParam): unknown => ({ name: p.name, type: p.type, ...(p.components ? { components: p.components.map(shape) } : {}) })
const entryOf = (abi: AbiParam[], name: string) =>
	abi.find((e) => (e as { name?: string }).name === name) as unknown as {
		inputs: AbiParam[]
		outputs: AbiParam[]
		stateMutability: string
	}

// The hand-written quoter ABI is what discovery encodes; the compiled interface is what the facade
// (and the real V4 Quoter) answer. Read lazily so a checkout without forge's `out/` skips, never crashes.
describe.skipIf(!existsSync(ARTIFACT))("quoter-abi pin (forge artifact)", () => {
	it("quoteExactInputSingle inputs and outputs match IV4Quoter", () => {
		const real = entryOf(JSON.parse(readFileSync(ARTIFACT, "utf8")).abi, "quoteExactInputSingle")
		const ours = entryOf(QUOTER_ABI as unknown as AbiParam[], "quoteExactInputSingle")
		expect(ours.inputs.map(shape)).toEqual(real.inputs.map(shape))
		expect(ours.outputs.map(shape)).toEqual(real.outputs.map(shape))
		expect(ours.stateMutability).toBe(real.stateMutability)
	})
})
