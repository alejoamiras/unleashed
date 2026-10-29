/**
 * The claim of a record's own Fee Juice message: public Fee Juice paying for its own claim, or private credit at the
 * network's PrivateFPC. It latches the attempt before the wallet is asked and stores the hash once the wallet answers,
 * so a resumed call watches a sent claim, waits out a latched one until its nullifier or its age settles it, and sends
 * again only once nothing it sent can still land. It persists the block consumed and leaves settling to its caller.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { BridgeError, isUserRejection } from "../errors.ts"
import { isWellFormedTxHash } from "./claim-receipt.ts"
import { asBridgeError, assertMayPrompt, awaitClaimable, type ClaimLeg, type ClaimOutcome, persistClaim, watchClaim } from "./claim-run.ts"
import { FeeStopError } from "./fee-stop.ts"
import { buildFuelClaimInteraction, type FuelClaimInteraction } from "./fuel-claim.ts"
import { isPrivateFuelInsufficiency, PRIVATE_ATTEMPT_STALE_MS } from "./fuel-claim-state.ts"
import { fuelReceiptStatus } from "./fuel-settlement.ts"
import { isMsgNotReady } from "./message-errors.ts"
import { consumedMessageNullifier, type TokenMessageState } from "./message-nullifier.ts"
import { walletMaxFees } from "./wallet-fee-budget.ts"
import { feeJuiceAddress } from "../protocol/fee-juice.ts"
import { deriveBridgeSecret, PRIVATE_HUB_CLAIM_GAS } from "../protocol/private-fuel.ts"
import type { DepositFuelBlock } from "../records.ts"
import { checkAbort } from "../run.ts"

const SUBMITTED = "submitted" as const

const fuelOf = (leg: ClaimLeg): DepositFuelBlock => leg.record.fuel as DepositFuelBlock
const patchFuel = (leg: ClaimLeg, patch: Partial<DepositFuelBlock>) => persistClaim(leg, { fuel: { ...fuelOf(leg), ...patch } })
const gasOnly = (leg: ClaimLeg) => leg.record.intent === "gas"

/** A gas-only claim's hash lives at the top level, as a token claim's does, and in the fuel block the ladder reads. */
function storeClaimHash(leg: ClaimLeg, txHash: string | undefined): Promise<void> {
	const fuel = { ...fuelOf(leg), claimTxHash: txHash, ...(txHash === undefined ? { claimAttempt: false } : {}) }
	return persistClaim(leg, gasOnly(leg) ? { claimTxHash: txHash, fuel } : { fuel })
}

const dropped = (txHash: string) => new BridgeError("claim-dropped", `the claim ${txHash} was dropped; claim again`, SUBMITTED, "safe")

/** The secret the Fee Juice message is consumed with: the plaintext of a public leg, the claimer-bound derivation of
 *  a private one's salt. Undefined when the caller holds neither. */
function fuelSecretOf(leg: ClaimLeg): Fr | undefined {
	const fuel = fuelOf(leg)
	if (!leg.record.isPrivate) return fuel.secret ? Fr.fromString(fuel.secret) : undefined
	const salt = leg.run.secrets?.fuelSalt ?? (fuel.bridgeSecretSalt ? Fr.fromString(fuel.bridgeSecretSalt) : undefined)
	return salt && deriveBridgeSecret(salt, leg.aztec.account)
}

/** Whether the Fee Juice message's nullifier is checkpointed: consumed by some claim, ours or another's. */
export async function fuelNullifierState(leg: ClaimLeg): Promise<TokenMessageState> {
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

/** How the record's Fee Juice landed. */
export interface FuelLanding {
	via: ClaimOutcome["via"]
	txHash?: string
}

async function landed(leg: ClaimLeg, via: FuelLanding["via"], txHash?: string): Promise<FuelLanding> {
	await patchFuel(leg, { consumed: true })
	return { via, ...(txHash ? { txHash } : {}) }
}

/** Watches the claim the record already sent: a gas-only record's top-level hash, a token + gas record's gas hash. One
 *  that dropped is cleared and reported, never sent again in the same call. */
async function resumeSentClaim(leg: ClaimLeg): Promise<FuelLanding | undefined> {
	const txHash = gasOnly(leg) ? leg.record.claimTxHash : fuelOf(leg).claimTxHash
	if (txHash === undefined) return gasOnly(leg) ? readLatchedHash(leg) : undefined
	if (!isWellFormedTxHash(txHash)) throw asBridgeError(new FeeStopError("malformed-claim-hash"))
	const fate = await watchClaim(leg, txHash, "gas", () => fuelNullifierState(leg))
	// A mined claim of ours spent the message in its setup, whatever its execution result; a reverted transaction whose
	// message is still live spent nothing, so the hash was never this record's claim.
	if (fate === "success" || (fate === "reverted" && (await fuelNullifierState(leg)) !== "live")) return landed(leg, "claim", txHash)
	await storeClaimHash(leg, undefined)
	if (fate === "dropped") throw dropped(txHash)
	throw new BridgeError("claim-reverted", `the transaction ${txHash} spent none of this gas; claim again`, SUBMITTED, "safe")
}

/** A gas-only fuel block hash with no top-level one: a writer latched it and then lost, or cleared after a drop, the
 *  top-level copy. Its receipt is read as the ladder reads a prior attempt: landed or pending stops, dropped is lifted. */
async function readLatchedHash(leg: ClaimLeg): Promise<undefined> {
	const txHash = fuelOf(leg).claimTxHash
	if (txHash === undefined) return undefined
	if (!isWellFormedTxHash(txHash)) throw asBridgeError(new FeeStopError("malformed-claim-hash"))
	const status = await fuelReceiptStatus({ node: leg.r.aztecNode }, txHash)
	if (status === "included") throw asBridgeError(new FeeStopError("fuel-already-claimed"))
	if (status === "pending") throw asBridgeError(new FeeStopError("fuel-claim-pending"))
	await storeClaimHash(leg, undefined)
	return undefined
}

/** A latched attempt that never recorded its hash may still land; until it ages out only its nullifier settles it. */
async function settleOrRefuseInFlight(leg: ClaimLeg): Promise<FuelLanding | undefined> {
	const fuel = fuelOf(leg)
	if (!fuel.claimAttempt || fuel.setupInsufficiency) return undefined
	if ((await fuelNullifierState(leg)) === "nullified") return landed(leg, "claim")
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
async function sendClaim(leg: ClaimLeg, interaction: FuelClaimInteraction): Promise<FuelLanding> {
	checkAbort(leg.run, SUBMITTED)
	const attemptAt = Date.now()
	await patchFuel(leg, { claimAttempt: true, claimAttemptAt: attemptAt, setupInsufficiency: false })
	leg.emit({ type: "claim-requested", leg: "gas" })
	let txHash: string
	try {
		txHash = (await interaction.send()).txHash
	} catch (e) {
		throw await failedSend(leg, e)
	}
	await storeClaimHash(leg, txHash)
	leg.emit({ type: "claim-sent", leg: "gas", txHash, payer: "fuel" })
	if ((await watchClaim(leg, txHash, "gas")) !== "dropped") return landed(leg, "claim", txHash)
	await storeClaimHash(leg, undefined)
	throw dropped(txHash)
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

/**
 * Claims the record's Fee Juice, resuming whatever the record holds. `gated` waits out the arrival gates first; a
 * caller that already saw the deposit's messages land passes false.
 */
export async function claimFuelBlock(leg: ClaimLeg, opts: { gated: boolean }): Promise<FuelLanding> {
	const resumed = (await resumeSentClaim(leg)) ?? (await settleOrRefuseInFlight(leg))
	if (resumed) return resumed
	assertMayPrompt(leg, "claiming the bridged gas")
	const interaction = await buildClaim(leg)
	if (opts.gated) {
		const hashes = [fuelOf(leg).messageHash].filter((h): h is string => !!h)
		const ready = await awaitClaimable(
			leg,
			hashes,
			() => simulateOrStop(interaction),
			() => fuelNullifierState(leg),
		)
		if (ready === "claimed-elsewhere") return landed(leg, "claimed-elsewhere")
	}
	return sendClaim(leg, interaction)
}

/** A claim paid from held gas, or a token another submitter claimed, leaves the bridged Fee Juice unspent. The
 *  message's nullifier says whether any landed transaction spent it; if none did, it is claimed on its own (public Fee
 *  Juice, or private credit at the PrivateFPC). `claim: false` only records what the landed token claim spent. */
export async function claimBridgedGas(leg: ClaimLeg, opts: { claim: boolean }): Promise<void> {
	const fuel = leg.record.fuel
	if (!fuel?.leafIndex || fuel.consumed || fuel.standaloneClaimed) return
	// The landed claim paid its fee from this gas: an included transaction's setup spent the message.
	if (fuel.claimTxHash !== undefined && fuel.claimTxHash === leg.record.claimTxHash)
		return persistClaim(leg, { fuel: { ...fuel, consumed: true } })
	if (!opts.claim) return
	// A private message is spent with the claimer-bound derivation of its salt, which only the caller holds.
	if (leg.record.isPrivate && !leg.run.secrets?.fuelSalt && !fuel.bridgeSecretSalt)
		throw new BridgeError("invalid-request", "claiming the bridged private gas needs secrets.fuelSalt", SUBMITTED, "safe")
	const state = await fuelNullifierState(leg)
	if (state === "nullified") return persistClaim(leg, { fuel: { ...fuel, consumed: true } })
	if (state !== "live")
		throw new BridgeError("read-failed", "could not read whether the bridged gas was claimed", SUBMITTED, "after-wait")
	await claimFuelBlock(leg, { gated: false })
}
