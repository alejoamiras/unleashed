/**
 * Which deposits the relayer fills. Anyone can name our filler, so a deposit is admitted only inside the envelope of
 * what the app builds off mainnet: self-built terms, LI.FI's receiver, and a one-step message into our router that
 * pulls exactly the output. The router checks the intent itself; one it refuses recovers the output to the message's fallback receiver.
 */
import {
	type AcrossRelayData,
	decodeRouterMessage,
	SELF_BUILT_FILL_WINDOW_S,
	type SourceDeposit,
	selfBuiltTerms,
} from "@unleashed/bridge-core/across-fill"
import { type Address, type Hex, isAddressEqual, pad, size, zeroAddress } from "viem"
import type { RelayerRoute } from "./route"

/** Far above the app's 1,408-byte message: caps the calldata a stranger's message adds to our fill (`TX_GAS_CAP` caps its gas). */
export const MAX_MESSAGE_BYTES = 2_048

export type IgnoreReason =
	| "destination"
	| "relayer"
	| "token"
	| "recipient"
	| "amount"
	| "output"
	| "window"
	| "message"
	| "router"
	| "intent"

const isWord = (word: Hex, a: Address) => word.toLowerCase() === pad(a, { size: 32 }).toLowerCase()

function identityReason(r: AcrossRelayData, destinationChainId: bigint, route: RelayerRoute): IgnoreReason | null {
	if (destinationChainId !== BigInt(route.destination.chainId)) return "destination"
	if (!isWord(r.exclusiveRelayer, route.filler) || r.exclusivityDeadline !== r.fillDeadline) return "relayer"
	if (!isWord(r.inputToken, route.source.token) || !isWord(r.outputToken, route.destination.token)) return "token"
	if (!isWord(r.recipient, route.destination.recipient)) return "recipient"
	return null
}

/** The amounts and timing against the app's self-built terms for the same input and quote time. */
function termsReason(r: AcrossRelayData, quoteTimestamp: number, route: RelayerRoute): IgnoreReason | null {
	if (r.inputAmount <= 0n || r.inputAmount > route.maxInput) return "amount"
	const terms = selfBuiltTerms(route.destination.chainId, r.inputAmount, quoteTimestamp, route.filler)
	if (r.outputAmount <= 0n || r.outputAmount > terms.outputAmount) return "output"
	if (r.fillDeadline < quoteTimestamp || r.fillDeadline - quoteTimestamp > SELF_BUILT_FILL_WINDOW_S) return "window"
	return null
}

/** The message: one LI.FI step into one of our routers, moving the output token, pulling exactly the output. */
function messageReason(message: Hex, output: bigint, route: RelayerRoute): IgnoreReason | null {
	if (size(message) > MAX_MESSAGE_BYTES) return "message"
	const decoded = decodeRouterMessage(message)
	if (!decoded.ok) return "message"
	const { message: m, router } = decoded.decoded
	const { step } = m
	const token = route.destination.token
	if (!route.destination.routers.some((a) => isAddressEqual(a, step.callTo)) || !isAddressEqual(step.approveTo, step.callTo)) {
		return "router"
	}
	const moves = isAddressEqual(step.sendingAssetId, token) && isAddressEqual(step.receivingAssetId, token)
	if (isAddressEqual(m.receiver, zeroAddress) || !moves || step.fromAmount !== output || step.requiresDeposit) return "message"
	if (!isAddressEqual(router.intent.token, token) || router.minReceived !== output || router.maxPull !== output) return "intent"
	return null
}

/** Why the relayer leaves `d` alone, or `null` when it is a deposit the app built for `route.filler`. Pure. */
export function classify(d: SourceDeposit, route: RelayerRoute): IgnoreReason | null {
	return (
		identityReason(d.relay, d.destinationChainId, route) ??
		termsReason(d.relay, d.quoteTimestamp, route) ??
		messageReason(d.relay.message, d.relay.outputAmount, route)
	)
}
