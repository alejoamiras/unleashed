/**
 * The canary's transactions, built from the core encoders and nothing else: the secrets and recipients of
 * a row's legs, its fuel slice and floor, the `bridgeFromCaller` call inside an Across deposit our own
 * builder encodes, and the Permit2-signed `bridgeWithPermit`. A cross-chain transaction is used only once
 * `verifyRoute` accepts it: the decoder is the trust boundary even for bytes we built.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { type Address, encodeFunctionData, type Hex, zeroHash } from "viem"
import { buildAcrossV4Deposit } from "../src/across-v4"
import { deriveTokenClaimSecret } from "../src/claim-secret"
import { DEPOSIT_ROUTER_ABI } from "../src/deposit-router-abi"
import { type FuelQuoteProvider, withFuelFloor } from "../src/fuel-quote"
import { proposeGasShare } from "../src/gas-share"
import { type DepositWitness, depositWitness, depositWitnessPermitTypedData } from "../src/l1"
import {
	acrossDepositFor,
	type DecodedRoute,
	type RouteExpectation,
	type RouterIntent,
	type RouteTx,
	verifyRoute,
} from "../src/lifi-decode"
import { deriveBridgeSecret, PRIVATE_FPC_ADDRESS } from "../src/private-fuel"
import { type CanaryBindings, CanaryRefusal, type CanaryRowShape, recoveryFloor } from "./lifi-canary-plan"

/** What a row's claims need and its record never shows. */
export interface RowSecrets {
	/** PUBLIC: the raw token secret. PRIVATE: the `claim_salt`. */
	tokenClaimValue: Fr
	fuel?: { via: "public"; secret: Fr } | { via: "private-fpc"; bridgeSalt: Fr }
}

/** The intent fields a row's secrets decide. */
export interface RowLegs {
	aztecRecipient: Hex
	tokenSecretHash: Hex
	fuelRecipient: Hex
	fuelSecretHash: Hex
	secrets: RowSecrets
}

const hashOf = async (secret: Fr): Promise<Hex> => (await computeSecretHash(secret)).toString() as Hex

/**
 * Fresh secrets for one row, bound the way the claims rebuild them: a private token leg derives its secret
 * from `(claim_salt, recipient)`, private fuel from `(bridgeSalt, claimer)` and lands at the PrivateFPC; a
 * private row never publishes its recipient.
 */
export async function rowLegs(shape: CanaryRowShape, recipient: AztecAddress, random: () => Fr): Promise<RowLegs> {
	const tokenClaimValue = random()
	const tokenSecret = shape.isPrivate ? deriveTokenClaimSecret(tokenClaimValue, recipient) : tokenClaimValue
	const legs = {
		aztecRecipient: shape.isPrivate ? zeroHash : (recipient.toString() as Hex),
		tokenSecretHash: await hashOf(tokenSecret),
	}
	if (shape.fuel === "none") return { ...legs, fuelRecipient: zeroHash, fuelSecretHash: zeroHash, secrets: { tokenClaimValue } }
	if (shape.fuel === "public") {
		const secret = random()
		const fuel = { via: "public" as const, secret }
		return {
			...legs,
			fuelRecipient: recipient.toString() as Hex,
			fuelSecretHash: await hashOf(secret),
			secrets: { tokenClaimValue, fuel },
		}
	}
	const bridgeSalt = random()
	const fuelSecretHash = await hashOf(deriveBridgeSecret(bridgeSalt, recipient))
	const fuel = { via: "private-fpc" as const, bridgeSalt }
	return { ...legs, fuelRecipient: PRIVATE_FPC_ADDRESS as Hex, fuelSecretHash, secrets: { tokenClaimValue, fuel } }
}

export interface FuelLeg {
	slice: bigint
	/** `_minAmountOut` already equal to `minOut`. */
	swapData: Hex
	minOut: bigint
	expectedOut: bigint
}

/**
 * The slice of `delivered` the app's sizing diverts into Fee Juice, quoted at exactly that slice. The
 * recovery row signs `recoveryFloor` of the quote instead of the slippage floor, in the intent and in the
 * swap call alike, so the router's own check and the swapper's both refuse it.
 */
export async function fuelLegFor(
	provider: FuelQuoteProvider,
	b: CanaryBindings,
	token: { erc20: Address; decimals: number },
	delivered: bigint,
	recovery: boolean,
): Promise<FuelLeg> {
	const probe = await provider.probe(token.erc20, 10n ** BigInt(token.decimals))
	if (!probe.ok) throw new CanaryRefusal(`the swapper gave no rate for ${token.erc20} (${probe.reason})`)
	const share = proposeGasShare({
		amount: delivered,
		decimals: token.decimals,
		fjPerTx: b.fuel.fjPerTx,
		fjRegister: b.fuel.fjRegister,
		minFuelFj: b.fuel.minFuelFj,
		rate: probe.probe,
		slippageBps: b.fuel.slippageBps,
	})
	const q = await provider.quote(token.erc20, share.fuelAmount)
	if (!q.ok) throw new CanaryRefusal(`the swapper's quote for a ${share.fuelAmount} slice is refused (${q.reason})`)
	const { swapData, minOut, expectedOut } = q.quote
	if (!recovery) return { slice: share.fuelAmount, swapData, minOut, expectedOut }
	const floor = recoveryFloor(expectedOut)
	return { slice: share.fuelAmount, swapData: withFuelFloor(swapData, floor), minOut: floor, expectedOut }
}

/** The router's `DepositIntent` for a row's legs; a row without fuel leaves every fuel field zero. */
export function routerIntent(token: Address, isPrivate: boolean, legs: RowLegs, fuel?: FuelLeg): RouterIntent {
	return {
		token,
		aztecRecipient: legs.aztecRecipient,
		tokenSecretHash: legs.tokenSecretHash,
		isPrivate,
		fuelSlice: fuel?.slice ?? 0n,
		fuelRecipient: fuel ? legs.fuelRecipient : zeroHash,
		fuelSecretHash: fuel ? legs.fuelSecretHash : zeroHash,
		minFuelOutput: fuel?.minOut ?? 0n,
	}
}

/** `bridgeFromCaller` for an Across delivery: the rail delivers exactly `delivered`, so it bounds the pull on both sides. */
export function bridgeFromCallerCall(intent: RouterIntent, swapData: Hex, delivered: bigint): Hex {
	return encodeFunctionData({ abi: DEPOSIT_ROUTER_ABI, functionName: "bridgeFromCaller", args: [intent, swapData, delivered, delivered] })
}

/** The Across terms a deposit is built on: a live quote, or the canary's own when Across quotes none. */
export interface RailTerms {
	quote: "across" | "self-built"
	outputAmount: bigint
	quoteTimestamp: number
	fillDeadline: number
	etaSeconds: number
}

/** The testnet relay fee Across charged a message-bearing 5 USDC deposit; a self-built deposit asks the same. */
export const SELF_BUILT_RELAY_FEE_BPS = 2_500n
/** Across's testnet fill window. */
export const SELF_BUILT_FILL_WINDOW_S = 7_200

/** Terms for a deposit Across will not quote: priced like its testnet quotes and timed from the source head. */
export function selfBuiltTerms(srcAmount: bigint, sourceHeadTimestamp: number): RailTerms {
	return {
		quote: "self-built",
		outputAmount: srcAmount - (srcAmount * SELF_BUILT_RELAY_FEE_BPS) / 10_000n,
		quoteTimestamp: sourceHeadTimestamp,
		fillDeadline: sourceHeadTimestamp + SELF_BUILT_FILL_WINDOW_S,
		etaSeconds: SELF_BUILT_FILL_WINDOW_S,
	}
}

/** What `verifyRoute` holds a cross-chain row to, from the manifest and our own builders only. */
export function crossChainExpectation(
	b: CanaryBindings,
	p: { user: Address; srcAmount: bigint; lifiTxId: Hex; routerCall: Hex; hasFuel: boolean; terms: RailTerms },
): RouteExpectation {
	return {
		srcChainId: b.source.chainId,
		user: p.user,
		srcToken: b.source.token,
		srcAmount: p.srcAmount,
		lifiTxId: p.lifiTxId,
		l1ChainId: b.l1ChainId,
		router: b.depositRouter,
		destToken: b.destToken.erc20 as Address,
		feeAsset: b.feeAsset,
		routerCall: p.routerCall,
		...(p.hasFuel ? { fuel: { provider: "testnetSwapper" as const } } : {}),
		rail: {
			kind: "acrossV4",
			outputAmount: p.terms.outputAmount,
			quoteTimestamp: p.terms.quoteTimestamp,
			fillDeadline: p.terms.fillDeadline,
		},
	}
}

/** The source transaction and its exact approval, encoded by `across-v4.ts` from the expectation itself. */
export function crossChainTx(x: RouteExpectation): RouteTx {
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

/** `verifyRoute`'s acceptance, or a refusal naming the field it refused. */
export function verifiedRoute(tx: RouteTx, x: RouteExpectation): DecodedRoute {
	const verdict = verifyRoute(tx, x)
	if (!verdict.ok) throw new CanaryRefusal(`verifyRoute refused ${verdict.field}: ${verdict.reason}`)
	return verdict.decoded
}

export interface PermitTerms {
	nonce: bigint
	deadline: bigint
}

/** The witness and the Permit2 payload the canary signs for `bridgeWithPermit`. */
export function permitPayload(
	b: CanaryBindings,
	p: { intent: RouterIntent; swapData: Hex; amount: bigint; permit: PermitTerms },
): { witness: DepositWitness; typedData: ReturnType<typeof depositWitnessPermitTypedData> } {
	const witness = depositWitness(p.intent, p.swapData)
	const transfer = {
		permitted: { token: p.intent.token, amount: p.amount },
		spender: b.depositRouter,
		nonce: p.permit.nonce,
		deadline: p.permit.deadline,
	}
	return { witness, typedData: depositWitnessPermitTypedData(transfer, witness, b.permit2, b.l1ChainId) }
}

export function bridgeWithPermitCall(intent: RouterIntent, swapData: Hex, amount: bigint, permit: PermitTerms & { signature: Hex }): Hex {
	return encodeFunctionData({ abi: DEPOSIT_ROUTER_ABI, functionName: "bridgeWithPermit", args: [intent, swapData, amount, permit] })
}
