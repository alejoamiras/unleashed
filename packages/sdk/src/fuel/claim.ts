/**
 * Claims Fee Juice on Aztec: a gas-only deposit's, as public Fee Juice paying for its own claim or private credit at the
 * network's PrivateFPC, or the bridged gas a token + gas deposit left once its tokens are claimed. A resumed call reads
 * what the record holds: no leaves, it recovers them; a claim hash, it watches that claim.
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
import { claimBridgedGas, claimFuelBlock } from "../execution/fuel-block-claim.ts"
import type { Network, Reads } from "../network.ts"
import type { DepositRecord } from "../records.ts"

async function claimGas(leg: ClaimLeg): Promise<ClaimOutcome> {
	const fuel = leg.record.fuel
	if (fuel?.consumed || fuel?.standaloneClaimed) return settle(leg, "claim", fuel.claimTxHash)
	await ensureDepositFacts(leg)
	const landing = await claimFuelBlock(leg, { gated: true })
	return settle(leg, landing.via, landing.txHash)
}

/** The bridged gas of a token + gas record whose tokens are done. Only the fuel block changes: the record's own
 *  completion is its token claim's. */
async function claimGasLeg(leg: ClaimLeg): Promise<ClaimOutcome> {
	await ensureDepositFacts(leg)
	await claimBridgedGas(leg, { claim: true })
	await leg.persisted
	const txHash = leg.record.fuel?.claimTxHash
	return { record: leg.record, via: "claim", ...(txHash ? { txHash } : {}) }
}

/**
 * Claims the Fee Juice of a gas-only deposit made by `depositFuel`, or the bridged gas of a token + gas deposit whose
 * tokens are claimed (`completedAt`) or were claimed by another submitter (`claimedByOther`), for the account the
 * deposit names. Persists through `run.persist` before every event that names a new fact; a private claim needs
 * `run.secrets.fuelSalt`. Throws `BridgeError`: `fee-stop` (with its `stop`) when the claim cannot pay for itself now,
 * `claim-not-visible` when an earlier send may still land, `invalid-request` for a token + gas record whose tokens are
 * not claimed yet.
 */
export async function claimFuel(net: Network, r: Reads, aztec: AztecSigner, rec: DepositRecord, run: ClaimOptions): Promise<ClaimOutcome> {
	const gasOnly = rec.intent === "gas"
	const leg = await openClaim(net, r, aztec, rec, run, gasOnly ? "gas" : "gas-leg")
	const done = gasOnly ? settledAlready(leg) : undefined
	if (done) return done
	try {
		return await (gasOnly ? claimGas(leg) : claimGasLeg(leg))
	} catch (e) {
		throw asClaimError(e)
	}
}
