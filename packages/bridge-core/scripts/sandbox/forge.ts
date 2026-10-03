/** The sandbox deploys the bridge from Foundry's `out/` artifacts, which are gitignored. Every boot
 *  runs an incremental `forge build` with the same remappings the contract suite uses — a no-op
 *  when nothing changed, and the only thing that keeps a stale checkout's mocks current. */
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { aztecPin } from "./local-network"

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, "..", "..")
const EVM_ROOT = resolve(PACKAGE_ROOT, "..", "..", "contracts", "bridge", "evm")

/** The forge the pinned Aztec toolchain bundles, so the sandbox and the L1 deploy agree on a
 *  compiler; PATH's forge is the fallback for a machine without that toolchain. */
function forgeBin(): string {
	const bundled = join(homedir(), ".aztec", "versions", aztecPin(), "internal-bin", "forge")
	return existsSync(bundled) ? bundled : "forge"
}

export function ensureForgeArtifacts(): void {
	if (!existsSync(join(EVM_ROOT, "lib", "forge-std"))) {
		throw new Error(`${EVM_ROOT}/lib is missing — run the pinned \`forge install\` from contracts/bridge/evm/README.md first`)
	}
	console.log("[sandbox] forge build (incremental)")
	execFileSync("bun", ["scripts/gen-remappings.ts"], { cwd: PACKAGE_ROOT, stdio: "inherit" })
	execFileSync(forgeBin(), ["build", "--root", EVM_ROOT], { stdio: "inherit" })
}
