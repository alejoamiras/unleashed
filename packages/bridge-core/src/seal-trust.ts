/**
 * Per-wallet seal-determinism trust: remembers that an L1 account's wallet passed the
 * sign-twice self-test, so later private deposits seal with a SINGLE signature.
 *
 * Positive verdicts only — a wallet that fails the self-test aborts its deposit and simply
 * re-tests on the next attempt; caching a negative would wrongly outlive a wallet swap.
 * Entries are provider-aware: determinism is a property of the signing SOFTWARE, not the
 * address, so a trust hit requires the current provider fingerprint to match the stored one.
 *
 * Threat note: this cache is an explicitly accepted testnet risk — it is deliberately
 * un-MAC'd (no key exists without spending the signature it saves), and a forged positive entry
 * can strand FUTURE funds by skipping the self-test on a non-deterministic wallet. Revocation on
 * unseal failure + the provider fingerprint + the record-preserving failure UX bound the damage.
 */

import type { KV } from "./journal"

export const SEAL_TRUST_KEY = "unleashed-bridge:seal-trust:v1"

interface TrustEntry {
	verifiedAt: number
	/** Best-effort signer fingerprint: EIP-6963 rdns, else injected flags, else "unknown". */
	provider: string
}

interface TrustStore {
	schema: 1
	entries: Record<string, TrustEntry>
}

/** Fingerprints that don't identify a SPECIFIC wallet app. Two different unrecognized wallets
 *  would collide on these, silently reusing trust across signers — so generic fingerprints never
 *  earn a persistent verdict: those wallets self-test on every private deposit (2 signatures). */
const GENERIC_FINGERPRINTS = new Set(["unknown", "injected", ""])

export function isCacheableProvider(provider: string): boolean {
	return !GENERIC_FINGERPRINTS.has(provider)
}

function entryKey(chainId: number, address: string): string {
	return `${chainId}:${address.toLowerCase()}`
}

function load(kv: KV): TrustStore {
	const raw = kv.getItem(SEAL_TRUST_KEY)
	if (!raw) return { schema: 1, entries: {} }
	try {
		const parsed = JSON.parse(raw) as TrustStore
		if (parsed?.schema !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
			return { schema: 1, entries: {} }
		}
		return parsed
	} catch {
		return { schema: 1, entries: {} }
	}
}

/** True only when a positive verdict exists for (chainId, address) AND its provider fingerprint
 *  matches the current one — a different wallet app re-earns trust. Generic fingerprints are
 *  never trusted (they can't distinguish wallet apps). */
export function isSealTrusted(kv: KV, chainId: number, address: string, provider: string): boolean {
	if (!isCacheableProvider(provider)) return false
	const entry = load(kv).entries[entryKey(chainId, address)]
	return !!entry && entry.provider === provider
}

export function markSealTrusted(kv: KV, chainId: number, address: string, provider: string): void {
	if (!isCacheableProvider(provider)) return
	const store = load(kv)
	store.entries[entryKey(chainId, address)] = { verifiedAt: Date.now(), provider }
	kv.setItem(SEAL_TRUST_KEY, JSON.stringify(store))
}

export function revokeSealTrust(kv: KV, chainId: number, address: string): void {
	const store = load(kv)
	if (!(entryKey(chainId, address) in store.entries)) return
	delete store.entries[entryKey(chainId, address)]
	kv.setItem(SEAL_TRUST_KEY, JSON.stringify(store))
}
