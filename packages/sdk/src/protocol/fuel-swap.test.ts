import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, decodeFunctionData, encodeFunctionData, type Hex, pad } from "viem"
import { describe, expect, it, vi } from "vitest"
import { decodeFuelSwap, FEE_FORWARDER_ABI, type FuelSwap, type FuelSwapExpectation, fuelSwapIssue } from "./fuel-swap.ts"
import { type LifiSwapData, SWAP_TOKENS_SINGLE_V3_ABI } from "./lifi-abi.ts"
import { registerSandboxLifi, SANDBOX_LIFI_CHAIN_IDS } from "./lifi-addresses.ts"

/** The recorded swaps are Ethereum's; these cases hold them to the policy as an enabled chain would. */
const fuelChains = vi.hoisted(() => [31337, 31338, 1])
vi.mock("./lifi-gas.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), LIFI_FUEL_CHAIN_IDS: fuelChains }))

const FIXTURES = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"contracts",
	"bridge",
	"evm",
	"test",
	"fixtures",
	"lifi",
)
type Recorded = { tool: string; fromToken: Address; fromAmount: string; data: Hex }
const MAINNET = JSON.parse(readFileSync(join(FIXTURES, "mainnet.json"), "utf8")) as {
	ethereum: { aztec: Address }
	sameChain: Record<"deadlineFree" | "rfq" | "weth", Recorded>
}

const OTHER = pad("0xbad", { size: 20 })

function recorded(name: keyof typeof MAINNET.sameChain): { swap: FuelSwap; x: FuelSwapExpectation } {
	const q = MAINNET.sameChain[name]
	const swap = decodeFuelSwap(q.data) as FuelSwap
	const venue = { provider: "lifi", tool: q.tool } as const
	return { swap, x: { chainId: 1, token: q.fromToken, slice: BigInt(q.fromAmount), feeAsset: MAINNET.ethereum.aztec, venue } }
}

const feeCall = (step: LifiSwapData) => decodeFunctionData({ abi: FEE_FORWARDER_ABI, data: step.callData }).args
const withFee = (token: Address, shares: readonly { recipient: Address; amount: bigint }[]): Hex =>
	encodeFunctionData({ abi: FEE_FORWARDER_ABI, args: [token, shares] })

type Case = (s: FuelSwap, x: FuelSwapExpectation) => [FuelSwap, FuelSwapExpectation]
const steps = (s: FuelSwap, edit: (fee: LifiSwapData, venue: LifiSwapData) => LifiSwapData[]): FuelSwap => ({
	...s,
	steps: edit(s.steps[0] as LifiSwapData, s.steps[1] as LifiSwapData),
})

/** One leaf off the recorded sushiswap swap at a time; each names the field the policy refuses. */
const OUTSIDE: [string, string, Case][] = [
	["fee step at another target", "fuelSwap._swapData[0].callTo", (s, x) => [steps(s, (f, v) => [{ ...f, callTo: OTHER }, v]), x]],
	[
		"fee split into two shares",
		"fuelFee._distributions.length",
		(s, x) => [
			steps(s, (f, v) => {
				const [, [share]] = feeCall(f)
				const half = (share?.amount ?? 0n) / 2n
				return [
					{
						...f,
						callData: withFee(x.token, [
							{ ...share!, amount: half },
							{ recipient: OTHER, amount: half },
						]),
					},
					v,
				]
			}),
			x,
		],
	],
	[
		"fee above LI.FI's 25 bps, taken from the venue's input",
		"fuelFee._distributions[0].amount",
		(s, x) => {
			const fee = (x.slice * 26n) / 10_000n
			const [, [share]] = feeCall(s.steps[0] as LifiSwapData)
			const edited = steps(s, (f, v) => [
				{ ...f, callData: withFee(x.token, [{ ...share!, amount: fee }]) },
				{ ...v, fromAmount: x.slice - fee },
			])
			return [edited, x]
		},
	],
	[
		"fee paid in another token",
		"fuelFee._token",
		(s, x) => [steps(s, (f, v) => [{ ...f, callData: withFee(OTHER, feeCall(f)[1]) }, v]), x],
	],
	["venue at another target", "fuelSwap._swapData[1].callTo", (s, x) => [steps(s, (f, v) => [f, { ...v, callTo: OTHER }]), x]],
	[
		"venue named for another tool",
		"fuelSwap._swapData[1].callTo",
		(s, x) => [s, { ...x, venue: { provider: "lifi", tool: "nordstern" } }],
	],
	["tool without a proven venue", "fuel.tool", (s, x) => [s, { ...x, venue: { provider: "lifi", tool: "bitget" } }]],
	["tool named after a prototype key", "fuel.tool", (s, x) => [s, { ...x, venue: { provider: "lifi", tool: "constructor" } }]],
	[
		"venue fed the whole slice",
		"fuelSwap._swapData[1].fromAmount",
		(s, x) => [steps(s, (f, v) => [f, { ...v, fromAmount: x.slice }]), x],
	],
	["venue paid out in another asset", "fuelSwap._swapData[1].receivingAssetId", (s, x) => [s, { ...x, feeAsset: OTHER }]],
	["a third step", "fuelSwap._swapData.length", (s, x) => [steps(s, (f, v) => [f, v, v]), x]],
]

/** The sandbox's single-step shape (the browser fixture's): the recorded venue step, the whole slice, on chain 31337. */
function sandboxSwap(): { swap: FuelSwap; x: FuelSwapExpectation } {
	const { swap, x } = recorded("deadlineFree")
	const a = swap.args as { _transactionId: Hex; _integrator: string; _referrer: string; _receiver: Address; _minAmountOut: bigint }
	const venue = { ...(swap.steps[1] as LifiSwapData), fromAmount: x.slice, requiresDeposit: true }
	const data = encodeFunctionData({
		abi: SWAP_TOKENS_SINGLE_V3_ABI,
		args: [a._transactionId, a._integrator, a._referrer, a._receiver, a._minAmountOut, venue],
	})
	return { swap: decodeFuelSwap(data) as FuelSwap, x: { ...x, chainId: 31337 } }
}

describe("fuelSwapIssue", () => {
	const at = (n: number) => pad(`0x${n.toString(16)}`, { size: 20 })
	registerSandboxLifi({
		source: { chainId: 31338, diamond: at(1), spokePool: at(2) },
		ethereum: { chainId: 31337, diamond: at(6), executor: at(3), receiverAcrossV4: at(4), spokePool: at(5) },
	})

	it("accepts the recorded fee-then-venue swaps and refuses each step outside the policy", () => {
		for (const name of ["deadlineFree", "weth"] as const)
			expect(fuelSwapIssue(recorded(name).swap, recorded(name).x), name).toBeUndefined()
		expect(fuelSwapIssue(recorded("rfq").swap, recorded("rfq").x)?.field, "rfq").toBe("fuel.tool")

		const { swap, x } = recorded("deadlineFree")
		for (const [name, field, edit] of OUTSIDE) expect(fuelSwapIssue(...edit(swap, x))?.field, name).toBe(field)

		const single = sandboxSwap()
		const swapper = (single.swap.steps[0] as LifiSwapData).callTo
		const testnet = { ...single.x, venue: { provider: "testnetSwapper", swapper } } as const
		expect(fuelSwapIssue(single.swap, testnet), "the manifest's swapper").toBeUndefined()
		expect(fuelSwapIssue(single.swap, { ...testnet, venue: { provider: "testnetSwapper", swapper: OTHER } })?.field).toBe(
			"fuelSwap._swapData.callTo",
		)
		expect(fuelSwapIssue(single.swap, { ...testnet, venue: { provider: "testnetSwapper" } })?.field).toBe("expected.fuelSwapper")
		expect(fuelSwapIssue(single.swap, { ...testnet, chainId: 1 })?.field).toBe("fuel.provider")
		expect(fuelSwapIssue(swap, { ...testnet, chainId: 31337 })?.field, "the testnet swapper takes one step").toBe(
			"fuelSwap._swapData.length",
		)
	})

	it("refuses a LI.FI fuel swap on a chain where LI.FI gas swaps are not enabled", async () => {
		const real = await vi.importActual<typeof import("./lifi-gas.ts")>("./lifi-gas.ts")
		expect(real.LIFI_FUEL_CHAIN_IDS).toEqual(SANDBOX_LIFI_CHAIN_IDS)
		fuelChains.splice(fuelChains.indexOf(1), 1)
		try {
			expect(fuelChains).toEqual(real.LIFI_FUEL_CHAIN_IDS)
			for (const name of ["deadlineFree", "weth"] as const)
				expect(fuelSwapIssue(recorded(name).swap, recorded(name).x)?.field, name).toBe("fuel.provider")
			const sandbox = sandboxSwap()
			expect(fuelSwapIssue(sandbox.swap, sandbox.x), "the sandbox's single-step swap").toBeUndefined()
		} finally {
			fuelChains.push(1)
		}
	})
})

describe("decodeFuelSwap", () => {
	it("decodes only a pinned entrypoint's canonical encoding", () => {
		const { data } = MAINNET.sameChain.deadlineFree
		expect(decodeFuelSwap(data)).toMatchObject({ single: false, steps: [{}, {}] })
		expect(decodeFuelSwap(`0x736eac0b${data.slice(10)}`)).toMatchObject({ field: "fuelSwap.selector" })
		expect(decodeFuelSwap(`${data}00`)).toMatchObject({ field: "fuelSwap", reason: "non-canonical encoding" })
	})
})
