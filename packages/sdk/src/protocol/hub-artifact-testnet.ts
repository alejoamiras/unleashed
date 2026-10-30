import { type ContractArtifact, loadContractArtifact } from "@aztec-labs/aztec.js/abi"
// The hub artifact the testnet generation deployed, kept beside its record. Only a dynamic import reaches this module,
// so a gas-only integrator never loads the megabytes; the import attribute is what Node's ESM loader requires.
import hubJson from "../../../../contracts/bridge/generations/testnet/aztec/TokenBridgeHub.json" with { type: "json" }

export const testnetHubArtifact: ContractArtifact = loadContractArtifact(hubJson as never)
