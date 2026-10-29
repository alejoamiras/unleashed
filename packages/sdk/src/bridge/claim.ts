/**
 * Claims a token deposit, with or without gas, through the hub, registering the token first when the hub does not
 * know it. A resumed call reads what the record holds: no deposit hash or leaves, it recovers them; a claim hash, it
 * watches that claim; a registration the hub does not show yet, it reads that registration's fate before sending.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { computeSecretHash } from "@aztec-labs/stdlib/hash"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import type { Address } from "viem"
import { BridgeError, isUserRejection } from "../errors.ts"
import { classifyClaimReceipt, isWellFormedTxHash } from "../execution/claim-receipt.ts"
import {
	type AztecSigner,
	asClaimError,
	assertMayPrompt,
	awaitClaimable,
	type ClaimLeg,
	type ClaimOptions,
	type ClaimOutcome,
	ensureDepositFacts,
	ladderEnvOf,
	openClaim,
	persistClaim,
	settle,
	settledAlready,
	watchClaim,
} from "../execution/claim-run.ts"
import { patchFuel } from "../execution/fee-env.ts"
import { type HubClaimFee, resolveHubClaimSendOpts } from "../execution/fee-ladder.ts"
import { FeeStopError } from "../execution/fee-stop.ts"
import { isPrivateFuelInsufficiency, PRIVATE_ATTEMPT_STALE_MS } from "../execution/fuel-claim-state.ts"
import { claimBridgedGas, fuelNullifierState } from "../execution/fuel-block-claim.ts"
import { type Registration, readRegistration } from "../execution/factory-registry.ts"
import { claimViaHub, type HubClaimParams, hubAt, hubTokenFor, probeHubClaim, type SendOpts } from "../execution/hub-l2.ts"
import { registrationToBlock } from "../execution/send-flow.ts"
import { isMsgNotReady } from "../execution/message-errors.ts"
import { hubMessageState, type TokenMessageState } from "../execution/message-nullifier.ts"
import type { Network, Reads, TokenRoute } from "../network.ts"
import { tokenClaimSecretHash } from "../protocol/claim-secret.ts"
import { deriveHubTokenInstance } from "../protocol/hub-token.ts"
import type { DepositRecord, JournalTokenBlock } from "../records.ts"
import { checkAbort, untilAborted } from "../run.ts"

const SUBMITTED = "submitted" as const
const DROP_STRIKES = 3
const DROP_POLL_MS = 4000

type OptsFee = Extract<HubClaimFee, { kind: "opts" }>

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const tokenOf = (leg: ClaimLeg) => (leg.record as Extract<DepositRecord, { token: JournalTokenBlock }>).token
const wait = (leg: ClaimLeg, ms: number) => untilAborted(new Promise<void>((done) => setTimeout(done, ms)), leg.run, SUBMITTED)

const refused = (message: string) => new BridgeError("invalid-request", message, SUBMITTED, "never")

async function registrationOf(leg: ClaimLeg, bridge: TokenRoute, erc20: string): Promise<Registration | undefined> {
	try {
		return await readRegistration(leg.r.l1 as never, bridge.factory, erc20 as Address)
	} catch (e) {
		throw new BridgeError("read-failed", `could not read the token's registration: ${messageOf(e)}`, SUBMITTED, "after-wait", {
			cause: e,
		})
	}
}

/**
 * The record's token must still be the one the factory froze and the hub derives: a record edited or restored from
 * elsewhere could otherwise aim the claim, or a registration, at another token. A block the deposit never froze (its
 * receipt was not read before a crash) is the quote's prediction; the registration replaces it, as confirmation does.
 */
async function frozenTokenBlock(leg: ClaimLeg, bridge: TokenRoute): Promise<JournalTokenBlock> {
	const token = tokenOf(leg)
	const reg = await registrationOf(leg, bridge, token.erc20)
	if (!reg || !same(reg.portal, token.portal)) throw refused("the record's token has no portal on this network")
	if (token.registerKey === undefined) {
		const frozen = await registrationToBlock(bridge, token.erc20 as Address, reg)
		await persistClaim(leg, { token: frozen } as Partial<DepositRecord>)
		return frozen
	}
	const words = same(reg.nameWord, token.nameWord) && same(reg.symbolWord, token.symbolWord) && reg.decimals === token.decimals
	const keyed =
		same(reg.registerKey, token.registerKey) &&
		(token.registerIndex === undefined || reg.registerIndex.toString() === token.registerIndex)
	if (!words || !keyed) throw refused("the record's token no longer matches its registration on Ethereum")
	const hub = AztecAddress.fromStringUnsafe(bridge.hub)
	const derived = await deriveHubTokenInstance(hub, token.erc20, reg, bridge.tokenClassId)
	if (!same(derived.address.toString(), token.l2Token)) throw refused("the record names an Aztec token the hub does not derive")
	if (token.registerIndex !== undefined) return token
	const indexed = { ...token, registerIndex: reg.registerIndex.toString() }
	await persistClaim(leg, { token: indexed } as Partial<DepositRecord>)
	return indexed
}

/** The claim's arguments. A private claim spends the claim salt only the caller's `secrets` hold. */
/** The token leg's claim value, held to the record's secret hash: another deposit's value would derive a nullifier that
 *  never exists, and its message would read live forever. Undefined when the caller holds none. */
async function claimValueOf(leg: ClaimLeg): Promise<Fr | undefined> {
	const { record, run } = leg
	const value = record.isPrivate ? run.secrets?.claimSalt : record.secret ? Fr.fromString(record.secret) : undefined
	if (!value) return undefined
	const recipient = AztecAddress.fromStringUnsafe(record.recipient)
	const hash = record.isPrivate ? await tokenClaimSecretHash(value, recipient) : await computeSecretHash(value)
	if (!hash.equals(Fr.fromString(record.secretHashHex))) throw refused("the claim value does not derive the record's secret hash")
	return value
}

async function claimParamsOf(leg: ClaimLeg, token: JournalTokenBlock): Promise<HubClaimParams> {
	const { record, aztec } = leg
	const claimValue = await claimValueOf(leg)
	if (!claimValue)
		throw refused(record.isPrivate ? "a private claim needs the deposit's secrets.claimSalt" : "the record holds no claim secret")
	return {
		token,
		recipient: record.recipient,
		amount: BigInt(record.amount),
		claimValue,
		leafIndex: BigInt(record.leafIndex as string),
		isPrivate: record.isPrivate,
		from: aztec.account.toString(),
	}
}

/** A dropped reading is believed only on consecutive polls: a transaction can look unknown just after it was sent. */
async function fateOf(leg: ClaimLeg, txHash: string): Promise<ReturnType<typeof classifyClaimReceipt> | "unknown"> {
	for (let strike = 1; ; strike++) {
		const receipt = await leg.r.aztecNode.getTxReceipt(TxHash.fromString(txHash)).catch(() => undefined)
		const fate = receipt === undefined ? "unknown" : classifyClaimReceipt(receipt as never)
		if (fate !== "dropped" || strike >= DROP_STRIKES) return fate
		await wait(leg, DROP_POLL_MS)
	}
}

/** A registration this record sent that the wallet does not show yet: registering again is safe only once it dropped
 *  or reverted, which left the token unregistered. */
async function resumeRegistration(leg: ClaimLeg, bound: boolean): Promise<void> {
	const txHash = leg.record.registerTxHash
	if (txHash === undefined || bound) return
	if (!isWellFormedTxHash(txHash)) throw refused("the record's registration hash is malformed")
	const fate = await fateOf(leg, txHash)
	if (fate === "dropped" || fate === "reverted") return persistClaim(leg, { registerTxHash: undefined })
	throw new BridgeError("claim-not-visible", `the registration ${txHash} has not reached the wallet yet`, SUBMITTED, "after-wait")
}

/** The tokens landed: who claimed them is recorded first (a landing of ours drops a stale `claimedByOther`), so a gas
 *  claim that then fails still says so. Gas that can never pay for its own claim does not hold the record open: it settles, saying why. Any
 *  other failure of the gas claim names the landed token claim, and the next call claims the gas again. */
async function landed(leg: ClaimLeg, via: ClaimOutcome["via"], txHash?: string): Promise<ClaimOutcome> {
	const byOther = via === "claimed-elsewhere" ? true : undefined
	if (leg.record.claimedByOther !== byOther) await persistClaim(leg, { claimedByOther: byOther })
	leg.emit({ type: "claim-landed", via, ...(txHash ? { txHash } : {}) })
	let gasLeft: BridgeError | undefined
	try {
		await claimBridgedGas(leg, { claim: !leg.run.withoutGas })
	} catch (e) {
		const error = asClaimError(e)
		if (error.retry !== "never") {
			const message = `the tokens landed${txHash ? ` in ${txHash}` : ""}; their bridged gas is not claimed yet: ${error.message}`
			throw new BridgeError(error.code, message, SUBMITTED, error.retry, { cause: e, ...(error.stop ? { stop: error.stop } : {}) })
		}
		gasLeft = error
	}
	await leg.persisted
	return settle(leg, via, txHash, gasLeft)
}

/** A token claim latched without its hash, its message not spent yet: it may still land until it ages past landing.
 *  A claim sent again after that is safe, since the message's nullifier lets only one of them spend it. */
async function settleHashlessClaim(leg: ClaimLeg): Promise<void> {
	const { claimAttempt, claimAttemptAt, claimTxHash } = leg.record
	if (!claimAttempt || claimTxHash !== undefined) return
	if (claimAttemptAt === undefined || Date.now() - claimAttemptAt > PRIVATE_ATTEMPT_STALE_MS)
		return persistClaim(leg, { claimAttempt: false })
	throw new BridgeError("claim-not-visible", "an earlier claim of this deposit may still land", SUBMITTED, "after-wait")
}

/** A fuel attempt latched without its hash may have landed. Its nullifier settles it, so a private claim pays from the
 *  credit a landed one left instead of minting a spent message again. A public latch aged past landing is lifted, so the
 *  ladder never waits on it forever; the private ladder ages its own. */
async function settleHashlessAttempt(leg: ClaimLeg): Promise<void> {
	const fuel = leg.record.fuel
	if (!fuel?.claimAttempt || fuel.claimTxHash !== undefined || fuel.consumed) return
	const state = await fuelNullifierState(leg)
	if (state === "nullified") return persistClaim(leg, { fuel: { ...fuel, consumed: true } })
	if (leg.record.isPrivate) return
	const aged = fuel.claimAttemptAt === undefined || Date.now() - fuel.claimAttemptAt > PRIVATE_ATTEMPT_STALE_MS
	if (state === "live" && aged) return persistClaim(leg, { fuel: { ...fuel, claimAttempt: false } })
}

/** Watches the claim the record already sent, which counts only once its message's nullifier shows. A live reading
 *  drops a `claimedByOther` marker, as before a claim. */
async function resumeSentClaim(leg: ClaimLeg): Promise<ClaimOutcome | undefined> {
	const txHash = leg.record.claimTxHash
	if (txHash === undefined) return undefined
	if (!isWellFormedTxHash(txHash)) throw refused("the record's claim hash is malformed")
	const verify = async () => {
		const state = await tokenStateOf(leg)
		if (state === "live" && leg.record.claimedByOther) await persistClaim(leg, { claimedByOther: undefined })
		return state
	}
	return afterSend(leg, txHash, await watchClaim(leg, txHash, "token", verify))
}

/** A reverted claim spent its fee but not its message; a dropped one spent neither. Either way the hash is cleared
 *  and the next call claims again: a claim is never sent twice in one call. */
async function afterSend(leg: ClaimLeg, txHash: string, fate: Awaited<ReturnType<typeof watchClaim>>): Promise<ClaimOutcome> {
	if (fate === "success") return landed(leg, "claim", txHash)
	await persistClaim(leg, { claimTxHash: undefined, claimAttempt: false })
	if (fate === "reverted") throw new BridgeError("claim-reverted", `the claim ${txHash} reverted; claim again`, SUBMITTED, "safe")
	throw new BridgeError("claim-dropped", `the claim ${txHash} was dropped; claim again`, SUBMITTED, "safe")
}

function tokenState(leg: ClaimLeg, claimValue: Fr): Promise<TokenMessageState> {
	const nullified = async (n: Fr) => (await leg.r.aztecNode.getNullifierMembershipWitness("checkpointed", n)) !== undefined
	return hubMessageState(leg.record, { secretHex: claimValue.toString() }, { rollupVersion: leg.net.rollupVersion }, nullified)
}

/** The token message's state, "unknown" when the caller holds no claim value to derive its nullifier from. */
async function tokenStateOf(leg: ClaimLeg): Promise<TokenMessageState> {
	const claimValue = await claimValueOf(leg)
	return claimValue ? tokenState(leg, claimValue) : "unknown"
}

/** The seams that persist each latch the fee owes before the wallet is asked, and report the registration once its
 *  hash is stored. The fuel latches against whichever transaction spends it. */
function hubSeams(leg: ClaimLeg, fee: OptsFee) {
	let registeredHere = false
	const fuelOnRegistration = () => registeredHere && fee.fuelOnRegister === true
	const seams: SendOpts = {
		receiptOf: (txHash) => leg.r.aztecNode.getTxReceipt(TxHash.fromString(txHash)),
		registrationWait: { sleep: (ms) => wait(leg, ms) },
		// A registration paid from held credit latches like a claim: nothing names it until its hash is stored.
		onRegisterSend: async () => {
			if (fee.fuelOnRegister) fee.onAttempt?.()
			else persistClaim(leg, { claimAttempt: true, claimAttemptAt: Date.now() })
			await leg.persisted
			leg.emit({ type: "registration-requested" })
		},
		onRegistered: async (txHash: string) => {
			registeredHere = true
			if (fee.fuelOnRegister && fee.onRegistered) fee.onRegistered(txHash)
			else persistClaim(leg, { registerTxHash: txHash, claimAttempt: false })
			await leg.persisted
			leg.emit({ type: "registration-sent", txHash })
		},
		onClaimSend: async () => {
			if (!fuelOnRegistration()) fee.onAttempt?.()
			await persistClaim(leg, { claimAttempt: true, claimAttemptAt: Date.now() })
			leg.emit({ type: "claim-requested", leg: "token" })
		},
	}
	return { seams, fuelOnRegistration }
}

/** A send that failed before its claim existed. A refused prompt sent nothing, so its fuel latch is lifted. */
async function failedSend(leg: ClaimLeg, e: unknown): Promise<unknown> {
	// The ladder's failure latch persists without awaiting: its refusal outranks the send's own error.
	await leg.persisted
	if (e instanceof BridgeError) return e
	const msg = messageOf(e)
	if (isUserRejection(e) || e instanceof FeeStopError) {
		const fuel = leg.record.fuel
		if (fuel?.claimAttempt && fuel.claimTxHash === undefined) patchFuel(ladderEnvOf(leg), leg.record.id, fuel, { claimAttempt: false })
		await persistClaim(leg, { claimAttempt: false })
		return isUserRejection(e) ? new BridgeError("user-rejected", "the claim was refused", SUBMITTED, "safe", { cause: e }) : e
	}
	const registration = /registration \S+ (was dropped|reverted)/.exec(msg)
	if (registration) {
		await persistClaim(leg, { registerTxHash: undefined, claimAttempt: false })
		const code = registration[1] === "reverted" ? "registration-reverted" : "registration-dropped"
		return new BridgeError(code, msg, SUBMITTED, "safe", { cause: e })
	}
	if (isPrivateFuelInsufficiency(msg) || isMsgNotReady(msg)) {
		await persistClaim(leg, { claimAttempt: false })
		return new BridgeError("message-timeout", `the claim was refused before it was sent: ${msg}`, SUBMITTED, "after-wait", { cause: e })
	}
	return new BridgeError("claim-not-visible", `the claim may have been sent: ${msg}`, SUBMITTED, "after-wait", { cause: e })
}

async function sendClaim(leg: ClaimLeg, hub: ContractBase, p: HubClaimParams, fee: OptsFee): Promise<ClaimOutcome> {
	checkAbort(leg.run, "submitted")
	const { seams, fuelOnRegistration } = hubSeams(leg, fee)
	let txHash: string
	try {
		txHash = (await claimViaHub(hub, p, { ...fee.opts, ...seams })).claimTxHash
	} catch (e) {
		fee.onFailure?.(e)
		throw await failedSend(leg, e)
	}
	const fuelPaid = !!fee.onTxHash && !fuelOnRegistration()
	if (fuelPaid) fee.onTxHash?.(txHash)
	await persistClaim(leg, { claimTxHash: txHash })
	leg.emit({ type: "claim-sent", leg: "token", txHash, payer: fuelPaid ? "fuel" : leg.record.isPrivate ? "fpc-credit" : "own-gas" })
	return afterSend(leg, txHash, await watchClaim(leg, txHash, "token"))
}

/** Before any fee is chosen: a message already spent needs none, one that is not this record's must not be claimed,
 *  and a marker the chain no longer bears out is dropped. */
async function settleSpentMessage(leg: ClaimLeg, p: HubClaimParams): Promise<ClaimOutcome | undefined> {
	const state = await tokenState(leg, p.claimValue)
	// A claim of ours that never stored its hash, or anyone's, may already have spent the message.
	if (state === "nullified") {
		const ours = leg.record.claimAttempt || leg.record.fuel?.claimAttempt
		return landed(leg, ours && !leg.record.claimedByOther ? "claim" : "claimed-elsewhere")
	}
	if (state === "invalid")
		throw new BridgeError("message-invalid", "the record's message is not the one its facts describe", SUBMITTED, "never")
	if (state === "live" && leg.record.claimedByOther) await persistClaim(leg, { claimedByOther: undefined })
	return undefined
}

async function claimHub(leg: ClaimLeg, bridge: TokenRoute): Promise<ClaimOutcome> {
	await ensureDepositFacts(leg)
	const token = await frozenTokenBlock(leg, bridge)
	const resumed = await resumeSentClaim(leg)
	if (resumed) return resumed
	const { aztec, run } = leg
	const p = await claimParamsOf(leg, token)
	const hub = hubAt(aztec.wallet, bridge.hub)
	const spent = await settleSpentMessage(leg, p)
	if (spent) return spent
	await settleHashlessClaim(leg)
	const bound = (await hubTokenFor(hub, token.erc20, p.from)) !== undefined
	await resumeRegistration(leg, bound)
	await settleHashlessAttempt(leg)
	assertMayPrompt(leg, "the claim")
	// The record as the settling steps above left it, not as the call opened it.
	const fee = await resolveHubClaimSendOpts(ladderEnvOf(leg), {
		rec: leg.record,
		recipientAddr: aztec.account,
		aztec: aztec.wallet,
		userOverride: run.withoutGas === true,
		sealedSalt: run.secrets?.fuelSalt?.toString(),
		registers: !bound,
	})
	if (fee.kind === "stop") throw new FeeStopError(fee.stop)
	const hashes = [leg.record.messageHash, leg.record.fuel?.messageHash].filter((h): h is string => !!h)
	const probe = () => probeHubClaim(hub, p, fee.opts, aztec.wallet)
	const ready = await awaitClaimable(leg, hashes, probe, () => tokenState(leg, p.claimValue))
	if (ready === "claimed-elsewhere") return landed(leg, "claimed-elsewhere")
	return sendClaim(leg, hub, p, fee)
}

/**
 * Claims a token deposit made by `depositToken` for the account the deposit names, registering the token on its first
 * claim. Persists through `run.persist` before every wallet prompt and before every event that names a new fact; a
 * private claim needs `run.secrets.claimSalt`, and its gas `run.secrets.fuelSalt`. Gas the claim left unspent (it paid
 * from held gas, or another submitter claimed the token) is claimed on its own before the record settles. Throws
 * `BridgeError`: `fee-stop` (with its `stop`) when no fee source can pay now, `claim-not-visible` when an earlier send
 * may still land.
 */
export async function claimToken(net: Network, r: Reads, aztec: AztecSigner, rec: DepositRecord, run: ClaimOptions): Promise<ClaimOutcome> {
	const leg = await openClaim(net, r, aztec, rec, run, "token")
	const done = settledAlready(leg)
	if (done) return done
	try {
		return await claimHub(leg, leg.route as TokenRoute)
	} catch (e) {
		throw asClaimError(e)
	}
}
