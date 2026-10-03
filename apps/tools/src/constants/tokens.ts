import { FAUCET_TOKENS, type FaucetSymbol } from "@unleashed/bridge-core"

/*
 * The faucet's fixed drip amounts; symbols and decimals come from the catalog.
 *
 * `onchainAmount` is what the Dripper's `amount: u64` param receives.
 * Both values fit comfortably under u64 (max ≈ 1.844e19); Dripper casts
 * to u128 internally.
 */

export type TokenSymbol = FaucetSymbol

export interface DripToken {
	readonly symbol: TokenSymbol
	readonly decimals: number
	readonly displayAmount: string
	readonly onchainAmount: bigint
}

const AMOUNTS: Record<TokenSymbol, Pick<DripToken, "displayAmount" | "onchainAmount">> = {
	SIGNAL: { displayAmount: "1,000", onchainAmount: 1_000_000_000n },
	NOISE: { displayAmount: "1", onchainAmount: 1_000_000_000_000_000_000n },
}

export const DRIP_TOKENS: readonly DripToken[] = FAUCET_TOKENS.map(({ symbol, decimals }) => ({ symbol, decimals, ...AMOUNTS[symbol] }))

export function findDripToken(symbol: TokenSymbol): DripToken {
	const t = DRIP_TOKENS.find((t) => t.symbol === symbol)
	if (!t) throw new Error(`DRIP_TOKENS missing entry for ${symbol}`)
	return t
}
