import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, decodeFunctionData, type Hex, toFunctionSelector } from "viem"
import { describe, expect, it } from "vitest"
import {
	ACROSS_V4_FACET_ABI,
	type AcrossV4DepositParams,
	buildAcrossV4Deposit,
	encodeLifiReceiverMessage,
	START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR,
} from "./across-v4"
import type { LifiSwapData } from "./lifi-abi"

// The vector LifiTestnetRailFork sends through LI.FI's real Base Sepolia Diamond and fills on Sepolia.
const FIXTURE = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"contracts",
	"bridge",
	"evm",
	"test",
	"fixtures",
	"lifi",
	"testnet-rail.json",
)

interface RailFixture {
	source: { chainId: number; diamond: Address; usdc: Address }
	destination: { chainId: number; receiverAcrossV4: Address; usdc: Address }
	inputs: {
		transactionId: Hex
		integrator: string
		user: Address
		inputAmount: string
		outputAmount: string
		quoteTimestamp: number
		fillDeadline: number
		step: Omit<LifiSwapData, "fromAmount"> & { fromAmount: string }
	}
	message: Hex
	calldata: Hex
}

function fixtureParams(): { f: RailFixture; params: AcrossV4DepositParams } {
	const f = JSON.parse(readFileSync(FIXTURE, "utf8")) as RailFixture
	const step: LifiSwapData = { ...f.inputs.step, fromAmount: BigInt(f.inputs.step.fromAmount) }
	return {
		f,
		params: {
			diamond: f.source.diamond,
			transactionId: f.inputs.transactionId,
			integrator: f.inputs.integrator,
			user: f.inputs.user,
			inputToken: f.source.usdc,
			inputAmount: BigInt(f.inputs.inputAmount),
			destinationChainId: BigInt(f.destination.chainId),
			destinationReceiver: f.destination.receiverAcrossV4,
			outputToken: f.destination.usdc,
			outputAmount: BigInt(f.inputs.outputAmount),
			quoteTimestamp: f.inputs.quoteTimestamp,
			fillDeadline: f.inputs.fillDeadline,
			steps: [step],
		},
	}
}

describe("across-v4", () => {
	it("reproduces the fork-proven vector byte for byte", () => {
		const { f, params } = fixtureParams()
		const tx = buildAcrossV4Deposit(params)
		expect(tx).toEqual({ to: f.source.diamond, data: f.calldata, value: 0n })
		expect(encodeLifiReceiverMessage(params.transactionId, params.steps, params.user)).toBe(f.message)
	})

	it("calls the facet's pinned selector with the message under the receiver contract", () => {
		expect(toFunctionSelector(ACROSS_V4_FACET_ABI[0])).toBe(START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR)
		const { f, params } = fixtureParams()
		const { args } = decodeFunctionData({ abi: ACROSS_V4_FACET_ABI, data: buildAcrossV4Deposit(params).data })
		const [bridgeData, acrossData] = args
		expect(bridgeData).toMatchObject({ receiver: params.user, hasDestinationCall: true, hasSourceSwaps: false })
		expect(acrossData.receiverAddress.toLowerCase()).toBe(`0x${"0".repeat(24)}${f.destination.receiverAcrossV4.slice(2).toLowerCase()}`)
		expect(acrossData.message).toBe(f.message)
		expect(acrossData).toMatchObject({ exclusiveRelayer: `0x${"0".repeat(64)}`, exclusivityParameter: 0 })
	})

	it("holds an exclusive fill until the fill deadline, passed as Across's absolute exclusivity deadline", () => {
		const { params } = fixtureParams()
		const filler: Address = `0x${"ca".repeat(20)}`
		const { args } = decodeFunctionData({
			abi: ACROSS_V4_FACET_ABI,
			data: buildAcrossV4Deposit({ ...params, exclusiveRelayer: filler }).data,
		})
		expect(args[1]).toMatchObject({
			exclusiveRelayer: `0x${"0".repeat(24)}${"ca".repeat(20)}`,
			exclusivityParameter: params.fillDeadline,
		})
	})

	it.each<[string, (p: AcrossV4DepositParams) => Partial<AcrossV4DepositParams>]>([
		["an output above the input", (p) => ({ outputAmount: p.inputAmount + 1n })],
		["a deadline at the quote time", (p) => ({ fillDeadline: p.quoteTimestamp })],
		["no destination step", () => ({ steps: [] })],
		["a short transaction id", () => ({ transactionId: "0x01" })],
		["the zero address as exclusive relayer", () => ({ exclusiveRelayer: `0x${"0".repeat(40)}` })],
		// Across would read a deadline this small as an offset from the deposit's block.
		[
			"an exclusive deposit whose deadline is not a timestamp",
			() => ({ exclusiveRelayer: `0x${"ca".repeat(20)}`, quoteTimestamp: 1, fillDeadline: 7_201 }),
		],
	])("refuses %s", (_, override) => {
		const { params } = fixtureParams()
		expect(() => buildAcrossV4Deposit({ ...params, ...override(params) })).toThrow(/across-v4/)
	})
})
