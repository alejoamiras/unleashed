import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, concat, decodeAbiParameters, decodeFunctionData, type Hex, numberToHex, pad, size, slice } from "viem"
import { describe, expect, it, vi } from "vitest"
import { DEPOSIT_ROUTER_ABI } from "./deposit-router-abi"
import { lifiFuelProvider, testnetSwapperFuelProvider, withFuelFloor } from "./fuel-quote"
import { signedMinFuelOutput } from "./gas-share"
import { LIFI_RECEIVER_MESSAGE_PARAMS } from "./lifi-abi"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm", "test", "fixtures", "lifi")
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))

type RawQuote = {
	tool: string
	estimate: { toAmount: string; approvalAddress: string }
	transactionRequest: { to: string; data: Hex; value: string }
}
const RAW: Record<"deadlineFree" | "rfq", RawQuote> = fixture("mainnet.raw.json")
const MAINNET = fixture("mainnet.json") as { router: Address; ethereum: { diamond: Address; usdc: Address; aztec: Address } }

const SLICE = 10_000_000n
const POLICY = { slippageBps: 100, minFuelFj: 1n }

function lifiProvider(raw: unknown, status = 200) {
	const f = vi.fn(async () => new Response(JSON.stringify(raw), { status })) as unknown as typeof fetch
	return lifiFuelProvider({
		client: { fetch: f },
		chainId: 1,
		diamond: MAINNET.ethereum.diamond,
		router: MAINNET.router,
		feeAsset: MAINNET.ethereum.aztec,
		...POLICY,
	})
}

const word = (data: Hex, offset: number) => slice(data, offset, offset + 32)
const withWord = (data: Hex, offset: number, value: Hex) => concat([slice(data, 0, offset), value, slice(data, offset + 32)])

describe("lifiFuelProvider", () => {
	it("returns LI.FI's recorded bytes with only _minAmountOut changed, to signedMinFuelOutput of the quote", async () => {
		const raw = RAW.deadlineFree
		const res = await lifiProvider(raw).quote(MAINNET.ethereum.usdc, SLICE)
		if (!res.ok) throw new Error(JSON.stringify(res))

		const expectedOut = BigInt(raw.estimate.toAmount)
		const floor = signedMinFuelOutput(expectedOut, POLICY.slippageBps, POLICY.minFuelFj)
		expect(res.quote).toMatchObject({ provider: "lifi", tool: raw.tool, amountIn: SLICE, expectedOut, minOut: floor })
		expect(res.quote.swapData).toBe(withWord(raw.transactionRequest.data, 132, numberToHex(floor, { size: 32 })))
	})

	const base = RAW.deadlineFree
	const data = base.transactionRequest.data
	const tx = (patch: Partial<RawQuote["transactionRequest"]>) => ({
		...base,
		transactionRequest: { ...base.transactionRequest, ...patch },
	})
	const OTHER = pad("0xbad", { size: 20 })

	it.each([
		["tool", RAW.rfq],
		["tool", { ...base, tool: "1inch" }],
		["transactionRequest.to", tx({ to: OTHER })],
		["estimate.approvalAddress", { ...base, estimate: { ...base.estimate, approvalAddress: OTHER } }],
		["transactionRequest.value", tx({ value: "0x1" })],
		["selector", tx({ data: concat(["0x736eac0b", slice(data, 4)]) })],
		["_receiver", tx({ data: withWord(data, 100, pad(OTHER)) })],
		["_minAmountOut", tx({ data: withWord(data, 132, pad("0x01")) })],
		["swapData", tx({ data: slice(data, 0, 100) })],
	])("refuses a quote whose %s breaks its pin", async (field, raw) => {
		expect(await lifiProvider(raw).quote(MAINNET.ethereum.usdc, SLICE)).toEqual({ ok: false, reason: "unsafe", field })
	})

	it("passes LI.FI's own refusal through as the provider's", async () => {
		const res = await lifiProvider({ message: "No available quotes for the requested transfer.", code: 1002 }, 404).probe(
			MAINNET.ethereum.usdc,
			SLICE,
		)
		expect(res).toMatchObject({ ok: false, reason: "provider", lifi: { reason: "no-route" } })
	})
})

/** The forge-proven testnet rail: `bridgeFromCaller` calls inside each variant's LI.FI message, built by the recorder. */
type RailVariant = { transactionId: Hex; message: Hex; intent: { token: Address; fuelSlice: string; minFuelOutput: string } }
const RAIL = fixture("testnet-rail.json") as {
	router: { router: Address; swapper: Address; feeAsset: Address; fjPerWholeToken: string; variants: Record<string, RailVariant> }
}
const AT = { router: RAIL.router.router, swapper: RAIL.router.swapper, feeAsset: RAIL.router.feeAsset }
const USDC = RAIL.router.variants.public!.intent.token

function railSwapData(message: Hex): Hex {
	const [, steps] = decodeAbiParameters(LIFI_RECEIVER_MESSAGE_PARAMS, message)
	const call = decodeFunctionData({ abi: DEPOSIT_ROUTER_ABI, data: (steps[0] as { callData: Hex }).callData })
	return call.args[1] as Hex
}

describe("testnetSwapperFuelProvider", () => {
	const rate = BigInt(RAIL.router.fjPerWholeToken)
	const reader = { quote: async (_token: Address, amountIn: bigint) => (amountIn * rate) / 10n ** 6n }

	it.each(["public", "private", "fuelOnly"])("builds the %s variant's swap call byte for byte", async (name) => {
		const v = RAIL.router.variants[name]!
		const provider = testnetSwapperFuelProvider({ reader, ...AT, ...POLICY, transactionId: v.transactionId })
		const res = await provider.quote(v.intent.token, BigInt(v.intent.fuelSlice))
		if (!res.ok) throw new Error(JSON.stringify(res))

		expect(res.quote.minOut).toBe(BigInt(v.intent.minFuelOutput))
		expect(res.quote.swapData).toBe(railSwapData(v.message))
	})

	it("refuses a slice that cannot buy a positive floor, and a reader that cannot quote", async () => {
		const dust = testnetSwapperFuelProvider({ reader, ...AT, slippageBps: 100, minFuelFj: 10n ** 30n })
		expect(await dust.quote(USDC, 1_000_000n)).toEqual({ ok: false, reason: "floor", expectedOut: 10n ** 20n, floor: 10n ** 30n })
		const nothing = testnetSwapperFuelProvider({ reader: { quote: async () => 0n }, ...AT, ...POLICY })
		expect(await nothing.quote(USDC, 1n)).toMatchObject({ ok: false, reason: "floor", expectedOut: 0n })
		const unsupported = testnetSwapperFuelProvider({
			reader: { quote: () => Promise.reject(new Error("UnsupportedToken()")) },
			...AT,
			...POLICY,
		})
		expect(await unsupported.probe(USDC, 1_000_000n)).toEqual({ ok: false, reason: "provider", message: "UnsupportedToken()" })
	})
})

describe("withFuelFloor", () => {
	it("rewrites the word only behind one of the two pinned selectors", () => {
		const data = RAW.deadlineFree.transactionRequest.data
		expect(size(withFuelFloor(data, 7n))).toBe(size(data))
		expect(word(withFuelFloor(data, 7n), 132)).toBe(numberToHex(7n, { size: 32 }))
		expect(() => withFuelFloor(concat(["0x736eac0b", slice(data, 4)]), 7n)).toThrow(/selector/)
		expect(() => withFuelFloor(slice(data, 0, 163), 7n)).toThrow(/swapData/)
	})
})
