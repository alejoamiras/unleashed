import type { Address } from "viem"
import type { BridgeBlock, ManifestV2 } from "./manifest-v2"
import type { FuelRoute, SendGeneration } from "./send-flow"

/** A router's gas-only send binding plus what its fuel quotes floor against. */
export interface ManifestFuelRoute extends FuelRoute {
	/** The testnet swapper the router swaps through; absent where its `SWAP_TARGET` is LI.FI's Diamond. */
	fuelSwapper?: Address
	slippageBps: number
	minFuelFj: bigint
}

/**
 * The router a manifest's gas-only sends go through: its bridge's, or a fuel-only route's behind its gate. Undefined
 * for a manifest with neither (a bridge without a router, or the placeholder).
 */
export function fuelRouteOf(m: ManifestV2): ManifestFuelRoute | undefined {
	const l1 = m.bridge?.l1
	const r =
		l1?.depositRouter && l1.fuel
			? { router: l1.depositRouter, permit2: l1.permit2, fuelSwapper: l1.fuelSwapper, fuel: l1.fuel }
			: m.fuelRoute && { router: m.fuelRoute.depositRouter, ...m.fuelRoute }
	if (!r) return undefined
	return {
		router: r.router as Address,
		permit2: r.permit2 as Address,
		feeJuicePortal: m.feeJuice.portal as Address,
		feeAsset: m.feeJuice.asset as Address,
		chainId: m.l1ChainId,
		...(r.fuelSwapper ? { fuelSwapper: r.fuelSwapper as Address } : {}),
		slippageBps: r.fuel.slippageBps,
		minFuelFj: BigInt(r.fuel.minFuelFj),
	}
}

/**
 * What every send binds to, read off a manifest: the router's gas-only binding plus the factory and hub that token legs
 * derive from. `feeAsset` is the one token whose gas slice needs no swap. Throws for a bridge without a deposit
 * router: every Ethereum-origin send goes through it.
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

/** Routers whose in-flight deposits still recover, newest first (`l1.legacyRouters`). No send ever goes through one. */
export function legacyRoutersOf(bridge: BridgeBlock): Address[] {
	const current = bridge.l1.depositRouter?.toLowerCase()
	const all = (bridge.l1.legacyRouters ?? []).map((a) => a.toLowerCase() as Address)
	return [...new Set(all)].filter((a) => a !== current)
}
