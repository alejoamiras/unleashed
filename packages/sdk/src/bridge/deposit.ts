import type { WalletClient } from "viem"
import { refusal } from "../errors.ts"
import { depositL1 } from "../execution/l1-deposit.ts"
import { assertNetwork, type Network, type Reads } from "../network.ts"
import { assertQuote } from "../quote-proof.ts"
import type { DepositRecord } from "../records.ts"
import type { RunOptions } from "../run.ts"
import type { BridgeQuote } from "./quote.ts"
import { tokenBlockOf } from "./token.ts"

/**
 * Sends a reviewed token deposit (with its gas slice, if quoted) from `l1`'s account and resolves once Ethereum
 * confirmed it. A first-time token's portal is created inside the same transaction. A private deposit's salts reach
 * `run.persist` in `secrets`, before the first prompt; `claimToken` needs them.
 */
export function depositToken(net: Network, r: Reads, l1: WalletClient, quote: BridgeQuote, run: RunOptions): Promise<DepositRecord> {
	assertNetwork(net)
	if (quote.network !== net) throw refusal("invalid-request", "the quote was made for another network")
	assertQuote(quote)
	return depositL1(
		net,
		r,
		l1,
		{
			intent: quote.gas ? "token+gas" : "token",
			token: quote.token.erc20,
			amount: quote.amount,
			recipient: quote.recipient,
			isPrivate: quote.privacy === "private",
			...(quote.gas ? { gas: { fuelAmount: quote.gas.fuelAmount, minFuelOutput: quote.gas.minFj } } : {}),
			tokenBlock: tokenBlockOf(quote.token),
			registers: quote.token.state !== "registered",
		},
		run,
	)
}
