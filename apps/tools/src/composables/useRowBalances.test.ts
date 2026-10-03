import { flushPromises } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address, PublicClient } from "viem"
import { ref } from "vue"
import type { SelectableToken } from "@/lib/send-model"
import { useRowBalances } from "./useRowBalances"

const h = vi.hoisted(() => ({ readErc20Balances: vi.fn() }))

vi.mock("@unleashed/bridge-core", () => ({ readErc20Balances: h.readErc20Balances }))

const OWNER = "0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d" as Address
const PUB = {} as PublicClient

function token(n: number): SelectableToken {
	const address = `0x${n.toString(16).padStart(40, "0")}` as Address
	return { chainId: 1, address, symbol: `T${n}`, name: `Token ${n}`, decimals: 18, source: "list", logoKey: `1:${address}` }
}

function harness(rows: SelectableToken[], owner: Address | undefined = OWNER) {
	const tokens = ref(rows)
	const who = ref<Address | undefined>(owner)
	const handle = useRowBalances({ pub: () => PUB, owner: () => who.value, tokens: () => tokens.value })
	return { tokens, who, handle }
}

describe("useRowBalances", () => {
	beforeEach(() => {
		h.readErc20Balances.mockReset()
		h.readErc20Balances.mockImplementation(
			async (_pub: unknown, _owner: string, addresses: readonly Address[]) => new Map(addresses.map((a, i) => [a, BigInt(i + 1)])),
		)
	})

	it("reads every row's balance for the owner in one batch, keyed by logoKey", async () => {
		const rows = [token(1), token(2)]
		const { handle } = harness(rows)
		await flushPromises()
		expect(h.readErc20Balances).toHaveBeenCalledTimes(1)
		expect(h.readErc20Balances).toHaveBeenCalledWith(PUB, OWNER, [rows[0]?.address, rows[1]?.address])
		expect(handle.balances.value).toEqual({ [rows[0]?.logoKey ?? ""]: 1n, [rows[1]?.logoKey ?? ""]: 2n })
	})

	it("reads nothing without an owner, and clears what it had", async () => {
		const { who, handle } = harness([token(1)])
		await flushPromises()
		expect(Object.keys(handle.balances.value)).toHaveLength(1)
		who.value = undefined
		await flushPromises()
		expect(handle.balances.value).toEqual({})
		expect(h.readErc20Balances).toHaveBeenCalledTimes(1)
	})

	it("a row the batch did not answer reads as zero", async () => {
		h.readErc20Balances.mockResolvedValue(new Map())
		const rows = [token(1)]
		const { handle } = harness(rows)
		await flushPromises()
		expect(handle.balances.value).toEqual({ [rows[0]?.logoKey ?? ""]: 0n })
	})

	it("a failed read leaves the previous map standing", async () => {
		const { handle } = harness([token(1)])
		await flushPromises()
		const before = handle.balances.value
		h.readErc20Balances.mockRejectedValueOnce(new Error("rpc down"))
		await handle.refresh()
		expect(handle.balances.value).toBe(before)
	})

	it("reads only the rows it has not read yet when the visible set changes, and none for the same rows in a new array", async () => {
		const rows = [token(1)]
		const { tokens, handle } = harness(rows)
		await flushPromises()
		tokens.value = [...rows]
		await flushPromises()
		expect(h.readErc20Balances).toHaveBeenCalledTimes(1)
		tokens.value = [...rows, token(2)]
		await flushPromises()
		expect(h.readErc20Balances).toHaveBeenCalledTimes(2)
		expect(h.readErc20Balances.mock.calls[1]?.[2]).toEqual([token(2).address])
		// A search that narrows the list to rows already read costs nothing; widening it back neither.
		tokens.value = [token(2)]
		await flushPromises()
		tokens.value = [...rows, token(2)]
		await flushPromises()
		expect(h.readErc20Balances).toHaveBeenCalledTimes(2)
		expect(Object.keys(handle.balances.value)).toHaveLength(2)
	})

	it("forgets everything when the account changes, and re-reads what is on screen on an explicit refresh", async () => {
		const rows = [token(1)]
		const { who, handle } = harness(rows)
		await flushPromises()
		who.value = "0x1111111111111111111111111111111111111111" as Address
		await flushPromises()
		expect(h.readErc20Balances).toHaveBeenCalledTimes(2)
		expect(h.readErc20Balances.mock.calls[1]?.[1]).toBe(who.value)
		await handle.refresh()
		expect(h.readErc20Balances).toHaveBeenCalledTimes(3)
	})

	it("a superseded read never lands", async () => {
		let release = (): void => {}
		h.readErc20Balances.mockImplementationOnce(() => new Promise((r) => (release = () => r(new Map([[token(1).address, 99n]])))))
		const rows = [token(1)]
		const { handle } = harness(rows)
		await handle.refresh()
		release()
		await flushPromises()
		expect(handle.balances.value[rows[0]?.logoKey ?? ""]).toBe(1n)
	})

	it("bounds the batch to the first fifty rows", async () => {
		const rows = Array.from({ length: 60 }, (_, i) => token(i + 1))
		harness(rows)
		await flushPromises()
		const batch = h.readErc20Balances.mock.calls[0]?.[2] as readonly Address[] | undefined
		expect(batch?.length).toBe(50)
	})
})
