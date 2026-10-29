/** A token, or a token plus gas, through the hub. This entry loads the hub artifact. */
import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import { tokenBridgeHubArtifact } from "../protocol/artifacts.ts"

export { type Capability, capabilitiesFor } from "../capabilities.ts"
export { depositToken } from "./deposit.ts"
export { type BridgeGasLeg, type BridgeQuote, quoteBridge } from "./quote.ts"
export { type BridgeToken, type BridgeTokenState, resolveToken } from "./token.ts"

/** The L2 hub's artifact, for a wallet that must register the hub before a claim. */
export async function hubArtifact(): Promise<ContractArtifact> {
	return tokenBridgeHubArtifact
}
export type { AztecSigner, ClaimOptions, ClaimOutcome } from "../execution/claim-run.ts"
export { claimToken } from "./claim.ts"
