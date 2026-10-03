import type { Abi, Address } from "viem"
import type { BridgeBlock, ManifestV2 } from "./manifest-v2"
import { SWAP_BRIDGE_ROUTER_ABI } from "./router-abi"
import type { SendGeneration } from "./send-flow"

/** What every send binds to, read off a manifest. `feeAsset` is the one token whose gas slice needs no swap. */
export function sendGenerationOf(m: ManifestV2, bridge: BridgeBlock): SendGeneration {
	return {
		router: bridge.l1.router as Address,
		routerAbi: SWAP_BRIDGE_ROUTER_ABI as unknown as Abi,
		permit2: bridge.l1.permit2 as Address,
		factory: bridge.l1.factory as Address,
		implementation: bridge.l1.implementation as Address,
		feeJuicePortal: bridge.l1.feeJuicePortal as Address,
		feeAsset: m.feeJuice.asset as Address,
		swapTarget: bridge.l1.swapTarget as Address,
		chainId: m.l1ChainId,
		hub: bridge.l2.hub.address,
		tokenClassId: bridge.l2.tokenClassId,
	}
}
