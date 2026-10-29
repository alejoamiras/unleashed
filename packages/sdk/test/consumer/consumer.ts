/**
 * An npm consumer of the packed SDK: imports every published entry, loads the hub artifact through `./bridge` and prints
 * one JSON line that `scripts/pack-check.ts` holds Node and Bun to.
 */
import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import * as root from "@unleashed/sdk"
import * as bridge from "@unleashed/sdk/bridge"
import * as fuel from "@unleashed/sdk/fuel"
import * as networks from "@unleashed/sdk/networks"
import * as protocol from "@unleashed/sdk/protocol"

const entries: Record<string, object> = { ".": root, "./fuel": fuel, "./bridge": bridge, "./protocol": protocol, "./networks": networks }
const hub: ContractArtifact = await bridge.hubArtifact()
const manifests: unknown[] = [networks.TESTNET_MANIFEST, networks.MAINNET_MANIFEST]

console.log(
	JSON.stringify({
		runtime: process.versions.bun === undefined ? "node" : "bun",
		version: process.versions.bun ?? process.versions.node,
		entries: Object.fromEntries(
			Object.entries(entries).map(([key, namespace]) => [
				key,
				{ url: import.meta.resolve(`@unleashed/sdk${key.slice(1)}`), exports: Object.keys(namespace).sort() },
			]),
		),
		hub: hub.name,
		manifests: manifests.map((manifest) => typeof manifest),
	}),
)
