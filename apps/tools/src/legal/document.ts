/**
 * The mainnet build's legal documents as data. They render through text interpolation only, so no
 * string here can become markup. Node-safe (no Vue), so the post-build check can import the ids.
 */

/** Each document's id, rendered as `data-legal-doc`: the post-build check proves the mainnet dist
 *  carries both and no other target carries either. */
export const LEGAL_DOC_IDS = ["unleashed-terms-of-use", "unleashed-privacy-policy"] as const

export type LegalDocId = (typeof LEGAL_DOC_IDS)[number]

export interface ProviderRow {
	name: string
	/** The URL origin the mainnet build reaches; null for one it never calls (the host serving the pages). */
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
