/**
 * The test wallet's build: a page tools frames on the local target only. Its identity (node URL,
 * chain, the one origin allowed to frame it) comes from the sandbox run's artifacts, the same way
 * the local tools build reads them — nothing here is committed or shared between runs.
 *
 *   UNLEASHED_SANDBOX_ARTIFACTS=<dir>  UNLEASHED_TOOLS_ORIGIN=http://127.0.0.1:<port>  vite build|preview --config …
 */
import { readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { resolveExportedAsset, resolvePackageAsset, resolvePackageRoot } from "@alejoamiras/nulo-resolve-asset"
import { loadLocalRunFromEnv } from "../../../src/lib/local-target-loader"

const here = dirname(fileURLToPath(import.meta.url))

function identity() {
	const run = loadLocalRunFromEnv()
	const toolsOrigin = process.env.UNLEASHED_TOOLS_ORIGIN
	if (!toolsOrigin) throw new Error("the test wallet needs UNLEASHED_TOOLS_ORIGIN=<the tools preview origin it may be framed by>")
	return { nodeUrl: run.config.nodeUrl, l1ChainId: 31337, rollupVersion: run.config.rollupVersion, toolsOrigin }
}

/** The encrypted SQLite-OPFS store's worker resolves `sqlite3.wasm` at runtime through emscripten's
 *  `locateFile` fallback — a BARE `assets/sqlite3.wasm` beside the worker chunk that no bundler
 *  rewrites — so unhashed copies are emitted next to the hashed ones (the async proxy rides along
 *  for the non-SAH VFS the glue can also probe). */
function sqliteWasmEmit(): Plugin {
	// Two hops through declared dependencies: the isolated linker only lets a package see what it
	// declares, and it is @aztec-labs/kv-store — reached through @aztec-labs/pxe — that declares the wasm.
	const pxeRoot = realpathSync(resolvePackageRoot("@aztec-labs/pxe", { from: import.meta.url }))
	const kvRoot = realpathSync(resolvePackageRoot("@aztec-labs/kv-store", { from: join(pxeRoot, "package.json") }))
	const from = join(kvRoot, "package.json")
	return {
		name: "sqlite3mc-wasm-emit",
		apply: "build",
		generateBundle() {
			for (const file of ["sqlite3.wasm", "sqlite3-opfs-async-proxy.js"]) {
				this.emitFile({
					type: "asset",
					fileName: `assets/${file}`,
					source: readFileSync(resolveExportedAsset("@aztec-labs/sqlite3mc-wasm", `./vendor/jswasm/${file}`, { from })),
				})
			}
		},
	}
}

const id = identity()
const nodeOrigin = new URL(id.nodeUrl).origin
/** Framed by tools only; talks to itself and the sandbox node only. */
const csp = [
	"default-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"worker-src 'self' blob:",
	"style-src 'self' 'unsafe-inline'",
	`connect-src 'self' ${nodeOrigin} data: blob:`,
	"object-src 'none'",
	"base-uri 'self'",
	`frame-ancestors ${id.toolsOrigin}`,
].join("; ")

export default defineConfig({
	root: here,
	base: "/",
	build: { outDir: process.env.UNLEASHED_TEST_WALLET_OUT_DIR ?? join(here, "dist"), emptyOutDir: true, target: "esnext" },
	worker: { format: "es" },
	preview: {
		headers: {
			// The frame must be as isolated as its embedder for `crossOriginIsolated` (bb.js threads) to
			// hold inside it, and must say it may be embedded cross-origin at all.
			"Cross-Origin-Embedder-Policy": "require-corp",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Resource-Policy": "cross-origin",
			"Content-Security-Policy": csp,
		},
	},
	define: { __TEST_WALLET__: JSON.stringify(id) },
	resolve: {
		alias: [
			{
				find: "vite-plugin-node-polyfills/shims/buffer",
				replacement: resolvePackageAsset("vite-plugin-node-polyfills", "shims/buffer/dist/index.js", { from: import.meta.url }),
			},
			{ find: "detect-node", replacement: join(here, "detect-node.ts") },
		],
		dedupe: ["@aztec-foundation/noir-noirc_abi", "@aztec-foundation/noir-acvm_js"],
	},
	optimizeDeps: { exclude: ["@aztec-foundation/bb.js", "@aztec-foundation/noir-acvm_js", "@aztec-foundation/noir-noirc_abi"] },
	plugins: [nodePolyfills({ globals: { Buffer: true, global: true, process: true } }), sqliteWasmEmit()],
})
