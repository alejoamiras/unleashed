/**
 * Shared conductor bootstrap: the L1/L2 client construction, elapsed-timer,
 * and --config manifest loading of every deploy/smoke/canary script, in one
 * place so no script can differ silently in `proverEnabled` or in what it does
 * when --config is absent.
 *
 * Deliberately FOUR separate client factories, never a combined one: the
 * conductors interleave L1, node, and wallet creation with fund-moving domain
 * logic, in per-script orders that must not change. Each factory is one
 * construction step; call sites keep their exact sequencing.
 */
import { readFileSync } from "node:fs"
import { type ManifestV2, parseManifestV2 } from "../src/manifest-v2"
import { ownedWalletStore } from "./wallet-store"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import {
	type Account,
	type Chain,
	createPublicClient,
	createWalletClient,
	defineChain,
	http,
	type PublicClient,
	type Transport,
	type WalletClient,
} from "viem"

/** The one Sepolia chain descriptor every testnet conductor was re-declaring. */
export function sepoliaChain(rpcUrl: string): Chain {
	return defineChain({
		id: 11155111,
		name: "sepolia",
		nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
		rpcUrls: { default: { http: [rpcUrl] } },
	})
}

/** The one Ethereum-mainnet chain descriptor every mainnet conductor was re-declaring. */
export function mainnetChain(rpcUrl: string): Chain {
	return defineChain({
		id: 1,
		name: "ethereum",
		nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
		rpcUrls: { default: { http: [rpcUrl] } },
	})
}

/** L1 wallet + public client pair. Construction order (wallet first) matches
 *  every conductor's original sequence. Generic over chain + account so viem's
 *  literal narrowing survives — `writeContract`/`deployContract` keep their
 *  optional chain/account params at every call site, no casts needed. */
export function createL1Clients<TChain extends Chain, TAccount extends Account>(opts: {
	chain: TChain
	rpcUrl: string
	account: TAccount
}): {
	wallet: WalletClient<Transport, TChain, TAccount>
	pub: PublicClient<Transport, TChain>
} {
	// One contained cast: viem's createWalletClient widens the account through
	// parseAccount, so its inferred client type doesn't re-narrow to TAccount —
	// the runtime value IS the caller's account. Centralizing the narrow here
	// is the whole point (it replaced nine per-script casts).
	const wallet = createWalletClient({
		account: opts.account,
		chain: opts.chain,
		transport: http(opts.rpcUrl),
	}) as unknown as WalletClient<Transport, TChain, TAccount>
	const pub = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) })
	return { wallet, pub }
}

/** Read-only L1 client, for scripts (or extra clients) with no signing side. */
export function createL1PublicClient(opts: { chain: Chain; rpcUrl: string }): PublicClient {
	return createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) })
}

/** Aztec node client. Separate from the wallet factory: conductors create the
 *  two on opposite sides of domain logic, in both orders. */
export function createNode(nodeUrl: string): ReturnType<typeof createAztecNodeClient> {
	return createAztecNodeClient(nodeUrl)
}

/** Embedded Aztec wallet. `proverEnabled` is REQUIRED — every call site states
 *  its choice visibly, so the sandbox's `false` is never a silent outlier. `sandboxKeysOnly` lets the store fall back to disk on a
 *  host without a tmpfs `/dev/shm`; a wallet holding real keys refuses to run there. */
export function createL2Wallet(opts: { nodeUrl: string; proverEnabled: boolean; sandboxKeysOnly?: boolean }): Promise<EmbeddedWallet> {
	const dataDirectory = ownedWalletStore("wallet", { allowDisk: opts.sandboxKeysOnly ?? false })
	return EmbeddedWallet.create(opts.nodeUrl, { pxeConfig: { proverEnabled: opts.proverEnabled, dataDirectory } })
}

/** Elapsed-minutes stopwatch — replaces each hand-rolled `t0`/`mins()` pair. */
export function stopwatch(): () => string {
	const t0 = Date.now()
	return () => `${((Date.now() - t0) / 60000).toFixed(1)}m`
}

/**
 * Load the `--config <path>` manifest with the caller's EXPLICIT absence
 * policy: `required` throws (deploy/smoke conductors), `fallback` reads the
 * given path instead (the fee-juice canary's live-manifest behavior —
 * deliberately retained; the win is that the choice is now visible here).
 */
export function loadManifestFromConfigArg<T>(
	argv: readonly string[],
	opts:
		| { mode: "required"; requiredHint?: string; parse: (raw: unknown) => T }
		| { mode: "fallback"; fallbackPath: string; parse: (raw: unknown) => T },
): T {
	const configArg = argv.indexOf("--config")
	if (configArg === -1) {
		if (opts.mode === "required") {
			const hint = opts.requiredHint ? ` (e.g. ${opts.requiredHint})` : ""
			throw new Error(`pass --config <candidate manifest path>${hint}`)
		}
		return opts.parse(JSON.parse(readFileSync(opts.fallbackPath, "utf8")))
	}
	return opts.parse(JSON.parse(readFileSync(argv[configArg + 1] as string, "utf8")))
}

/** The generation manifest (`schema: 2`) from `--config`, strictly parsed; the L2 derivation check is the caller's. */
export function loadManifestV2FromConfigArg(
	argv: readonly string[],
	opts: { mode: "required"; requiredHint?: string } | { mode: "fallback"; fallbackPath: string },
): ManifestV2 {
	return loadManifestFromConfigArg(argv, { ...opts, parse: parseManifestV2 })
}

/** A manifest with no bridge is a placeholder network — every bridge operation refuses it by name. */
export function requireBridge(m: ManifestV2): NonNullable<ManifestV2["bridge"]> {
	if (!m.bridge) throw new Error(`manifest for ${m.network} carries no bridge (placeholder network) — STOP`)
	return m.bridge
}
