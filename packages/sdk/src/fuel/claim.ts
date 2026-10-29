/**
 * Claims a gas-only deposit's Fee Juice on Aztec: public Fee Juice paying for its own claim, or private credit at the
 * network's PrivateFPC. A resumed call reads what the record holds: no deposit hash, it finds the deposit; no leaves,
 * it reads the receipt; a claim hash, it watches that claim and sends again only once it dropped.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { BridgeError, isUserRejection } from "../errors.ts"
import { isWellFormedTxHash } from "../execution/claim-receipt.ts"
import {
	type AztecSigner,
	asBridgeError,
	asClaimError,
	awaitClaimable,
	type ClaimLeg,
	type ClaimOptions,
	type ClaimOutcome,
	ensureDepositFacts,
	openClaim,
	persistClaim,
	settle,
	settledAlready,
	watchClaim,
} from "../execution/claim-run.ts"
import { FeeStopError } from "../execution/fee-stop.ts"
import { buildFuelClaimInteraction, type FuelClaimInteraction } from "../execution/fuel-claim.ts"
import { isPrivateFuelInsufficiency, PRIVATE_ATTEMPT_STALE_MS } from "../execution/fuel-claim-state.ts"
import { isMsgNotReady } from "../execution/message-errors.ts"
import { consumedMessageNullifier, type TokenMessageState } from "../execution/message-nullifier.ts"
import { walletMaxFees } from "../execution/wallet-fee-budget.ts"
import type { Network, Reads } from "../network.ts"
import { feeJuiceAddress } from "../protocol/fee-juice.ts"
import { deriveBridgeSecret, PRIVATE_HUB_CLAIM_GAS } from "../protocol/private-fuel.ts"
import type { DepositFuelBlock, DepositRecord } from "../records.ts"

const SUBMITTED = "submitted" as const

const fuelOf = (leg: ClaimLeg): DepositFuelBlock => leg.record.fuel as DepositFuelBlock
const patchFuel = (leg: ClaimLeg, patch: Partial<DepositFuelBlock>) => persistClaim(leg, { fuel: { ...fuelOf(leg), ...patch } })

/** The secret the Fee Juice message is consumed with: the plaintext of a public leg, the claimer-bound derivation of
 *  a private one's salt. Undefined when the caller holds neither. */
function fuelSecretOf(leg: ClaimLeg): Fr | undefined {
	const fuel = fuelOf(leg)
	if (!leg.record.isPrivate) return fuel.secret ? Fr.fromString(fuel.secret) : undefined
	const salt = leg.run.secrets?.fuelSalt ?? (fuel.bridgeSecretSalt ? Fr.fromString(fuel.bridgeSecretSalt) : undefined)
	return salt && deriveBridgeSecret(salt, leg.aztec.account)
}

/** Whether the Fee Juice message's nullifier is checkpointed: consumed by some claim, ours or another's. */
async function nullifierState(leg: ClaimLeg): Promise<TokenMessageState> {
	const { messageHash } = fuelOf(leg)
	const secret = fuelSecretOf(leg)
	if (!messageHash || !secret) return "unknown"
	try {
		const nullifier = await consumedMessageNullifier(feeJuiceAddress, Fr.fromString(messageHash), secret)
		const witness = await leg.r.aztecNode.getNullifierMembershipWitness("checkpointed", nullifier)
		return witness === undefined ? "live" : "nullified"
	} catch {
		return "unknown"
	}
}

async function landed(leg: ClaimLeg, via: ClaimOutcome["via"], txHash?: string): Promise<ClaimOutcome> {
	await patchFuel(leg, { consumed: true })
	return settle(leg, via, txHash)
}

/** Watches the claim the record already sent. Undefined once it dropped: the message is unspent and may be claimed. */
async function resumeSentClaim(leg: ClaimLeg): Promise<ClaimOutcome | undefined> {
	const txHash = fuelOf(leg).claimTxHash
	if (txHash === undefined) return undefined
	if (!isWellFormedTxHash(txHash)) throw asBridgeError(new FeeStopError("malformed-claim-hash"))
	// A mined claim consumed the message in its setup, whatever its execution result.
	if ((await watchClaim(leg, txHash)) !== "dropped") return landed(leg, "claim", txHash)
	await patchFuel(leg, { claimTxHash: undefined, claimAttempt: false })
	return undefined
}

/** A latched attempt that never recorded its hash may still land; until it ages out only its nullifier settles it. */
async function settleOrRefuseInFlight(leg: ClaimLeg): Promise<ClaimOutcome | undefined> {
	const fuel = fuelOf(leg)
	if (!fuel.claimAttempt || fuel.setupInsufficiency) return undefined
	if ((await nullifierState(leg)) === "nullified") return landed(leg, "claim")
	if (fuel.claimAttemptAt === undefined || Date.now() - fuel.claimAttemptAt > PRIVATE_ATTEMPT_STALE_MS) return undefined
	throw new BridgeError("claim-not-visible", "an earlier claim of this gas may still land", SUBMITTED, "after-wait")
}

async function buildClaim(leg: ClaimLeg): Promise<FuelClaimInteraction> {
	const { net, r, aztec, record } = leg
	let maxFeesPerGas: { feePerDaGas: bigint; feePerL2Gas: bigint }
	try {
		maxFeesPerGas = await walletMaxFees(r.aztecNode, aztec.wallet, aztec.account, PRIVATE_HUB_CLAIM_GAS)
	} catch (e) {
		throw asBridgeError(Object.assign(new FeeStopError("unpriced-by-wallet"), { cause: e }))
	}
	return buildFuelClaimInteraction(record, {
		aztec: aztec.wallet,
		node: r.aztecNode,
		privateFpc: net.privateFpc,
		recipient: aztec.account,
		minFloorFj: BigInt(net.manifest.feeJuice.minFj),
		maxFeesPerGas,
		resolvedSalt: leg.run.secrets?.fuelSalt?.toString(),
	})
}

/** Latches the attempt, sends, persists the hash, then reports and watches it. */
async function sendClaim(leg: ClaimLeg, interaction: FuelClaimInteraction): Promise<ClaimOutcome> {
	const attemptAt = Date.now()
	await patchFuel(leg, { claimAttempt: true, claimAttemptAt: attemptAt, setupInsufficiency: false })
	let txHash: string
	try {
		txHash = (await interaction.send()).txHash
	} catch (e) {
		throw await failedSend(leg, e)
	}
	await patchFuel(leg, { claimTxHash: txHash })
	leg.emit({ type: "claim-sent", txHash, payer: "fuel" })
	if ((await watchClaim(leg, txHash)) !== "dropped") return landed(leg, "claim", txHash)
	await patchFuel(leg, { claimTxHash: undefined, claimAttempt: false })
	throw new BridgeError("claim-not-visible", `the claim ${txHash} was dropped; claim again`, SUBMITTED, "safe")
}

/** A send that failed before any transaction existed clears its latch; one that may have reached the wallet's
 *  network keeps it, so a resume waits for it rather than sending twice. */
async function failedSend(leg: ClaimLeg, e: unknown): Promise<unknown> {
	const msg = e instanceof Error ? e.message : String(e)
	if (e instanceof FeeStopError || isUserRejection(e)) {
		await patchFuel(leg, { claimAttempt: false })
		return isUserRejection(e)
			? new BridgeError("user-rejected", "the claim was refused", SUBMITTED, "safe", { cause: e })
			: asBridgeError(e)
	}
	if (isPrivateFuelInsufficiency(msg) || isMsgNotReady(msg)) {
		await patchFuel(leg, { setupInsufficiency: true })
		return new BridgeError("message-timeout", `the claim was refused before it was sent: ${msg}`, SUBMITTED, "after-wait", { cause: e })
	}
	return new BridgeError("claim-not-visible", `the claim may have been sent: ${msg}`, SUBMITTED, "after-wait", { cause: e })
}

/** The PrivateFPC refuses a claim whose Fee Juice cannot cover its own fee: no wait changes that amount. */
async function simulateOrStop(interaction: FuelClaimInteraction): Promise<unknown> {
	try {
		return await interaction.simulate()
	} catch (e) {
		if (isPrivateFuelInsufficiency(e instanceof Error ? e.message : String(e))) throw new FeeStopError("fuel-short")
		throw e
	}
}

async function claimGas(leg: ClaimLeg): Promise<ClaimOutcome> {
	if (fuelOf(leg).consumed || fuelOf(leg).standaloneClaimed) return settle(leg, "claim", fuelOf(leg).claimTxHash)
	await ensureDepositFacts(leg)
	const resumed = (await resumeSentClaim(leg)) ?? (await settleOrRefuseInFlight(leg))
	if (resumed) return resumed
	const interaction = await buildClaim(leg)
	const hashes = [fuelOf(leg).messageHash].filter((h): h is string => !!h)
	const ready = await awaitClaimable(
		leg,
		hashes,
		() => simulateOrStop(interaction),
		() => nullifierState(leg),
	)
	if (ready === "claimed-elsewhere") return landed(leg, "claimed-elsewhere")
	return sendClaim(leg, interaction)
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
