import { LEGAL_URLS, type LegalDocument, PRIVACY, TERMS } from "@unleashed/legal"
import {
	type Address,
	type EIP1193Provider,
	getAddress,
	type Hex,
	isAddress,
	sha256,
	stringToBytes,
	stringToHex,
	verifyMessage,
} from "viem"
import { isUserRejection } from "@/lib/wallet-errors"

/**
 * The mainnet app's record that this browser accepted the current Terms of Use and Privacy Policy: an
 * EIP-191 signature over a fixed text naming both documents' digests, the site and the account. It records
 * assent and guards nothing: anyone who can write this origin's storage can write a valid record, so no
 * code may treat it as access control.
 */

export const ACCEPTANCE_KEY = "unleashed:legal-acceptance"

const digest = (doc: LegalDocument): Hex => sha256(stringToBytes(JSON.stringify(doc)))

/** Each document's version. Any edit to a document, its date included, changes its digest and so asks again. */
export const DIGESTS = { terms: digest(TERMS), privacy: digest(PRIVACY) } as const

export interface AcceptanceRecord {
	v: 1
	account: Address
	signature: Hex
	terms: Hex
	privacy: Hex
}

/** `changed` proves no earlier acceptance: it only says the stored digests are not the current ones. */
export type Standing = "accepted" | "changed" | "none"

export type GetStorage = () => Pick<Storage, "getItem" | "setItem">

export const browserStorage: GetStorage = () => window.localStorage

/**
 * The text the wallet is asked to sign. It stays printable ASCII, so wallets that show only plain characters
 * can show it, and its first line never takes EIP-4361's `<domain> wants you to sign in` form, so no sign-in
 * verifier accepts the signature. `origin` is the site the page claims to be; the wallet shows the real one.
 */
export function acceptanceMessage(origin: string, account: Address): string {
	return [
		"Unleashed: accept the Terms of Use",
		"",
		"I agree to the Unleashed Terms of Use, and I have read the Privacy Policy.",
		"",
		`Terms of Use, updated ${TERMS.updated}`,
		LEGAL_URLS["unleashed-terms-of-use"],
		`Version ${DIGESTS.terms}`,
		"",
		`Privacy Policy, updated ${PRIVACY.updated}`,
		LEGAL_URLS["unleashed-privacy-policy"],
		`Version ${DIGESTS.privacy}`,
		"",
		`Site: ${origin}`,
		`Account: ${account}`,
		"",
		"Signing is free. It is not a transaction and moves no funds.",
	].join("\n")
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/
const DIGEST = /^0x[0-9a-f]{64}$/

/** Storage is untrusted input: only a plain object with every field in its exact form is a record. */
function asRecord(value: unknown): AcceptanceRecord | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null
	const { v, account, signature, terms, privacy } = value as Record<string, unknown>
	if (v !== 1) return null
	if (typeof account !== "string" || !ADDRESS.test(account)) return null
	if (typeof signature !== "string" || !SIGNATURE.test(signature)) return null
	if (typeof terms !== "string" || !DIGEST.test(terms)) return null
	if (typeof privacy !== "string" || !DIGEST.test(privacy)) return null
	return { v: 1, account: account as Address, signature: signature as Hex, terms: terms as Hex, privacy: privacy as Hex }
}

/** viem's check is async and rejects on a malformed signature; only an awaited `true` counts. */
async function verifies(address: Address, message: string, signature: Hex): Promise<boolean> {
	try {
		return (await verifyMessage({ address, message, signature })) === true
	} catch {
		return false
	}
}

/**
 * Where this browser stands. `accepted` only when the stored record parses, names the current digests and
 * its signature verifies over the text rebuilt for `origin`; a record naming other digests is `changed`, and
 * one for another site, with any field edited, or in a storage that throws, is `none`. Needs no wallet.
 */
export async function readAcceptance(getStorage: GetStorage, origin: string): Promise<Standing> {
	let record: AcceptanceRecord | null
	try {
		const raw = getStorage().getItem(ACCEPTANCE_KEY)
		record = raw === null ? null : asRecord(JSON.parse(raw))
	} catch {
		return "none"
	}
	if (!record) return "none"
	if (record.terms !== DIGESTS.terms || record.privacy !== DIGESTS.privacy) return "changed"
	return (await verifies(record.account, acceptanceMessage(origin, record.account), record.signature)) ? "accepted" : "none"
}

/**
 * Asks the wallet for an account and a signature over the text, and returns the record only once that
 * signature verifies for that account. Throws the wallet's own error on a refusal (see `signFailure`), and
 * an `Error` when the wallet returns no account or a signature that does not verify (another account, an
 * ERC-1271 signature, junk).
 */
export async function signAcceptance(provider: EIP1193Provider, origin: string): Promise<AcceptanceRecord> {
	const [first] = await provider.request({ method: "eth_requestAccounts" })
	if (!first || !isAddress(first, { strict: false })) throw new Error("The wallet returned no account.")
	const account = getAddress(first)
	const message = acceptanceMessage(origin, account)
	const signature = await provider.request({ method: "personal_sign", params: [stringToHex(message), account] })
	const record = asRecord({ v: 1, account, signature, terms: DIGESTS.terms, privacy: DIGESTS.privacy })
	if (!record || !(await verifies(account, message, record.signature))) {
		throw new Error("The wallet's signature does not verify for its account.")
	}
	return record
}

/** Best effort: a browser that cannot store keeps the acceptance for the page's lifetime only. */
export function recordAcceptance(getStorage: GetStorage, record: AcceptanceRecord): void {
	try {
		getStorage().setItem(ACCEPTANCE_KEY, JSON.stringify(record))
	} catch {}
}

/** EIP-1474 `-32002`, which wallets such as MetaMask return while an earlier request from this origin waits; a reload does not clear it. */
const REQUEST_PENDING = -32002

export type SignFailure = "refused" | "busy" | "failed"

export function signFailure(error: unknown): SignFailure {
	if (isUserRejection(error)) return "refused"
	if ((error as { code?: unknown } | null)?.code === REQUEST_PENDING) return "busy"
	return "failed"
}

export function injectedProvider(): EIP1193Provider | undefined {
	return (window as Window & { ethereum?: EIP1193Provider }).ethereum
}
