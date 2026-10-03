/**
 * Rendering guards for token identity. Every display string the wizard shows for a non-manifest
 * token comes from a remote list or a pasted contract, so it is untrusted text sitting next to an
 * address the user is about to fund: it is stripped of anything that can reorder or hide adjacent
 * UI, capped, and the address it claims to name is rendered beside it in checksummed form.
 */
import { getAddress } from "viem"

/** No legitimate symbol or name is longer; a token list can publish kilobytes into a row. */
const DISPLAY_MAX = 32

/** C0/C1 controls, the Arabic letter mark, the zero-width and bidi override/isolate marks, and the
 *  BOM: a listed symbol must never reorder or hide the address rendered beside it. */
function isUnsafeDisplayChar(point: number): boolean {
	if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)) return true
	if (point === 0x61c || point === 0xfeff) return true
	return (point >= 0x200b && point <= 0x200f) || (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069)
}

/** A persisted sentence (a journal record's stored refusal reason) gets the same strip, with a
 *  cap sized for prose rather than a symbol. */
const SENTENCE_MAX = 240

function stripAndCap(text: string, max: number): string {
	const kept = Array.from(text).filter((ch) => !isUnsafeDisplayChar(ch.codePointAt(0) ?? 0))
	const cleaned = Array.from(kept.join("").trim())
	return cleaned.length > max ? `${cleaned.slice(0, max).join("")}…` : cleaned.join("")
}

/** Sanitize + bound one list- or contract-supplied display string. Iterating code points rather
 *  than UTF-16 units keeps a cap from splitting an emoji surrogate pair mid-name. */
export function safeDisplay(text: string): string {
	return stripAndCap(text, DISPLAY_MAX)
}

export function safeSentence(text: string): string {
	return stripAndCap(text, SENTENCE_MAX)
}

/** An address-shaped persisted string for display: stripped, capped past any real address length. */
export function safeAddressText(text: string): string {
	return stripAndCap(text, 80)
}

/** EIP-55 form, so the user compares against the same casing their explorer shows. An address the
 *  checksummer refuses is rendered verbatim rather than dropped — hiding it would be worse. */
export function checksumAddress(address: string): string {
	try {
		return getAddress(address)
	} catch {
		return address
	}
}
