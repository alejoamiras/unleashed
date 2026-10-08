import { FUEL_SWAP_SELECTORS } from "@unleashed/bridge-core"
import { type Address, BaseError, ContractFunctionRevertedError, type PublicClient, size, slice } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NO_GAS_ROUTE } from "@/lib/send-model"
import { GAS_QUOTE_MOVED, sliceSwapData, useFuelQuote } from "./useFuelQuote"

const FEE_ASSET = "0x0000000000000000000000000000000000000005" as Address
const TOKEN = "0x00000000000000000000000000000000000000aa" as Address
const OTHER = "0x00000000000000000000000000000000000000bb" as Address
const ROUTER = "0x00000000000000000000000000000000000000d1"
const SWAPPER = "0x00000000000000000000000000000000000000d2"

const h = vi.hoisted(() => ({ routed: { value: true } }))

vi.mock("@/contracts/bridge-generation", () => ({
	get SEND_GENERATION() {
		return h.routed.value ? { router: "0x00000000000000000000000000000000000000d1" } : undefined
	},
	MANIFEST: {
		l1ChainId: 31337,
		feeJuice: { asset: "0x0000000000000000000000000000000000000005" },
		bridge: {
			l1: {
				depositRouter: "0x00000000000000000000000000000000000000d1",
				fuelSwapper: "0x00000000000000000000000000000000000000d2",
				fuel: { slippageBps: 300, minFuelFj: "1000", fjPerTx: "1", fjRegister: "1", crossChainSlippageBps: 100 },
			},
		},
	},
	FUEL_ASSET: "0x0000000000000000000000000000000000000005",
}))

type QuoteArgs = { address: Address; functionName: string; args: readonly [Address, bigint] }

/** `TestnetFuelSwapper.quote` at a fixed rate per whole unit (18 decimals), or the given failure. */
function swapperClient(rate: bigint | "revert" | "down") {
	const readContract = vi.fn(async ({ args }: QuoteArgs) => {
		if (rate === "revert")
			throw new BaseError("quote reverted", { cause: new ContractFunctionRevertedError({ abi: [], functionName: "quote" }) })
		if (rate === "down") throw new Error("rpc down")
		return (args[1] * rate) / 10n ** 18n
	})
	return { client: { readContract } as unknown as PublicClient, readContract }
}

/** A swapper whose reads stay pending until the test answers them, so two probes can overlap. */
function deferredClient() {
	const pending: ((out: bigint) => void)[] = []
	const readContract = vi.fn(() => new Promise<bigint>((resolve) => pending.push(resolve)))
	return { client: { readContract } as unknown as PublicClient, pending }
}

const WHOLE = 10n ** 18n

async function settle(q: ReturnType<typeof useFuelQuote>, token: Address, amount = WHOLE): Promise<void> {
	const done = q.quote(token, amount)
	await vi.advanceTimersByTimeAsync(400)
	await done
}

describe("useFuelQuote", () => {
	beforeEach(() => {
		h.routed.value = true
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("prices the swapper's rate, tagged with the question it answers and the venue", async () => {
		const { client, readContract } = swapperClient(40n * WHOLE)
		const q = useFuelQuote({ pub: () => client })
		await settle(q, TOKEN)
		expect(q.quoted.value).toEqual({
			token: TOKEN,
			probeAmount: WHOLE,
			outcome: { kind: "route", probeOut: 40n * WHOLE, venue: { provider: "testnetSwapper" } },
		})
		expect(readContract.mock.calls[0][0]).toMatchObject({ address: SWAPPER, functionName: "quote", args: [TOKEN, WHOLE] })
		expect(q.error.value).toBeNull()
	})

	it("drops the previous answer the moment another token is asked about", async () => {
		const { client } = swapperClient(40n * WHOLE)
		const q = useFuelQuote({ pub: () => client })
		await settle(q, TOKEN)
		void q.quote(OTHER, WHOLE)
		expect(q.quoted.value).toBeNull()
		expect(q.loading.value).toBe(true)
	})

	it("bridges the fee asset one for one without a read", async () => {
		const { client, readContract } = swapperClient(1n)
		const q = useFuelQuote({ pub: () => client })
		await settle(q, FEE_ASSET)
		expect(q.quoted.value?.outcome).toEqual({ kind: "identity" })
		expect(readContract).not.toHaveBeenCalled()
	})

	it.each([
		["a token the swapper has no rate for", "revert", { kind: "no-route" }],
		["a dead transport", "down", { kind: "unavailable", reason: "rpc" }],
	] as const)("tells %s apart", async (_, rate, outcome) => {
		const { client } = swapperClient(rate)
		const q = useFuelQuote({ pub: () => client })
		await settle(q, TOKEN)
		expect(q.quoted.value?.outcome).toEqual(outcome)
		expect(q.error.value).toBeNull()
	})

	it("says no route can buy gas on a network without a deposit router, without probing", async () => {
		h.routed.value = false
		const { client, readContract } = swapperClient(1n)
		const q = useFuelQuote({ pub: () => client })
		await settle(q, TOKEN)
		expect(q.quoted.value?.outcome).toEqual({ kind: "unavailable", reason: "config" })
		expect(q.error.value).toBe(NO_GAS_ROUTE)
		expect(readContract).not.toHaveBeenCalled()
	})

	it("asks for the Ethereum wallet when there is no client to read through", async () => {
		const q = useFuelQuote({ pub: () => undefined })
		await settle(q, TOKEN)
		expect(q.quoted.value?.outcome).toEqual({ kind: "unavailable", reason: "rpc" })
		expect(q.error.value).toMatch(/Connect your Ethereum wallet/)
	})

	it("collapses a burst of edits into one probe and keeps the latest answer over a late older one", async () => {
		const { client, pending } = deferredClient()
		const q = useFuelQuote({ pub: () => client })
		void q.quote(TOKEN, 1n)
		void q.quote(TOKEN, 2n)
		void q.quote(TOKEN, WHOLE)
		await vi.advanceTimersByTimeAsync(400)
		expect(pending).toHaveLength(1)
		const latest = q.quote(TOKEN, 2n * WHOLE)
		await vi.advanceTimersByTimeAsync(400)
		pending[1](200n)
		await latest
		pending[0](100n)
		await vi.advanceTimersByTimeAsync(0)
		expect(q.quoted.value).toMatchObject({ probeAmount: 2n * WHOLE, outcome: { probeOut: 200n } })
	})

	it("publishes nothing after dispose", async () => {
		const { client, pending } = deferredClient()
		const q = useFuelQuote({ pub: () => client })
		void q.quote(TOKEN, WHOLE)
		await vi.advanceTimersByTimeAsync(400)
		q.dispose()
		pending[0](500n)
		await vi.advanceTimersByTimeAsync(0)
		expect(q.quoted.value).toBeNull()
		expect(q.loading.value).toBe(false)
	})
})

describe("sliceSwapData", () => {
	beforeEach(() => {
		h.routed.value = true
	})

	const MIN_AMOUNT_OUT = (data: `0x${string}`) => BigInt(slice(data, 132, 164))

	it("quotes the exact slice and signs the floor the user reviewed", async () => {
		const { client, readContract } = swapperClient(40n * WHOLE)
		const data = await sliceSwapData(client, TOKEN, { fuelAmount: 3n * WHOLE, minFuelOutput: 110n * WHOLE })
		expect(readContract.mock.calls[0][0].args).toEqual([TOKEN, 3n * WHOLE])
		expect(FUEL_SWAP_SELECTORS).toContain(slice(data, 0, 4))
		expect(size(data)).toBeGreaterThan(164)
		expect(MIN_AMOUNT_OUT(data)).toBe(110n * WHOLE)
		// The receiver word names the router: the swap pays the router, never anyone else.
		expect(slice(data, 100, 132).toLowerCase()).toBe(`0x${"0".repeat(24)}${ROUTER.slice(2)}`)
	})

	it("refuses when the venue now quotes under the reviewed floor, and when it cannot quote at all", async () => {
		const moved = swapperClient(40n * WHOLE).client
		await expect(sliceSwapData(moved, TOKEN, { fuelAmount: 3n * WHOLE, minFuelOutput: 121n * WHOLE })).rejects.toThrow(GAS_QUOTE_MOVED)
		const down = swapperClient("down").client
		await expect(sliceSwapData(down, TOKEN, { fuelAmount: WHOLE, minFuelOutput: 1n })).rejects.toThrow(GAS_QUOTE_MOVED)
	})

	it("needs no swap for the fee asset, and refuses gas where no venue exists", async () => {
		const { client, readContract } = swapperClient(1n)
		await expect(sliceSwapData(client, FEE_ASSET, { fuelAmount: WHOLE, minFuelOutput: WHOLE })).resolves.toBe("0x")
		h.routed.value = false
		await expect(sliceSwapData(client, TOKEN, { fuelAmount: WHOLE, minFuelOutput: 1n })).rejects.toThrow(NO_GAS_ROUTE)
		expect(readContract).not.toHaveBeenCalled()
	})
})
