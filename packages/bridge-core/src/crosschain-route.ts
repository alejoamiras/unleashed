/**
 * The bytes a cross-chain deposit signs, built from the user's own legs and our own encoders: the router's
 * `DepositIntent`, its `bridgeFromCaller` call, and the Across deposit that carries that call to Ethereum. A
 * transaction built here is still only usable once `verifyRoute` accepts it.
 */
import { type Address, encodeFunctionData, type Hex, zeroHash } from "viem"
import { acrossV4Call, buildAcrossV4Deposit } from "./across-v4"
import { DEPOSIT_ROUTER_ABI } from "./deposit-router-abi"
import { acrossDepositFor, type RouteExpectation, type RouterIntent, type RouteTx } from "./lifi-decode"
import { PRIVATE_FPC_ADDRESS } from "./private-fuel"

/** The legs of one deposit, as the claims rebuild them. */
export interface CrossChainLegs {
	isPrivate: boolean
	/** The Aztec recipient; a private intent never publishes it. */
	recipient: Hex
	/** Absent for a gas-only intent. */
	tokenSecretHash?: Hex
	/** Absent without a gas slice. `slice` is in token units, `minOutput` in Fee Juice. */
	fuel?: { secretHash: Hex; slice: bigint; minOutput: bigint }
}

/**
 * The router's `DepositIntent` for `legs`, in the shape `DepositRouter._checkShape` accepts: the recipient is
 * public only on a public token leg, private gas lands at the PrivateFPC, and an intent without a slice
 * leaves every fuel field zero. Throws on an intent with neither leg.
 */
export function crossChainIntent(token: Address, legs: CrossChainLegs): RouterIntent {
	if (!legs.tokenSecretHash && !legs.fuel) throw new Error("crosschain-route: an intent needs a token leg or a gas slice")
	if (legs.fuel && legs.fuel.slice <= 0n) throw new Error("crosschain-route: a gas leg needs a positive slice")
	const publicToken = !legs.isPrivate && legs.tokenSecretHash !== undefined
	return {
		token,
		aztecRecipient: publicToken ? legs.recipient : zeroHash,
		tokenSecretHash: legs.tokenSecretHash ?? zeroHash,
		isPrivate: legs.isPrivate,
		fuelSlice: legs.fuel?.slice ?? 0n,
		fuelRecipient: legs.fuel ? (legs.isPrivate ? (PRIVATE_FPC_ADDRESS as Hex) : legs.recipient) : zeroHash,
		fuelSecretHash: legs.fuel?.secretHash ?? zeroHash,
		minFuelOutput: legs.fuel?.minOutput ?? 0n,
	}
}

/** `bridgeFromCaller` calldata; the router pulls at least `minReceived` and at most `maxPull` from the Executor. */
export function bridgeFromCallerCall(intent: RouterIntent, swapData: Hex, minReceived: bigint, maxPull: bigint): Hex {
	return encodeFunctionData({
		abi: DEPOSIT_ROUTER_ABI,
		functionName: "bridgeFromCaller",
		args: [intent, swapData, minReceived, maxPull],
	})
}

/** The LI.FI message an Across deposit for `x` carries: what `/suggested-fees` prices the relay for. Its
 *  length, and so the relayer's gas, does not depend on the amounts. */
export function acrossMessageOf(x: RouteExpectation): Hex {
	return acrossV4Call(acrossDepositFor(x)).acrossData.message
}

/** The source transaction and its exact approval for an Across expectation, encoded from the expectation itself. */
export function acrossRouteTx(x: RouteExpectation): RouteTx {
	const call = buildAcrossV4Deposit(acrossDepositFor(x))
	return {
		chainId: x.srcChainId,
		from: x.user,
		to: call.to,
		value: call.value,
		data: call.data,
		approval: { token: x.srcToken, spender: call.to, amount: x.srcAmount },
	}
}
