/**
 * The legal documents as closed data: a renderer knows every field, so a renderer that escapes each
 * string leaves no way for one to become markup.
 */

/** Each document's id, stable across text edits. The tools app's post-build check refuses any of them
 *  in a testnet or local dist. */
export const LEGAL_DOC_IDS = ["unleashed-terms-of-use", "unleashed-privacy-policy"] as const

export type LegalDocId = (typeof LEGAL_DOC_IDS)[number]

export interface ProviderRow {
	name: string
	/** The URL origin the mainnet app reaches; null for a provider it never calls (the host serving the pages). */
	origin: string | null
	role: string
	sees: string
	policyUrl: string
}

export type Block =
	| { kind: "p"; text: string }
	| { kind: "list"; items: readonly string[] }
	| { kind: "providers"; rows: readonly ProviderRow[] }

export interface LegalSection {
	heading: string
	blocks: readonly Block[]
}

export interface LegalDocument {
	id: LegalDocId
	title: string
	updated: string
	sections: readonly LegalSection[]
}
