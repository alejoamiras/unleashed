/** Testnet deposits as the app builds them, through the app's own builders. */
import {
	acrossDepositFor,
	acrossV4Call,
	bridgeFromCallerCall,
	crossChainIntent,
	type RouteExpectation,
	selfBuiltTerms,
} from "@unleashed/bridge-core"
import type { SourceDeposit } from "@unleashed/bridge-core/across-fill"
import { type Address, getAddress, keccak256, pad, toHex } from "viem"

export const SOURCE_USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e")
export const SEPOLIA_USDC = getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238")
export const ROUTER = getAddress("0x6e5566894908e945a12245f9810b4055c4a1035b")
export const LEGACY_ROUTER = getAddress("0xad08e65dda66eaed5ab9447f27b7610a850f4303")
export const USER = getAddress("0x00000000000000000000000000000000000a11ce")

export interface AppDepositOptions {
	input: bigint
	filler: Address
	/** The source head's timestamp the app quoted from. */
	head?: number
	depositId?: bigint
	router?: Address
}

/** The deposit the app sends for `input` from Base Sepolia to a public Aztec recipient, as the source pool logs it. */
export function appDeposit(o: AppDepositOptions): SourceDeposit {
	const head = o.head ?? 1_800_000_000
	const depositId = o.depositId ?? 1n
	const terms = selfBuiltTerms(11155111, o.input, head, o.filler)
	const intent = crossChainIntent(SEPOLIA_USDC, { isPrivate: false, recipient: pad("0xa11ce0"), tokenSecretHash: pad("0x5ec7e") })
	const x: RouteExpectation = {
		srcChainId: 84532,
		user: USER,
		srcToken: SOURCE_USDC,
		srcAmount: o.input,
		lifiTxId: keccak256(toHex(depositId)),
		l1ChainId: 11155111,
		router: o.router ?? ROUTER,
		destToken: SEPOLIA_USDC,
		feeAsset: SEPOLIA_USDC,
		routerCall: bridgeFromCallerCall(intent, "0x", terms.outputAmount, terms.outputAmount),
		rail: {
			kind: "acrossV4",
			outputAmount: terms.outputAmount,
			quoteTimestamp: terms.quoteTimestamp,
			fillDeadline: terms.fillDeadline,
			exclusiveRelayer: o.filler,
		},
	}
	const a = acrossV4Call(acrossDepositFor(x)).acrossData
	return {
		relay: {
			depositor: a.refundAddress,
			recipient: a.receiverAddress,
			exclusiveRelayer: a.exclusiveRelayer,
			inputToken: a.sendingAssetId,
			outputToken: a.receivingAssetId,
			inputAmount: o.input,
			outputAmount: a.outputAmount,
			originChainId: 84532n,
			depositId,
			fillDeadline: a.fillDeadline,
			exclusivityDeadline: a.exclusivityParameter,
			message: a.message,
		},
		destinationChainId: 11155111n,
		quoteTimestamp: a.quoteTimestamp,
	}
}
