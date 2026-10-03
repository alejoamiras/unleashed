import { readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { DESIGN_COMPONENTS, designResolver } from "./design-resolver"

const here = dirname(fileURLToPath(import.meta.url)) // apps/tools/scripts
const srcDir = join(here, "../src")

describe("design-resolver", () => {
	// No tools-local SFC may share a name with the resolver set: with dirs:[] the resolver only fires
	// for unimported bare tags, but a same-named local component would still be the one a bare tag means
	// to render. This pins that the resolver can never silently shadow a local component. Scans ALL of
	// src/** (not just src/components) so an SFC in views/ or a nested folder can't slip a collision past.
	test("no tools-local SFC name collides with the resolver set", () => {
		const localNames = (readdirSync(srcDir, { recursive: true }) as string[])
			.filter((f) => f.endsWith(".vue"))
			.map((f) =>
				f
					.split("/")
					.pop()!
					.replace(/\.vue$/, ""),
			)
		const collisions = localNames.filter((n) => DESIGN_COMPONENTS.has(n))
		expect(collisions).toEqual([])
	})

	test("resolves a known primitive to @unleashed/design", () => {
		expect(designResolver()("Flex")).toEqual({ name: "Flex", from: "@unleashed/design" })
	})

	test("ignores unknown names (explicit imports / local components win)", () => {
		const resolve = designResolver()
		expect(resolve("Button")).toBeUndefined()
		expect(resolve("WalletPanel")).toBeUndefined()
	})
})
