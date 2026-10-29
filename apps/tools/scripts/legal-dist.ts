import { LEGAL_DOC_IDS, LEGAL_URLS } from "@unleashed/legal"
import type { ToolsTargetKey } from "../src/lib/network-targets"

/** A built dist's text files, keyed by their path relative to the dist root. */
export type DistTexts = ReadonlyMap<string, string>

/** The mainnet root's chunks (the gate, the placeholder): emitted by name, so checkable without reading them. */
const MAINNET_CHUNK = /(^|\/)(MainnetRoot|MainnetPlaceholderView)[^/]*$/

/**
 * What breaks "the mainnet build carries the legal documents and their acceptance gate, and no other build
 * does": a mainnet dist missing a document's URL or id (the gate digests the documents themselves), or
 * another target's dist carrying a URL, a document id or a mainnet root chunk. One line per broken
 * expectation, naming the file that matched; empty when the dist is right.
 */
export function legalDistProblems(key: ToolsTargetKey, files: DistTexts): string[] {
	const urls = Object.values(LEGAL_URLS)
	if (key === "mainnet") {
		const texts = [...files.values()]
		const missing = (marker: string) => !texts.some((t) => t.includes(marker))
		return [
			...urls.filter(missing).map((url) => `mainnet dist does not link ${url}`),
			...LEGAL_DOC_IDS.filter(missing).map((id) => `mainnet dist does not carry the document "${id}"`),
		]
	}
	const problems: string[] = []
	for (const [path, text] of files) {
		if (MAINNET_CHUNK.test(path)) problems.push(`${key} dist ships the mainnet root: ${path}`)
		for (const marker of [...urls, ...LEGAL_DOC_IDS])
			if (text.includes(marker)) problems.push(`${key} dist carries "${marker}" in ${path}`)
	}
	return problems
}
