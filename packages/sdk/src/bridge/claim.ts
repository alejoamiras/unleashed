/**
 * Claims a token deposit, with or without gas, through the hub, registering the token first when the hub does not
 * know it. A resumed call reads what the record holds: no deposit hash or leaves, it recovers them; a claim hash, it
 * watches that claim; a registration the hub does not show yet, it reads that registration's fate before sending.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import type { Address } from "viem"
import { BridgeError, isUserRejection } from "../errors.ts"
import { classifyClaimReceipt, isWellFormedTxHash } from "../execution/claim-receipt.ts"
import {
	type AztecSigner,
	asClaimError,
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
import { isPrivateFuelInsufficiency } from "../execution/fuel-claim-state.ts"
import { sendStandaloneFjClaim } from "../execution/fuel-settlement.ts"
import { type Registration, readRegistration } from "../execution/factory-registry.ts"
import { claimViaHub, type HubClaimParams, hubAt, hubTokenFor, probeHubClaim, type SendOpts } from "../execution/hub-l2.ts"
import { isMsgNotReady } from "../execution/message-errors.ts"
import { hubMessageState, type TokenMessageState } from "../execution/message-nullifier.ts"
import type { Network, Reads, TokenRoute } from "../network.ts"
import { deriveHubTokenInstance } from "../protocol/hub-token.ts"
import type { DepositFuelBlock, DepositRecord, JournalTokenBlock } from "../records.ts"
import { untilAborted } from "../run.ts"

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
 * elsewhere could otherwise aim the claim, or a registration, at another token. Returns the block with the frozen
 * register key and index a first claim registers with, persisted when the record lacked them.
 */
async function frozenTokenBlock(leg: ClaimLeg, bridge: TokenRoute): Promise<JournalTokenBlock> {
	const token = tokenOf(leg)
	const reg = await registrationOf(leg, bridge, token.erc20)
	if (!reg || !same(reg.portal, token.portal)) throw refused("the record's token has no portal on this network")
	const words = same(reg.nameWord, token.nameWord) && same(reg.symbolWord, token.symbolWord) && reg.decimals === token.decimals
	const keyed =
		(token.registerKey === undefined || same(reg.registerKey, token.registerKey)) &&
		(token.registerIndex === undefined || reg.registerIndex.toString() === token.registerIndex)
	if (!words || !keyed) throw refused("the record's token no longer matches its registration on Ethereum")
	const hub = AztecAddress.fromStringUnsafe(bridge.hub)
	const derived = await deriveHubTokenInstance(hub, token.erc20, reg, bridge.tokenClassId)
	if (!same(derived.address.toString(), token.l2Token)) throw refused("the record names an Aztec token the hub does not derive")
	if (token.registerKey !== undefined && token.registerIndex !== undefined) return token
	const frozen = { ...token, registerKey: reg.registerKey, registerIndex: reg.registerIndex.toString() }
	await persistClaim(leg, { token: frozen } as Partial<DepositRecord>)
	return frozen
}

/** The claim's arguments. A private claim spends the claim salt only the caller's `secrets` hold. */
function claimParamsOf(leg: ClaimLeg, token: JournalTokenBlock): HubClaimParams {
	const { record, run, aztec } = leg
	const claimValue = record.isPrivate ? run.secrets?.claimSalt : record.secret ? Fr.fromString(record.secret) : undefined
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

/** A public claim that paid from held gas left the bridged Fee Juice unspent, for a claim of its own. */
const fuelLeftOver = (rec: DepositRecord) =>
	!rec.isPrivate && !!rec.fuel?.leafIndex && !rec.fuel.consumed && !rec.fuel.standaloneClaimed && rec.fuel.claimTxHash === undefined

/** The token landed: the gas it bridged is claimed too before the record settles, so no record completes with Fee
 *  Juice nobody claimed. */
async function landed(leg: ClaimLeg, via: ClaimOutcome["via"], txHash?: string): Promise<ClaimOutcome> {
	if (fuelLeftOver(leg.record)) {
		const { aztec, record } = leg
		await sendStandaloneFjClaim(ladderEnvOf(leg), aztec.wallet, aztec.account, record.fuel as DepositFuelBlock, record.id)
	}
	await leg.persisted
	return settle(leg, via, txHash)
}

/** Watches the claim the record already sent. Undefined once it dropped: the message is unspent. */
async function resumeSentClaim(leg: ClaimLeg): Promise<ClaimOutcome | undefined> {
	const txHash = leg.record.claimTxHash
	if (txHash === undefined) return undefined
	if (!isWellFormedTxHash(txHash)) throw refused("the record's claim hash is malformed")
	return afterSend(leg, txHash, await watchClaim(leg, txHash), "resumed")
}

/** A reverted claim spent its fee but not its message; a dropped one spent neither. Either way the hash is cleared
 *  so the next call claims again. */
async function afterSend(
	leg: ClaimLeg,
	txHash: string,
	fate: Awaited<ReturnType<typeof watchClaim>>,
	how: "resumed" | "sent",
): Promise<ClaimOutcome | undefined> {
	if (fate === "success") return landed(leg, "claim", txHash)
	await persistClaim(leg, { claimTxHash: undefined })
	if (fate === "reverted") throw new BridgeError("claim-reverted", `the claim ${txHash} reverted; claim again`, SUBMITTED, "safe")
	if (how === "resumed") return undefined
	throw new BridgeError("claim-not-visible", `the claim ${txHash} was dropped; claim again`, SUBMITTED, "safe")
}

function tokenState(leg: ClaimLeg, p: HubClaimParams): Promise<TokenMessageState> {
	const nullified = async (n: Fr) => (await leg.r.aztecNode.getNullifierMembershipWitness("checkpointed", n)) !== undefined
	return hubMessageState(leg.record, { secretHex: p.claimValue.toString() }, { rollupVersion: leg.net.rollupVersion }, nullified)
}

/** The seams that persist each latch the fee owes before the wallet is asked, and report the registration once its
 *  hash is stored. The fuel latches against whichever transaction spends it. */
function hubSeams(leg: ClaimLeg, fee: OptsFee) {
	let registeredHere = false
	const fuelOnRegistration = () => registeredHere && fee.fuelOnRegister === true
	const seams: SendOpts = {
		receiptOf: (txHash) => leg.r.aztecNode.getTxReceipt(TxHash.fromString(txHash)),
		registrationWait: { sleep: (ms) => wait(leg, ms) },
		onRegisterSend: async () => {
			if (fee.fuelOnRegister) fee.onAttempt?.()
			await leg.persisted
		},
		onRegistered: async (txHash: string) => {
			registeredHere = true
			if (fee.fuelOnRegister && fee.onRegistered) fee.onRegistered(txHash)
			else persistClaim(leg, { registerTxHash: txHash })
			await leg.persisted
			leg.emit({ type: "registration-sent", txHash })
		},
		onClaimSend: async () => {
			if (!fuelOnRegistration()) fee.onAttempt?.()
			await leg.persisted
		},
	}
	return { seams, fuelOnRegistration }
}

/** A send that failed before its claim existed. A refused prompt sent nothing, so its fuel latch is lifted. */
async function failedSend(leg: ClaimLeg, e: unknown): Promise<unknown> {
	if (e instanceof BridgeError || e instanceof FeeStopError) return e
	const msg = messageOf(e)
	if (isUserRejection(e)) {
		const fuel = leg.record.fuel
		if (fuel?.claimAttempt && fuel.claimTxHash === undefined) patchFuel(ladderEnvOf(leg), leg.record.id, fuel, { claimAttempt: false })
		await leg.persisted
		return new BridgeError("user-rejected", "the claim was refused", SUBMITTED, "safe", { cause: e })
	}
	const registration = /registration \S+ (was dropped|reverted)/.exec(msg)
	if (registration) {
		await persistClaim(leg, { registerTxHash: undefined })
		const code = registration[1] === "reverted" ? "registration-reverted" : "registration-dropped"
		return new BridgeError(code, msg, SUBMITTED, "safe", { cause: e })
	}
	if (isPrivateFuelInsufficiency(msg) || isMsgNotReady(msg))
		return new BridgeError("message-timeout", `the claim was refused before it was sent: ${msg}`, SUBMITTED, "after-wait", { cause: e })
	return new BridgeError("claim-not-visible", `the claim may have been sent: ${msg}`, SUBMITTED, "after-wait", { cause: e })
}

async function sendClaim(leg: ClaimLeg, hub: ContractBase, p: HubClaimParams, fee: OptsFee): Promise<ClaimOutcome> {
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
	leg.emit({ type: "claim-sent", txHash, payer: fuelPaid ? "fuel" : leg.record.isPrivate ? "fpc-credit" : "own-gas" })
	return (await afterSend(leg, txHash, await watchClaim(leg, txHash), "sent")) as ClaimOutcome
}

async function claimHub(leg: ClaimLeg, bridge: TokenRoute): Promise<ClaimOutcome> {
	await ensureDepositFacts(leg)
	const token = await frozenTokenBlock(leg, bridge)
	const resumed = await resumeSentClaim(leg)
	if (resumed) return resumed
	const { aztec, run, record } = leg
	const p = claimParamsOf(leg, token)
	const hub = hubAt(aztec.wallet, bridge.hub)
	const bound = (await hubTokenFor(hub, token.erc20, p.from)) !== undefined
	await resumeRegistration(leg, bound)
	const fee = await resolveHubClaimSendOpts(ladderEnvOf(leg), {
		rec: record,
		recipientAddr: aztec.account,
		aztec: aztec.wallet,
		userOverride: false,
		sealedSalt: run.secrets?.fuelSalt?.toString(),
		registers: !bound,
	})
	if (fee.kind === "stop") throw new FeeStopError(fee.stop)
	const hashes = [leg.record.messageHash, leg.record.fuel?.messageHash].filter((h): h is string => !!h)
	const probe = () => probeHubClaim(hub, p, fee.opts, aztec.wallet)
	const ready = await awaitClaimable(leg, hashes, probe, () => tokenState(leg, p))
	if (ready === "claimed-elsewhere") return landed(leg, "claimed-elsewhere")
	return sendClaim(leg, hub, p, fee)
}

/**
 * Claims a token deposit made by `depositToken` for the account the deposit names, registering the token on its first
 * claim. Persists through `run.persist` before every wallet prompt and before every event that names a new fact; a
 * private claim needs `run.secrets.claimSalt`, and its gas `run.secrets.fuelSalt`. A public claim that paid from held
 * gas also claims the gas it bridged before it settles. Throws `BridgeError`: `fee-stop` (with its `stop`) when no fee
 * source can pay now, `claim-not-visible` when an earlier send may still land.
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
