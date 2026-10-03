/**
 * The journal card's gas-recovery actions: the three things a user can do about a bridge whose gas
 * slice did not arrive with its tokens. They act on a record's own `fuel` block through the
 * protocol Fee Juice contract, so they outlive any one bridge generation.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { type DepositFuelBlock, type DepositJournalRecord, assetKindOf } from "@unleashed/bridge-core"
import { decideStandaloneFuelRecovery } from "@/lib/fuel-claim-state"
import { safeAddressText } from "@/lib/token-display"
import { humanizeWalletError } from "@/lib/wallet-errors"
import { fuelReceiptStatus, patchFuel, sendStandaloneFjClaim } from "./deposit-flow"
import { currentRecord, flagRecordError, useBridgeJournal } from "./useBridgeJournal"
import { useBridgeWallet } from "./useBridgeWallet"
import { withOperation } from "./useOpsInFlight"

// The user's explicit "claim without fuel" choices; set by the journal UI, read by the fee ladder.
const fuelOverrides = new Set<string>()

export function overrideFuelClaim(id: string): void {
	fuelOverrides.add(id)
}

/** Whether THIS record's claim may skip its bridged Fee Juice because the user said so. */
export function fuelOverrideActive(id: string): boolean {
	return fuelOverrides.has(id)
}

/** TEST-ONLY: drop the overrides between cases. */
export function __resetFuelOverridesForTests(): void {
	fuelOverrides.clear()
}

const recordOf = (id: string): DepositJournalRecord | undefined =>
	useBridgeJournal().records.value.find((r) => r.id === id) as DepositJournalRecord | undefined

/** Reconcile a fueled record's `consumed` flag from chain truth: if the fee-juice claim attempt is
 *  INCLUDED (success OR app-reverted — both consumed the message), persist `consumed`. Probing the
 *  attempt's own hash covers every path and leaves a genuinely DROPPED attempt unsettled, so the
 *  recovery affordance still surfaces. Idempotent. */
export async function reconcileFuelConsumed(id: string): Promise<void> {
	const fuel = (currentRecord(id) as DepositJournalRecord | undefined)?.fuel
	if (!fuel?.claimTxHash || fuel.consumed === true) return
	if ((await fuelReceiptStatus(fuel.claimTxHash)) !== "included") return
	// The receipt settles the block that was probed: a block another tab swapped in while the
	// receipt was read must not inherit it.
	const live = (currentRecord(id) as DepositJournalRecord | undefined)?.fuel
	if (live?.claimTxHash !== fuel.claimTxHash || live.secretHashHex !== fuel.secretHashHex) return
	patchFuel(id, live, { consumed: true })
}

/**
 * The same standalone claim, launched by the claim lane rather than the card: when the fee ladder
 * pays a hub claim from the wallet's own gas it leaves the bridged Fee Juice unconsumed, and nothing else
 * ever claims it. Best-effort by construction — the tokens are already moving, so a failure is
 * latched on the record (which re-offers CLAIM YOUR GAS once the deposit completes) and never
 * thrown into the claim that succeeded.
 */
export async function launchStandaloneFuelClaim(
	id: string,
	aztec: unknown,
	recipient: AztecAddress,
	fuel: DepositFuelBlock,
): Promise<void> {
	try {
		await joinStandalone(id, () => withOperation(() => sendStandaloneFjClaim(aztec, recipient, fuel, id)))
	} catch (e) {
		flagRecordError(
			id,
			`${humanizeWalletError(e instanceof Error ? e.message : String(e))}. Your tokens are unaffected — retry the gas claim from this card.`,
		)
	}
}

/** A standalone claim has no record lock, so a second start from any path — the claim lane's
 *  automatic one, the card, the dock, a remounted dock — joins the run already in flight. */
const standaloneInFlight = new Map<string, Promise<void>>()
function joinStandalone(id: string, start: () => Promise<void>): Promise<void> {
	const running = standaloneInFlight.get(id)
	if (running) return running
	const run = start().finally(() => standaloneInFlight.delete(id))
	standaloneInFlight.set(id, run)
	return run
}

/** The card's "Claim your gas" recovery: claims a stranded fuel message after the token side
 *  already completed. Throws so the caller can surface the failure (never silent). */
export function claimFuelStandalone(id: string): Promise<void> {
	return joinStandalone(id, () => claimFuelStandaloneOnce(id))
}

async function claimFuelStandaloneOnce(id: string): Promise<void> {
	const bridgeWallet = useBridgeWallet()
	const aztec = bridgeWallet.wallet.value
	if (!aztec) throw new Error("Connect your Aztec wallet first.")
	const rec = recordOf(id)
	const fuel = rec?.fuel
	if (!rec || !fuel?.received || !fuel.leafIndex) throw new Error("This bridge has no fuel to claim.")
	// Same source as the card's affordance, so the button and this guard can never disagree. The
	// ladder below is public, which the privacy fence forbids for private records — and
	// their Fee Juice is bound to the PrivateFPC, so it could not match one anyway.
	if (
		decideStandaloneFuelRecovery({
			isPrivate: rec.isPrivate,
			isFeeJuiceAsset: assetKindOf(rec) === "fee-juice",
			schema: rec.schema,
			completedAt: rec.completedAt,
			claimedByOther: rec.claimedByOther,
			fuel,
		}) !== "offer"
	) {
		throw new Error("Private gas is claimed as part of the private bridge; standalone recovery is unavailable.")
	}
	// The claim acts for rec.recipient — refuse under a different (or unknown, fail-closed) active
	// account, and run the wallet send inside a tracked operation span.
	const active = bridgeWallet.selectedAccount.value
	if (!active || active.toLowerCase() !== rec.recipient.toLowerCase()) {
		const shown = safeAddressText(rec.recipient)
		throw new Error(`This gas claim belongs to ${shown.slice(0, 6)}…${shown.slice(-4)}. Switch to that account to claim.`)
	}
	await withOperation(() => sendStandaloneFjClaim(aztec, AztecAddress.fromStringUnsafe(rec.recipient), fuel, id))
	// A token another submitter claimed had only its fuel left open: with the fuel settled, the
	// engine's guarded completion is the one write left, and it prompts for nothing.
	if (rec.claimedByOther && rec.completedAt === undefined) await useBridgeJournal().runDepositClaim(id, { interactive: false })
}
