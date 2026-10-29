/**
 * Proves the packed tarball works for an npm consumer. Stages and packs the SDK, holds the file list and manifest to the
 * publish rules, installs the consumer fixture (`test/consumer/`) frozen into a scratch copy outside every workspace,
 * unpacks the tarball into its `node_modules`, typechecks the consumer under `NodeNext` and `Bundler`, and runs it in
 * Node and in Bun. `--relock` re-resolves the fixture's lockfile and writes it back; `--keep` keeps the scratch copy.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, parse } from "node:path"
import { pathToFileURL } from "node:url"
import {
	DIST_DIR,
	HUB_ARTIFACT,
	PACKAGE_DIR,
	type PublishedManifest,
	PUBLISHED_ENTRIES,
	REPO_DIR,
	type Staged,
	sha256,
	stage,
} from "./stage.ts"

const FIXTURE_DIR = join(PACKAGE_DIR, "test", "consumer")
const FIXTURE_FILES = ["package.json", "bunfig.toml", "bun.lock", "consumer.ts", "tsconfig.nodenext.json", "tsconfig.bundler.json"]
const TSCONFIGS = ["tsconfig.nodenext.json", "tsconfig.bundler.json"]
/** Source, tooling, tests and secrets: none of these is a published module. */
const FORBIDDEN = [
	/\.map$/,
	/(^|\/)\.env/,
	/(^|\/)(src|scripts|test|tests|__tests__)\//,
	/\.(test|spec)\.[cm]?[jt]s$/,
	/(?<!\.d)\.[cm]?ts$/,
	/(^|\/)(tsconfig[^/]*\.json|bunfig\.toml|bun\.lockb?|\.npmrc|[^/]*\.tsbuildinfo)$/,
]
const BUN = process.versions.bun === undefined ? "bun" : process.execPath
/**
 * Only what the tools need to run and to find the user's caches: a keyed shell's secrets never reach an install or a
 * consumer, and `NODE_PATH`/`NODE_OPTIONS` would let a runtime resolve modules from outside the consumer.
 */
const PASSED_ENV = [
	...["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR", "LANG", "TERM", "CI"],
	...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"],
]
const CHILD_ENV = Object.fromEntries(PASSED_ENV.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])))

type Report = {
	runtime: string
	version: string
	entries: Record<string, { url: string; exports: string[] }>
	hub: string
	manifests: string[]
}
type FixtureManifest = { dependencies?: Record<string, string> }

function fail(message: string): never {
	throw new Error(`pack:check: ${message}`)
}

const spawn = (command: string, args: string[], cwd: string) =>
	spawnSync(command, args, { cwd, env: CHILD_ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

function exec(command: string, args: string[], cwd: string): string {
	const result = spawn(command, args, cwd)
	if (result.status !== 0) {
		fail(`${[command, ...args].join(" ")} exited ${result.status ?? result.signal}\n${result.stdout ?? ""}${result.stderr ?? ""}`)
	}
	return result.stdout
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T
const sameList = (a: readonly string[], b: readonly string[]): boolean => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

/** A fresh directory on real disk with no `node_modules` above it, so nothing resolves from outside the consumer. */
function scratchDir(): string {
	const base = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "unleashed-sdk-pack-check")
	mkdirSync(base, { recursive: true })
	const scratch = mkdtempSync(join(base, "run-"))
	for (let dir = dirname(scratch); dir !== parse(dir).root; dir = dirname(dir)) {
		if (existsSync(join(dir, "node_modules"))) fail(`${join(dir, "node_modules")} sits above the scratch copy`)
	}
	return scratch
}

function pack(scratch: string): string {
	exec(BUN, ["pm", "pack", "--destination", scratch, "--ignore-scripts", "--quiet"], DIST_DIR)
	const tarballs = readdirSync(scratch).filter((name) => name.endsWith(".tgz"))
	if (tarballs.length !== 1) fail(`expected one tarball, found ${tarballs.join(", ") || "none"}`)
	return join(scratch, tarballs[0])
}

/** The packed paths, without npm's `package/` prefix. */
function packedFiles(tarball: string): string[] {
	const entries = exec("tar", ["-tzf", tarball], dirname(tarball))
		.split("\n")
		.filter((entry) => entry !== "" && !entry.endsWith("/"))
	const stray = entries.filter((entry) => !entry.startsWith("package/"))
	if (stray.length > 0) fail(`tarball entries outside package/: ${stray.join(", ")}`)
	return entries.map((entry) => entry.slice("package/".length))
}

function checkFileList(packed: string[], staged: Staged): void {
	const forbidden = packed.filter((file) => FORBIDDEN.some((pattern) => pattern.test(file)))
	if (forbidden.length > 0) fail(`forbidden files packed: ${forbidden.join(", ")}`)
	if (!sameList(packed, ["package.json", ...staged.files])) {
		fail(`packed files differ from the staged ones:\n  packed ${packed.sort().join(" ")}\n  staged ${staged.files.join(" ")}`)
	}
}

/** An inline map embeds the sources, which a file-name check cannot see. */
function checkNoSourceMaps(installed: string, packed: string[]): void {
	const mapped = packed
		.filter((file) => /\.[cm]?js$|\.d\.[cm]?ts$/.test(file))
		.filter((file) => readFileSync(join(installed, file), "utf8").includes("sourceMappingURL"))
	if (mapped.length > 0) fail(`source maps referenced from ${mapped.join(", ")}`)
}

/** Holds the packed manifest to the publish rules: published entries only, nothing that marks a workspace package. */
function checkManifest(installed: string): PublishedManifest {
	const manifest = readJson<PublishedManifest & Record<string, unknown>>(join(installed, "package.json"))
	const workspace = readJson<{ exports: Record<string, string> }>(join(PACKAGE_DIR, "package.json"))
	const leaked = Object.keys(workspace.exports).filter((key) => !PUBLISHED_ENTRIES.includes(key) && key in manifest.exports)
	if (leaked.length > 0) fail(`workspace-only entries exported: ${leaked.join(", ")}`)
	if (!sameList(Object.keys(manifest.exports), PUBLISHED_ENTRIES)) fail(`exports ${Object.keys(manifest.exports).join(", ")}`)
	const marks = ["private", "scripts", "devDependencies"].filter((field) => field in manifest)
	if (marks.length > 0) fail(`the packed manifest carries ${marks.join(", ")}`)
	for (const target of Object.values(manifest.exports).flatMap((entry) => [entry.types, entry.import])) {
		if (!existsSync(join(installed, target))) fail(`export target ${target} is not in the tarball`)
	}
	return manifest
}

/** The fixture stands in for a registry install: exactly the peers at their pins, plus the SDK's own dependencies. */
function checkFixturePins(manifest: PublishedManifest): void {
	const fixture = readJson<FixtureManifest>(join(FIXTURE_DIR, "package.json")).dependencies ?? {}
	// A range peer is pinned at its floor.
	const pins = Object.entries({ ...manifest.peerDependencies, ...manifest.dependencies })
	const wanted = pins.map(([name, spec]): [string, string] => [name, spec.replace(/^\^/, "")])
	const off = wanted.filter(([name, version]) => fixture[name] !== version).map(([name, version]) => `${name}@${version}`)
	const extra = Object.keys(fixture).filter((name) => !wanted.some(([wantedName]) => wantedName === name))
	if (off.length > 0 || extra.length > 0) {
		fail(
			`test/consumer/package.json must declare exactly ${wanted.map(([n, v]) => `${n}@${v}`).join(", ")}; off: ${[...off, ...extra].join(", ")}`,
		)
	}
}

function installFixture(scratch: string, relock: boolean): void {
	for (const file of FIXTURE_FILES) {
		if (existsSync(join(FIXTURE_DIR, file))) copyFileSync(join(FIXTURE_DIR, file), join(scratch, file))
		else if (!(relock && file === "bun.lock")) fail(`test/consumer/${file} is missing`)
	}
	exec(BUN, ["install", "--ignore-scripts", ...(relock ? [] : ["--frozen-lockfile"])], scratch)
	if (relock) copyFileSync(join(scratch, "bun.lock"), join(FIXTURE_DIR, "bun.lock"))
}

/** Unpacks after the install, which would otherwise prune a package its lockfile does not name. */
function unpack(tarball: string, scratch: string): string {
	const unpacked = join(scratch, "unpacked")
	mkdirSync(unpacked)
	exec("tar", ["-xzf", tarball, "-C", unpacked], scratch)
	const installed = join(scratch, "node_modules", "@unleashed", "sdk")
	mkdirSync(dirname(installed), { recursive: true })
	renameSync(join(unpacked, "package"), installed)
	return installed
}

function checkAssets(installed: string, staged: Staged): void {
	for (const asset of staged.assets) {
		const shipped = sha256(join(installed, asset.staged))
		if (shipped !== sha256(join(REPO_DIR, asset.source))) fail(`${asset.staged} sha256 ${shipped} differs from ${asset.source}`)
	}
	if (!staged.assets.some((asset) => asset.source === HUB_ARTIFACT)) fail("the hub artifact was not staged")
}

/** Imports the consumer in one runtime and holds its report to the installed tarball. */
function runConsumer(command: string, args: string[], scratch: string, installed: string): Report {
	const lines = exec(command, [...args, "consumer.ts"], scratch)
		.trim()
		.split("\n")
	const report = JSON.parse(lines[lines.length - 1]) as Report
	const imported = Object.keys(report.entries)
	if (!sameList(imported, PUBLISHED_ENTRIES)) fail(`${report.runtime} imported ${imported.join(", ")}`)
	const root = `${pathToFileURL(installed).href}/`
	const elsewhere = Object.entries(report.entries).filter(([, entry]) => !entry.url.startsWith(root))
	if (elsewhere.length > 0) fail(`${report.runtime} resolved ${elsewhere.map(([key, e]) => `${key} → ${e.url}`).join(", ")}`)
	const hubName = readJson<{ name: string }>(join(REPO_DIR, HUB_ARTIFACT)).name
	if (report.hub !== hubName) fail(`${report.runtime} loaded hub artifact ${report.hub}, want ${hubName}`)
	if (report.manifests.some((kind) => kind !== "object")) fail(`${report.runtime} bundled manifests ${report.manifests.join(", ")}`)
	return report
}

/**
 * Checks without `skipLibCheck`, so an unresolved import inside the SDK's declarations is an error, not a silent `any`.
 * The peers' declarations do not check clean (types they import but do not declare, DOM-only names), which consumers
 * skip with `skipLibCheck`, so only diagnostics in the consumer and the SDK count.
 */
function typecheck(scratch: string, config: string): void {
	const tsc = join(scratch, "node_modules", "typescript", "bin", "tsc")
	const result = spawn("node", [tsc, "-p", config, "--pretty", "false"], scratch)
	const diagnostics = result.stdout.split(/\n(?=\S)/).filter((line) => line.trim() !== "")
	const ours = diagnostics.filter((d) => !d.startsWith("node_modules/") || d.startsWith("node_modules/@unleashed/sdk/"))
	if (ours.length > 0 || (result.status !== 0 && diagnostics.length === 0)) {
		fail(`tsc -p ${config} exited ${result.status ?? result.signal}\n${ours.join("\n")}${result.stderr}`)
	}
}

function checkConsumer(scratch: string, installed: string): Report[] {
	for (const config of TSCONFIGS) typecheck(scratch, config)
	const reports = [runConsumer("node", [], scratch, installed), runConsumer(BUN, ["--no-install"], scratch, installed)]
	if (reports[0].runtime !== "node" || reports[1].runtime !== "bun") fail(`ran ${reports.map((r) => r.runtime).join(" and ")}`)
	const [node, bun] = reports.map((r) => JSON.stringify(PUBLISHED_ENTRIES.map((key) => r.entries[key].exports)))
	if (node !== bun) fail(`Node and Bun see different exports:\n  node ${node}\n  bun  ${bun}`)
	return reports
}

function main(): void {
	const relock = process.argv.includes("--relock")
	const keep = process.argv.includes("--keep")
	const staged = stage()
	checkFixturePins(staged.manifest)
	const scratch = scratchDir()
	try {
		const tarball = pack(scratch)
		const packed = packedFiles(tarball)
		checkFileList(packed, staged)
		installFixture(scratch, relock)
		const installed = unpack(tarball, scratch)
		checkNoSourceMaps(installed, packed)
		const manifest = checkManifest(installed)
		checkAssets(installed, staged)
		const reports = checkConsumer(scratch, installed)
		const peers = Object.entries(manifest.peerDependencies).map(([name, spec]) => `${name}@${spec}`)
		const dependencies = Object.entries(manifest.dependencies).map(([name, spec]) => `${name}@${spec}`)
		console.log(`pack:check: ${parse(tarball).base}, ${staged.files.length + 1} files`)
		console.log(`  exports ${PUBLISHED_ENTRIES.join(" ")}`)
		console.log(`  peers ${peers.join(" ")}`)
		console.log(`  dependencies ${dependencies.join(" ")}`)
		for (const asset of staged.assets) console.log(`  ${asset.staged} sha256 ${asset.sha256} = ${asset.source}`)
		console.log(`  typechecked under ${TSCONFIGS.join(", ")}`)
		for (const r of reports) console.log(`  ${r.runtime} ${r.version}: ${Object.keys(r.entries).length} entries imported, hub ${r.hub}`)
		if (staged.unusedPeers.length > 0) console.log(`  peers no published module imports: ${staged.unusedPeers.join(", ")}`)
		if (relock) console.log("  wrote test/consumer/bun.lock")
		console.log("pack:check: ok")
	} finally {
		if (keep) console.log(`  kept ${scratch}`)
		else rmSync(scratch, { recursive: true, force: true })
	}
}

try {
	main()
} catch (error) {
	console.error(error instanceof Error ? error.message : error)
	process.exit(1)
}
