/**
 * Fixed Across terms for a testnet deposit, filled only by our own relayer. Across's testnet relayer cannot
 * complete our message: it fills with 1.15× the node's gas estimate, and under Sepolia's gas rules that lands
 * where LI.FI's ReceiverAcrossV4 recovers the token to the user's wallet instead of depositing it. So every
 * testnet send names `TESTNET_FILLER` as its exclusive relayer, and that key fills it
 * (`packages/bridge-core/scripts/fill-testnet.ts`) before `fillDeadline`; otherwise the SpokePool refunds it on
 * the source chain. Mainnet rides a live quote and any relayer.
 */
import type { Address } from "viem"

/** The Across terms a deposit is built on: a live quote, or the fixed ones below. */
export interface RailTerms {
	quote: "across" | "self-built"
	outputAmount: bigint
	quoteTimestamp: number
	fillDeadline: number
	etaSeconds: number
	/** The only relayer that may fill before `fillDeadline`; absent, any relayer may. */
	exclusiveRelayer?: Address
}

/** The testnet relay fee Across charged a message-bearing 5 USDC deposit; a self-built deposit asks the same. */
export const SELF_BUILT_RELAY_FEE_BPS = 2_500n
/** Across's testnet fill window. */
export const SELF_BUILT_FILL_WINDOW_S = 7_200
/** The pinned testnet canary key: the one account `fill-testnet.ts` signs fills with. */
export const TESTNET_FILLER: Address = "0x7A4f7Be599Afa3AfB0A41bb1D44762Ce441f8fAc"

const ETHEREUM_MAINNET = 1

/**
 * Terms priced like Across's testnet quotes and timed from the source chain's head: the output keeps
 * `SELF_BUILT_RELAY_FEE_BPS` of `srcAmount`, the fill deadline is `SELF_BUILT_FILL_WINDOW_S` after the head,
 * and `filler` alone may fill until then. `etaSeconds` is the whole window: nobody quotes a fill time.
 *
 * @param l1ChainId The destination L1 of the manifest the deposit is built for.
 * @param sourceHeadTimestamp The source chain's latest block timestamp, in seconds; the SpokePool bounds
 *   `quoteTimestamp` and `fillDeadline` by its own clock, never the caller's.
 * @param filler The exclusive relayer: the account that will fill the deposit.
 * @throws when `l1ChainId` is Ethereum mainnet, where nobody self-fills.
 */
export function selfBuiltTerms(l1ChainId: number, srcAmount: bigint, sourceHeadTimestamp: number, filler: Address): RailTerms {
	if (l1ChainId === ETHEREUM_MAINNET) throw new Error("Self-built Across terms are testnet-only: a mainnet deposit needs a live quote.")
	return {
		quote: "self-built",
		outputAmount: srcAmount - (srcAmount * SELF_BUILT_RELAY_FEE_BPS) / 10_000n,
		quoteTimestamp: sourceHeadTimestamp,
		fillDeadline: sourceHeadTimestamp + SELF_BUILT_FILL_WINDOW_S,
		etaSeconds: SELF_BUILT_FILL_WINDOW_S,
		exclusiveRelayer: filler,
	}
}
