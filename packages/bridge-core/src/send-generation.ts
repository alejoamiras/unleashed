import type { Address } from "viem"
import type { BridgeBlock, ManifestV2 } from "./manifest-v2"
import type { SendGeneration } from "./send-flow"

/**
 * What every send binds to, read off a manifest. `feeAsset` is the one token whose gas slice needs no
 * swap. Throws for a bridge without a deposit router: every Ethereum-origin send goes through it.
 */
export function sendGenerationOf(m: ManifestV2, bridge: BridgeBlock): SendGeneration {
	const router = bridge.l1.depositRouter
	if (!router) throw new Error("the manifest carries no bridge.l1.depositRouter — this bridge cannot send")
	return {
		router: router as Address,
		permit2: bridge.l1.permit2 as Address,
		factory: bridge.l1.factory as Address,
		implementation: bridge.l1.implementation as Address,
		feeJuicePortal: bridge.l1.feeJuicePortal as Address,
		feeAsset: m.feeJuice.asset as Address,
		chainId: m.l1ChainId,
		hub: bridge.l2.hub.address,
		tokenClassId: bridge.l2.tokenClassId,
	}
}

/**
 * Routers whose in-flight deposits still recover, newest first: the bridge's previous router while it
 * stays listed as `l1.router`, then `l1.legacyRouters`. No send ever goes through one.
 */
export function legacyRoutersOf(bridge: BridgeBlock): Address[] {
	const current = bridge.l1.depositRouter?.toLowerCase()
	const listed = [...(bridge.l1.router ? [bridge.l1.router] : []), ...(bridge.l1.legacyRouters ?? [])]
	const all = listed.map((a) => a.toLowerCase() as Address)
	return [...new Set(all)].filter((a) => a !== current)
}
