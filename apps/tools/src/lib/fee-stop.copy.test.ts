import type { FeeStop } from "@unleashed/sdk/internal"
import { expect, test } from "vitest"
import { FEE_STOP_COPY } from "./fee-stop-copy"

// The sentences the claim side showed before its stops became codes, as literals; both tables are
// `Record<FeeStop, string>`, so the compiler holds them to the same codes.
const TODAY: Record<FeeStop, string> = {
	"malformed-claim-hash":
		"This bridge's recorded gas-claim transaction hash is malformed — restore the record from a backup, or discard it.",
	"fuel-already-claimed": "The gas claim was already included on Aztec — there is nothing left to claim for this bridge.",
	"fuel-claim-pending":
		"A gas claim for this bridge is still pending — waiting for its receipt before trying again. Retry later; if you decide to discard this record, back it up first.",
	"private-claim-pending": "private fuel claim pending — waiting for its receipt before retrying",
	"fuel-attempt-pending": "fuel claim attempt pending — waiting for its receipt before retrying",
	"fuel-attempt-pending-send": "fuel claim attempt pending",
	"consumed-unconfirmed": "An earlier gas claim could not be confirmed as checkpointed just now — try Claim your gas again in a moment.",
	"consumed-unreadable": "The gas claim's state could not be read just now — try Claim your gas again in a moment.",
	"standalone-unconfirmed": "The gas claim was sent but hasn't confirmed yet — try Claim your gas again in a moment.",
	"unpriced-by-wallet": "Your wallet could not price this transaction's fee ceiling just now — please try again in a moment.",
	"private-fuel-unread":
		"This private bridge's gas details couldn't be read from Ethereum yet — retry in a minute. The public gas recovery is deliberately unavailable for private bridges.",
	"private-fuel-missing":
		"This private bridge is missing the data needed to claim its gas privately (an older or partially restored record). Only its backup file can restore that — the public gas recovery is deliberately unavailable for private bridges.",
	"fpc-drift": "Private fuel FPC address mismatch (version drift), refusing to claim. Reselect a mode.",
	"below-fuel-floor": "The bridged gas is below the safe claim floor; the private fuel claim can't self-pay.",
	"no-claimable-fuel": "This Fuel bridge has no claimable Fee Juice.",
	"floor-unconfigured": "Fuel floor is not configured — refusing to bridge (fail-closed).",
	"below-claim-floor": "The bridged gas is below the safe claim floor — it can't cover its own claim. Increase the amount.",
	"fee-limit-spiked": "The bridged gas can't cover this claim's fee limit right now (fees spiked). Try again shortly.",
	"missing-salt": "This private Fuel bridge is missing its recovery salt, cannot claim.",
	"missing-secret": "This Fuel bridge is missing its claim secret.",
	"fuel-short": "The bridged gas is under the private claim's fee ceiling at current network fees — retry when fees ease.",
	"fuel-short-registering":
		"The bridged gas is under the fee ceiling of registering the token and claiming it privately at current network fees — retry when fees ease.",
	"credit-needs-wallet": "Connect your Aztec wallet to pay this claim from your private gas.",
	"credit-unreadable": "Couldn't check your private gas at the fee contract — please try again in a moment.",
	"credit-short":
		"Your private gas is under this claim's fee ceiling at current network fees — retry when fees ease, or bridge more gas.",
	"credit-short-registering":
		"Your private gas is under the fee ceiling of registering the token and claiming it at current network fees — retry when fees ease, or bridge more gas.",
	"own-gas-none":
		'No gas to claim this bridge with: your account holds no Fee Juice the bridge can pay from. Send with "arrive with gas", or bridge gas first.',
	"own-gas-unverifiable": "Couldn't check your gas — please try again in a moment.",
	"own-gas-short": "Your gas is under this claim's fee ceiling at current network fees — retry when fees ease, or bridge more gas.",
	"private-own-gas-none":
		"A private bridge pays its claim only from private gas, and your account holds none at the fee contract — paying from public Fee Juice would link your account to this bridge. Bridge gas privately first.",
	"private-own-gas-unverifiable": "Couldn't check your private gas — please try again in a moment.",
	"private-own-gas-short":
		"Your private gas is under this claim's fee ceiling at current network fees — retry when fees ease, or bridge more gas privately.",
	"record-predates-send": "This record predates the current bridge — its Ethereum leg cannot be recovered here.",
	"deposit-reverted": "The Ethereum deposit transaction reverted — there is nothing to claim. You can discard this record.",
	"no-bridge": "This network has no bridge.",
	"record-changed": "This bridge record changed while its deposit was being checked — reload and retry.",
}

test.each(Object.entries(TODAY))("%s keeps its sentence", (code, sentence) => {
	expect(FEE_STOP_COPY[code as FeeStop]).toBe(sentence)
})
