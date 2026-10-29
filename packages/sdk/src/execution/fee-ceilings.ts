/**
 * The Fee Juice a private claim forfeits before any of it reaches the claimer: the PrivateFPC keeps each
 * transaction's `gasLimits · maxFeesPerGas` in full and refunds nothing. A gas slice whose floor cannot cover it
 * would cross only for the claim to refuse it after the deposit is irreversible.
 */
import { refusal } from "../errors.ts"
import type { Reads } from "../network.ts"
import { predictedWorstMinFees } from "../protocol/fee-juice.ts"
import {
	type HubGas,
	PRIVATE_FUEL_CLAIM_GAS,
	PRIVATE_HUB_CLAIM_GAS,
	PRIVATE_HUB_REGISTER_GAS,
	privateFpcFeeLimit,
} from "../protocol/private-fuel.ts"
import { clampGas, type MaxFees, readNetworkMax } from "./wallet-fee-budget.ts"

export type { MaxFees }

/** The fees a ceiling is priced at: the caller's (its wallet's) when given, else the node's worst prediction. */
export async function maxFeesOf(r: Reads, given?: MaxFees): Promise<MaxFees> {
	if (given) return given
	try {
		const f = await predictedWorstMinFees(r.aztecNode as never)
		return { feePerDaGas: f.feePerDaGas, feePerL2Gas: f.feePerL2Gas }
	} catch (e) {
		throw refusal("read-failed", "could not read Aztec's network fees to size a private claim", "after-wait", e)
	}
}

/** Limits above the network's per-transaction maximum are refused at submission, so a ceiling is priced clamped. */
async function clamped(r: Reads, txs: readonly HubGas[]): Promise<HubGas[]> {
	await readNetworkMax(r.aztecNode)
	return txs.map((g) => clampGas(r.aztecNode, g))
}

/** A private hub claim's ceilings: the claim's, plus a registration's for a token the hub does not know yet. */
export async function privateHubCeilings(r: Reads, registers: boolean, fees: MaxFees): Promise<bigint> {
	const txs = await clamped(r, registers ? [PRIVATE_HUB_CLAIM_GAS, PRIVATE_HUB_REGISTER_GAS] : [PRIVATE_HUB_CLAIM_GAS])
	return txs.reduce((sum, g) => sum + privateFpcFeeLimit(g, fees), 0n)
}

/** A gas-only deposit's standalone private claim ceiling. */
export async function privateFuelCeiling(r: Reads, fees: MaxFees): Promise<bigint> {
	const [g] = await clamped(r, [PRIVATE_FUEL_CLAIM_GAS])
	return privateFpcFeeLimit(g ?? PRIVATE_FUEL_CLAIM_GAS, fees)
}
