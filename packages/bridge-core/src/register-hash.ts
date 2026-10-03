/**
 * The `register` message a PortalFactory sends when it creates a token's portal — the third
 * toolchain of that keystone (Solidity `PortalFactory`, Noir `register_hash_lib`). The hub consumes
 * it with the FACTORY as the L1 sender and the portal inside the content, so the L1↔L2 pairing is
 * attested by the deployer of the clone itself. A drift here strands every deposit of that token.
 *
 * Name/symbol travel as 31-byte WORDS (`0x00 ‖ b0..b30`), never as strings: aztec.js encodes
 * strings by UTF-16 code unit, so a byte-level mismatch on a non-ASCII `name()` would produce an
 * unconsumable message. The factory sanitizes to printable ASCII before committing the word.
 */
import { computeSecretHash } from "@aztec-labs/stdlib/hash"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { bytesFromHex, sha256ToField, strip0x, word } from "./content-hash"

/** Registration is permissionless: its consumption secret is a public constant. */
export const REGISTER_SECRET = 0n

/** `compute_secret_hash([0])` — the Poseidon2 secret hash the factory hard-codes. */
export function registerSecretHash(): Promise<Fr> {
	return computeSecretHash(new Fr(REGISTER_SECRET))
}

/** `keccak256("register(address,address,bytes32,bytes32,uint8)")[:4]` — verify with `cast sig`. */
export const REGISTER_SELECTOR = "0xfbc7d0f1"

/**
 * The factory's sanitization, byte for byte: keep printable ASCII (0x20–0x7E), replace anything
 * else with `_`, truncate to 31 bytes. Takes the RAW bytes a token returned — a decoded string
 * is not the same thing (an invalid UTF-8 byte decodes to a 3-byte U+FFFD and sanitizes to three
 * underscores instead of one). The binding words are always `registrationOf(token)` on chain;
 * this exists for the keystone vectors and for previewing a not-yet-registered token from raw
 * `eth_call` returndata.
 */
export function sanitizeWordBytes(bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(Math.min(bytes.length, 31))
	for (let i = 0; i < out.length; i++) {
		const b = bytes[i]
		out[i] = b >= 0x20 && b <= 0x7e ? b : 0x5f
	}
	return out
}

/** `0x00 ‖ b0..b30` — the sanitized bytes, zero-padded on the right. */
export function toWord(raw: Uint8Array): `0x${string}` {
	const bytes = sanitizeWordBytes(raw)
	const padded = new Uint8Array(31)
	padded.set(bytes)
	let hex = "00"
	for (const b of padded) hex += b.toString(16).padStart(2, "0")
	return `0x${hex}`
}

/** The UTF-8 bytes of an ASCII-clean string — for fixed test vectors only, never live metadata. */
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** The printable string behind a word (trailing zero bytes dropped). */
export function fromWord(w: string): string {
	const hex = word(w).slice(2)
	let s = ""
	for (let i = 0; i < 62; i += 2) {
		const b = Number.parseInt(hex.slice(i, i + 2), 16)
		if (b === 0) break
		s += String.fromCharCode(b)
	}
	return s
}

/** The 31-char `str<31>` an Aztec constructor takes for a word (space-free zero padding is kept). */
export function wordToNoirString(w: string): string {
	const hex = word(w).slice(2)
	let s = ""
	for (let i = 0; i < 62; i += 2) s += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16))
	return s
}

/** Mirrors `PortalFactory` / `register_hash_lib`: sha256ToField(selector ‖ token ‖ portal ‖ nameWord ‖ symbolWord ‖ decimals). */
export function registerContentHash(
	token: string,
	portal: string,
	nameWord: string,
	symbolWord: string,
	decimals: number,
): Promise<string> {
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("decimals must be a uint8")
	return sha256ToField(
		bytesFromHex(
			strip0x(REGISTER_SELECTOR) +
				word(token) +
				word(portal) +
				word(nameWord) +
				word(symbolWord) +
				decimals.toString(16).padStart(64, "0"),
		),
	)
}
