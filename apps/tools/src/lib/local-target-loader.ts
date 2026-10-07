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

type Hex = `0x${string}`

interface Handle {
	anvilUrl: string
	nodeUrl: string
	rollupVersion: number
	walletChainId: number
	l1ChainId: number
	/** Absent on a handle from before the sandbox's cross-chain half. */
	crossChain?: {
		sourceUrl: string
		sourceChainId: number
		source: { spokePool: Hex; diamond: Hex; token: Hex }
		destination: { spokePool: Hex; executor: Hex; receiverAcrossV4: Hex; token: Hex }
	}
}

type CrossChain = NonNullable<Handle["crossChain"]>

/** The sandbox manifest routes nothing, since no live book may learn its chains, so the local build alone routes the
 *  source anvil's token into the rail token it delivers, which shares its symbol and decimals. */
function withSandboxRouting(manifestJson: string, cc: CrossChain): string {
	const manifest = JSON.parse(manifestJson) as {
		bridge?: { tokens: { erc20: string; displaySymbol: string; decimals: number }[]; routing?: unknown } | null
	}
	const dest = manifest.bridge?.tokens.find((t) => t.erc20.toLowerCase() === cc.destination.token.toLowerCase())
	if (!manifest.bridge || !dest) throw new Error(`local target: the sandbox manifest has no token ${cc.destination.token} to route into`)
	const token = { address: cc.source.token, symbol: dest.displaySymbol, decimals: dest.decimals, destToken: cc.destination.token }
	manifest.bridge.routing = { provider: "lifi", sources: [{ chainId: cc.sourceChainId, rail: "acrossV4", tokens: [token] }] }
	return `${JSON.stringify(manifest, null, "\t")}\n`
}

const sandboxLifiOf = (cc: CrossChain, l1ChainId: number): NonNullable<LocalTargetConfig["sandboxLifi"]> => ({
	source: { chainId: cc.sourceChainId, diamond: cc.source.diamond, spokePool: cc.source.spokePool },
	ethereum: {
		chainId: l1ChainId,
		executor: cc.destination.executor,
		receiverAcrossV4: cc.destination.receiverAcrossV4,
		spokePool: cc.destination.spokePool,
	},
})

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
	}
	const cc = handle.crossChain
	if (cc) {
		config.source = { chainId: cc.sourceChainId, rpcUrl: cc.sourceUrl }
		config.sandboxLifi = sandboxLifiOf(cc, handle.l1ChainId)
	}
	const acrossApiUrl = relayApiUrl(artifactsDir)
	if (acrossApiUrl) config.acrossApiUrl = acrossApiUrl
	const manifestJson = readFileSync(join(artifactsDir, "manifest.json"), "utf8")
	return {
		target: localTarget(config),
		config,
		manifestJson: cc ? withSandboxRouting(manifestJson, cc) : manifestJson,
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
