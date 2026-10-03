import { type CatalogToken, parseManifestV2 } from "@unleashed/bridge-core"
import type { Address } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import rawManifest from "../../../../packages/bridge-core/fixtures/sandbox-manifest.json"
import { markOf } from "@/components/send/token-mark"
import { useTokenCatalog } from "./useTokenCatalog"

/**
 * The live `public/testnet-bridge.json` is still the previous schema, so the generation reader is
 * mocked from the sandbox fixture — a real v2 manifest with three tokens.
 */
const h = vi.hoisted(() => ({
	placeholder: { value: false },
	tokens: { value: [] as unknown[] },
	chainId: { value: 31337 },
	loadTokenList: vi.fn(),
}))

vi.mock("@/contracts/bridge-generation", () => ({
	get IS_PLACEHOLDER() {
		return h.placeholder.value
	},
	get MANIFEST_TOKENS() {
		return h.tokens.value
	},
	get MANIFEST() {
		return { l1ChainId: h.chainId.value }
	},
}))

vi.mock("@unleashed/bridge-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@unleashed/bridge-core")>()
	return { ...actual, loadTokenList: h.loadTokenList }
})

const MANIFEST = parseManifestV2(rawManifest)
const FIXTURE_TOKENS = MANIFEST.bridge?.tokens ?? []
const USDC = FIXTURE_TOKENS[0].erc20.toLowerCase() as Address

const listed = (address: string, symbol: string, name = symbol): CatalogToken => ({
	chainId: 31337,
	address: address.toLowerCase() as Address,
	symbol,
	name,
	decimals: 18,
})

const resolves = (tokens: CatalogToken[], provenance: "fresh" | "cache" | "fallback" = "fresh") =>
	h.loadTokenList.mockResolvedValue({ tokens, provenance })

describe("useTokenCatalog", () => {
	beforeEach(() => {
		h.loadTokenList.mockReset()
		h.placeholder.value = false
		h.tokens.value = FIXTURE_TOKENS
		h.chainId.value = MANIFEST.l1ChainId
		resolves([])
	})

	it("puts the generation's tokens first, in manifest order", async () => {
		resolves([listed("0x00000000000000000000000000000000000000a1", "AAA")])
		const c = useTokenCatalog()
		await c.refresh()
		expect(c.tokens.value.slice(0, 3).map((t) => t.address)).toEqual(FIXTURE_TOKENS.map((t) => t.erc20.toLowerCase()))
		expect(c.tokens.value.slice(0, 3).every((t) => t.source === "manifest")).toBe(true)
		expect(c.tokens.value[3]?.symbol).toBe("AAA")
	})

	it("keeps the manifest entry when the remote list carries the same address", async () => {
		resolves([listed(USDC, "FAKE", "Impostor")])
		const c = useTokenCatalog()
		await c.refresh()
		const hits = c.tokens.value.filter((t) => t.address === USDC)
		expect(hits).toHaveLength(1)
		expect(hits[0]).toMatchObject({ source: "manifest", symbol: FIXTURE_TOKENS[0].displaySymbol })
	})

	it("a remote entry that claims manifest provenance stays a list row and gets no brand", async () => {
		const forged = { ...listed("0x00000000000000000000000000000000000000c3", "USDC"), source: "manifest" } as CatalogToken
		resolves([forged])
		const c = useTokenCatalog()
		await c.refresh()
		const row = c.tokens.value.find((t) => t.address === forged.address)
		expect(row?.source).toBe("list")
		expect(markOf(row as NonNullable<typeof row>).brand).toBeNull()
	})

	it("surfaces the loader's provenance, cached or degraded", async () => {
		resolves([], "fallback")
		const c = useTokenCatalog()
		expect(c.provenance.value).toBe("none")
		await c.refresh()
		expect(c.provenance.value).toBe("fallback")
		expect(c.tokens.value).toHaveLength(FIXTURE_TOKENS.length)
	})

	it("never fetches a list on a network with no bridge", async () => {
		h.placeholder.value = true
		h.tokens.value = []
		const c = useTokenCatalog()
		await c.refresh()
		expect(c.tokens.value).toEqual([])
		expect(c.provenance.value).toBe("none")
		expect(h.loadTokenList).not.toHaveBeenCalled()
	})

	it("refuses anything that is not a 20-byte address", () => {
		const c = useTokenCatalog()
		expect(() => c.addPasted("not-an-address")).toThrow(/40 hex characters/)
		expect(() => c.addPasted("0x1234")).toThrow(/40 hex characters/)
	})

	it("refuses the zero address", () => {
		const c = useTokenCatalog()
		expect(() => c.addPasted(`0x${"0".repeat(40)}`)).toThrow(/zero address/)
	})

	it("refuses a duplicate however it is cased", () => {
		const c = useTokenCatalog()
		expect(() => c.addPasted(USDC.toUpperCase().replace("0X", "0x"))).toThrow(/already in the list/)
	})

	it("adds a looked-up token under the identity the contract answered", () => {
		const c = useTokenCatalog()
		const added = c.addPasted("0x00000000000000000000000000000000000000c9", { symbol: "LINK", name: "ChainLink Token", decimals: 18 })
		expect(added).toMatchObject({ source: "pasted", symbol: "LINK", name: "ChainLink Token", decimals: 18 })
		expect(c.chainId).toBe(MANIFEST.l1ChainId)
	})

	it("adds a pasted token with no metadata yet, right after the manifest block", () => {
		const c = useTokenCatalog()
		const added = c.addPasted(" 0x00000000000000000000000000000000000000B7 ")
		expect(added).toMatchObject({ address: "0x00000000000000000000000000000000000000b7", source: "pasted", symbol: "", name: "" })
		expect(added.decimals).toBe(-1)
		expect(added.logoKey).toBe(`${MANIFEST.l1ChainId}:0x00000000000000000000000000000000000000b7`)
		expect(c.tokens.value[FIXTURE_TOKENS.length]).toStrictEqual(added)
	})

	it("filters by symbol, name or address prefix", async () => {
		resolves([listed("0x00000000000000000000000000000000000000c3", "WETH", "Wrapped Ether")])
		const c = useTokenCatalog()
		await c.refresh()
		expect(c.filtered.value).toHaveLength(FIXTURE_TOKENS.length + 1)
		c.search.value = "usd"
		expect(c.filtered.value.map((t) => t.symbol)).toEqual(["USDC", "USDT"])
		c.search.value = "Wrapped"
		expect(c.filtered.value.map((t) => t.symbol)).toEqual(["WETH"])
		c.search.value = "0x00000000000000000000000000000000000000c3"
		expect(c.filtered.value.map((t) => t.symbol)).toEqual(["WETH"])
		c.search.value = "zzz"
		expect(c.filtered.value).toEqual([])
	})

	it("replaces the previous list on a re-load and clears loading", async () => {
		resolves([listed("0x00000000000000000000000000000000000000d1", "ONE")])
		const c = useTokenCatalog()
		const first = c.refresh()
		expect(c.loading.value).toBe(true)
		await first
		expect(c.loading.value).toBe(false)
		resolves([listed("0x00000000000000000000000000000000000000d2", "TWO")], "cache")
		await c.refresh()
		expect(c.tokens.value.map((t) => t.symbol)).toEqual([...FIXTURE_TOKENS.map((t) => t.displaySymbol), "TWO"])
		expect(c.provenance.value).toBe("cache")
	})

	it("shows a pasted address with the list's metadata once the list carries it", async () => {
		const c = useTokenCatalog()
		const added = c.addPasted("0x00000000000000000000000000000000000000e4")
		resolves([listed(added.address, "LATE", "Late Arrival")])
		await c.refresh()
		const row = c.tokens.value[FIXTURE_TOKENS.length]
		expect(row).toMatchObject({ address: added.address, symbol: "LATE", decimals: 18 })
		expect(c.tokens.value.filter((t) => t.address === added.address)).toHaveLength(1)
	})

	it("dispose drops a load that is still in flight", async () => {
		let release: (value: { tokens: CatalogToken[]; provenance: "fresh" }) => void = () => undefined
		h.loadTokenList.mockReturnValue(new Promise((resolve) => (release = resolve)))
		const c = useTokenCatalog()
		const pending = c.refresh()
		c.dispose()
		release({ tokens: [listed("0x00000000000000000000000000000000000000f9", "GONE")], provenance: "fresh" })
		await pending
		expect(c.tokens.value.map((t) => t.symbol)).toEqual(FIXTURE_TOKENS.map((t) => t.displaySymbol))
		expect(c.provenance.value).toBe("none")
		expect(c.loading.value).toBe(false)
	})
})
