import {
	type Address,
	type ClientConfig,
	createPublicClient,
	custom,
	decodeFunctionData,
	encodeAbiParameters,
	encodeErrorResult,
	encodeFunctionResult,
	ExecutionRevertedError,
	type Hex,
	HttpRequestError,
	multicall3Abi,
	padHex,
	type PublicClient,
} from "viem"
import { sepolia } from "viem/chains"
import { describe, expect, it, vi } from "vitest"
import { type Erc20CallResult, type Erc20Client, Erc20MetadataError, readErc20Balances, readErc20Metadata } from "./erc20.ts"

const TOKEN = "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2" as Address
const OWNER = "0xA40A2FE147b7e96325d7c7D974B1f11C3ED82c68" as Address

const ok = (result: unknown): Erc20CallResult => ({ status: "success", result })
const fail = (): Erc20CallResult => ({ status: "failure", error: new Error("execution reverted") })
const abiString = (s: string): Hex => encodeAbiParameters([{ type: "string" }], [s])
const word = (n: number | bigint): Hex => encodeAbiParameters([{ type: "uint256" }], [BigInt(n)])

/** `PortalFactory.METADATA_GAS` on top of the call's intrinsic 21,000 + 4 × 16, spelled independently of the reader so
 *  a loosened cap, or a token starved below the factory's budget, reds here. */
const METADATA_GAS = 100_000n + 21_064n

type FakeClient = Erc20Client & { multicall: ReturnType<typeof vi.fn>; gasCaps: bigint[] }

function fakeClient(results: Erc20CallResult[], returndata: Record<string, Hex> = {}): FakeClient {
	const gasCaps: bigint[] = []
	return {
		multicall: vi.fn(async () => results),
		call: vi.fn(async ({ data, gas }: { data: Hex; gas: bigint }) => {
			gasCaps.push(gas)
			const value = returndata[data.slice(0, 10)]
			if (value === undefined) throw new ExecutionRevertedError()
			return { data: value }
		}),
		gasCaps,
		ccipRead: false,
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

describe("readErc20Metadata through viem's call", () => {
	/** A node that answers every metadata read of one healthy token, except the selector `fails` names, through a client
	 *  built with `ccipRead: false` unless `opts` names another; `calls` collects the selector of every `eth_call`. */
	function node(
		fails: Record<string, () => Error> = {},
		opts: { ccipRead?: ClientConfig["ccipRead"]; calls?: string[] } = {},
	): PublicClient {
		const answers: Record<string, Hex> = { [NAME]: abiString("Token"), [SYMBOL]: abiString("TKN"), [DECIMALS]: word(18) }
		const { calls = [] } = opts
		return createPublicClient({
			chain: sepolia,
			ccipRead: "ccipRead" in opts ? opts.ccipRead : false,
			transport: custom(
				{
					request: async ({ method, params }) => {
						if (method !== "eth_call") throw new Error(`unexpected ${method}`)
						const selector = (params as [{ data: Hex }])[0].data.slice(0, 10)
						calls.push(selector)
						const fail = fails[selector]
						if (fail) throw fail()
						return answers[selector]
					},
				},
				{ retryCount: 0 },
			),
		}) as PublicClient
	}

	const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code, data: "0x" })
	const http429 = () => new HttpRequestError({ url: "https://rpc.invalid", status: 429, body: {} })

	// A -32603 is also how anvil reports an EVM halt: a shape no reader can tell from a refusal, so it fails closed.
	it.each([
		["an HTTP 429 on name()", NAME, http429, "HTTP request failed"],
		["a JSON-RPC internal error on symbol()", SYMBOL, () => rpcError(-32603, "internal error"), "internal error"],
		["a provider's own error code on name()", NAME, () => rpcError(30, "request timeout on the free tier"), "free tier"],
		["geth's -32000 for a pruned block on symbol()", SYMBOL, () => rpcError(-32000, "header not found"), "header not found"],
		["an HTTP 429 on decimals()", DECIMALS, http429, "HTTP request failed"],
	] as const)("rejects %s with the client's error, never as missing metadata", async (_label, selector, refusal, message) => {
		const err = await readErc20Metadata(node({ [selector]: refusal }), TOKEN).catch((e) => e)
		expect(err).not.toBeInstanceOf(Erc20MetadataError)
		expect(err.message).toContain(message)
		await expect(readErc20Metadata(node(), TOKEN)).resolves.toMatchObject({ name: "Token", symbol: "TKN", decimals: 18 })
	})

	it.each([
		["code 3", () => rpcError(3, "execution reverted")],
		["geth's bare -32000", () => rpcError(-32000, "execution reverted")],
		[
			"a wallet's -32603 around the node's code 3",
			() =>
				Object.assign(new Error("Internal JSON-RPC error."), {
					code: -32603,
					data: { code: 3, message: "execution reverted", data: "0x" },
				}),
		],
	] as const)("reads a symbol() the node reports reverted (%s) as no symbol", async (_label, revert) => {
		await expect(readErc20Metadata(node({ [SYMBOL]: revert }), TOKEN)).resolves.toEqual({
			name: "Token",
			symbol: "",
			decimals: 18,
			nameRaw: new TextEncoder().encode("Token"),
			symbolRaw: new Uint8Array(0),
		})
		await expect(readErc20Metadata(node({ [DECIMALS]: revert }), TOKEN)).rejects.toBeInstanceOf(Erc20MetadataError)
	})

	/** An EIP-3668 `OffchainLookup(sender, urls, callData, callbackFunction, extraData)` revert naming `TOKEN`. */
	const LOOKUP = encodeErrorResult({
		abi: [
			{
				type: "error",
				name: "OffchainLookup",
				inputs: [
					{ name: "sender", type: "address" },
					{ name: "urls", type: "string[]" },
					{ name: "callData", type: "bytes" },
					{ name: "callbackFunction", type: "bytes4" },
					{ name: "extraData", type: "bytes" },
				],
			},
		],
		errorName: "OffchainLookup",
		args: [TOKEN, ["https://gateway.invalid/{sender}/{data}.json"], "0x", "0xdeadbeef", "0x"],
	})

	it.each([
		["code 3", () => Object.assign(new Error("execution reverted"), { code: 3, data: LOOKUP })],
		[
			"a wallet's -32603 around the node's code 3",
			() =>
				Object.assign(new Error("Internal JSON-RPC error."), {
					code: -32603,
					data: { code: 3, message: "execution reverted", data: LOOKUP },
				}),
		],
	] as const)(
		"reads a name() that reverts with an off-chain lookup (%s) as reverted, fetching and calling nothing else",
		async (_label, lookup) => {
			const fetch = vi.fn(async () => Response.json({ data: abiString("Gateway") }))
			vi.stubGlobal("fetch", fetch)
			try {
				const calls: string[] = []
				await expect(readErc20Metadata(node({ [NAME]: lookup }, { calls }), TOKEN)).resolves.toEqual({
					name: "",
					symbol: "TKN",
					decimals: 18,
					nameRaw: new Uint8Array(0),
					symbolRaw: new TextEncoder().encode("TKN"),
				})
				expect(fetch).not.toHaveBeenCalled()
				expect(calls.sort()).toEqual([NAME, SYMBOL, DECIMALS].sort())
				await expect(readErc20Metadata(node(), TOKEN)).resolves.toMatchObject({ name: "Token", symbol: "TKN", decimals: 18 })
			} finally {
				vi.unstubAllGlobals()
			}
		},
	)

	it.each([
		["omitted", undefined],
		["a custom resolver", { request: vi.fn(async (): Promise<Hex> => "0x") }],
	] as const)("refuses a client whose ccipRead is %s, before any call", async (_label, ccipRead) => {
		const calls: string[] = []
		await expect(readErc20Metadata(node({}, { ccipRead, calls }), TOKEN)).rejects.toThrow("ccipRead: false")
		expect(calls).toEqual([])
		if (ccipRead) expect(ccipRead.request).not.toHaveBeenCalled()
		await expect(readErc20Metadata(node(), TOKEN)).resolves.toMatchObject({ name: "Token" })
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

	// A refusal raised by another viem copy than the SDK's: only its name can identify it.
	const refusedElsewhere = new Error("aggregate refused", { cause: Object.assign(new Error("429"), { name: "CallExecutionError" }) })

	it.each([
		["a success that is not a bigint", [ok("7")], "gave no balance"],
		["a missing entry", [], "gave no balance"],
		["a refusal from another viem copy", [{ status: "failure", error: refusedElsewhere }], "aggregate refused"],
	] as const)("rejects %s", async (_label, results, message) => {
		await expect(readErc20Balances(fakeClient([...results]), OWNER, [TOKEN])).rejects.toThrow(message)
	})

	it("reads a failure whose cause chain loops as the token's own", async () => {
		const looping = new Error("looping")
		looping.cause = looping
		await expect(readErc20Balances(fakeClient([{ status: "failure", error: looping }]), OWNER, [TOKEN])).resolves.toEqual(
			new Map([[TOKEN, 0n]]),
		)
	})

	it("rejects a token address viem would refuse to encode, before any call", async () => {
		const client = fakeClient([ok(1n)])
		const badChecksum = TOKEN.replace("A579", "a579") as Address
		await expect(readErc20Balances(client, OWNER, [badChecksum])).rejects.toThrow(badChecksum)
		expect(client.multicall).not.toHaveBeenCalled()
		await expect(readErc20Balances(client, OWNER, [TOKEN])).resolves.toEqual(new Map([[TOKEN, 1n]]))
	})
})

describe("readErc20Balances through viem's multicall", () => {
	const a = "0x1111111111111111111111111111111111111111" as Address
	const b = "0x2222222222222222222222222222222222222222" as Address

	/** A node that answers every `aggregate3` with 5 for the first token and a revert for the rest, or refuses it. */
	function node(batch: boolean, refusal?: Error): PublicClient {
		return createPublicClient({
			chain: sepolia,
			batch: batch ? { multicall: true } : undefined,
			transport: custom(
				{
					request: async ({ method, params }) => {
						if (method !== "eth_call") throw new Error(`unexpected ${method}`)
						if (refusal) throw refusal
						const { args } = decodeFunctionData({ abi: multicall3Abi, data: (params as [{ data: Hex }])[0].data })
						return encodeFunctionResult({
							abi: multicall3Abi,
							functionName: "aggregate3",
							result: (args[0] as readonly unknown[]).map((_, i) => ({
								success: i === 0,
								returnData: i === 0 ? word(5) : "0x",
							})),
						})
					},
				},
				{ retryCount: 0 },
			),
		}) as PublicClient
	}

	const http429 = () => new HttpRequestError({ url: "https://rpc.invalid", status: 429, body: {} })
	// viem wraps a JSON-RPC internal error in a revert error: a different chain from a transport failure's.
	const internalError = () => Object.assign(new Error("internal error"), { code: -32603 })

	it.each([
		["an HTTP 429", false, http429, "HTTP request failed"],
		["an HTTP 429", true, http429, "HTTP request failed"],
		["a JSON-RPC internal error", false, internalError, "internal error"],
		["a JSON-RPC internal error", true, internalError, "internal error"],
	] as const)("rejects an aggregate refused with %s, never zeros (client batching: %s)", async (_label, batch, refusal, message) => {
		await expect(readErc20Balances(node(batch, refusal()), OWNER, [a, b])).rejects.toThrow(message)
		await expect(readErc20Balances(node(batch), OWNER, [a, b])).resolves.toEqual(
			new Map([
				[a, 5n],
				[b, 0n],
			]),
		)
	})
})
