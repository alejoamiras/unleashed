/**
 * Stages the publishable package in `dist/`: compiles the published entries' import graph, ships every JSON it imports
 * byte for byte (out-of-package ones under `assets/`, their specifiers rewritten) and writes the npm manifest. The
 * workspace manifest keeps exporting `src/*.ts`, so nothing in the repository builds first.
 */
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import ts from "typescript"

export const PACKAGE_DIR = resolve(import.meta.dirname, "..")
export const REPO_DIR = resolve(PACKAGE_DIR, "../..")
export const DIST_DIR = join(PACKAGE_DIR, "dist")
const SRC_DIR = join(PACKAGE_DIR, "src")

/** The subpaths npm consumers get; every other workspace export stays workspace-only. Sources: the workspace manifest. */
export const PUBLISHED_ENTRIES: readonly string[] = [".", "./fuel", "./bridge", "./protocol", "./networks"]

/** The hub's Noir artifact, which `./bridge` loads on first use. */
export const HUB_ARTIFACT = "contracts/bridge/aztec/token_bridge_hub/target/token_bridge_hub_contract-TokenBridgeHub.json"

/** The out-of-package files a published module may import (repo-relative source → staged path), shipped byte for byte. */
export const ASSETS: Readonly<Record<string, string>> = {
	[HUB_ARTIFACT]: "assets/token-bridge-hub.json",
	"apps/tools/public/testnet-bridge.json": "assets/testnet-bridge.json",
	"apps/tools/public/mainnet-bridge.json": "assets/mainnet-bridge.json",
}

/** `Fr` and `AztecAddress` are nominal classes: a second copy fails `instanceof`, so these peers are exact. */
const EXACT_PEER = /^(@aztec-labs\/|@aztec-foundation\/|@alejoamiras\/private-fee-juice$)/
/** Structurally typed: a caret range lets a wagmi app keep its own copy. */
const RANGE_PEERS = new Set(["viem"])
/** Installed with the SDK, exact at the version the lockfile resolves. */
const OWN_DEPENDENCIES = new Set(["zod"])
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
/** npm packs these whatever `files` says; Apache-2.0 §4(a) requires the licence to travel with every copy. */
export const DOCUMENTS: Readonly<Record<string, string>> = {
	LICENSE: join(REPO_DIR, "LICENSE"),
	"README.md": join(PACKAGE_DIR, "README.md"),
}

type Specs = Record<string, string>
type Repository = { type: "git"; url: string; directory: string }
type WorkspaceManifest = { name: string; version: string; exports: Specs; dependencies?: Specs; license: string; repository: Repository }
type Lockfile = { packages: Record<string, [string, ...unknown[]]> }
type DependencyFields = { peerDependencies: Specs; dependencies: Specs }
export type PublishedManifest = DependencyFields & {
	name: string
	version: string
	license: string
	repository: Repository
	type: "module"
	sideEffects: false
	exports: Record<string, { types: string; import: string }>
	files: string[]
}
export type StagedAsset = { source: string; staged: string; sha256: string }
export type Staged = { manifest: PublishedManifest; files: string[]; assets: StagedAsset[]; unusedPeers: string[] }
type Rewrite = { pos: number; end: number; text: string }

function fail(message: string): never {
	throw new Error(`stage: ${message}`)
}

export const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T
const toPosix = (path: string): string => path.split(sep).join("/")
const fromDist = (path: string): string => toPosix(relative(DIST_DIR, path))
const isInside = (dir: string, path: string): boolean => {
	const rel = relative(dir, path)
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
	return ts.formatDiagnostics(diagnostics, {
		getCanonicalFileName: (name) => name,
		getCurrentDirectory: () => PACKAGE_DIR,
		getNewLine: () => "\n",
	})
}

/** The `src/` file a published subpath points at in the workspace manifest. */
function entrySource(manifest: WorkspaceManifest, key: string): string {
	const source = manifest.exports[key]
	if (source === undefined || !/^\.\/src\/.+\.ts$/.test(source)) fail(`published entry ${key} maps to ${source}, not ./src/*.ts`)
	return source.slice("./src/".length, -".ts".length)
}

/** Emits the import closure (static and dynamic) of `roots` into `dist/`, so no module outside it ships. */
function compile(roots: string[]): void {
	const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d: ts.Diagnostic) => fail(formatDiagnostics([d])) }
	const config = ts.getParsedCommandLineOfConfigFile(join(PACKAGE_DIR, "tsconfig.build.json"), {}, host)
	if (config === undefined) fail("tsconfig.build.json did not parse")
	const program = ts.createProgram({ rootNames: roots, options: config.options })
	const before = [...config.errors, ...ts.getPreEmitDiagnostics(program)]
	if (before.length > 0) fail(formatDiagnostics(before))
	const emitted = program.emit()
	if (emitted.emitSkipped || emitted.diagnostics.length > 0) fail(formatDiagnostics(emitted.diagnostics))
}

function stagedFiles(): string[] {
	return readdirSync(DIST_DIR, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.sort()
}

/** Copies `source` to `target` and refuses a copy whose digest differs. */
function copyExact(source: string, target: string): string {
	mkdirSync(dirname(target), { recursive: true })
	copyFileSync(source, target)
	const digest = sha256(source)
	if (sha256(target) !== digest) fail(`${fromDist(target)} does not match ${toPosix(relative(REPO_DIR, source))}`)
	return digest
}

/** `tsc` re-serializes the JSON it emits; the package ships the source bytes instead. */
function restoreJson(files: string[]): void {
	for (const file of files.filter((path) => path.endsWith(".json"))) {
		const source = join(SRC_DIR, relative(DIST_DIR, file))
		if (!existsSync(source)) fail(`${fromDist(file)} has no source under src/`)
		copyExact(source, file)
	}
}

/** The specifier an emitted relative import must carry, or `undefined` when it already resolves inside the package. */
function relativeRewrite(file: string, specifier: string, assets: Map<string, StagedAsset>): string | undefined {
	const source = resolve(dirname(join(SRC_DIR, relative(DIST_DIR, file))), specifier)
	if (isInside(SRC_DIR, source)) {
		// Declaration emit keeps `.ts` specifiers; the sibling module is `.js`, which every resolver maps to `.d.ts`.
		return file.endsWith(".d.ts") && /(?<!\.d)\.ts$/.test(specifier) ? `${specifier.slice(0, -".ts".length)}.js` : undefined
	}
	const repoPath = toPosix(relative(REPO_DIR, source))
	const staged = ASSETS[repoPath]
	if (staged === undefined) fail(`${fromDist(file)} imports ${specifier}: outside the package and not a known asset`)
	const target = join(DIST_DIR, staged)
	if (!assets.has(repoPath)) assets.set(repoPath, { source: repoPath, staged, sha256: copyExact(source, target) })
	const rewritten = toPosix(relative(dirname(file), target))
	return rewritten.startsWith(".") ? rewritten : `./${rewritten}`
}

/** A bare specifier's package, or the specifier itself when it names a built-in, a URL or an absolute path. */
function packageOf(specifier: string): string {
	if (isAbsolute(specifier) || specifier.includes(":")) return specifier
	return specifier
		.split("/")
		.slice(0, specifier.startsWith("@") ? 2 : 1)
		.join("/")
}

/** `preProcessFile` reports a specifier at its opening quote; the edit covers the literal's contents only. */
function literalAt(text: string, quote: number, specifier: string, replacement: string): Rewrite {
	const pos = quote + 1
	const end = pos + specifier.length
	if (text.slice(pos, end) !== specifier || text[end] !== text[quote]) fail(`cannot locate ${specifier} at offset ${quote}`)
	return { pos, end, text: replacement }
}

/** Rewrites one emitted module's relative specifiers in place and returns the packages it imports. */
function localize(file: string, assets: Map<string, StagedAsset>): string[] {
	const text = readFileSync(file, "utf8")
	const info = ts.preProcessFile(text, true, true)
	const directives = [...info.referencedFiles, ...info.typeReferenceDirectives, ...info.libReferenceDirectives]
	if (directives.length > 0) fail(`${fromDist(file)} carries triple-slash references: ${directives.map((d) => d.fileName).join(", ")}`)
	const rewrites: Rewrite[] = []
	const packages: string[] = []
	for (const { fileName: specifier, pos } of info.importedFiles) {
		if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
			packages.push(packageOf(specifier))
			continue
		}
		const rewritten = relativeRewrite(file, specifier, assets)
		if (rewritten !== undefined) rewrites.push(literalAt(text, pos, specifier, rewritten))
	}
	const output = rewrites.sort((a, b) => b.pos - a.pos).reduce((acc, r) => acc.slice(0, r.pos) + r.text + acc.slice(r.end), text)
	if (output !== text) writeFileSync(file, output)
	return packages
}

/** Fails unless every relative specifier in the staged modules lands on a staged file. */
function assertResolvable(modules: string[]): void {
	const broken = modules.flatMap((file) =>
		ts
			.preProcessFile(readFileSync(file, "utf8"), true, true)
			.importedFiles.map((imported) => imported.fileName)
			.filter((specifier) => specifier.startsWith("."))
			.filter((specifier) => {
				const target = resolve(dirname(file), specifier)
				return !isInside(DIST_DIR, target) || !existsSync(target)
			})
			.map((specifier) => `${fromDist(file)} → ${specifier}`),
	)
	if (broken.length > 0) fail(`unresolvable relative imports:\n  ${broken.join("\n  ")}`)
}

/** The version `bun.lock` resolves `name` to for `workspace`: its nested entry first, else the hoisted one. */
function lockedVersion(lock: Lockfile, workspace: string, name: string): string {
	const id = (lock.packages[`${workspace}/${name}`] ?? lock.packages[name])?.[0]
	if (typeof id !== "string") fail(`${name} is not in bun.lock`)
	return id.slice(id.lastIndexOf("@") + 1)
}

/** Splits the workspace's runtime dependencies into peers and the SDK's own, failing on a name with no rule. */
function dependencyFields(manifest: WorkspaceManifest, lock: Lockfile): DependencyFields {
	const fields: DependencyFields = { peerDependencies: {}, dependencies: {} }
	for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
		if (OWN_DEPENDENCIES.has(name)) {
			fields.dependencies[name] = lockedVersion(lock, manifest.name, name)
			continue
		}
		if (!EXACT_PEER.test(name) && !RANGE_PEERS.has(name)) fail(`${name} has no publish rule: make it a peer or a dependency`)
		if (!EXACT_VERSION.test(spec)) fail(`${name}@${spec}: a peer's workspace pin must be exact`)
		fields.peerDependencies[name] = RANGE_PEERS.has(name) ? `^${spec}` : spec
	}
	return fields
}

function readLockfile(): Lockfile {
	const path = join(REPO_DIR, "bun.lock")
	const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"))
	if (error !== undefined) fail(`bun.lock: ${formatDiagnostics([error])}`)
	return config as Lockfile
}

function publishedManifest(workspace: WorkspaceManifest, fields: DependencyFields, files: string[]): PublishedManifest {
	const exports = Object.fromEntries(
		PUBLISHED_ENTRIES.map((key) => {
			const out = entrySource(workspace, key)
			return [key, { types: `./${out}.d.ts`, import: `./${out}.js` }]
		}),
	)
	return {
		name: workspace.name,
		version: workspace.version,
		license: workspace.license,
		repository: workspace.repository,
		type: "module",
		sideEffects: false,
		exports,
		files,
		...fields,
	}
}

/** Builds `dist/` from scratch and returns what it staged. */
export function stage(): Staged {
	const workspace = readJson<WorkspaceManifest>(join(PACKAGE_DIR, "package.json"))
	if (new Set(Object.values(ASSETS)).size !== Object.keys(ASSETS).length) fail("two assets share a staged path")
	rmSync(DIST_DIR, { recursive: true, force: true })
	compile(PUBLISHED_ENTRIES.map((key) => join(SRC_DIR, `${entrySource(workspace, key)}.ts`)))
	const emitted = stagedFiles()
	restoreJson(emitted)
	const modules = emitted.filter((file) => file.endsWith(".js") || file.endsWith(".d.ts"))
	const assets = new Map<string, StagedAsset>()
	const imported = new Set(modules.flatMap((file) => localize(file, assets)))
	assertResolvable(modules)
	const fields = dependencyFields(workspace, readLockfile())
	const declared = new Set([...Object.keys(fields.peerDependencies), ...Object.keys(fields.dependencies)])
	const undeclared = [...imported].filter((name) => !declared.has(name)).sort()
	if (undeclared.length > 0) fail(`imported but neither a peer nor a dependency: ${undeclared.join(", ")}`)
	if (!workspace.license || !workspace.repository?.url) fail("the workspace manifest names no license or repository")
	for (const [name, source] of Object.entries(DOCUMENTS)) copyExact(source, join(DIST_DIR, name))
	const files = stagedFiles().map(fromDist)
	const manifest = publishedManifest(workspace, fields, files)
	for (const target of Object.values(manifest.exports).flatMap((e) => [e.types, e.import])) {
		if (!files.includes(target.slice(2))) fail(`export target ${target} was not emitted`)
	}
	writeFileSync(join(DIST_DIR, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`)
	const unusedPeers = Object.keys(fields.peerDependencies).filter((name) => !imported.has(name))
	return { manifest, files, assets: [...assets.values()], unusedPeers }
}

function main(): void {
	const { manifest, files, assets, unusedPeers } = stage()
	console.log(`stage: ${manifest.name}@${manifest.version}, ${files.length} files in ${toPosix(relative(PACKAGE_DIR, DIST_DIR))}/`)
	for (const asset of assets) console.log(`  ${asset.staged} ← ${asset.source} (sha256 ${asset.sha256})`)
	if (unusedPeers.length > 0) console.log(`  peers no published module imports: ${unusedPeers.join(", ")}`)
}

if (process.argv[1] === import.meta.filename) {
	try {
		main()
	} catch (error) {
		console.error(error instanceof Error ? error.message : error)
		process.exit(1)
	}
}
