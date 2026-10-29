/**
 * The promoted testnet and mainnet manifests, as reviewed in this release. On their chains `parseNetwork` accepts these
 * and nothing else, so an integrator trusts no file served from our hosts and a new generation reaches integrators
 * through an SDK release. Each is still checked against the chain. Frozen: what the check compares with cannot be
 * edited after import.
 */
import mainnetJson from "../../../apps/tools/public/mainnet-bridge.json" with { type: "json" }
import testnetJson from "../../../apps/tools/public/testnet-bridge.json" with { type: "json" }
import { deepFreeze } from "./protocol/freeze.ts"

export const TESTNET_MANIFEST: unknown = deepFreeze(testnetJson)
export const MAINNET_MANIFEST: unknown = deepFreeze(mainnetJson)

const BUNDLED: readonly unknown[] = [TESTNET_MANIFEST, MAINNET_MANIFEST]

/** The manifest this release bundles for L1 chain `l1ChainId`, or undefined when it bundles none for that chain. */
export function bundledManifest(l1ChainId: number): unknown {
	return BUNDLED.find((m) => (m as { l1ChainId?: unknown }).l1ChainId === l1ChainId)
}
