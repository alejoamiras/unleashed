/**
 * Single source of truth for the tools app's alpha-testnet chain identity.
 *
 * Chain identity is pinned at build time, so these are CONSTANTS with deliberately NO
 * `VITE_CHAIN_*` env override: a stale Cloudflare `VITE_CHAIN_VERSION=4127419662`
 * once shadowed the correct value, yielding wallet chainId `4138294185` — which
 * the V5 wallet (then `1816023401`) had no network for ("No network configured for
 * chainId 4138294185"). `chain-info.ts` (runtime wallet-sdk discovery) and the
 * build-metadata plugin both read from here, so they cannot drift. URL query
 * params remain the only override, for the e2e test driver.
 *
 * Wallets keep their own copy of this identity; nothing here reads theirs, and a reset moves
 * both independently.
 *
 * Plain numbers + no imports on purpose: this module is importable from both
 * the app bundle and `vite.config.ts` (Node) without pulling `@aztec-labs/*`.
 */

/** Sepolia — the L1 the alpha-testnet rollup settles to. */
export const TESTNET_L1_CHAIN_ID = 11155111
/** V6 alpha-testnet rollup version. */
export const TESTNET_ROLLUP_VERSION = 2914217885

/** The wallet matches a network by `(l1 ^ rollupVersion) >>> 0` → `2904119610`. */
export const TESTNET_WALLET_CHAIN_ID = (TESTNET_L1_CHAIN_ID ^ TESTNET_ROLLUP_VERSION) >>> 0

/** Ethereum mainnet — the L1 the Alpha/mainnet rollup settles to. */
export const MAINNET_L1_CHAIN_ID = 1
/**
 * Alpha/mainnet rollup version. MUST be kept as fresh as its wallet-id pair — the Alpha 5.0.1
 * upgrade shipped a stale MAINNET pin once, so a bump re-reads this from the node.
 */
export const MAINNET_ROLLUP_VERSION = 4248422647

/** The wallet matches a network by `(l1 ^ rollupVersion) >>> 0` → `4248422646` (== extension CHAIN_IDS.MAINNET). */
export const MAINNET_WALLET_CHAIN_ID = (MAINNET_L1_CHAIN_ID ^ MAINNET_ROLLUP_VERSION) >>> 0
