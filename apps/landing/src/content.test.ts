import { expect, test } from "vitest"
import { CANONICAL, COPY, EXPERIMENTS, LINKS } from "./content.ts"

test("every destination is https, and every experiment links into LINKS or is the open slot", () => {
	for (const url of [...Object.values(LINKS), CANONICAL]) expect(new URL(url).protocol, url).toBe("https:")
	const allowed = new Set<string>(Object.values(LINKS))
	for (const e of EXPERIMENTS) expect(e.href === null || allowed.has(e.href), e.name).toBe(true)
	for (const l of COPY.navLinks) expect(allowed.has(l.href), l.label).toBe(true)
	expect(new Set(EXPERIMENTS.map((e) => e.name)).size).toBe(EXPERIMENTS.length)
})
