import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { KEYED_ENV } from "../../packages/bridge-core/scripts/keyed-env"

/**
 * What a keyed script prints stays free of keyed values. Only keyed-run.ts may name the dRPC URL composer: every
 * other script takes the URL from `keyedNodeUrl`, which refuses until `runKeyed` has redacted the run's output.
 * `KEYED_ENV`, the list redaction replaces, holds every keyed-looking env name the code reads and every `op://`
 * field of the keyed-run templates. Untracked files that git does not ignore count. Failures name files and env
 * names, never values.
 */
const ROOT = join(import.meta.dir, "..", "..")
const COMPOSER = /\brequireDrpcNodeUrl\b/
const ALLOWED_COMPOSERS = ["packages/bridge-core/src/drpc-node.ts", "packages/bridge-core/scripts/keyed-run.ts"]
const KEYED_SUFFIX = /_(?:KEY|SECRET|SECRET_[A-Z]+|RPC|RPC_URL|TOKEN)$/
const PUBLIC_NAMES = new Set([
	"DEPLOYER_SALT", // a deployed account's salt
	"AZTEC_DISABLE_ADMIN_API_KEY", // boolean switches the sandbox strips from its child
	"AZTEC_RESET_ADMIN_API_KEY",
	"SANDBOX_L1_RPC", // a local sandbox's loopback URLs
	"SANDBOX_SOURCE_RPC",
])

const files = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT })
	.stdout.toString()
	.split("\0")
	.filter(Boolean)

/** The file's text, or null for a path that is no longer a readable file (deleted, a directory). */
function textOf(path: string): string | null {
	try {
		return readFileSync(join(ROOT, path), "utf8")
	} catch {
		return null
	}
}

function sourcesOf(paths: readonly string[]): Map<string, string> {
	return new Map(paths.flatMap((path) => (path.endsWith(".ts") && !path.endsWith(".test.ts") ? [[path, textOf(path) ?? ""]] : [])))
}

/** Sources that name the composer outside the allowed files; a mention, so an alias or a namespace import counts. */
export function composers(sources: ReadonlyMap<string, string>): string[] {
	return [...sources].filter(([path, text]) => !ALLOWED_COMPOSERS.includes(path) && COMPOSER.test(text)).map(([path]) => path)
}

/** Keyed-looking env names `text` reads (`env.X`), quotes (`"X"`, `env["X"]`) or destructures from `process.env`. */
export function keyedNames(text: string): string[] {
	const named = [...text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)|"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1] ?? m[2] ?? "")
	const destructured = [...text.matchAll(/\{([^}]*)\}\s*=\s*process\.env\b/g)].flatMap((m) =>
		[...(m[1] ?? "").matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)].map((n) => n[1] ?? ""),
	)
	return [...named, ...destructured].filter((name) => KEYED_SUFFIX.test(name))
}

test("the composer rule flags a call, an alias and a namespace import, and passes keyedNodeUrl", () => {
	// Assembled at run time, so no source file but this test names the composer.
	const name = ["require", "Drpc", "NodeUrl"].join("")
	const sources = new Map([
		["call.ts", `import { ${name} } from "../src/drpc-node"\n${name}("testnet", process.env)`],
		["alias.ts", `import { ${name} as nodeUrl } from "@unleashed/bridge-core"\nnodeUrl("mainnet", process.env)`],
		["namespace.ts", `import * as drpc from "../src/drpc-node"\ndrpc.${name}("testnet", env)`],
		["keyed.ts", `import { keyedNodeUrl } from "./keyed-run"\nkeyedNodeUrl("testnet")`],
		[ALLOWED_COMPOSERS[1] as string, `return ${name}(network, process.env)`],
	])
	expect(composers(sources)).toEqual(["call.ts", "alias.ts", "namespace.ts"])
})

test("keyedNames finds reads, quoted names and destructuring, and skips other names", () => {
	const text = [
		"const a = process.env.FOO_RPC_URL",
		'const b = env["BAR_API_KEY"]',
		"const { BAZ_SECRET_MAINNET: _b, ...rest } = process.env",
		'const NAME = "QUX_TOKEN"',
		'const c = env.SEED_TOKENS + "PLAIN"',
	].join("\n")
	expect(keyedNames(text).sort()).toEqual(["BAR_API_KEY", "BAZ_SECRET_MAINNET", "FOO_RPC_URL", "QUX_TOKEN"])
})

test("no source composes the dRPC node URL except through keyedNodeUrl", () => {
	expect(files.length).toBeGreaterThan(500)
	const sources = sourcesOf(files)
	expect(ALLOWED_COMPOSERS.every((path) => COMPOSER.test(sources.get(path) ?? ""))).toBe(true)
	expect(composers(sources)).toEqual([])
})

test("KEYED_ENV holds every keyed name the code reads and every keyed-run template field", () => {
	const code = [...sourcesOf(files.filter((path) => /^(apps|packages)\//.test(path) && !path.includes("/tests/"))).values()]
	const templates = files
		.filter((path) => path.endsWith(".env.example") && !path.startsWith("implementations-plan/archive/"))
		.map((path) => [...(textOf(path) ?? "").matchAll(/^([A-Z][A-Z0-9_]*)=op:\/\//gm)].map((m) => m[1] ?? ""))
	const found = new Set([...code.flatMap(keyedNames), ...templates.flat()])
	expect(["DRPC_API_KEY", "BASE_RPC_URL", "ARBITRUM_RPC_URL", "OPTIMISM_RPC_URL"].every((name) => found.has(name))).toBe(true)
	const listed = new Set<string>(KEYED_ENV)
	expect([...found].filter((name) => !listed.has(name) && !PUBLIC_NAMES.has(name)).sort()).toEqual([])
})
