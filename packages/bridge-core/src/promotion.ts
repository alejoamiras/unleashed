/**
 * The pure validation seams of a manifest promotion: the boot shape the app needs from a candidate,
 * and the interlock that stops a promotion from quietly moving the network or the generation.
 * Extracted so the fund-adjacent checks are unit-testable without live RPC plumbing.
 */
import { type ManifestV2, parseManifestV2Strict } from "./manifest-v2"

/**
 * Strict-parses a candidate — both halves, so every token's L2 address is the hub's derivation —
 * and adds what the app needs at boot but the schema allows in general: a real bridge
 * (`bridge: null` is a legal placeholder manifest, never a promotable one) carrying at least one
 * token, so the wizard never boots onto an empty token list.
 */
export async function assertFaucetCandidateShape(raw: unknown): Promise<ManifestV2> {
	const m = await parseManifestV2Strict(raw)
	if (!m.bridge) {
		throw new Error(`candidate for ${m.network} carries no bridge (placeholder network) — there is nothing to promote; STOP`)
	}
	if (m.bridge.tokens.length === 0) throw new Error(`candidate for ${m.network} carries no tokens — STOP`)
	return m
}

const IDENTITY_FIELDS = ["network", "l1ChainId", "walletChainId"] as const

/**
 * A promotion advances the SAME network's SAME generation and nothing else. The chain identity keys
 * every stored account, journal row and claim secret; the factory is what every portal address
 * derives from, and the factory's register messages are addressed to ONE hub. Moving any of them
 * is a new generation — a deliberate flow of its own, never the side effect of publishing a
 * candidate.
 */
export function assertZeroSeed(candidate: ManifestV2, live: ManifestV2): void {
	const moved = IDENTITY_FIELDS.filter((k) => candidate[k] !== live[k])
	if (moved.length > 0) {
		const detail = moved.map((k) => `${k} ${String(live[k])} → ${String(candidate[k])}`).join(", ")
		throw new Error(`promotion would change the network identity (${detail}) — STOP`)
	}
	if (!live.bridge) return
	if (!candidate.bridge) throw new Error("promotion would drop the live bridge (candidate is a placeholder) — STOP")
	if (candidate.bridge.l1.factory.toLowerCase() !== live.bridge.l1.factory.toLowerCase()) {
		throw new Error(
			`promotion would change the L1 factory (${live.bridge.l1.factory} → ${candidate.bridge.l1.factory}): every portal address ` +
				"derives from it, so that is a new generation, not a promotion — STOP",
		)
	}
	if (candidate.bridge.l2.hub.address.toLowerCase() !== live.bridge.l2.hub.address.toLowerCase()) {
		throw new Error(
			`promotion would change the L2 hub (${live.bridge.l2.hub.address} → ${candidate.bridge.l2.hub.address}) under the same ` +
				"factory: the factory's register messages name one hub, so the new one could never learn a token — STOP",
		)
	}
}
