import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parseManifestV2Strict } from "./manifest-v2"

/**
 * A real manifest a sandbox generation deploy produced, kept as a SHAPE fixture: its addresses come
 * from the deployer's nonce and are not reproducible, but every derivation the schema enforces
 * (portal CREATE2, the hub's token derivation, the hub's constructor args) has to hold for it — so a
 * schema or derivation change that no synthetic fixture would notice reds here.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sandbox-manifest.json")

describe("the sandbox generation manifest", () => {
	it("parses strictly and re-derives every token", async () => {
		const manifest = await parseManifestV2Strict(JSON.parse(readFileSync(FIXTURE, "utf8")))
		expect(manifest.network).toBe("sandbox")
		expect(manifest.bridge?.tokens.length).toBeGreaterThan(0)
	})
})
