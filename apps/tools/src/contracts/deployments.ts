import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { FaucetSymbol } from "@unleashed/bridge-core"
import { type DeploymentsJson, rebuildDripperInstanceFrom, rebuildTokenInstanceFrom, type TokenDeployment } from "./deployment-records"
import deploymentsJson from "./deployments.json"

export {
	type DeploymentsJson,
	type DripperDeployment,
	rebuildDripperInstanceFrom,
	rebuildTokenInstanceFrom,
	type TokenDeployment,
} from "./deployment-records"

/*
 * deployments.json is DEPLOY METADATA, not a registerable ContractInstance.
 * `wallet.registerContract` needs the full instance with publicKeys + the
 * derived address - we reconstruct each one here via
 * `getContractInstanceFromInstantiationParams` (matches what the deploy
 * script does on its side, so addresses agree by construction).
 *
 * Tokens are looked up by `constructorArgs.symbol` - the deploy script writes
 * an array; we never rely on its order.
 */

const data = deploymentsJson as DeploymentsJson

function findToken(symbol: FaucetSymbol): TokenDeployment {
	const t = data.tokens.find((t) => t.constructorArgs.symbol === symbol)
	if (!t) throw new Error(`deployments.json missing token: ${symbol}`)
	return t
}

const SIGNAL_RECORD = findToken("SIGNAL")
const NOISE_RECORD = findToken("NOISE")

export const DRIPPER = AztecAddress.fromStringUnsafe(data.dripper.address)
export const SIGNAL = AztecAddress.fromStringUnsafe(SIGNAL_RECORD.address)
export const NOISE = AztecAddress.fromStringUnsafe(NOISE_RECORD.address)

export const DEPLOYMENT_RECORDS = {
	dripper: data.dripper,
	signal: SIGNAL_RECORD,
	noise: NOISE_RECORD,
} as const

type ReconstructedInstance = Awaited<ReturnType<typeof rebuildDripperInstanceFrom>>

export async function rebuildDripperInstance(): Promise<ReconstructedInstance> {
	return rebuildDripperInstanceFrom(data.dripper)
}

export async function rebuildSignalInstance(): Promise<ReconstructedInstance> {
	return rebuildTokenInstanceFrom(SIGNAL_RECORD)
}

export async function rebuildNoiseInstance(): Promise<ReconstructedInstance> {
	return rebuildTokenInstanceFrom(NOISE_RECORD)
}
