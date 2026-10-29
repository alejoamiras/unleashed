/** Manifests frozen for the tests that build candidates from them: every promotion rewrites the shipped ones. */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type ManifestV2, parseManifestV2 } from "@unleashed/sdk/protocol"

/** Ethereum mainnet before any route: no bridge, the canonical 6.0.0 rollup's Fee Juice pair and PrivateFPC. */
export function mainnetPlaceholderManifest(): ManifestV2 {
	return parseManifestV2(JSON.parse(readFileSync(join(import.meta.dirname, "mainnet-bridge.placeholder.json"), "utf8")))
}
