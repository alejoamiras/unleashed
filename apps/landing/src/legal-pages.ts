/**
 * The legal pages the build emits, one per document at the path of its public URL. Build-time only:
 * main.ts never imports it, so no document text reaches the landing's script.
 */
import { LEGAL_DOCUMENTS, LEGAL_URLS, type LegalDocument } from "@unleashed/legal"

export interface LegalPage {
	readonly doc: LegalDocument
	/** The document's public URL, its canonical link. */
	readonly url: string
	/** Where the site links it; the Worker serves `file` there. */
	readonly path: string
	readonly file: string
}

export const LEGAL_PAGES: readonly LegalPage[] = LEGAL_DOCUMENTS.map((doc) => {
	const url = LEGAL_URLS[doc.id]
	const path = new URL(url).pathname
	return { doc, url, path, file: `${path.slice(1)}.html` }
})
