/**
 * Pure-TS L1<->L2 content hashes — the THIRD toolchain in the keystone.
 * Solidity `Hash.sha256ToField(abi.encodeWithSignature(...))` and the Noir
 * `token_portal_content_hash_lib` are the other two; bridge-core's tests assert
 * these produce byte-identical values for the same fixed vectors, so a drift
 * here fails the same way it would on-chain (an unconsumable message → stranded
 * funds). No aztec.js dependency — just Web Crypto SHA-256.
 *
 * `sha256ToField(data) = uint256(sha256(data)) >> 8` — Aztec shifts off the low
 * byte so the result fits under the BN254 field (hence the leading 0x00 byte).
 * Selectors are `keccak256(signature)[:4]` (verify with `cast sig "<sig>"`).
 */

const SELECTOR = {
	mintToPublic: "bc6a9bd3", // mint_to_public(bytes32,uint256)
	mintToPrivate: "8b3af5e8", // mint_to_private(uint256)
	withdraw: "69328dec", // withdraw(address,uint256,address)
} as const

export function strip0x(h: string): string {
	return h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h
}

/** ABI word: a hex value right-aligned in 32 bytes (64 hex chars). */
export function word(hex: string): string {
	return strip0x(hex).toLowerCase().padStart(64, "0")
}

function wordFromBigInt(n: bigint): string {
	return n.toString(16).padStart(64, "0")
}

export function bytesFromHex(hex: string): Uint8Array<ArrayBuffer> {
	const clean = strip0x(hex)
	const out = new Uint8Array(new ArrayBuffer(clean.length / 2))
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
	return out
}

export async function sha256ToField(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data))
	let hex = ""
	for (const b of digest) hex += b.toString(16).padStart(2, "0")
	// uint256(sha256) >> 8  ==  0x00 prepended to the first 31 bytes of the digest.
	return `0x00${hex.slice(0, 62)}`
}

/** Content hash for a public mint (recipient bound in the hash). `to` is a bytes32. */
export function mintToPublicContentHash(toBytes32: string, amount: bigint): Promise<string> {
	return sha256ToField(bytesFromHex(SELECTOR.mintToPublic + word(toBytes32) + wordFromBigInt(amount)))
}

/** Content hash for a private mint (no recipient — the L2 claim chooses it). */
export function mintToPrivateContentHash(amount: bigint): Promise<string> {
	return sha256ToField(bytesFromHex(SELECTOR.mintToPrivate + wordFromBigInt(amount)))
}

/** Content hash for an L2->L1 withdraw. `recipient`/`caller` are L1 addresses. */
export function withdrawContentHash(recipient: string, amount: bigint, caller: string): Promise<string> {
	return sha256ToField(bytesFromHex(SELECTOR.withdraw + word(recipient) + wordFromBigInt(amount) + word(caller)))
}
