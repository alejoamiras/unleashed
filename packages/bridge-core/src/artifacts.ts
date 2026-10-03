import { type ContractArtifact, loadContractArtifact } from "@aztec-labs/aztec.js/abi"
// The L2 hub's Noir artifact. Imported here so the browser app can register instances with a
// PXE without reaching across packages. The JSON is large; the explicit ContractArtifact return
// type keeps the huge literal from leaking into consumers' typechecks. The import attribute is
// what Node's ESM loader (the Playwright runner) requires for JSON; Bun and Vite accept it too.
import hubJson from "../../../contracts/bridge/aztec/token_bridge_hub/target/token_bridge_hub_contract-TokenBridgeHub.json" with {
	type: "json",
}

export const tokenBridgeHubArtifact: ContractArtifact = loadContractArtifact(hubJson as never)
