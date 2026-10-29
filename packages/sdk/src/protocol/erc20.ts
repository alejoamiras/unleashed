/**
 * ERC-20 reads for an arbitrary token: metadata read call by call, balances batched into one
 * multicall.
 *
 * EVERY metadata read is a raw call under the factory's own gas ceiling, and the display strings are
 * decoded from those same bytes rather than read again through a typed call: a decoded read is
 * unbounded, so a second one would hand a hostile token an uncapped channel into this process no
 * matter how tightly the first is capped. The raw bytes ship alongside the strings because only they
 * may be fed to the factory's word sanitizer — an invalid UTF-8 byte decodes to a 3-byte U+FFFD, so
 * a preview derived from the string would sanitize to three underscores where the chain commits one.
 * `decimals` is mandatory — the factory refuses a token without it, so a missing/oversized value is
 * a hard failure here rather than a silent default.
 */
import { type Address, encodeFunctionData, type Hex, hexToBytes } from "viem"

export const ERC20_ABI = [
	{ type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
	{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
	{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
	{
		type: "function",
		name: "balanceOf",
		stateMutability: "view",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ type: "uint256" }],
	},
	{
		type: "function",
		name: "allowance",
		stateMutability: "view",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "spender", type: "address" },
		],
		outputs: [{ type: "uint256" }],
	},
	{
		type: "function",
		name: "approve",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ type: "bool" }],
	},
	{
		type: "function",
		name: "transfer",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ type: "bool" }],
	},
] as const

/** One entry of an `allowFailure: true` multicall. */
export type Erc20CallResult = { status: "success"; result: unknown } | { status: "failure"; error: Error }

/** The viem surface these reads need — a PublicClient satisfies it. */
export interface Erc20Client {
	multicall(args: {
		allowFailure: true
		contracts: readonly {
			address: Address
			abi: typeof ERC20_ABI
			functionName: "balanceOf"
			args?: readonly [Address] | undefined
		}[]
	}): Promise<readonly Erc20CallResult[]>
	call(args: { to: Address; data: Hex; gas: bigint }): Promise<{ data?: Hex | undefined }>
}

/** Thrown when a token cannot be bridged because its `decimals` is absent or out of uint8 range. */
export class Erc20MetadataError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = "Erc20MetadataError"
	}
}

export interface Erc20Metadata {
	name: string
	symbol: string
	decimals: number
	/** What `name()` returned, undecoded — the sanitizer's input. Empty when the token has no name. */
	nameRaw: Uint8Array
	/** What `symbol()` returned, undecoded. */
	symbolRaw: Uint8Array
}

const NAME_SELECTOR = encodeFunctionData({ abi: ERC20_ABI, functionName: "name" })
const SYMBOL_SELECTOR = encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" })
const DECIMALS_SELECTOR = encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" })
const EMPTY = new Uint8Array(0)

/** `PortalFactory.METADATA_GAS`. Returning bytes costs memory expansion, so the same ceiling the
 *  chain applies also bounds what a hostile token can make an RPC transport into this process. */
const METADATA_GAS = 100_000n

/** Reads one 32-byte big-endian word as a JS length/offset; `undefined` when it can't be one. */
function wordAt(bytes: Uint8Array, at: number): number | undefined {
	if (at < 0 || at + 32 > bytes.length) return undefined
	let value = 0n
	for (const b of bytes.subarray(at, at + 32)) value = (value << 8n) | BigInt(b)
	return value > 0xffff_ffffn ? undefined : Number(value)
}

/** The only string offset `PortalFactory._readWord` accepts — its window holds no other layout. */
const STRING_OFFSET = 32

/**
 * The metadata bytes inside raw `name()`/`symbol()` returndata: the payload of an ABI string, or —
 * for the bytes32-style tokens that predate the string ABI (MKR) — the word up to its first zero
 * byte. Anything that is neither yields no bytes.
 *
 * The string branch mirrors `PortalFactory._readWord`'s acceptance conditions exactly, because a
 * layout the factory refuses commits the EMPTY word on chain: a token returning `[offset=0x40]…`
 * has a name here and none there, and every derived L2 address would follow the wrong one.
 */
export function metadataReturndataBytes(returndata: Hex): Uint8Array {
	const bytes = hexToBytes(returndata)
	if (bytes.length === 32) {
		const end = bytes.indexOf(0)
		return bytes.slice(0, end === -1 ? 32 : end)
	}
	if (bytes.length < 64 || wordAt(bytes, 0) !== STRING_OFFSET) return EMPTY
	// A length word too large to be a JS number can only overrun what the token returned.
	const length = wordAt(bytes, STRING_OFFSET) ?? bytes.length
	// A non-empty string whose data word never arrived: the factory's zero-filled window would
	// sanitize into `length` underscores, so it takes the empty word instead.
	if (length > 0 && bytes.length < 96) return EMPTY
	return bytes.slice(64, 64 + length)
}

/** The single door every metadata read goes through: the gas cap is the only thing bounding what an
 *  RPC will transport in, so a read that bypasses it is unbounded however the reply is decoded. */
async function rawCall(client: Erc20Client, token: Address, selector: Hex): Promise<Hex | undefined> {
	try {
		return (await client.call({ to: token, data: selector, gas: METADATA_GAS })).data
	} catch {
		return undefined
	}
}

async function rawMetadata(client: Erc20Client, token: Address, selector: Hex): Promise<Uint8Array> {
	const data = await rawCall(client, token, selector)
	return data === undefined ? EMPTY : metadataReturndataBytes(data)
}

/** `PortalFactory._readDecimals`: exactly one word, holding something a uint8 can hold. A `string`
 *  return (whose first word is the offset 0x20) must never read as 32 decimals. */
async function rawDecimals(client: Erc20Client, token: Address): Promise<number> {
	const data = await rawCall(client, token, DECIMALS_SELECTOR)
	const bytes = data === undefined ? EMPTY : hexToBytes(data)
	const value = bytes.length === 32 ? wordAt(bytes, 0) : undefined
	if (value === undefined || value > 255) {
		throw new Erc20MetadataError(`Token ${token} has no usable decimals() — it cannot be bridged.`)
	}
	return value
}

/** How much of a name or symbol reaches a display. Beyond it the bytes still exist (the sanitizer
 *  reads its own window of them) — they just stop being something the UI has to render. */
const DISPLAY_BYTES = 256

function displayString(raw: Uint8Array): string {
	const text = new TextDecoder().decode(raw.subarray(0, DISPLAY_BYTES))
	return raw.length > DISPLAY_BYTES ? `${text}…` : text
}

/** Metadata read: three gas-capped raw calls in parallel, and nothing else. */
export async function readErc20Metadata(client: Erc20Client, token: Address): Promise<Erc20Metadata> {
	const [nameRaw, symbolRaw, decimals] = await Promise.all([
		rawMetadata(client, token, NAME_SELECTOR),
		rawMetadata(client, token, SYMBOL_SELECTOR),
		rawDecimals(client, token),
	])
	return { name: displayString(nameRaw), symbol: displayString(symbolRaw), decimals, nameRaw, symbolRaw }
}

/**
 * Balances for many tokens in one batch, keyed by the address AS PASSED (so `get(tokens[i])` hits
 * regardless of casing). A token that reverts, or is not an ERC-20 at all, reports `0n` — one bad
 * entry must never cost the caller the whole list.
 */
export async function readErc20Balances(client: Erc20Client, owner: Address, tokens: readonly Address[]): Promise<Map<Address, bigint>> {
	const balances = new Map<Address, bigint>()
	if (tokens.length === 0) return balances
	const results = await client.multicall({
		allowFailure: true,
		contracts: tokens.map((address) => ({ address, abi: ERC20_ABI, functionName: "balanceOf" as const, args: [owner] as const })),
	})
	tokens.forEach((address, i) => {
		const result = results[i]
		balances.set(address, result?.status === "success" && typeof result.result === "bigint" ? result.result : 0n)
	})
	return balances
}
