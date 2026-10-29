import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { KEYED_ENV } from "../../packages/bridge-core/scripts/keyed-env"

/**
 * What a keyed script prints stays free of keyed values. Only keyed-run.ts may name the dRPC URL composer: every
 * other script takes the URL from `keyedNodeUrl`, which refuses until `runKeyed` has redacted the run's output, and
 * every script entry that reads a keyed value runs through `runKeyed`. `KEYED_ENV`, the list redaction replaces,
 * holds every keyed-looking env name the code reads and every `op://` field of the keyed-run templates. Untracked
 * files that git does not ignore count. Failures name files and env names, never values.
 */
const ROOT = join(import.meta.dir, "..", "..")
const COMPOSER = /\brequireDrpcNodeUrl\b|lb\.drpc\.(?:live|org)|\benv\.DRPC_API_KEY\b/
const ALLOWED_COMPOSERS = ["packages/bridge-core/src/drpc-node.ts", "packages/bridge-core/scripts/keyed-run.ts"]
// A CLI entry: a direct-invocation guard, or a top-level call of the script's main.
const ENTRY = /import\.meta\.main|\bisMain\b|\bisDirectInvocation\b|^(?:await )?main\(\)|^runKeyed\(/m
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

/** Sources that compose outside the allowed files; a mention, so an alias, a namespace import or a hand-built URL counts. */
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

/** Script entries that read a keyed env var. */
export function keyedEntries(sources: ReadonlyMap<string, string>): [path: string, text: string][] {
	const keyed = new Set<string>(KEYED_ENV)
	return [...sources].filter(
		([path, text]) => /^(apps|packages)\/[^/]+\/scripts\//.test(path) && ENTRY.test(text) && keyedNames(text).some((name) => keyed.has(name)),
	)
}

const unkeyed = (entries: [path: string, text: string][]): string[] =>
	entries.filter(([, text]) => !/\brunKeyed\(/.test(text)).map(([path]) => path)

test("the composer rule flags a call, an alias, a namespace import and a hand-built URL, and passes keyedNodeUrl", () => {
	const sources = new Map([
		["call.ts", 'import { requireDrpcNodeUrl } from "../src/drpc-node"\nrequireDrpcNodeUrl("testnet", process.env)'],
		["alias.ts", 'import { requireDrpcNodeUrl as nodeUrl } from "@unleashed/bridge-core"\nnodeUrl("mainnet", process.env)'],
		["namespace.ts", 'import * as drpc from "../src/drpc-node"\ndrpc.requireDrpcNodeUrl("testnet", env)'],
		["by-hand.ts", "const url = `https://lb.drpc.live/aztec-testnet/${process.env.DRPC_API_KEY}`"],
		["keyed.ts", 'import { keyedNodeUrl } from "./keyed-run"\nkeyedNodeUrl("testnet")'],
		[ALLOWED_COMPOSERS[1] as string, "return requireDrpcNodeUrl(network, process.env)"],
	])
	expect(composers(sources)).toEqual(["call.ts", "alias.ts", "namespace.ts", "by-hand.ts"])
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

test("the entry rule flags a script entry that reads a keyed value without runKeyed", () => {
	const read = "const rpc = process.env.SEPOLIA_RPC_URL"
	const sources = new Map([
		["packages/x/scripts/bare.ts", `${read}\nif (import.meta.main) await main()`],
		["packages/x/scripts/keyed.ts", `${read}\nif (import.meta.main) runKeyed(main)`],
		["packages/x/scripts/library.ts", `export function rpc(): string | undefined {\n\treturn process.env.SEPOLIA_RPC_URL\n}`],
		["packages/x/scripts/keyless.ts", "main().catch(() => process.exit(1))"],
	])
	expect(unkeyed(keyedEntries(sources))).toEqual(["packages/x/scripts/bare.ts"])
})

test("every script entry that reads a keyed value runs through runKeyed", () => {
	const entries = keyedEntries(sourcesOf(files))
	expect(entries.length).toBeGreaterThan(10)
	expect(unkeyed(entries)).toEqual([])
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
