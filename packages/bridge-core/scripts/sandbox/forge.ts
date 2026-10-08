/** The sandbox deploys the bridge from Foundry's `out/` artifacts and LI.FI's destination half from the `lifi`
 *  profile's `out-lifi/`, all gitignored. Every boot runs an incremental `forge build` of both with the same
 *  remappings the contract suite uses — a no-op when nothing changed, and the only thing that keeps a stale
 *  checkout's mocks current. */
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

function requireLib(name: string): void {
	if (!existsSync(join(EVM_ROOT, "lib", name))) {
		throw new Error(
			`${EVM_ROOT}/lib/${name} is missing — run the pinned \`forge install\` lines from contracts/bridge/evm/README.md first`,
		)
	}
}

export function ensureForgeArtifacts(): void {
	requireLib("forge-std")
	requireLib("lifi-contracts")
	console.log("[sandbox] forge build (incremental), default and lifi profiles")
	execFileSync("bun", ["scripts/gen-remappings.ts"], { cwd: PACKAGE_ROOT, stdio: "inherit" })
	execFileSync(forgeBin(), ["build", "--root", EVM_ROOT], { stdio: "inherit" })
	// A profile foundry.toml lacks would silently build the default one, so the artifact is checked.
	execFileSync(forgeBin(), ["build", "--root", EVM_ROOT], { stdio: "inherit", env: { ...process.env, FOUNDRY_PROFILE: "lifi" } })
	if (!existsSync(lifiArtifactPath("ReceiverAcrossV4"))) throw new Error("the lifi profile built no ReceiverAcrossV4 artifact")
}

/** A `lifi` profile artifact by contract name (`out-lifi/<name>.sol/<name>.json`). */
export function lifiArtifactPath(name: string): string {
	return join(EVM_ROOT, "out-lifi", `${name}.sol`, `${name}.json`)
}
