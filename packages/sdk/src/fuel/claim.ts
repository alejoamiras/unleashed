/**
 * Claims a gas-only deposit's Fee Juice on Aztec: public Fee Juice paying for its own claim, or private credit at the
 * network's PrivateFPC. A resumed call reads what the record holds: no deposit hash, it finds the deposit; no leaves,
 * it reads the receipt; a claim hash, it watches that claim and sends again only once it dropped.
 */
import {
	type AztecSigner,
	asClaimError,
	type ClaimLeg,
	type ClaimOptions,
	type ClaimOutcome,
	ensureDepositFacts,
	openClaim,
	settle,
	settledAlready,
} from "../execution/claim-run.ts"
import { claimFuelBlock } from "../execution/fuel-block-claim.ts"
import type { Network, Reads } from "../network.ts"
import type { DepositRecord } from "../records.ts"

async function claimGas(leg: ClaimLeg): Promise<ClaimOutcome> {
	const fuel = leg.record.fuel
	if (fuel?.consumed || fuel?.standaloneClaimed) return settle(leg, "claim", fuel.claimTxHash)
	await ensureDepositFacts(leg)
	const landing = await claimFuelBlock(leg, { gated: true })
	return settle(leg, landing.via, landing.txHash)
}

/**
 * Claims the Fee Juice of a gas-only deposit made by `depositFuel`, for the account the deposit names. Persists
 * through `run.persist` before every event that names a new fact; a private claim needs `run.secrets.fuelSalt`.
 * Throws `BridgeError`: `fee-stop` (with its `stop`) when the claim cannot pay for itself now, `claim-not-visible`
 * when an earlier send may still land.
 */
export async function claimFuel(net: Network, r: Reads, aztec: AztecSigner, rec: DepositRecord, run: ClaimOptions): Promise<ClaimOutcome> {
	const leg = await openClaim(net, r, aztec, rec, run, "gas")
	const done = settledAlready(leg)
	if (done) return done
	try {
		return await claimGas(leg)
	} catch (e) {
		throw asClaimError(e)
	}
}
