/**
 * Post-build gate: prove the built artifact IS the target it claims to be, using the digest EMITTED
 * in the artifact's own build.json (not a recomputed one). Run per target in CI after `build:<target>`;
 * catches a build that shipped the wrong manifest or was built with the wrong config. Offline.
 *
 *   bun run scripts/verify-build-target.ts <testnet|mainnet|local> [--dist <dir>]
 *
 * The local target's identity and manifest come from the sandbox run's artifacts
 * (UNLEASHED_SANDBOX_ARTIFACTS), exactly as the build read them.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadLocalRunFromEnv } from "../src/lib/local-target-loader"
import { TARGETS, type ToolsTarget, type ToolsTargetKey } from "../src/lib/network-targets"

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, "..")

const args = process.argv.slice(2)
const distFlag = args.indexOf("--dist")
const distValue = distFlag >= 0 ? args[distFlag + 1] : undefined
const dist = distValue !== undefined ? resolve(distValue) : join(appRoot, "dist")
// Only the value that follows `--dist` is not the target; without the flag every positional is.
const key = (args.find((a) => !a.startsWith("--") && a !== distValue) || process.env.TOOLS_TARGET || "testnet") as ToolsTargetKey

let target: ToolsTarget
let manifest: string
if (key === "local") {
	const run = loadLocalRunFromEnv()
	target = run.target
	manifest = run.manifestJson
} else {
	const t = TARGETS[key as "testnet" | "mainnet"]
	if (!t) throw new Error(`verify-build-target: unknown target "${key}" (expected testnet | mainnet | local)`)
	target = t
	manifest = readFileSync(join(appRoot, "public", t.manifestFile), "utf8")
}

const build = JSON.parse(readFileSync(join(dist, "build.json"), "utf8")) as {
	target?: string
	chainId?: number
	manifestDigest?: string
}
const digest = createHash("sha256").update(manifest).digest("hex")

const problems: string[] = []
if (build.target !== key) problems.push(`build.json target=${build.target} != ${key}`)
if (build.chainId !== target.walletChainId) problems.push(`build.json chainId=${build.chainId} != ${target.walletChainId}`)
if (build.manifestDigest !== digest) {
	problems.push(`build.json manifestDigest=${build.manifestDigest} != sha256(${target.manifestFile})=${digest}`)
}

if (problems.length > 0) {
	console.error(`✗ build-target verification FAILED for ${key}:\n  ${problems.join("\n  ")}`)
	process.exit(1)
}
console.log(`✓ ${dist}/build.json matches target ${key} (chainId ${build.chainId}; ${target.manifestFile} digest verified)`)
