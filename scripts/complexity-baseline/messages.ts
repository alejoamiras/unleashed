import type { BaselinedRule } from "./scan"

/** Rule-anchored parsers for Biome 2.5.9's diagnostic messages — wording drift after a bump
 *  fails loudly here instead of silently mis-reading a number out of a different sentence. */
const OBSERVED_RE: Record<BaselinedRule, RegExp> = {
	noExcessiveCognitiveComplexity: /^Excessive complexity of (\d+) detected/,
	noExcessiveLinesPerFunction: /^This function has too many lines \((\d+)\)/,
}

export function parseObserved(rule: BaselinedRule, message: string): number {
	const m = message.match(OBSERVED_RE[rule])
	if (!m) throw new Error(`unrecognised ${rule} message (Biome wording changed?): ${JSON.stringify(message)}`)
	return Number(m[1])
}

/** The fail-closed line the generator inserts above a newly flagged function. The scanner
 *  refuses it, so the tree cannot pass a check until a human justifies or refactors. */
export function markerFor(rule: BaselinedRule, observed: number): string {
	const form = rule === "noExcessiveCognitiveComplexity" ? `score ${observed}` : `${observed} lines`
	const seen = rule === "noExcessiveCognitiveComplexity" ? `observed score ${observed}` : `observed ${observed} lines`
	return `// biome-ignore lint/complexity/${rule}: JUSTIFICATION REQUIRED (${seen}): refactor, or replace this line with "accepted at ${form} — <why this complexity is essential here>"`
}
