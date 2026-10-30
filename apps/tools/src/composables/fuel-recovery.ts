/**
 * The journal card's gas-recovery actions: the three things a user can do about a bridge whose gas
 * slice did not arrive with its tokens. They act on a record's own `fuel` block through the
 * protocol Fee Juice contract, so they outlive any one bridge generation.
 */
import { type DepositJournalRecord, assetKindOf } from "@unleashed/bridge-core"
import { decideStandaloneFuelRecovery } from "@unleashed/sdk/internal"
import { safeAddressText } from "@/lib/token-display"
import { fuelReceiptStatus, patchFuel } from "./deposit-flow"
import { currentRecord, runGasClaim, underJournalLock, useBridgeJournal } from "./useBridgeJournal"
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
	// receipt was read must not inherit it. Under the journal lock, as a running claim writes this block.
	await underJournalLock(() => {
		const live = (currentRecord(id) as DepositJournalRecord | undefined)?.fuel
		if (!live || live.claimTxHash !== fuel.claimTxHash || live.secretHashHex !== fuel.secretHashHex) return
		patchFuel(id, live, { consumed: true })
	})
}

/** The card's "Claim your gas" recovery: claims a stranded fuel message after the token side
 *  already completed, or after another submitter claimed the tokens. Throws so the caller can
 *  surface the failure (never silent). */
export async function claimFuelStandalone(id: string): Promise<void> {
	const bridgeWallet = useBridgeWallet()
	if (!bridgeWallet.wallet.value) throw new Error("Connect your Aztec wallet first.")
	const rec = recordOf(id)
	const fuel = rec?.fuel
	if (!rec || !fuel?.received || !fuel.leafIndex) throw new Error("This bridge has no fuel to claim.")
	// Same source as the card's affordance, so the button and this guard can never disagree. The
	// claim is public, which the privacy fence forbids for private records — and
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
	await withOperation(() => runGasClaim(id))
}
