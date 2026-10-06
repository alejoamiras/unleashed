/**
 * The fueled-claim recovery ladder as a pure decision function.
 *
 * Triggers are RECORD-SPECIFIC ground truth only — never aggregate balances, never
 * inference from simulate-failure (the claim classifier cannot distinguish "message
 * consumed" from "PXE not synced"):
 *  - our own attempt's receipt reading INCLUDED consumes the FJ message (setup phase
 *    is non-revertible, so even an app-reverted claim burned the fuel as fees);
 *  - fee-insufficiency compares two record-local quantities (event-sourced
 *    `fuelReceived` vs the network's current min fee with margin);
 *  - everything ambiguous WAITS, and a persistent-failure threshold only ever
 *    OFFERS a manual, non-destructive "claim without fuel" action to the user.
 */

export type FuelClaimAction =
	| "fjwc" // token claim pays for itself by claiming the fuel in-tx (the default).
	| "own-gas" // fuel is gone (consumed by our included attempt, or user chose to skip it).
	| "own-gas-plus-standalone-fj" // fee spike: the token claim pays from the wallet's own gas AND the FJ is claimed standalone.
	| "wait" // no positive evidence yet - keep waiting; never fall back on ambiguity.

export type FuelReceiptStatus = "included" | "dropped" | "pending"

export interface FuelClaimEvidence {
	/** The journal-first latch: an fjwc-embedded wallet call was invoked for this record. */
	attempt: boolean
	/** Whether the attempt's tx hash was persisted (the wallet returned). */
	txHashKnown: boolean
	/** The attempt tx's receipt state, when a hash is known and probed. */
	receiptStatus?: FuelReceiptStatus
	/** Event-sourced fuelReceived (base units). Undefined while the L1 leg hasn't landed. */
	fuelReceived?: bigint
	/** The network's current minimum claim fee (base units), when known. */
	currentMinFee?: bigint
	/** Durable "the FJ message was consumed by our attempt" - persisted once seen, so a later
	 *  UNREACHABLE node (receiptStatus probe returns `pending`) cannot strand a known consumption
	 *  in `wait` forever. A conclusive `dropped` receipt still overrides it. */
	consumed?: boolean
	/** Consecutive fjwc gate/simulate failures observed for this record. */
	persistentFailureCount: number
	/** The user explicitly chose "Claim without fuel". */
	userOverride: boolean
}

export interface FuelClaimDecision {
	action: FuelClaimAction
	/** True when the UI should surface the manual "Claim without fuel" action. */
	offerManual: boolean
}

/** Fee-spike margin: the claimed fuel must cover at least margin × current min fee to self-pay. */
export const FUEL_FEE_MARGIN = 2n

/** Ambiguous-wait threshold before the manual escape is OFFERED (never auto-fired). */
export const MANUAL_OFFER_THRESHOLD = 3

export function decideFuelClaim(e: FuelClaimEvidence): FuelClaimDecision {
	const offerManual = e.persistentFailureCount >= MANUAL_OFFER_THRESHOLD

	// The user's explicit, non-destructive escape: the token claim pays from the wallet's own gas; the FJ message (if
	// unconsumed) stays claimable later - fuel is never marked abandoned.
	if (e.userOverride) return { action: "own-gas", offerManual: false }

	// Trigger 1 - our own receipt is ground truth: an INCLUDED fjwc attempt consumed the FJ
	// message regardless of app-phase outcome. Never re-embed a consumed claim.
	if (e.attempt && e.txHashKnown) {
		// A conclusive `dropped` overrides even a (prematurely) persisted consumed flag: a dropped
		// tx consumed nothing, so retry fjwc.
		if (e.receiptStatus === "dropped") return { action: "fjwc", offerManual }
		if (e.receiptStatus === "included" || e.consumed) return { action: "own-gas", offerManual: false }
		// Pending or unprobed (incl. an unreachable node): the tx may still land - wait, never guess.
		return { action: "wait", offerManual }
	}

	// Attempt latched but the wallet never returned a hash (crash mid-prompt): the tx MAY have
	// been sent. A durable consumed flag still settles it; otherwise unknowable ⇒ wait (the manual
	// escape resolves it safely - own gas works whether or not the unknown tx consumed the fuel).
	if (e.attempt) return e.consumed ? { action: "own-gas", offerManual: false } : { action: "wait", offerManual }

	// Trigger 2 - fee insufficiency from two record-local quantities: the claimed fuel cannot
	// cover its own claim tx. Claim the token from the wallet's own gas AND land the FJ as balance standalone.
	if (e.fuelReceived !== undefined && e.currentMinFee !== undefined && e.fuelReceived < e.currentMinFee * FUEL_FEE_MARGIN) {
		return { action: "own-gas-plus-standalone-fj", offerManual: false }
	}

	return { action: "fjwc", offerManual }
}

/**
 * The PRIVATE fuel-claim ladder: a fully SEPARATE decider from
 * the public one above. Its action type makes the privacy invariant structural — it can NEVER return
 * `own-gas` / `own-gas-plus-standalone-fj` (those would link the user). The private claim's fee is
 * always the Wonderland PrivateFPC method; recovery retries that method only, never public.
 *
 * Positive-evidence-only, same as the public ladder:
 *  - an INCLUDED attempt (or a durable `consumed`) burned the FJ at the FPC (the `mint_and_pay_fee`
 *    setup is non-revertible) ⇒ `consumed`: do NOT re-mint (a second claim double-spends the message);
 *  - a conclusively `dropped` attempt landed nothing ⇒ retry the private claim;
 *  - the ONE retryable no-hash case is a pre-inclusion `mint_and_pay_fee` setup-insufficiency (the
 *    "Amount too low to cover gas cost" assert makes the bundled tx invalid, so the FJ stays unconsumed);
 *  - everything else ambiguous WAITS. Never public on any branch.
 */
export type PrivateFuelClaimAction =
	| "private-fpc" // attempt (or retry) the PrivateFPC mint_and_pay_fee claim.
	| "consumed" // the FJ was burned by an included attempt - do NOT re-mint (recover the credited balance via pay_fee, a follow-up).
	| "wait" // no positive evidence yet - keep waiting; never fall back to public.

export interface PrivateFuelClaimEvidence {
	/** A private mint_and_pay_fee claim was invoked for this record (journal-first latch). */
	attempt: boolean
	/** The attempt's tx hash was persisted (the wallet returned). */
	txHashKnown: boolean
	/** The attempt tx's receipt state, when a hash is known and probed. */
	receiptStatus?: FuelReceiptStatus
	/** Durable "the FJ message was consumed by our included attempt". */
	consumed?: boolean
	/** The last send threw the exact `mint_and_pay_fee` insufficiency assert (pre-inclusion, no hash).
	 *  This is the ONLY retryable no-hash signal - the narrow allow-list (string-matched, no typed selector). */
	setupInsufficiency: boolean
	/** The last attempt latch is older than PRIVATE_ATTEMPT_STALE_MS (or has no timestamp — every
	 *  pre-fix record). Unstales the "wait" limbo: a vanished tx whose receipt reads "pending"
	 *  forever (node never reports "dropped") would otherwise deadlock the claim with no escape.
	 *  Safe because the retry is SIMULATE-gated: a claim whose FJ message was actually consumed
	 *  fails the engine's simulate authority and is never re-sent — aging out can only re-attempt
	 *  provably-unconsumed messages (or surface the consumed state via the simulate error). */
	attemptAgedOut: boolean
}

/** How long a private claim attempt may sit in receipt limbo before the retry path re-opens. */
export const PRIVATE_ATTEMPT_STALE_MS = 15 * 60_000

export function decidePrivateFuelClaim(e: PrivateFuelClaimEvidence): { action: PrivateFuelClaimAction } {
	if (e.attempt && e.txHashKnown) return decideHashedAttempt(e)
	if (e.attempt) return decideHashlessAttempt(e)
	return { action: "private-fpc" } // fresh record ⇒ first private claim attempt
}

/** Attempt latched AND the tx hash is known — receipt evidence drives the call. */
function decideHashedAttempt(e: PrivateFuelClaimEvidence): { action: PrivateFuelClaimAction } {
	if (e.receiptStatus === "included" || e.consumed) return { action: "consumed" }
	if (e.receiptStatus === "dropped") return { action: "private-fpc" } // not included ⇒ FJ unconsumed ⇒ retry
	// Pending / unprobed / unreachable node: a FRESH attempt may still land - wait, never guess.
	// An AGED-OUT attempt re-opens the retry (the engine's simulate gate is the double-spend
	// authority; see attemptAgedOut).
	return e.attemptAgedOut ? { action: "private-fpc" } : { action: "wait" }
}

/** Attempt latched but NO tx hash. Durable consumption still settles it; the setup-insufficiency
 *  assert is the one retryable case; anything else waits until the latch ages out (the wallet
 *  may still return / the tx may still land within the stale window). NEVER public. */
function decideHashlessAttempt(e: PrivateFuelClaimEvidence): { action: PrivateFuelClaimAction } {
	if (e.consumed) return { action: "consumed" }
	if (e.setupInsufficiency) return { action: "private-fpc" }
	return e.attemptAgedOut ? { action: "private-fpc" } : { action: "wait" }
}

/**
 * Whether the private Fee Juice the account ALREADY holds at the PrivateFPC pays a claim with no
 * fresh Fee Juice message of its own (a no-fuel bridge, a fee spike, a spent prior attempt, the
 * user's choice to claim without the bridged gas). That balance is the ONLY payer such a claim can
 * name: the account's public Fee Juice cannot be named as a dApp transaction's payer through the
 * wallet (a payer with no claim call is routed as a claim-in-setup that never ends setup), and a
 * claim sent without a payer is left to the wallet's picker, whose default is the sponsored FPC
 * that no bridge path may lean on.
 *
 * `ceiling` is what the claim commits to (limits × predicted fees, every transaction it makes): the
 * FPC deducts exactly that and refunds nothing, so a balance under it is refused before the FPC
 * refuses it.
 *
 * **Fail-closed read:** `null` = the read THREW (≠ a real zero) → `unverifiable` ("couldn't check —
 * retry"), never a false "no gas".
 */
export type OwnGasCredit =
	| "pays" // the private balance covers the ceiling: the FPC pays (`pay_fee`).
	| "short" // held, but under the ceiling - the FPC would refuse.
	| "unverifiable" // the read failed - fail closed ("couldn't check").
	| "none" // known and zero - a truly cold account.

export interface OwnGasCreditInputs {
	/** Private Fee Juice at the PrivateFPC (base units, via `balance_of`), or `null` if the read FAILED. */
	privateFeeJuice: bigint | null
	/** The fee the claim commits to, in Fee Juice base units. */
	ceiling: bigint
}

export function decideOwnGasCredit(i: OwnGasCreditInputs): OwnGasCredit {
	const credit = i.privateFeeJuice
	if (credit === null) return "unverifiable"
	if (credit >= i.ceiling) return "pays"
	return credit > 0n ? "short" : "none"
}

/**
 * Which held gas pays, once the wallet can also route the account's PUBLIC Fee Juice as a
 * dApp-named payer (`publicAllowed`, from the wallet's feature probe; false keeps the private-only
 * rule above). Either balance pays only when it covers the ceiling — the public reference ceiling
 * is conservative next to the wallet's own estimate, but an irreversible deposit is never signed
 * on a balance that might not. A PRIVATE bridge pays only from its private balance, whatever the
 * public one holds: a transaction's fee payer is public, and the claim publicly raises the token's
 * supply by the bridged amount, so an account paying its own fee links itself to the L1 deposit.
 * A public bridge prefers its public balance (the wallet charges the exact fee; the FPC keeps the
 * whole ceiling).
 */
export type OwnGasSource = "public" | "private" | "short" | "unverifiable" | "none"

export interface OwnGasSourceInputs extends OwnGasCreditInputs {
	/** Public Fee Juice (base units), or `null` if the `balance_of_public` read FAILED; ignored unless allowed. */
	publicFeeJuice: bigint | null
	/** The bridge is private: only the private balance may pay (the fence above). */
	privateBridge: boolean
	publicAllowed: boolean
}

export function decideOwnGasSource(i: OwnGasSourceInputs): OwnGasSource {
	if (i.privateBridge || !i.publicAllowed) {
		const credit = decideOwnGasCredit(i)
		return credit === "pays" ? "private" : credit
	}
	const pub = i.publicFeeJuice
	const priv = i.privateFeeJuice
	const publicCovers = pub !== null && pub >= i.ceiling
	const privateCovers = priv !== null && priv >= i.ceiling
	if (publicCovers) return "public"
	if (privateCovers) return "private"
	if (pub === null || priv === null) return "unverifiable"
	return pub > 0n || priv > 0n ? "short" : "none"
}

/** The exact PrivateFPC `mint_and_pay_fee` insufficiency assert (verified in the installed 215fd08
 *  artifact). The narrow retry allow-list string-matches this — there is no typed selector. */
export const PRIVATE_FUEL_INSUFFICIENCY_MSG = "Amount too low to cover gas cost"

/** Classify a private-claim send error as the retryable setup-insufficiency (fail-closed: anything that
 *  doesn't match is NOT retryable). */
export function isPrivateFuelInsufficiency(message: string): boolean {
	return message.includes(PRIVATE_FUEL_INSUFFICIENCY_MSG)
}

/**
 * Which fuel ladder a deposit's claim may use — the privacy fence as a routing decision.
 *
 * The two ladders are NOT interchangeable: the public one claims the bridged Fee Juice with a
 * publicly-visible tx, which deanonymizes a private bridge. So a private record whose
 * private-claim metadata is incomplete — `bridgeSecretSalt` is optional in persisted and backup
 * records, so salt-less, partially-restored or tampered ones exist — must FAIL CLOSED instead of
 * falling through to the public ladder.
 *
 * A private deposit with NO fuel block is unaffected: it never bridged Fee Juice, so there is no
 * FJ claim to protect and its claim pays the wallet's own way exactly as before.
 */
export type FuelLadder =
	| "private" // PrivateFPC mint_and_pay_fee — the only ladder a private FUELED record may use.
	| "public" // the own-gas/fjwc/standalone ladder (or the no-fuel fee path): never a private fueled record.
	| "private-incomplete" // private + fueled but missing claim metadata: refuse BOTH ladders.

export interface FuelLadderInputs {
	isPrivate: boolean
	/** With `intent`, the DURABLE "this deposit bought fuel" marker — see {@link boughtFuel}. */
	schema: 1 | 2 | 3 | 4
	/** Schema-3 and -4 records carry their intent; only a gas-buying one is expected to hold a fuel block. */
	intent?: "token" | "token+gas" | "gas"
	fuel?: { received?: string; leafIndex?: string; bridgeSecretSalt?: string }
}

/**
 * Whether the deposit bought fuel, read from the record's durable shape rather than the fuel
 * block's presence: a fueled record whose block was lost is corrupted and still has a live FJ
 * message, and classifying it by the block's absence alone would send it down the public ladder.
 * Schema 2 is fueled by definition; schema 3 says so through its intent; schema 1 never is.
 */
export function boughtFuel(i: Pick<FuelLadderInputs, "schema" | "intent">): boolean {
	if (i.schema === 2) return true
	if (i.schema === 3 || i.schema === 4) return i.intent !== undefined && i.intent !== "token"
	return false
}

export function decideFuelLadder(i: FuelLadderInputs): FuelLadder {
	if (!i.isPrivate) return "public"
	// Only a genuine no-fuel private deposit has no FJ to protect.
	if (!i.fuel) return boughtFuel(i) ? "private-incomplete" : "public"
	const f = i.fuel
	return f.received && f.leafIndex && f.bridgeSecretSalt ? "private" : "private-incomplete"
}

/**
 * Whether the PUBLIC standalone gas recovery ("Claim your gas") applies to a record — the single
 * source both the card's affordance and the action's own guard read, so the button and the function
 * can never disagree.
 *
 * A private claim pays for itself with the bridged FJ inside the completing tx, so on a COMPLETED
 * well-formed private record the fuel is spent and an unlatched `consumed` is a stale flag, not
 * stranded gas — silence is correct. The incomplete case is the one that must SAY something: its
 * fuel state is genuinely unknown, and the public recovery still must not be offered.
 */
export type StandaloneFuelRecovery =
	| "offer" // public record, completed, fuel bridged and not yet settled.
	| "none" // nothing to recover: no fuel, a direct-Fuel record, unfinished, or already settled.
	| "private-settled" // private + well-formed: its FJ paid for the completing tx. Say nothing.
	| "private-unknown" // private + metadata gaps: never an offer, and the card has no action to advertise.

export interface StandaloneFuelRecoveryInputs {
	isPrivate: boolean
	/** A direct-Fuel record's completion IS its gas claim — never offer a re-claim for one. */
	isFeeJuiceAsset: boolean
	schema: 1 | 2 | 3
	intent?: FuelLadderInputs["intent"]
	completedAt?: number
	/** The token leg ended with another submitter's claim: finished for the fuel's purposes, even
	 *  while the record stays open for the fuel itself. */
	claimedByOther?: boolean
	fuel?: {
		received?: string
		leafIndex?: string
		bridgeSecretSalt?: string
		consumed?: boolean
		standaloneClaimed?: boolean
	}
}

export function decideStandaloneFuelRecovery(i: StandaloneFuelRecoveryInputs): StandaloneFuelRecovery {
	const f = i.fuel
	if (i.isFeeJuiceAsset) return "none"
	if (!f?.received && !(i.isPrivate && boughtFuel(i))) return "none"
	if (i.completedAt === undefined && !i.claimedByOther) return "none" // an unfinished claim retries via the normal action.
	if (f?.consumed === true || f?.standaloneClaimed === true) return "none"
	if (!i.isPrivate) return f?.received ? "offer" : "none"
	// Another submitter's token claim never spent this record's private fuel, so neither private
	// verdict below is true of it; the card states the open fuel itself.
	if (i.claimedByOther && i.completedAt === undefined) return "none"
	return decideFuelLadder({ isPrivate: true, schema: i.schema, intent: i.intent, fuel: f }) === "private"
		? "private-settled"
		: "private-unknown"
}

/** The terminal record/receipt mismatch: the L1 receipt cannot supply this record's fuel data, so a
 *  retry repeats the same immutable failure forever. Matched by the engine to mark the record
 *  terminally rather than as a retryable error. */
export const RECEIPT_RECORD_MISMATCH_MSG = "receipt doesn't match its record"

export function isReceiptRecordMismatch(message: string): boolean {
	return message.includes(RECEIPT_RECORD_MISMATCH_MSG)
}
