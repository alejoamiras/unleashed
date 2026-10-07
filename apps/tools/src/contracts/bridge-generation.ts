import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractInstanceWithAddress } from "@aztec-labs/aztec.js/contracts"
import { TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import {
	type BridgeBlock,
	deriveHubTokenInstance,
	deriveManifestHub,
	type HubTokenWords,
	legacyRoutersOf,
	type ManifestToken,
	type ManifestV2,
	parseManifestV2,
	type SendGeneration,
	sendGenerationOf,
} from "@unleashed/bridge-core"
import { tokenBridgeHubArtifact } from "@unleashed/bridge-core/artifacts"
import rawTestnetConfig from "../../public/testnet-bridge.json"

/*
 * The generation manifest: one L1 factory + one L2 hub per network, plus the tokens whose portals
 * were pre-created. STRICT-validated at module init — a malformed or stale-shaped manifest fails
 * the app loudly at boot instead of shipping a broken lane. `bridge: null` is a legal manifest:
 * the network has no bridge and the app renders the placeholder only.
 *
 * Injected per build target via vite `define`; the static testnet import is the vitest fallback.
 */
const injectedManifest = import.meta.env.VITE_BRIDGE_MANIFEST_JSON
export const MANIFEST: ManifestV2 = parseManifestV2(injectedManifest ? JSON.parse(injectedManifest) : rawTestnetConfig)

export const GENERATION: BridgeBlock | null = MANIFEST.bridge
export const IS_PLACEHOLDER = GENERATION === null

/** The chain identity this manifest declares — consumed by the build-integrity assertion. */
export const MANIFEST_CHAIN = { l1ChainId: MANIFEST.l1ChainId, walletChainId: MANIFEST.walletChainId }

export const FEE_JUICE = MANIFEST.feeJuice
export const FUEL_PORTAL = FEE_JUICE.portal as `0x${string}`
export const FUEL_ASSET = FEE_JUICE.asset as `0x${string}`
export const FUEL_ASSET_HANDLER = FEE_JUICE.feeAssetHandler as `0x${string}` | undefined
export const FUEL_MIN_FJ = BigInt(FEE_JUICE.minFj)
export const PRIVATE_FPC = MANIFEST.privateFpc

/** Every send binds to this; undefined on a placeholder network and on a generation without a deposit router,
 *  which this app cannot send through. */
export const SEND_GENERATION: SendGeneration | undefined = GENERATION?.l1.depositRouter ? sendGenerationOf(MANIFEST, GENERATION) : undefined
export const HUB: AztecAddress | undefined = GENERATION ? AztecAddress.fromStringUnsafe(GENERATION.l2.hub.address) : undefined
export const TOKEN_CLASS_ID: string | undefined = GENERATION?.l2.tokenClassId
export const MANIFEST_TOKENS: readonly ManifestToken[] = GENERATION?.tokens ?? []
type FuelBudgets = Pick<NonNullable<BridgeBlock["l1"]["fuel"]>, "slippageBps" | "minFuelFj" | "fjPerTx" | "fjRegister">

/** The gas-share budgets; undefined on a generation without a deposit router. */
export const FUEL: FuelBudgets | undefined = GENERATION?.l1.fuel
/** Routers whose deposits still reconcile; no send uses them. */
export const LEGACY_ROUTERS: readonly `0x${string}`[] = GENERATION ? legacyRoutersOf(GENERATION) : []

/** The generation's hub instance, re-derived from its record so the registered instance is never a carried value. */
export async function rebuildHubInstance(): Promise<ContractInstanceWithAddress> {
	if (!GENERATION) throw new Error("no bridge on this network")
	const instance = await deriveManifestHub(GENERATION)
	if (instance.address.toString().toLowerCase() !== GENERATION.l2.hub.address.toLowerCase()) {
		throw new Error(`hub ${GENERATION.l2.hub.address} is not the instantiation of its manifest record`)
	}
	return instance
}

/** The L2 Token the hub derives for an ERC-20 from its attested words — the instance a wallet registers. */
export async function rebuildHubTokenInstance(erc20: string, words: HubTokenWords): Promise<ContractInstanceWithAddress> {
	if (!HUB || !TOKEN_CLASS_ID) throw new Error("no bridge on this network")
	return deriveHubTokenInstance(HUB, erc20, words, TOKEN_CLASS_ID)
}

export const HUB_ARTIFACT = tokenBridgeHubArtifact
export const HUB_TOKEN_ARTIFACT = TokenContractArtifact
