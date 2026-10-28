/**
 * Fee-juice payment for the bridge's L2 txs: pay gas by claiming bridged Fee Juice in the
 * same tx (the headline "land Fee Juice in one transaction"), or bootstrap via the
 * sandbox/testnet sponsored FPC before any FJ has been bridged. Thin aztec.js wrappers — the
 * caller passes the connected sender + the L1→L2 claim the Fee-Juice deposit produced.
 *
 * Private-fuel note: aztec.js 4.2.0's `PrivateFeePaymentMethod` is `@deprecated` (unsupported
 * on mainnet) and the Wonderland private-FPC path needs an FPC deployed + sandbox validation,
 * so paying gas from a privately-held FJ note is deferred. `FeeJuicePaymentMethodWithClaim`
 * is the supported one-tx path and works for a claim from either a public or private deposit
 * (it consumes the L1→L2 message by leaf index, regardless of how the deposit was made).
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { L2AmountClaim } from "@aztec-labs/aztec.js/ethereum"
import { type FeePaymentMethod, FeeJuicePaymentMethodWithClaim, SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { GasFees, ManaUsageEstimate } from "@aztec-labs/stdlib/gas"
import { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { FEE_JUICE_ADDRESS } from "@aztec-labs/constants"

/** The canonical L2 Fee Juice contract address — a protocol constant (identical on every network). */
export const feeJuiceAddress: string = AztecAddress.fromNumberUnsafe(FEE_JUICE_ADDRESS).toString()

/** Minimal node shape for fee prediction (avoids a hard dep on the full node client type). */
export type MinFeeNode = {
	getPredictedMinFees?: (manaUsage?: ManaUsageEstimate) => Promise<GasFees[]>
	getCurrentMinFees: () => Promise<GasFees>
}

/**
 * The protocol's worst-case min fee across predicted future slots — the inclusion-safe basis for a
 * committed `maxFeesPerGas`. Mirrors `@aztec-labs/wallets` `base_wallet.getMinFees`: take the highest
 * `feePerL2Gas` from `getPredictedMinFees()`, falling back to `getCurrentMinFees()` on older nodes.
 *
 * A claim is built (simulated + proven) seconds-to-minutes before it lands; committing only the
 * CURRENT min fee risks an inclusion-time reject if the base fee rises in that window. The predicted
 * worst-case bounds that window. For an FPC-budgeted claim this also fixes the ceiling the FPC checks
 * (`gasLimits·maxFeesPerGas`), so the bridged amount can be sized against a stable, known number.
 */
export async function predictedWorstMinFees(node: MinFeeNode): Promise<GasFees> {
	if (!node.getPredictedMinFees) return node.getCurrentMinFees()
	let predicted: GasFees[]
	try {
		// Limit-congestion estimate (blocks at max capacity), matching BaseWallet's conservative default -
		// an argless call defaults the node to Target, which under-prices the cap under rising congestion.
		predicted = await node.getPredictedMinFees(ManaUsageEstimate.Limit)
	} catch (e) {
		// Only fall back for old nodes that don't IMPLEMENT the method — NOT for
		// transient RPC errors (a silent fallback to current-min would under-price
		// the inclusion-safe cap → the tx can be rejected for insufficient fee).
		// Mirror BaseWallet's method-missing predicate: Aztec's JSON-RPC server
		// emits `Method not found: <m>` with code -32601 and the client rethrows it
		// verbatim with `cause = response.error`. A bare "not found" (e.g. "block
		// not found") is a transient error and MUST propagate.
		const code = (e as { cause?: { code?: number } } | null | undefined)?.cause?.code
		const msg = e instanceof Error ? e.message : String(e)
		if (code === -32601 || /method not found/i.test(msg)) return node.getCurrentMinFees()
		throw e
	}
	if (!predicted || predicted.length === 0) return node.getCurrentMinFees()
	// Component-wise worst across slots (max each fee independently) — a true upper bound even if the DA
	// and L2 fees peak in different slots, so the committed cap is never under-priced on either axis.
	const first = predicted[0]
	if (!first) return node.getCurrentMinFees()
	let worstDa = first.feePerDaGas
	let worstL2 = first.feePerL2Gas
	for (const f of predicted) {
		if (f.feePerDaGas > worstDa) worstDa = f.feePerDaGas
		if (f.feePerL2Gas > worstL2) worstL2 = f.feePerL2Gas
	}
	return new GasFees(worstDa, worstL2)
}

/**
 * The mainnet deploy sequence's worst-case L2 tx count: the deployer account deploy + the three
 * contract deploys (proxy, token, bridge) + two wiring txs + the PrivateFPC deploy. The bridged
 * fee-juice budget MUST cover the WHOLE sequence, not one claim — under-sizing stalls a live-money
 * deploy mid-sequence (recoverable via the stable deployer, but a stall nonetheless).
 */
export const DEPLOY_SEQUENCE_TX_COUNT = 7

/** The full-sequence fee-juice budget: per-tx worst-case fee limit × the whole sequence. */
export function deploySequenceFeeBudget(perTxFeeLimit: bigint, txCount: number = DEPLOY_SEQUENCE_TX_COUNT): bigint {
	if (perTxFeeLimit <= 0n) throw new Error("deploySequenceFeeBudget: perTxFeeLimit must be positive")
	if (!Number.isInteger(txCount) || txCount < 1) throw new Error("deploySequenceFeeBudget: txCount must be a positive integer")
	return perTxFeeLimit * BigInt(txCount)
}

/** The L1→L2 claim a Fee-Juice bridge deposit produced; the preimage the L2 claim consumes. */
export type FeeJuiceClaim = Pick<L2AmountClaim, "claimAmount" | "claimSecret" | "messageLeafIndex">

/**
 * Pay L2 gas by claiming bridged Fee Juice in the same tx (`claim_and_end_setup`). `claim` is
 * what the L1 Fee-Juice deposit returned — amount + secret + the Inbox leaf index.
 */
export const publicFeeJuicePayment = (sender: AztecAddress, claim: FeeJuiceClaim): FeeJuicePaymentMethodWithClaim =>
	new FeeJuicePaymentMethodWithClaim(sender, claim)

/**
 * Bootstrap gas via a sponsored FPC (the sandbox + testnet pre-deploy one) — pays for the
 * bridge's L2 txs before the user holds any Fee Juice of their own.
 */
export const sponsoredFeePayment = (fpc: AztecAddress): SponsoredFeePaymentMethod => new SponsoredFeePaymentMethod(fpc)

/**
 * Pay L2 gas from the sender's ALREADY-CLAIMED public Fee-Juice balance, through an aztec.js /
 * wallet-sdk EmbeddedWallet. aztec.js 5.x ships no class for this because the protocol needs no
 * calls at all: the account entrypoint's meta payment method routes a zero-call fee payload as
 * PREEXISTING_FEE_JUICE, and wallet-sdk's `completeFeeOptions` routes an ABSENT payer the same
 * way — while a payload naming the sender as payer is routed as a claim in setup
 * (FEE_JUICE_WITH_CLAIM), which never ends setup without a `claim_and_end_setup` call. So the
 * payload must stay empty and name nobody. This is the mainnet deploy sequence's steady-state
 * method after the claim-in-tx bootstrap. It is NOT a way for a dApp to name the account's public
 * Fee Juice through the Nulo wallet, where an absent payer means the user's own fee picker.
 */
export const preexistingFeeJuicePayment = (sender: AztecAddress): FeePaymentMethod => ({
	getAsset: () => Promise.resolve(AztecAddress.fromNumberUnsafe(FEE_JUICE_ADDRESS)),
	getExecutionPayload: () => Promise.resolve(ExecutionPayload.empty()),
	getFeePayer: () => Promise.resolve(sender),
	getGasSettings: () => undefined,
})

/**
 * Name the account's own public Fee Juice as a dApp transaction's payer through a wallet that supports it:
 * the payload carries the sender as payer and no fee call, which that wallet routes as a
 * requested self-pay (its own Fee Juice method over the preexisting balance, the fee card locked
 * to it). Only for a wallet that advertises the routing (`getWalletFeatures` → "dapp-self-pay"):
 * an aztec.js / wallet-sdk EmbeddedWallet routes this same shape as a claim in setup and builds
 * an invalid transaction — use {@link preexistingFeeJuicePayment} there.
 */
export const selfPaidFeeJuicePayment = (sender: AztecAddress): FeePaymentMethod => ({
	getAsset: () => Promise.resolve(AztecAddress.fromNumberUnsafe(FEE_JUICE_ADDRESS)),
	getExecutionPayload: () => Promise.resolve(new ExecutionPayload([], [], [], [], sender)),
	getFeePayer: () => Promise.resolve(sender),
	getGasSettings: () => undefined,
})

/**
 * The FeeJuice claim call args for claiming bridged Fee Juice as a standalone payload
 * (use plain `claim` for an app-phase call — only the
 * fee payload may `claim_and_end_setup`). Use when claiming FJ to balance rather than
 * binding the claim to a single tx's fee via {@link publicFeeJuicePayment}.
 */
export const feeJuiceClaimArgs = (
	to: string,
	amount: bigint,
	secret: string,
	messageLeafIndex: bigint,
): readonly [string, bigint, string, bigint] => [to, amount, secret, messageLeafIndex]
