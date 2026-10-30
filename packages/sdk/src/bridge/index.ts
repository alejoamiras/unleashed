/** A token, or a token plus gas, through the hub. `parseNetwork` loads the hub artifact of a network with a token route. */
import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import { hubArtifactOf, type Network } from "../network.ts"

export { type Capability, capabilitiesFor } from "../capabilities.ts"
export { depositToken } from "./deposit.ts"
export { type BridgeGasLeg, type BridgeQuote, quoteBridge } from "./quote.ts"
export { type BridgeToken, type BridgeTokenState, resolveToken } from "./token.ts"

/** The artifact `net`'s hub was deployed from, for a wallet that must register the hub before a claim. Refuses a
 *  network `parseNetwork` did not build, or one with no token route (`invalid-network`). */
export async function hubArtifact(net: Network): Promise<ContractArtifact> {
	return hubArtifactOf(net)
}
export type { AztecSigner, ClaimOptions, ClaimOutcome } from "../execution/claim-run.ts"
export { claimToken } from "./claim.ts"
