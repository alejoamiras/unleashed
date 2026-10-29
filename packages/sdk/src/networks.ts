/**
 * The promoted testnet and mainnet manifests, as reviewed in this release: an integrator that passes one of these to
 * `parseNetwork` trusts no file served from our hosts. Each is still parsed and checked against the chain like any
 * other manifest.
 */
import mainnetJson from "../../../apps/tools/public/mainnet-bridge.json" with { type: "json" }
import testnetJson from "../../../apps/tools/public/testnet-bridge.json" with { type: "json" }

export const TESTNET_MANIFEST: unknown = testnetJson
export const MAINNET_MANIFEST: unknown = mainnetJson
