import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Production sources draw every fresh salt, claim secret and nonce from `randomField` (`@unleashed/sdk/internal`),
 * which reads WebCrypto. This matches direct references only, so an alias escapes it; the SDK's own test of
 * `randomField` covers the runtime. Tests and the local sandbox suite are exempt.
 */
const ROOT = join(import.meta.dir, "..", "..")
const ROOTS = ["packages/sdk/src/", "packages/bridge-core/src/", "packages/bridge-core/scripts/", "apps/tools/src/"]
const EXEMPT = /\.(?:test|spec)\.ts$|\/test\/|^packages\/bridge-core\/scripts\/sandbox\//
const SOURCE = /\.(?:ts|tsx|vue)$/
const FOUNDATION_DRAW = /\bF[rq]\s*\.\s*random\b|@aztec-labs\/foundation\/crypto\/random\b/g
// Doc comments name what they do not call.
const COMMENT = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm

const draws = (text: string): number => text.replace(COMMENT, "").match(FOUNDATION_DRAW)?.length ?? 0

const files = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...ROOTS], { cwd: ROOT })
	.stdout.toString()
	.split("\0")
	.filter((path) => SOURCE.test(path) && !EXEMPT.test(path))

test("the matcher flags foundation's field generators and passes randomField", () => {
	const lines: Record<string, string> = {
		call: "const salt = Fr.random()",
		"spaced call": "const salt = Fr . random ()",
		"passed as a value": "random: () => Fr = Fr.random,",
		"base field": "Fq.random()",
		"module import": 'import { randomBytes } from "@aztec-labs/foundation/crypto/random"',
		"in a comment": "/** never Fr.random() */",
		randomField: "const salt = randomField()",
		"Math.random": "const jitter = Math.random()",
	}
	expect(Object.entries(lines).map(([label, text]) => `${label}: ${draws(text)}`)).toEqual([
		"call: 1",
		"spaced call: 1",
		"passed as a value: 1",
		"base field: 1",
		"module import: 1",
		"in a comment: 0",
		"randomField: 0",
		"Math.random: 0",
	])
})

test("production sources draw fresh fields from randomField", () => {
	expect(files.length).toBeGreaterThan(200)
	const hits = files.flatMap((path) => {
		const count = draws(readFileSync(join(ROOT, path), "utf8"))
		return count > 0 ? [`${path}: ${count}`] : []
	})
	expect(hits).toEqual([])
})
