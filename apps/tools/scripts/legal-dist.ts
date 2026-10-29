import { LEGAL_DOC_IDS, LEGAL_URLS } from "@unleashed/legal"
import { GATE_TESTIDS } from "../src/legal/testids"
import type { ToolsTargetKey } from "../src/lib/network-targets"

/** A built dist's text files, keyed by their path relative to the dist root. */
export type DistTexts = ReadonlyMap<string, string>

/** The mainnet root's chunks (the gate, the placeholder): emitted by name, so checkable without reading them. */
const MAINNET_CHUNK = /(^|\/)(MainnetRoot|MainnetPlaceholderView)[^/]*$/

/**
 * What breaks "the mainnet build carries the legal documents and the acceptance gate, and no other build
 * does": a mainnet dist missing a document's URL, a document's data (its id) or the gate's testid, or another
 * target's dist carrying any of them or a mainnet root chunk. Markers prove presence, not that the gate runs;
 * the unit tests own that. One line per broken expectation, naming the file; empty when the dist is right.
 */
export function legalDistProblems(key: ToolsTargetKey, files: DistTexts): string[] {
	const urls = Object.values(LEGAL_URLS)
	if (key === "mainnet") {
		const texts = [...files.values()]
		const missing = (marker: string) => !texts.some((t) => t.includes(marker))
		return [
			...urls.filter(missing).map((url) => `mainnet dist does not link ${url}`),
			...LEGAL_DOC_IDS.filter(missing).map((id) => `mainnet dist does not carry the document "${id}"`),
			...(missing(GATE_TESTIDS.gate) ? [`mainnet dist does not carry the acceptance gate "${GATE_TESTIDS.gate}"`] : []),
		]
	}
	const problems: string[] = []
	for (const [path, text] of files) {
		if (MAINNET_CHUNK.test(path)) problems.push(`${key} dist ships the mainnet root: ${path}`)
		for (const marker of [...urls, ...LEGAL_DOC_IDS, GATE_TESTIDS.gate])
			if (text.includes(marker)) problems.push(`${key} dist carries "${marker}" in ${path}`)
	}
	return problems
}
