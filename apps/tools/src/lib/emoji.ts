import { hashToEmoji } from "@aztec-labs/wallet-sdk/crypto"

/**
 * Re-export of the wallet-sdk's verification-emoji helper.
 *
 * Both the dApp and the wallet import the same `hashToEmoji` function, so the
 * 9-emoji output matches by construction - there's no palette / window-stride
 * divergence to worry about. The verification grid is the only emoji surface
 * in the tools app (protocol security material, not UI).
 */
export { hashToEmoji }

/**
 * Split a hashToEmoji string into 9 cells (3 rows × 3 cols). Emoji are
 * variable-width grapheme clusters; we use Array.from(s) to split by code
 * point. The result is exactly 9 entries when the SDK is healthy; we pad
 * with empty strings if it returns fewer for any reason (defensive).
 */
export function toGrid(emojis: string): string[] {
	const cells = Array.from(emojis)
	if (cells.length >= 9) return cells.slice(0, 9)
	return [...cells, ...Array(9 - cells.length).fill("")]
}
