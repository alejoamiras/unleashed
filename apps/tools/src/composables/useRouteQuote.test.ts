import { QUOTER_ABI } from "@unleashed/bridge-core"
import { type Address, encodeFunctionResult, type Hex, type PublicClient } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useRouteQuote } from "./useRouteQuote"

const WETH = "0x0000000000000000000000000000000000000004" as Address
const FEE_JUICE = "0x0000000000000000000000000000000000000005" as Address
const TOKEN = "0x00000000000000000000000000000000000000aa" as Address

const SWAP_FIXTURE = {
	poolManager: "0x0000000000000000000000000000000000000001",
	quoter: "0x0000000000000000000000000000000000000002",
	multicall3: "0x0000000000000000000000000000000000000003",
	weth: WETH,
	feeJuice: FEE_JUICE,
	tiers: [
		{ fee: 3000, tickSpacing: 60 },
		{ fee: 500, tickSpacing: 10 },
	],
	ethFj: { fee: 3000, tickSpacing: 60 },
	slippageBps: 100,
	minFuelFj: "1000000000000000000",
	fjPerTx: "100000000000000000",
	fjRegister: "500000000000000000",
}

const h = vi.hoisted(() => ({ swap: { value: undefined as unknown } }))

vi.mock("@/contracts/bridge-generation", () => ({
	get SWAP() {
		return h.swap.value
	},
	// The L1 Fee Juice ERC-20: bridging it needs no swap at all.
	FUEL_ASSET: "0x0000000000000000000000000000000000000005",
}))

const encodeQuote = (out: bigint): Hex =>
	encodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", result: [out, 0n] })

type Aggregate3Args = { args: readonly [readonly unknown[]] }

/** A multicall3 that answers every batched hop the same way — enough to decide a route. */
function stubClient(behaviour: { out?: bigint; revert?: boolean; throws?: boolean }) {
	const readContract = vi.fn(async (args: Aggregate3Args) => {
		if (behaviour.throws) throw new Error("rpc down")
		return args.args[0].map(() =>
			behaviour.revert
				? { success: false, returnData: "0x" as Hex }
				: { success: true, returnData: encodeQuote(behaviour.out ?? 7n) },
		)
	})
	return { client: { readContract } as unknown as PublicClient, readContract }
}

/** A multicall3 whose batches stay pending until the test resolves them, so two runs can overlap. */
function deferredClient() {
	const pending: ((out: bigint) => void)[] = []
	const readContract = vi.fn(
		(args: Aggregate3Args) =>
			new Promise((resolve) => {
				pending.push((out) => resolve(args.args[0].map(() => ({ success: true, returnData: encodeQuote(out) }))))
			}),
	)
	return { client: { readContract } as unknown as PublicClient, pending, readContract }
}

describe("useRouteQuote", () => {
	beforeEach(() => {
		h.swap.value = SWAP_FIXTURE
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("reports the best route the quoter prices, tagged with the question it answers", async () => {
		const { client } = stubClient({ out: 42n })
		const q = useRouteQuote({ pub: () => client })
		const done = q.quote(TOKEN, 1_000n)
		await vi.advanceTimersByTimeAsync(400)
		await done
		expect(q.quoted.value).toMatchObject({ token: TOKEN, probeAmount: 1_000n, outcome: { kind: "route", quoteOut: 42n } })
		expect(q.loading.value).toBe(false)
		expect(q.error.value).toBeNull()
	})

	it("drops the previous answer SYNCHRONOUSLY, so the debounce window quotes nothing", async () => {
		const { client } = stubClient({ out: 42n })
		const q = useRouteQuote({ pub: () => client })
		const first = q.quote(TOKEN, 1_000n)
		await vi.advanceTimersByTimeAsync(400)
		await first
		expect(q.quoted.value?.token).toBe(TOKEN)

		void q.quote(WETH, 1_000n)
		// No await: this is the state a fast token switch leaves behind for the review to read.
		expect(q.quoted.value).toBeNull()
		expect(q.loading.value).toBe(true)
		expect(q.error.value).toBeNull()
	})

	it("short-circuits the fee asset to identity without an RPC call", async () => {
		const { client, readContract } = stubClient({})
		const q = useRouteQuote({ pub: () => client })
		const done = q.quote(FEE_JUICE, 1_000n)
		await vi.advanceTimersByTimeAsync(400)
		await done
		expect(q.quoted.value?.outcome).toEqual({ kind: "identity" })
		expect(readContract).not.toHaveBeenCalled()
	})

	it("reports no-route when every candidate tier reverts", async () => {
		const { client } = stubClient({ revert: true })
		const q = useRouteQuote({ pub: () => client })
		const done = q.quote(TOKEN, 1_000n)
		await vi.advanceTimersByTimeAsync(400)
		await done
		expect(q.quoted.value?.outcome).toEqual({ kind: "no-route", tried: SWAP_FIXTURE.tiers.length })
	})

	it("reports unavailable/rpc when the transport is dead", async () => {
		const { client } = stubClient({ throws: true })
		const q = useRouteQuote({ pub: () => client })
		const done = q.quote(TOKEN, 1_000n)
		await vi.advanceTimersByTimeAsync(400)
		await done
		expect(q.quoted.value?.outcome).toEqual({ kind: "unavailable", reason: "rpc" })
	})

	it("says so when the network has no swap venue, without probing", async () => {
		h.swap.value = undefined
		const { client, readContract } = stubClient({})
		const q = useRouteQuote({ pub: () => client })
		const done = q.quote(TOKEN, 1_000n)
		await vi.advanceTimersByTimeAsync(400)
		await done
		expect(q.quoted.value?.outcome).toEqual({ kind: "unavailable", reason: "config" })
		expect(q.error.value).toMatch(/no swap venue/)
		expect(readContract).not.toHaveBeenCalled()
	})

	it("says so when no L1 client is connected", async () => {
		const q = useRouteQuote({ pub: () => undefined })
		const done = q.quote(TOKEN, 1_000n)
		await vi.advanceTimersByTimeAsync(400)
		await done
		expect(q.quoted.value?.outcome).toEqual({ kind: "unavailable", reason: "rpc" })
		expect(q.error.value).toMatch(/Connect your Ethereum wallet/)
	})

	it("collapses a burst of amount edits into one probe", async () => {
		const { client, readContract } = stubClient({ out: 9n })
		const q = useRouteQuote({ pub: () => client })
		void q.quote(TOKEN, 1n)
		void q.quote(TOKEN, 2n)
		const done = q.quote(TOKEN, 3n)
		await vi.advanceTimersByTimeAsync(400)
		await done
		// Two hops of ONE surviving probe, not three probes.
		expect(readContract).toHaveBeenCalledTimes(2)
	})

	it("resolves the superseded caller instead of leaving it hanging", async () => {
		const { client } = stubClient({ out: 9n })
		const q = useRouteQuote({ pub: () => client })
		const first = q.quote(TOKEN, 1n)
		const second = q.quote(TOKEN, 2n)
		await vi.advanceTimersByTimeAsync(400)
		await expect(Promise.all([first, second])).resolves.toBeDefined()
	})

	it("keeps the latest probe's answer when an older one lands after it", async () => {
		const { client, pending } = deferredClient()
		const q = useRouteQuote({ pub: () => client })
		// WETH quotes through a single hop, so each probe is exactly one batch.
		void q.quote(WETH, 1n)
		await vi.advanceTimersByTimeAsync(400)
		const done = q.quote(WETH, 2n)
		await vi.advanceTimersByTimeAsync(400)
		expect(pending).toHaveLength(2)
		pending[1](200n)
		await done
		pending[0](100n)
		await vi.advanceTimersByTimeAsync(0)
		expect(q.quoted.value?.outcome).toMatchObject({ kind: "route", quoteOut: 200n })
	})

	it("dispose cancels a probe that has not fired yet", async () => {
		const { client, readContract } = stubClient({ out: 9n })
		const q = useRouteQuote({ pub: () => client })
		const done = q.quote(TOKEN, 1n)
		q.dispose()
		await vi.advanceTimersByTimeAsync(400)
		await done
		expect(readContract).not.toHaveBeenCalled()
		expect(q.quoted.value).toBeNull()
		expect(q.loading.value).toBe(false)
	})

	it("dispose drops the answer to a probe already in flight", async () => {
		const { client, pending } = deferredClient()
		const q = useRouteQuote({ pub: () => client })
		void q.quote(WETH, 1n)
		await vi.advanceTimersByTimeAsync(400)
		expect(q.loading.value).toBe(true)
		q.dispose()
		pending[0](500n)
		await vi.advanceTimersByTimeAsync(0)
		expect(q.quoted.value).toBeNull()
	})

	it("ignores a quote requested after dispose", async () => {
		const { client, readContract } = stubClient({ out: 9n })
		const q = useRouteQuote({ pub: () => client })
		q.dispose()
		await q.quote(TOKEN, 1n)
		await vi.advanceTimersByTimeAsync(400)
		expect(readContract).not.toHaveBeenCalled()
	})
})
