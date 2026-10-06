/**
 * Node-only: turns a sandbox run's artifacts (`bun run --cwd packages/bridge-core sandbox:up
 * --artifacts <dir>`) into the local target + its manifest. Used by `vite.local.config.mts` at
 * config-eval time and by `verify-build-target.ts`; never imported by the app bundle.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type LocalTargetConfig, localTarget, type ToolsTarget } from "./network-targets"

/** The browser suite answers the token list with these (`tests/browser/fixtures/egress.ts`). */
const TOKEN_LIST_FIXTURES = ["token-list.json", "token-list-hostile.json"].map(
	(name) => new URL(`../../tests/e2e/fixtures/${name}`, import.meta.url),
)

const sha256Of = (file: URL) => createHash("sha256").update(readFileSync(file)).digest("hex")

interface Handle {
	anvilUrl: string
	nodeUrl: string
	rollupVersion: number
	walletChainId: number
	l1ChainId: number
	/** Absent on a handle from before the sandbox's cross-chain half. */
	crossChain?: { sourceUrl: string; sourceChainId: number }
}

/** The loopback Across API a held sandbox serves; `sandbox:up` writes it, a one-shot run does not. */
function relayApiUrl(artifactsDir: string): string | undefined {
	const file = join(artifactsDir, "relay-api.json")
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { url: string }).url : undefined
}

export interface LocalRun {
	target: ToolsTarget
	config: LocalTargetConfig
	manifestJson: string
	/** The faucet record the sandbox deployed — must equal the app's committed `deployments.json`. */
	deploymentsJson: string
}

export interface LocalRunOptions {
	/** Where the browser suite serves the built app (exact hostname is integrity layer 5). */
	host?: string
	/** The test-wallet pages discovery probes. */
	webWalletUrls?: readonly string[]
}

export function loadLocalRun(artifactsDir: string, opts: LocalRunOptions = {}): LocalRun {
	const handle = JSON.parse(readFileSync(join(artifactsDir, "handle.json"), "utf8")) as Handle
	if (handle.l1ChainId !== 31337) throw new Error(`local target: the sandbox handle names L1 chain ${handle.l1ChainId}, expected 31337`)
	const config: LocalTargetConfig = {
		nodeUrl: handle.nodeUrl,
		rollupVersion: handle.rollupVersion,
		walletChainId: handle.walletChainId,
		host: opts.host ?? "127.0.0.1",
		webWalletUrls: opts.webWalletUrls ?? [],
		tokenListSha256: TOKEN_LIST_FIXTURES.map(sha256Of),
		l1RpcUrl: handle.anvilUrl,
		...(handle.crossChain ? { source: { chainId: handle.crossChain.sourceChainId, rpcUrl: handle.crossChain.sourceUrl } } : {}),
	}
	const acrossApiUrl = relayApiUrl(artifactsDir)
	if (acrossApiUrl) config.acrossApiUrl = acrossApiUrl
	return {
		target: localTarget(config),
		config,
		manifestJson: readFileSync(join(artifactsDir, "manifest.json"), "utf8"),
		deploymentsJson: readFileSync(join(artifactsDir, "deployments.json"), "utf8"),
	}
}

/** `UNLEASHED_SANDBOX_ARTIFACTS` (required), `UNLEASHED_TOOLS_HOST`, `UNLEASHED_TOOLS_WEB_WALLETS` (comma-separated). */
export function loadLocalRunFromEnv(env: NodeJS.ProcessEnv = process.env): LocalRun {
	const dir = env.UNLEASHED_SANDBOX_ARTIFACTS
	if (!dir) throw new Error("the local target needs UNLEASHED_SANDBOX_ARTIFACTS=<dir written by sandbox:up>")
	return loadLocalRun(dir, {
		host: env.UNLEASHED_TOOLS_HOST,
		webWalletUrls: (env.UNLEASHED_TOOLS_WEB_WALLETS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	})
}
