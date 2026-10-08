/** The manifest the sandbox ships to its consumers, and the artifacts directory a run writes. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BridgeBlock, ManifestToken, ManifestV2 } from "../../src/manifest-v2"
import { walletChainIdOf } from "../../src/wallet-chain-id"
import type { GenerationRecord } from "../generation"
import { CHAIN_ID, MIN_FJ } from "./constants"
import type { L1Deployment } from "./l1"

export type FuelBlock = NonNullable<BridgeBlock["l1"]["fuel"]>

/** The router's `bridge.l1.fuel` block, the smoke's calibration for this network: the swapper's fixed
 *  rate makes a claim cost ~3.6 FJ of the 40 whole units a fueled send buys, so the budgets never bind. */
export function sandboxFuelBlock(): FuelBlock {
	return {
		slippageBps: 300,
		crossChainSlippageBps: 100,
		minFuelFj: MIN_FJ.toString(),
		fjPerTx: "3577823745897251607",
		fjRegister: "1967429819850912960",
	}
}

/** The `DepositRouter` fields of `bridge.l1`. */
export interface RouterBlock {
	depositRouter: string
	fuelSwapper: string
	fuel: FuelBlock
}

export function buildManifest(
	gen: GenerationRecord,
	deployment: L1Deployment,
	tokens: ManifestToken[],
	rollupVersion: number,
	router: RouterBlock,
): ManifestV2 {
	return {
		schema: 2,
		network: "sandbox",
		l1ChainId: CHAIN_ID,
		walletChainId: walletChainIdOf(CHAIN_ID, rollupVersion),
		bridge: { l1: { ...gen.l1, ...router }, l2: gen.l2, tokens } as BridgeBlock,
		feeJuice: { portal: deployment.feeJuicePortal, asset: deployment.feeJuice, minFj: MIN_FJ.toString() },
		privateClaimMode: "salt-v2",
	}
}

export interface RunArtifacts {
	manifest: ManifestV2
	handle: unknown
	deployments?: unknown
}

export const ARTIFACT_FILES = {
	manifest: "manifest.json",
	handle: "handle.json",
	deployments: "deployments.json",
	/** `{ url }` of the loopback Across API a held sandbox serves; written by `up` only. */
	relayApi: "relay-api.json",
} as const

/** Everything a consumer needs is JSON on disk: a browser build reads the manifest at config time,
 *  a test process reconstructs its clients from the handle. */
export function writeArtifacts(dir: string, a: RunArtifacts): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, ARTIFACT_FILES.manifest), `${JSON.stringify(a.manifest, null, "\t")}\n`)
	writeFileSync(join(dir, ARTIFACT_FILES.handle), `${JSON.stringify(a.handle, null, "\t")}\n`)
	if (a.deployments) writeFileSync(join(dir, ARTIFACT_FILES.deployments), `${JSON.stringify(a.deployments, null, "\t")}\n`)
}
