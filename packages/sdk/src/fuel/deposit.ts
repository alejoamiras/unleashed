import type { WalletClient } from "viem"
import { refusal } from "../errors.ts"
import { depositL1 } from "../execution/l1-deposit.ts"
import { assertNetwork, type Network, type Reads } from "../network.ts"
import { assertQuote } from "../quote-proof.ts"
import type { DepositRecord } from "../records.ts"
import type { RunOptions } from "../run.ts"
import type { FuelQuote } from "./quote.ts"

/**
 * Sends a reviewed gas-only deposit from `l1`'s account and resolves once Ethereum confirmed it. Before any prompt it
 * refuses a wrong chain, a paused route, and a venue that now quotes under `quote.minFj` (`quote-moved`). A private
 * deposit's fuel salt reaches `run.persist` in `secrets`, before the first prompt; `claimFuel` needs it.
 */
export async function depositFuel(net: Network, r: Reads, l1: WalletClient, quote: FuelQuote, run: RunOptions): Promise<DepositRecord> {
	assertNetwork(net)
	if (quote.network !== net) throw refusal("invalid-request", "the quote was made for another network")
	assertQuote(quote)
	return depositL1(
		net,
		r,
		l1,
		{
			intent: "gas",
			token: quote.token,
			amount: quote.amount,
			recipient: quote.recipient,
			isPrivate: quote.privacy === "private",
			gas: { fuelAmount: quote.amount, minFuelOutput: quote.minFj },
		},
		run,
	)
}
