import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, URL } from "node:url"
import vue from "@vitejs/plugin-vue"
import { defineConfig, type Plugin, type UserConfig } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { resolvePackageAsset } from "@nulo-sh/resolve-asset"
import { componentsPlugin } from "./scripts/components-plugin"
import { type LocalTargetConfig, type ToolsTarget, TESTNET_TARGET } from "./src/lib/network-targets"

const COOP_COEP_HEADERS = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
}

// Dev server port. Defaults to 5176 for local DX; the e2e network harness
// overrides this per-worktree via TOOLS_DEV_PORT so parallel agents don't
// collide. strictPort is only on for local dev — when the harness picks a
// port, Vite must be allowed to bind to whatever it allocates.
const TOOLS_DEV_PORT = Number(process.env.TOOLS_DEV_PORT) || 5176

/**
 * Build metadata that proves what is live. One `buildId` goes into both the served HTML (a `<meta>`
 * tag) and `dist/build.json`, so a check can catch a split cache serving a fresh build.json over a
 * stale index.html. `chainId` is the target's wallet chain id, and `target`/`manifestDigest` let CI
 * prove the right per-target manifest shipped (`verify:build-target`).
 */
function buildMetaPlugin(target: ToolsTarget, manifestJson: string): Plugin {
	const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")) as { version: string }
	let buildId = ""
	let root = process.cwd()
	let outDir = "dist"
	return {
		name: "unleashed-build-meta",
		apply: "build",
		configResolved(config) {
			root = config.root
			outDir = config.build.outDir
			// Workers Builds' commit, else the local checkout's. A build with neither has no identity.
			const sha =
				process.env.WORKERS_CI_COMMIT_SHA?.slice(0, 8) ??
				(() => {
					try {
						return execSync("git rev-parse --short=8 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
							.toString()
							.trim()
					} catch {
						return null
					}
				})()
			if (!sha) throw new Error("no build identity: neither WORKERS_CI_COMMIT_SHA nor a git checkout")
			buildId = `${pkg.version}+${sha}`
		},
		transformIndexHtml() {
			return [{ tag: "meta", attrs: { name: "unleashed-build", content: buildId }, injectTo: "head" }]
		},
		closeBundle() {
			// manifestDigest lets CI (verify-deployments) compare the digest EMITTED here against the
			// bundled manifest — not a recomputed one.
			const manifestDigest = createHashHex(manifestJson)
			const meta = {
				buildId,
				version: pkg.version,
				target: target.key,
				chainId: target.walletChainId,
				manifestDigest,
			}
			writeFileSync(resolve(root, outDir, "build.json"), `${JSON.stringify(meta, null, 2)}\n`)
			// The active manifest is inlined into the bundle at build; the OTHER target's raw JSON must
			// not ship (no placeholder mainnet manifest served on the testnet site, and vice-versa).
			for (const f of readdirSync(resolve(root, outDir))) {
				if (f.endsWith("-bridge.json") && f !== target.manifestFile) rmSync(resolve(root, outDir, f))
			}
		},
	}
}

/** sha256 of the exact bundled manifest bytes, hex — the identity CI checks against. */
function createHashHex(s: string): string {
	return createHash("sha256").update(s).digest("hex")
}

function readManifest(target: ToolsTarget): string {
	const p = fileURLToPath(new URL(`./public/${target.manifestFile}`, import.meta.url))
	return readFileSync(p, "utf8")
}

/**
 * Write `dist/_headers` (Workers static assets) with the TARGET's CSP `connect-src` — testnet allows the
 * Aztec node hosts plus the pinned token-list file, while the mainnet placeholder talks to nothing remote
 * at all. Generated per build rather than shipped statically so the two deployments can't share one
 * header set, which would hand the placeholder origins it must never be able to reach.
 */
/** The target's CSP. Only the local target frames anything: the test wallets the browser suite hosts. */
function cspFor(target: ToolsTarget): string {
	const frames = target.webWalletUrls?.length ? [`frame-src ${target.webWalletUrls.map((u) => new URL(u).origin).join(" ")}`] : []
	return [
		"default-src 'self'",
		"img-src 'self' data:",
		"font-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"worker-src 'self' blob:",
		`connect-src ${target.cspConnectSrc}`,
		...frames,
		"object-src 'none'",
		"base-uri 'self'",
		"frame-ancestors 'none'",
	].join("; ")
}

function headersPlugin(target: ToolsTarget): Plugin {
	let root = process.cwd()
	let outDir = "dist"
	const csp = cspFor(target)
	const body = `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Strict-Transport-Security: max-age=31536000
`
	return {
		name: "unleashed-headers",
		apply: "build",
		configResolved(config) {
			root = config.root
			outDir = config.build.outDir
		},
		closeBundle() {
			writeFileSync(resolve(root, outDir, "_headers"), body)
		},
	}
}

/**
 * The config factory. Each `vite.<target>.config.mts` calls this with its one `ToolsTarget`; the
 * default export builds testnet, so a bare `vite build` (and vitest, which ignores this file)
 * works. The target key + its bridge manifest are `define`d into `import.meta.env` so the app
 * (`resolveToolsTarget`, `bridge-generation`) reads them at runtime; `build.json` gets the target
 * via the plugin arg (Node scope — a vite alias can't reach here).
 */
export interface ToolsConfigOptions {
	/** The manifest bytes to inline, when they are not a committed `public/<manifestFile>` (the local run's). */
	manifestJson?: string
	/** The local target's bundle-time identity; `define`d as `__LOCAL_TARGET__` for that build only. */
	localConfig?: LocalTargetConfig
}

export function makeToolsConfig(target: ToolsTarget, opts: ToolsConfigOptions = {}): UserConfig {
	const manifestJson = opts.manifestJson ?? readManifest(target)
	if ((target.key === "local") !== Boolean(opts.localConfig)) {
		throw new Error("makeToolsConfig: the local target and localConfig come together, never one without the other")
	}
	// The preview server is what the browser suite drives, so it serves the same CSP Cloudflare would.
	const previewHeaders = target.key === "local" ? { ...COOP_COEP_HEADERS, "Content-Security-Policy": cspFor(target) } : COOP_COEP_HEADERS
	return defineConfig({
		server: {
			port: TOOLS_DEV_PORT,
			strictPort: !process.env.TOOLS_DEV_PORT,
			// bb.js threaded wasm requires cross-origin isolation. Same headers
			// ship in production via the generated dist/_headers (Workers static assets).
			headers: COOP_COEP_HEADERS,
		},
		preview: {
			headers: previewHeaders,
		},
		build: {
			// The CSP's `font-src 'self'` blocks `data:` fonts, and the pixel-face subset is under the
			// default 4 KiB inline threshold.
			assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
		},
		define: {
			"import.meta.env.VITE_TOOLS_TARGET": JSON.stringify(target.key),
			"import.meta.env.VITE_BRIDGE_MANIFEST_JSON": JSON.stringify(manifestJson),
			...(opts.localConfig ? { __LOCAL_TARGET__: JSON.stringify(opts.localConfig) } : {}),
		},
		resolve: {
			alias: [
				{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
				// nodePolyfills' `globals.Buffer` injects an import of this shim into EVERY
				// transformed module, which rolldown then resolves from that module's own
				// location. Dependencies (the published wallet-crypto package among them) don't
				// declare the plugin, so under the isolated linker the bare specifier is
				// unreachable from them — pin it to this app's copy.
				{
					find: "vite-plugin-node-polyfills/shims/buffer",
					replacement: resolvePackageAsset("vite-plugin-node-polyfills", "shims/buffer/dist/index.js", {
						from: import.meta.url,
					}),
				},
			],
			// Multiple nested versions of these WASM-binding packages can exist
			// in node_modules. Without dedup, initAbi() and abiEncode() end up
			// in different module scopes and the WASM instance never resolves.
			dedupe: ["@aztec-foundation/noir-noirc_abi", "@aztec-foundation/noir-acvm_js"],
		},
		plugins: [
			vue(),
			componentsPlugin({ dts: "src/types/components.d.ts" }),
			nodePolyfills({
				// Aztec packages reach for `process` at module top-level via util/path
				// shims. Without these the bundle throws ReferenceError before mount.
				globals: { Buffer: true, global: true, process: true },
			}),
			buildMetaPlugin(target, manifestJson),
			headersPlugin(target),
		],
	})
}

export default makeToolsConfig(TESTNET_TARGET)
