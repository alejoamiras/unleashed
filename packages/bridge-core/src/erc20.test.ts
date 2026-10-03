import { type Address, encodeAbiParameters, type Hex, padHex, type PublicClient } from "viem"
import { describe, expect, it, vi } from "vitest"
import { type Erc20CallResult, type Erc20Client, Erc20MetadataError, readErc20Balances, readErc20Metadata } from "./erc20"

const TOKEN = "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2" as Address
const OWNER = "0xA40A2FE147b7e96325d7c7D974B1f11C3ED82c68" as Address

const ok = (result: unknown): Erc20CallResult => ({ status: "success", result })
const fail = (): Erc20CallResult => ({ status: "failure", error: new Error("execution reverted") })
const abiString = (s: string): Hex => encodeAbiParameters([{ type: "string" }], [s])
const word = (n: number | bigint): Hex => encodeAbiParameters([{ type: "uint256" }], [BigInt(n)])

/** `PortalFactory.METADATA_GAS`, spelled independently of the reader so a loosened cap reds here. */
const METADATA_GAS = 100_000n

type FakeClient = Erc20Client & { multicall: ReturnType<typeof vi.fn>; gasCaps: bigint[] }

function fakeClient(results: Erc20CallResult[], returndata: Record<string, Hex> = {}): FakeClient {
	// The caps are recorded rather than asserted in place: the reader swallows every raw-call throw,
	// so an assertion here would be caught and reported as a token with no metadata.
	const gasCaps: bigint[] = []
	return {
		multicall: vi.fn(async () => results),
		call: vi.fn(async ({ data, gas }: { data: Hex; gas: bigint }) => {
			gasCaps.push(gas)
			const value = returndata[data.slice(0, 10)]
			if (value === undefined) throw new Error("execution reverted")
			return { data: value }
		}),
		gasCaps,
	} as unknown as FakeClient
}

const NAME = "0x06fdde03"
const SYMBOL = "0x95d89b41"
const DECIMALS = "0x313ce567"

/** Every metadata read carries the ceiling; there is no fourth, uncapped one. */
function expectAllCapped(client: FakeClient): void {
	expect(client.gasCaps).toEqual([METADATA_GAS, METADATA_GAS, METADATA_GAS])
	expect(client.multicall).not.toHaveBeenCalled()
}

describe("readErc20Metadata", () => {
	// The assertion is the compile: a viem client must reach these reads without a cast.
	it("takes a real viem PublicClient", () => {
		expect((client: PublicClient): Erc20Client => client).toBeTypeOf("function")
	})

	it("returns the decoded strings and the raw payload bytes for a string-ABI token", async () => {
		const client = fakeClient([], {
			[NAME]: abiString("Wrapped Ether"),
			[SYMBOL]: abiString("WETH"),
			[DECIMALS]: word(18),
		})
		const meta = await readErc20Metadata(client, TOKEN)
		expect(meta).toMatchObject({ name: "Wrapped Ether", symbol: "WETH", decimals: 18 })
		expect(new TextDecoder().decode(meta.nameRaw)).toBe("Wrapped Ether")
		expect(meta.symbolRaw).toEqual(new TextEncoder().encode("WETH"))
		expectAllCapped(client)
	})

	it("reads bytes32-style metadata that the string decode cannot: the word up to its first zero byte", async () => {
		// MKR: `symbol()` returns a bare 32-byte word, not an ABI string.
		const client = fakeClient([], {
			[NAME]: padHex("0x4d616b6572", { dir: "right", size: 32 }),
			[SYMBOL]: padHex("0x4d4b52", { dir: "right", size: 32 }),
			[DECIMALS]: word(18),
		})
		const meta = await readErc20Metadata(client, TOKEN)
		expect(meta.name).toBe("Maker")
		expect(meta.symbol).toBe("MKR")
		// The raw bytes are what the factory sanitizes: the 29 pad bytes must not survive as underscores.
		expect(meta.symbolRaw).toEqual(new TextEncoder().encode("MKR"))
	})

	it("mirrors the factory's word reader: a string offset other than 0x20 yields no bytes and no display", async () => {
		// `[offset=0x40][pad][len][data]` — a legal ABI encoding the factory's 96-byte window refuses,
		// so a name read from it here would be a name the chain never commits.
		const shifted = (s: string): Hex => `0x${"40".padStart(64, "0")}${"0".repeat(64)}${abiString(s).slice(66)}`
		const client = fakeClient([], { [NAME]: shifted("Wrapped Ether"), [SYMBOL]: abiString("WETH"), [DECIMALS]: word(18) })
		const meta = await readErc20Metadata(client, TOKEN)
		expect(meta.nameRaw).toEqual(new Uint8Array(0))
		expect(meta.name).toBe("")
		expect(meta.symbolRaw).toEqual(new TextEncoder().encode("WETH"))
	})

	it("truncates an oversized name for display while keeping every raw byte", async () => {
		const client = fakeClient([], { [NAME]: abiString("A".repeat(300)), [SYMBOL]: abiString("A"), [DECIMALS]: word(18) })
		const meta = await readErc20Metadata(client, TOKEN)
		expect(meta.name).toBe(`${"A".repeat(256)}…`)
		expect(meta.nameRaw.length).toBe(300)
	})

	it("tolerates a token with no name or symbol", async () => {
		const client = fakeClient([], { [DECIMALS]: word(6) })
		const meta = await readErc20Metadata(client, TOKEN)
		expect(meta).toEqual({ name: "", symbol: "", decimals: 6, nameRaw: new Uint8Array(0), symbolRaw: new Uint8Array(0) })
	})

	it("refuses a token whose decimals() is missing or is not exactly one word", async () => {
		const missing = fakeClient([], { [NAME]: abiString("Nameless") })
		const err = await readErc20Metadata(missing, TOKEN).catch((e) => e)
		expect(err).toBeInstanceOf(Erc20MetadataError)
		expect(err.message).toContain(TOKEN)
		// A `string` return would otherwise read its 0x20 offset word as 32 decimals.
		const shortWord = fakeClient([], { [DECIMALS]: "0x12" })
		await expect(readErc20Metadata(shortWord, TOKEN)).rejects.toBeInstanceOf(Erc20MetadataError)
	})

	it("refuses decimals outside uint8", async () => {
		const client = fakeClient([], { [DECIMALS]: word(256) })
		await expect(readErc20Metadata(client, TOKEN)).rejects.toBeInstanceOf(Erc20MetadataError)
	})
})

describe("readErc20Balances", () => {
	it("maps one batch and reports a failing token as zero", async () => {
		const a = "0x1111111111111111111111111111111111111111" as Address
		const b = "0x2222222222222222222222222222222222222222" as Address
		const c = "0x3333333333333333333333333333333333333333" as Address
		const client = fakeClient([ok(7n), fail(), ok(0n)])
		const balances = await readErc20Balances(client, OWNER, [a, b, c])
		expect([...balances]).toEqual([
			[a, 7n],
			[b, 0n],
			[c, 0n],
		])
		expect(client.multicall).toHaveBeenCalledTimes(1)
	})

	it("makes no request for an empty token set", async () => {
		const client = fakeClient([])
		expect(await readErc20Balances(client, OWNER, [])).toEqual(new Map())
		expect(client.multicall).not.toHaveBeenCalled()
	})
})
