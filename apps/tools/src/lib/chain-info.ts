import type { ChainInfo } from "@aztec-labs/aztec.js/account"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { resolveToolsTarget } from "./network-targets"

/**
 * Resolve the chain info passed to wallet-sdk discovery.
 *
 * Precedence:
 *   1. URL ?chainId=…&version=… — ONLY in a dev build (`import.meta.env.DEV`). A production build
 *      dead-code-eliminates this branch, so a prod visitor CANNOT repoint the wallet handshake by
 *      editing the URL. This is layer 3 of the two-network integrity fence.
 *   2. The active build target (`network-targets.ts`, whose ids come from `chain-constants.ts`).
 *
 * There is deliberately NO `VITE_CHAIN_*` env override: a stale Cloudflare
 * `VITE_CHAIN_VERSION=4127419662` once shadowed the correct value and broke the wallet handshake in
 * prod ("No network configured for chainId 4138294185"). The identity is a compile-time constant
 * single-sourced from the build target so it cannot drift.
 *
 * (The `Fr.ZERO` wildcard was a prior UX hole — zero resolves to the wallet's "Local Network" seed
 * at `chainId === 0`, loading the capabilities popup with no accounts. Defaulting to the pair avoids
 * that in dev too.)
 */
export function readChainInfo(url: URL = new URL(window.location.href)): ChainInfo {
	const target = resolveToolsTarget()
	if (import.meta.env.DEV) {
		const queryChainId = url.searchParams.get("chainId")
		const queryVersion = url.searchParams.get("version")
		if (queryChainId || queryVersion) {
			return {
				chainId: parseField(queryChainId ?? String(target.l1ChainId)),
				version: parseField(queryVersion ?? String(target.rollupVersion)),
			}
		}
	}
	return {
		chainId: parseField(String(target.l1ChainId)),
		version: parseField(String(target.rollupVersion)),
	}
}

function parseField(raw: string | undefined): Fr {
	if (!raw) return Fr.ZERO
	return Fr.fromString(raw)
}
