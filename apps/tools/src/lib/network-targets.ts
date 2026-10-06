/**
 * The build targets, selected at BUILD TIME by which vite config is used — never at runtime and
 * never from a Cloudflare dashboard var (the `chain-constants` incident). This is the "config factory"
 * spine: each `vite.<target>.config.mts` imports one `ToolsTarget` and threads it into (a) a `define`
 * that the app reads via `resolveToolsTarget()` and (b) `buildMetaPlugin(target)` for `build.json`.
 *
 * Node-safe (imports only the plain-number `chain-constants`, no `viem`/`@aztec`, no `fs`), so
 * `vite.config.ts` can import it in Node scope — the same reason a vite `resolve.alias` can't carry
 * chain identity into `build.json`. The app ALSO imports it (for the type + the testnet fallback).
 *
 * The `local` target is the sandbox one: chain 31337, a node and a bridge generation the harness
 * booted for this run, and the web wallets the browser suite hosts. It has no constants — its
 * identity is read from the run's artifacts by `local-target-loader.ts` (Node) and `define`d into
 * the bundle as `__LOCAL_TARGET__`, so a testnet or mainnet build never carries it.
 */
import {
	MAINNET_L1_CHAIN_ID,
	MAINNET_ROLLUP_VERSION,
	MAINNET_WALLET_CHAIN_ID,
	TESTNET_L1_CHAIN_ID,
	TESTNET_ROLLUP_VERSION,
	TESTNET_WALLET_CHAIN_ID,
} from "./chain-constants"

export type ToolsTargetKey = "testnet" | "mainnet" | "local"

export interface ToolsTarget {
	key: ToolsTargetKey
	/** L1 (Ethereum) chain id — viem clients + the Permit2 EIP-712 domain bind to this. */
	l1ChainId: number
	/** Aztec rollup version (the wallet-handshake `version`). */
	rollupVersion: number
	/** `(l1 ^ rollupVersion) >>> 0` — the wallet-handshake chain id + `build.json` chainId. */
	walletChainId: number
	/** Bridge manifest bundled for this target (relative to `public/`, or the run's artifact for `local`). */
	manifestFile: string
	/** The hostname this build belongs at — integrity layer 5 asserts `location.hostname` matches. */
	host: string
	/** The Worker's own `<worker>.<subdomain>.workers.dev` host: also accepted by layer 5, and the one
	 *  preview aliases are derived from (Cloudflare serves them there, never under `host`). */
	workersDevHost?: string
	/** Layer 5 also accepts any `<label>-<workersDevHost>`: the alias and version hosts of the Worker's
	 *  preview uploads. Testnet only; a mainnet build runs at its two production hosts and nowhere else. */
	acceptsPreviewHosts?: boolean
	/** Aztec node RPC endpoint (overridable in dev/e2e via VITE_AZTEC_NODE_URL). */
	nodeUrl: string
	/** L1 block-explorer base (Etherscan-style), no trailing slash. */
	l1ExplorerBaseUrl: string
	/** CSP `connect-src` for this target — the node host MUST be listed or the app can't reach it. */
	cspConnectSrc: string
	/** Keyless read RPCs per chain id, preferred first, each serving `eth_getLogs` without silently truncating it:
	 *  what watches a cross-chain deposit without a wallet. A chain absent here has no wallet-independent reads. */
	readRpcUrls: Readonly<Record<number, readonly string[]>>
	/** The Across API base the testnet rail asks for its relay fee; absent where no route is quoted through it. */
	acrossApiUrl?: string
	/** Web (iframe) wallets discovery probes besides browser extensions. Only the local target lists any. */
	webWalletUrls?: readonly string[]
	/** Token-list digests accepted in place of bridge-core's pin. Only the local target sets any: its
	 *  browser suite answers the list from fixtures. */
	tokenListSha256?: readonly string[]
}

export const LOCAL_L1_CHAIN_ID = 31337

/**
 * bridge-core's `TOKEN_LIST_URL`, spelled out because this file must stay Node-safe; the test pins the
 * two equal. A full path, so a direct request reaches only that file on the CDN. CSP stops checking
 * paths after a redirect, which is one more reason the loader refuses redirects.
 */
const TOKEN_LIST_SOURCE = "https://cdn.jsdelivr.net/npm/@uniswap/default-token-list@22.20.0/build/uniswap-default.tokenlist.json"
const TESTNET_NODE_SOURCE = "https://lb.drpc.live/aztec-testnet/Ak_eT5HA2kbyqamqGTF702daoH37vEsR8YYxjmVXwXgc"

/** PublicNode answered consistent supersets over 1k–50k-block `Transfer` scans; the gateways that truncated were refused. */
const SEPOLIA_READ_RPCS = ["https://ethereum-sepolia-rpc.publicnode.com"] as const
/** bridge-core's `SOURCE_CHAINS[84532].rpcUrls`, spelled out to stay Node-safe; the test pins the two equal. */
const BASE_SEPOLIA_READ_RPCS = ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"] as const
/** bridge-core's `ACROSS_TESTNET_API`; the test pins the two equal. */
const ACROSS_TESTNET_API = "https://testnet.across.to/api"

/** The CSP sources for a target's read RPCs and Across API: each origin once. */
function readOrigins(readRpcUrls: Readonly<Record<number, readonly string[]>>, acrossApiUrl?: string): string[] {
	const urls = [...Object.values(readRpcUrls).flat(), ...(acrossApiUrl ? [acrossApiUrl] : [])]
	return [...new Set(urls.map((u) => new URL(u).origin))]
}

/** Everything the local target needs that only a booted sandbox knows. */
export interface LocalTargetConfig {
	nodeUrl: string
	rollupVersion: number
	walletChainId: number
	/** The origin the browser suite navigates to — integrity layer 5 compares the exact hostname. */
	host: string
	webWalletUrls: readonly string[]
	/** SHA-256 of each fixture the browser suite answers the token list with. */
	tokenListSha256?: readonly string[]
	/** The sandbox's L1 anvil. */
	l1RpcUrl?: string
	/** The sandbox's source-chain anvil, where its cross-chain half runs. */
	source?: { chainId: number; rpcUrl: string }
	/** The sandbox's loopback Across API. */
	acrossApiUrl?: string
}

const loopback = (protocol: string) => `${protocol}://127.0.0.1:* ${protocol}://localhost:*`

/** Pure: the local target for one sandbox run. */
export function localTarget(cfg: LocalTargetConfig): ToolsTarget {
	const walletOrigins = cfg.webWalletUrls.map((u) => new URL(u).origin)
	// Loopback only, so the CSP below already admits every one of them.
	const readRpcUrls: Record<number, readonly string[]> = {}
	if (cfg.l1RpcUrl) readRpcUrls[LOCAL_L1_CHAIN_ID] = [cfg.l1RpcUrl]
	if (cfg.source) readRpcUrls[cfg.source.chainId] = [cfg.source.rpcUrl]
	return {
		key: "local",
		l1ChainId: LOCAL_L1_CHAIN_ID,
		rollupVersion: cfg.rollupVersion,
		walletChainId: cfg.walletChainId,
		manifestFile: "local-bridge.json",
		host: cfg.host,
		nodeUrl: cfg.nodeUrl,
		l1ExplorerBaseUrl: "http://127.0.0.1",
		// Loopback only, plus the token list so the browser suite can answer it from a fixture
		// (a CSP-blocked request never reaches a route handler).
		cspConnectSrc: `'self' data: blob: ${loopback("http")} ${loopback("ws")} ${walletOrigins.join(" ")} ${TOKEN_LIST_SOURCE}`,
		webWalletUrls: cfg.webWalletUrls,
		...(cfg.tokenListSha256 ? { tokenListSha256: cfg.tokenListSha256 } : {}),
		readRpcUrls,
		...(cfg.acrossApiUrl ? { acrossApiUrl: cfg.acrossApiUrl } : {}),
	}
}

const TESTNET_READ_RPCS: Readonly<Record<number, readonly string[]>> = {
	[TESTNET_L1_CHAIN_ID]: SEPOLIA_READ_RPCS,
	84532: BASE_SEPOLIA_READ_RPCS,
}

export const TESTNET_TARGET: ToolsTarget = {
	key: "testnet",
	l1ChainId: TESTNET_L1_CHAIN_ID,
	rollupVersion: TESTNET_ROLLUP_VERSION,
	walletChainId: TESTNET_WALLET_CHAIN_ID,
	manifestFile: "testnet-bridge.json",
	host: "testnet.app.unleashed.systems",
	workersDevHost: "unleashed-testnet.alejo-amiras.workers.dev",
	acceptsPreviewHosts: true,
	// bridge-core's TESTNET_NODE_URL, repeated to stay Node-safe; a test holds the two equal.
	nodeUrl: TESTNET_NODE_SOURCE,
	l1ExplorerBaseUrl: "https://sepolia.etherscan.io",
	// The node by its exact path (the wallet reports the same one), the community token list the send
	// wizard's catalog fetches (omitted, the catalog degrades to manifest-only), and the read RPCs and
	// Across API a cross-chain send is quoted and watched through.
	cspConnectSrc: [
		"'self' data: blob:",
		TESTNET_NODE_SOURCE,
		TOKEN_LIST_SOURCE,
		...readOrigins(TESTNET_READ_RPCS, ACROSS_TESTNET_API),
	].join(" "),
	readRpcUrls: TESTNET_READ_RPCS,
	acrossApiUrl: ACROSS_TESTNET_API,
}

export const MAINNET_TARGET: ToolsTarget = {
	key: "mainnet",
	l1ChainId: MAINNET_L1_CHAIN_ID,
	rollupVersion: MAINNET_ROLLUP_VERSION,
	walletChainId: MAINNET_WALLET_CHAIN_ID,
	manifestFile: "mainnet-bridge.json",
	host: "app.unleashed.systems",
	workersDevHost: "unleashed-mainnet.alejo-amiras.workers.dev",
	// The Alpha node, on the same dRPC host the wallet pins.
	nodeUrl: "https://lb.drpc.live/aztec-mainnet/Ak_eT5HA2kbyqamqGTF702cdsdWqLTIR8YdadmahlY6k",
	l1ExplorerBaseUrl: "https://etherscan.io",
	// The mainnet build renders a static placeholder: no node handshake, no wallet transport, no token
	// list. Every remote origin is therefore removed — the narrowest CSP a build can ship, and the one
	// that makes a stray network call from this target fail loudly instead of reaching a live chain.
	cspConnectSrc: "'self' data: blob:",
	readRpcUrls: {},
}

/** The bundle-time local config, present only in a `vite.local.config.mts` build. */
declare const __LOCAL_TARGET__: LocalTargetConfig | undefined

function definedLocalTarget(): ToolsTarget | undefined {
	// A bare identifier the local build `define`s; every other build (and vitest) leaves it undefined,
	// so the local branch — node URL, wallet URLs, the 31337 chain — is dead code there.
	if (typeof __LOCAL_TARGET__ === "undefined") return undefined
	return localTarget(__LOCAL_TARGET__)
}

export const TARGETS: Record<"testnet" | "mainnet", ToolsTarget> = {
	testnet: TESTNET_TARGET,
	mainnet: MAINNET_TARGET,
}

/**
 * Resolve the active build target from the value `define`d by the vite config (`VITE_TOOLS_TARGET`).
 * Falls back to testnet when unset — i.e. under vitest (no define) and a bare `vite build`, so
 * unit tests and the default testnet build need no define.
 */
export function resolveToolsTarget(): ToolsTarget {
	const key = import.meta.env.VITE_TOOLS_TARGET as ToolsTargetKey | undefined
	if (key === "local") return definedLocalTarget() ?? TESTNET_TARGET
	return (key && TARGETS[key]) || TESTNET_TARGET
}
