/**
 * The single source of truth for the app-side network identity: the L1 chain, the Aztec node
 * endpoint, and explorer bases. Every composable and component reads chain identity from `NETWORK`
 * here — NOT from `viem/chains` directly. That import is Biome-banned everywhere except this file
 * (see `biome.json` → `noRestrictedImports`), so a half-switched build can't leave one composable
 * signing a Permit2 witness against the wrong chain id (the class of bug that reverts 100% of
 * deposits). The Permit2 EIP-712 domain chain id MUST be `NETWORK.l1ChainId`.
 *
 * Chain-id math lives in the Node-safe `chain-constants.ts` (importable from `vite.config.ts` with
 * no `viem`/`@aztec` pull); this module layers the `viem` Chain object + endpoints on top for the
 * app bundle. The Chain object is target-driven (Sepolia for the testnet build, mainnet otherwise).
 */
import type { Chain } from "viem"
import { foundry, mainnet, sepolia } from "viem/chains"
import { resolveToolsTarget } from "./network-targets"

export interface NetworkConfig {
	/** L1 (Ethereum) chain id — every viem client + the Permit2 EIP-712 domain bind to this. */
	l1ChainId: number
	/** Aztec wallet chain id, `(l1 ^ rollupVersion) >>> 0` — the node-handshake identity. */
	walletChainId: number
	/** The `viem` Chain object for L1 clients (`createWalletClient`, `writeContract`, …). */
	viemChain: Chain
	/** Aztec node RPC endpoint. */
	nodeUrl: string
	/** L1 block-explorer base (Etherscan-style), no trailing slash. */
	l1ExplorerBaseUrl: string
}

const target = resolveToolsTarget()

// The only place viem/chains is allowed. Map the target's L1 chain id to its viem Chain — the lookup
// is what guarantees viemChain.id === l1ChainId (so viem clients + the Permit2 domain agree).
// `foundry` (31337) is the sandbox the local target runs on. viem's Chain for it names no multicall3,
// and the L1 balance reads are multicalls (`ChainDoesNotSupportContract` otherwise); the sandbox
// installs the canonical, chain-invariant Multicall3, so the local chain declares that address.
const local: Chain = { ...foundry, contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } } }
const VIEM_CHAINS: Record<number, Chain> = { [sepolia.id]: sepolia, [mainnet.id]: mainnet, [foundry.id]: local }
const viemChain = VIEM_CHAINS[target.l1ChainId]
if (!viemChain) {
	throw new Error(`network.ts: no viem Chain for l1ChainId ${target.l1ChainId} (target ${target.key})`)
}

export const NETWORK: NetworkConfig = {
	l1ChainId: target.l1ChainId,
	walletChainId: target.walletChainId,
	viemChain,
	// The VITE_AZTEC_NODE_URL override is a dev/e2e affordance ONLY. A production build ignores it (like
	// the ?chainId override) so a stale Cloudflare VITE_AZTEC_NODE_URL can't silently repoint a
	// real-money build at the wrong Aztec node — the class of incident chain-constants exists to prevent.
	// Prod always uses the committed per-target node.
	nodeUrl: import.meta.env.DEV ? (import.meta.env.VITE_AZTEC_NODE_URL ?? target.nodeUrl) : target.nodeUrl,
	l1ExplorerBaseUrl: target.l1ExplorerBaseUrl,
}

/** The active target key. */
export const NETWORK_KEY = target.key

/** True on the mainnet/Alpha build. Drives the default tab, the network copy and the drip exec
 *  path (mainnet bridges real USDC; the drip tokens are play tokens there). */
export const IS_MAINNET = target.key === "mainnet"

/** L1 chip for the bridge/fuel FROM/TO panels: plain "Ethereum" on mainnet, the network-qualified
 *  "Ethereum · Sepolia" form on test targets. */
export const L1_CHAIN_LABEL = IS_MAINNET ? "Ethereum" : `Ethereum · ${viemChain.name}`
