import { LEGAL_DOC_IDS, LEGAL_URLS } from "@unleashed/legal"
import type { ToolsTargetKey } from "../src/lib/network-targets"

/** A built dist's text files, keyed by their path relative to the dist root. */
export type DistTexts = ReadonlyMap<string, string>

/** The placeholder's chunk file: emitted by name, so its presence is checkable without reading it. */
const PLACEHOLDER_CHUNK = /(^|\/)MainnetPlaceholderView[^/]*$/

/**
 * What breaks "the mainnet build links the legal documents and no other build does": a mainnet dist
 * missing a document's URL, or another target's dist carrying a URL, a document id or the placeholder's
 * chunk. One line per broken expectation, naming the file that matched; empty when the dist is right.
 */
export function legalDistProblems(key: ToolsTargetKey, files: DistTexts): string[] {
	const urls = Object.values(LEGAL_URLS)
	if (key === "mainnet") {
		const texts = [...files.values()]
		return urls.filter((url) => !texts.some((t) => t.includes(url))).map((url) => `mainnet dist does not link ${url}`)
	}
	const problems: string[] = []
	for (const [path, text] of files) {
		if (PLACEHOLDER_CHUNK.test(path)) problems.push(`${key} dist ships the mainnet placeholder: ${path}`)
		for (const marker of [...urls, ...LEGAL_DOC_IDS])
			if (text.includes(marker)) problems.push(`${key} dist carries "${marker}" in ${path}`)
	}
	return problems
}
