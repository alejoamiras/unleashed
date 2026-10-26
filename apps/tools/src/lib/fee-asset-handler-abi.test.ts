import { FeeAssetHandlerAbi } from "@aztec-foundation/l1-artifacts/FeeAssetHandlerAbi"
import { describe, expect, it } from "vitest"
import { FEE_ASSET_HANDLER_ABI } from "./fee-asset-handler-abi"

const shape = (f: {
	name: string
	stateMutability: string
	inputs: readonly { type: string }[]
	outputs: readonly { type: string }[]
}) => ({
	name: f.name,
	stateMutability: f.stateMutability,
	inputs: f.inputs.map((i) => i.type),
	outputs: f.outputs.map((o) => o.type),
})

describe("FEE_ASSET_HANDLER_ABI", () => {
	it("matches the published artifact for every function it declares", () => {
		for (const ours of FEE_ASSET_HANDLER_ABI) {
			const real = FeeAssetHandlerAbi.find((e) => e.type === "function" && e.name === ours.name)
			expect(real, ours.name).toBeDefined()
			expect(shape(ours)).toEqual(shape(real as Parameters<typeof shape>[0]))
		}
	})
})
