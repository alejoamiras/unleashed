import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { decodeFunctionData, type Hex, toFunctionSelector } from "viem"
import { describe, expect, it } from "vitest"
import {
	decodeLzOptions,
	decodeOftComposeMessage,
	LzOptionsError,
	START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR,
	STARGATE_FACET_V2_ABI,
	stargateFeeCeiling,
	SWAP_AND_START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR,
} from "./stargate"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm", "test", "fixtures", "lifi")
const readFixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))

// LayerZero type-3 framing: worker 1 (executor) ‖ uint16 size ‖ option type ‖ payload.
const u = (v: bigint | number, bytes: number) =>
	BigInt(v)
		.toString(16)
		.padStart(bytes * 2, "0")
const option = (type: number, payload: string) => `01${u(payload.length / 2 + 1, 2)}${u(type, 1)}${payload}`
const options = (...parts: string[]): Hex => `0x0003${parts.join("")}`

describe("stargate", () => {
	it("pins the facet's two entrypoint selectors", () => {
		expect(STARGATE_FACET_V2_ABI.map((f) => toFunctionSelector(f))).toEqual([
			SWAP_AND_START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR,
			START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR,
		])
	})

	it("decodes the recorded quote's options and the replayed compose's combined options", () => {
		const quote = readFixture("mainnet.raw.json").baseUsdc.transactionRequest.data as Hex
		const { args } = decodeFunctionData({ abi: STARGATE_FACET_V2_ABI, data: quote })
		const stargateData = args.length === 3 ? args[2] : args[1]
		expect(decodeLzOptions(stargateData.sendParams.extraOptions)).toEqual([
			{ kind: "lzCompose", index: 0, gas: 1_300_000n, value: 0n },
			{ kind: "lzReceive", gas: expect.any(BigInt), value: 0n },
		])
		// What the source pool sent: Stargate's enforced lzReceive gas first, then the caller's options.
		const compose = readFixture("mainnet.compose.json")
		const decoded = decodeLzOptions(compose.options)
		const lzReceiveGas = decoded.reduce((sum, o) => (o.kind === "lzReceive" ? sum + o.gas : sum), 0n)
		expect(lzReceiveGas).toBe(BigInt(compose.lzReceiveGas))
		expect(decoded.filter((o) => o.kind === "lzCompose")).toEqual([
			{ kind: "lzCompose", index: 0, gas: BigInt(compose.composeGas), value: 0n },
		])
	})

	it("decodes every executor option type in both payload forms", () => {
		const receiver = "ab".repeat(32)
		expect(
			decodeLzOptions(
				options(
					option(1, u(7, 16)),
					option(1, u(7, 16) + u(9, 16)),
					option(2, u(5, 16) + receiver),
					option(3, u(1, 2) + u(8, 16)),
					option(3, u(1, 2) + u(8, 16) + u(3, 16)),
					option(4, ""),
				),
			),
		).toEqual([
			{ kind: "lzReceive", gas: 7n, value: 0n },
			{ kind: "lzReceive", gas: 7n, value: 9n },
			{ kind: "nativeDrop", amount: 5n, receiver: `0x${receiver}` },
			{ kind: "lzCompose", index: 1, gas: 8n, value: 0n },
			{ kind: "lzCompose", index: 1, gas: 8n, value: 3n },
			{ kind: "orderedExecution" },
		])
	})

	it.each<[string, Hex]>([
		["a legacy type-1 header", `0x0001${u(200_000, 32)}`],
		["a DVN worker option", `0x0003020002000a`],
		["an unknown option type", options(option(5, u(1, 16)))],
		["a payload of the wrong length", options(option(1, u(1, 15)))],
		["a size that overruns the options", `0x0003010030${u(1, 16)}`],
		["a trailing partial header", `${options(option(1, u(1, 16)))}01`],
		["no type header", "0x03"],
	])("refuses %s", (_, bytes) => {
		expect(() => decodeLzOptions(bytes)).toThrow(LzOptionsError)
	})

	it("splits the replayed compose message into the OFT codec's fields", () => {
		const c = readFixture("mainnet.compose.json")
		expect(decodeOftComposeMessage(c.message)).toEqual({
			nonce: BigInt(c.nonce),
			srcEid: c.srcEid,
			amountLD: BigInt(c.amountLD),
			composeFrom: c.composeFrom,
			composeMsg: c.composeMsg,
		})
		expect(() => decodeOftComposeMessage(`0x${"00".repeat(75)}`)).toThrow(/76-byte head/)
	})

	it("caps the native fee at the pool's quote plus 10 %", () => {
		expect(stargateFeeCeiling(1_000_000_000n)).toBe(1_100_000_000n)
	})
})
