import { flushPromises } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PublicClient } from "viem"
import { nextTick, ref } from "vue"
import type { SelectableToken } from "@/lib/send-model"
import { useAddressLookup } from "./useAddressLookup"

const h = vi.hoisted(() => ({ readErc20Metadata: vi.fn() }))

vi.mock("@unleashed/bridge-core", () => ({ readErc20Metadata: h.readErc20Metadata }))

const LINK = "0x779877a7b0d9e8603169ddbd7836e478b4624789"
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
const PUB = {} as PublicClient

const known: SelectableToken[] = [
	{ chainId: 1, address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, source: "manifest", logoKey: `1:${USDC}` },
]

function meta(symbol: string, name: string, decimals: number) {
	const raw = new TextEncoder().encode(symbol)
	return { symbol, name, decimals, symbolRaw: raw, nameRaw: raw }
}

function harness(pub: PublicClient | null = PUB) {
	const query = ref("")
	const lookup = useAddressLookup({ pub: () => pub ?? undefined, query, known: () => known, chainId: () => 1 })
	return { query, lookup }
}

/** A read that waits until the test lets it answer. */
function gated(answer: ReturnType<typeof meta>): () => void {
	let release = (): void => {}
	h.readErc20Metadata.mockImplementationOnce(() => new Promise((r) => (release = () => r(answer))))
	return () => release()
}

describe("useAddressLookup", () => {
	beforeEach(() => {
		h.readErc20Metadata.mockReset()
		h.readErc20Metadata.mockResolvedValue(meta("LINK", "ChainLink Token", 18))
	})

	it("looks nothing up for plain text or a partial address", async () => {
		const { query, lookup } = harness()
		query.value = "usd"
		await flushPromises()
		query.value = "0x779877a7b0d9e8603169ddbd7836e478b46247"
		await flushPromises()
		expect(lookup.state.value).toBeNull()
		expect(h.readErc20Metadata).not.toHaveBeenCalled()
	})

	it("looks nothing up for an address the catalog already lists — the filter finds it", async () => {
		const { query, lookup } = harness()
		query.value = USDC.toUpperCase().replace("0X", "0x")
		await flushPromises()
		expect(lookup.state.value).toBeNull()
		expect(h.readErc20Metadata).not.toHaveBeenCalled()
	})

	it("refuses the zero address without a read", async () => {
		const { query, lookup } = harness()
		query.value = `0x${"0".repeat(40)}`
		await flushPromises()
		expect(lookup.state.value).toMatchObject({ status: "error", message: expect.stringMatching(/zero address/) })
		expect(h.readErc20Metadata).not.toHaveBeenCalled()
	})

	it("reads an unknown address's symbol, name and decimals, keyed like a list row", async () => {
		const release = gated(meta("LINK", "ChainLink Token", 18))
		const { query, lookup } = harness()
		query.value = ` ${LINK.toUpperCase().replace("0X", "0x")} `
		await nextTick()
		expect(lookup.state.value).toMatchObject({ status: "reading", address: LINK })
		release()
		await flushPromises()
		expect(lookup.state.value).toEqual({
			status: "found",
			address: LINK,
			logoKey: `1:${LINK}`,
			identity: { symbol: "LINK", name: "ChainLink Token", decimals: 18 },
		})
		expect(h.readErc20Metadata).toHaveBeenCalledWith(PUB, LINK)
	})

	it("reports the contract's own complaint when the read fails", async () => {
		h.readErc20Metadata.mockRejectedValue(new Error("Token has no usable decimals() — it cannot be bridged."))
		const { query, lookup } = harness()
		query.value = LINK
		await flushPromises()
		expect(lookup.state.value).toMatchObject({ status: "error", message: expect.stringMatching(/no usable decimals/) })
	})

	it("needs an Ethereum client to read", async () => {
		const { query, lookup } = harness(null)
		query.value = LINK
		await flushPromises()
		expect(lookup.state.value).toMatchObject({ status: "error", message: expect.stringMatching(/Ethereum wallet/) })
	})

	it("a superseded read never lands on the current query", async () => {
		const release = gated(meta("OLD", "Old", 18))
		const { query, lookup } = harness()
		query.value = LINK
		await nextTick()
		expect(lookup.state.value).toMatchObject({ status: "reading" })
		query.value = "usd"
		await nextTick()
		release()
		await flushPromises()
		expect(lookup.state.value).toBeNull()
	})

	it("dispose drops an in-flight read and clears the state", async () => {
		const release = gated(meta("LINK", "ChainLink Token", 18))
		const { query, lookup } = harness()
		query.value = LINK
		await nextTick()
		lookup.dispose()
		release()
		await flushPromises()
		expect(lookup.state.value).toBeNull()
	})
})
