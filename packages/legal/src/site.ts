import type { LegalDocId } from "./document.ts"

/**
 * Where the public reads each document: the landing, which no login wall covers. The mainnet app links
 * here, and the landing emits `<path>.html` for each, so the Worker serves it at this URL. One literal per
 * URL, so a build that links a document carries the whole URL as a checkable string.
 */
export const LEGAL_URLS = {
	"unleashed-terms-of-use": "https://unleashed.systems/terms",
	"unleashed-privacy-policy": "https://unleashed.systems/privacy",
} as const satisfies Readonly<Record<LegalDocId, string>>
