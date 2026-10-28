import { NO_FROM } from "@aztec-labs/aztec.js/account"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { BatchCall } from "@aztec-labs/aztec.js/contracts"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { FeeJuiceContract } from "@aztec-labs/aztec.js/protocol"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { Gas, type GasFees } from "@aztec-labs/stdlib/gas"
import type { Address, Hex } from "viem"
import { type FeeJuiceClaim, predictedWorstMinFees, publicFeeJuicePayment } from "../src/fee-juice"
import type { L1Ctx } from "../src/flows"
import { FeeJuicePortalAbi, type FuelDepositPlan, type FuelDepositReceipt, feeJuiceDepositArgs, parseFeeJuiceDeposit } from "../src/fuel"
import { PUBLIC_FUEL_CLAIM_GAS } from "../src/private-fuel"
import { approveExact } from "./script-l1"

/**
 * The canonical Fee Juice contract through `wallet`. When `node` is given, the address the wrapper
 * binds must equal the one the node reports: a mismatch means a wrong endpoint or a second Aztec
 * line in the process, and every balance or claim read through it would be against the wrong contract.
 */
export async function feeJuiceFor(wallet: Wallet, node?: Pick<AztecNode, "getNodeInfo">): Promise<FeeJuiceContract> {
	const fj = FeeJuiceContract.withWallet(wallet)
	if (node) {
		const reported = (await node.getNodeInfo()).protocolContractAddresses.feeJuice
		if (!reported.equals(fj.address)) throw new Error(`node reports FeeJuice at ${reported}, the wrapper binds ${fj.address}; STOP`)
	}
	return fj
}

/**
 * Deposits `plan` into the Fee Juice portal after approving exactly its amount. `onBroadcast` receives the
 * deposit's hash before its receipt, so an interrupted wait still leaves the operator something to look up.
 *
 * @throws when either transaction reverts, or the portal's event names another amount.
 */
export async function depositFeeJuicePublic(
	l1: L1Ctx,
	p: { asset: Address; portal: Address; plan: FuelDepositPlan; onBroadcast?: (hash: Hex) => void },
): Promise<FuelDepositReceipt> {
	await approveExact(l1, p.asset, p.portal, p.plan.amount)
	const hash = await l1.wallet.writeContract({
		address: p.portal,
		abi: FeeJuicePortalAbi,
		functionName: "depositToAztecPublic",
		args: feeJuiceDepositArgs(p.plan),
		account: l1.account,
		chain: l1.wallet.chain,
	} as never)
	p.onBroadcast?.(hash)
	const receipt = await l1.pub.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`depositToAztecPublic REVERTED (${hash}) — STOP`)
	const deposit = parseFeeJuiceDeposit(receipt.logs, p.portal)
	if (deposit.amount !== p.plan.amount) throw new Error(`deposit event amount ${deposit.amount} != planned ${p.plan.amount} — STOP`)
	return deposit
}

/** Explicit limits clamped to what the node admits per transaction (a local network caps DA gas lowest). */
export async function admittedLimits(node: Pick<AztecNode, "getNodeInfo">, gas: { daGas: number; l2Gas: number }): Promise<Gas> {
	const max = (await node.getNodeInfo()).txsLimits.gas
	return Gas.from({ daGas: Math.min(gas.daGas, max.daGas), l2Gas: Math.min(gas.l2Gas, max.l2Gas) })
}

/**
 * Gas settings for a transaction that pays its fee from the claim it carries. The fee limit is the claim's whole
 * budget (`claim_and_end_setup` refuses an amount below it), so the max fee is the predicted worst, unpadded.
 */
export async function selfPaidClaimGas(
	node: Pick<AztecNode, "getNodeInfo"> & Parameters<typeof predictedWorstMinFees>[0],
	gas: { daGas: number; l2Gas: number },
): Promise<{ gasLimits: Gas; teardownGasLimits: Gas; maxFeesPerGas: GasFees }> {
	const [gasLimits, maxFeesPerGas] = await Promise.all([admittedLimits(node, gas), predictedWorstMinFees(node)])
	return { gasLimits, teardownGasLimits: Gas.empty(), maxFeesPerGas }
}

/** The fee a transaction with these settings may be charged at most. */
export const feeLimitOf = (g: { gasLimits: Gas; maxFeesPerGas: GasFees }): bigint => g.gasLimits.computeFee(g.maxFeesPerGas).toBigInt()

/** A claim below its own fee limit cannot be sent, and waiting for fees to fall is the only remedy: refuse it here
 *  rather than prove a transaction the protocol rejects. */
function assertClaimCoversFee(claim: FeeJuiceClaim, gas: { gasLimits: Gas; maxFeesPerGas: GasFees }): void {
	const limit = feeLimitOf(gas)
	if (claim.claimAmount < limit) {
		throw new Error(
			`the claim of ${claim.claimAmount} FJ-wei is below its own fee limit ${limit} at today's fees; wait for fees to fall — STOP`,
		)
	}
}

/**
 * Limits of an account's first transaction when it deploys itself and pays from a claim in the same transaction:
 * the account's constructor, the multicall entrypoint and `claim_and_end_setup`. A 6.0.0 Schnorr account used
 * 742,498 L2 and 864 DA gas; the ~2.3× margin is {@link PUBLIC_FUEL_CLAIM_GAS}'s.
 */
export const ACCOUNT_CLAIM_DEPLOY_GAS = { daGas: 2_000, l2Gas: 1_710_000 } as const

/**
 * Claims `claim` to `from`'s public balance in a transaction with no app call, paying its fee from the claim
 * (`claim_and_end_setup` in setup). `from` must be initialized. The deposit's message must already be consumable.
 *
 * @returns the fee the transaction was charged.
 */
export async function claimFeeJuiceSelfPaid(p: {
	wallet: Wallet
	node: AztecNode
	from: AztecAddress
	claim: FeeJuiceClaim
}): Promise<bigint> {
	const gasSettings = await selfPaidClaimGas(p.node, PUBLIC_FUEL_CLAIM_GAS)
	assertClaimCoversFee(p.claim, gasSettings)
	const sent = (await new BatchCall(p.wallet, []).send({
		from: p.from,
		fee: { paymentMethod: publicFeeJuicePayment(p.from, p.claim), gasSettings },
		wait: { waitForStatus: TxStatus.PROPOSED },
	} as never)) as unknown as { receipt: { transactionFee?: bigint } }
	return sent.receipt.transactionFee ?? 0n
}

/**
 * Deploys `manager`'s account in a transaction that pays its fee from `claim`: aztec.js routes the claim through the
 * account's own entrypoint while the multicall entrypoint runs its constructor. The only way to start an account on
 * a network without a sponsor. The deposit's message must already be consumable.
 *
 * @returns the fee the transaction was charged.
 */
export async function claimAndDeployAccount(p: {
	node: AztecNode
	manager: { getDeployMethod: () => Promise<{ send: (o: never) => Promise<unknown> }> }
	from: AztecAddress
	claim: FeeJuiceClaim
}): Promise<bigint> {
	const gasSettings = await selfPaidClaimGas(p.node, ACCOUNT_CLAIM_DEPLOY_GAS)
	assertClaimCoversFee(p.claim, gasSettings)
	const method = await p.manager.getDeployMethod()
	const sent = (await method.send({
		from: NO_FROM,
		fee: { paymentMethod: publicFeeJuicePayment(p.from, p.claim), gasSettings },
		wait: { waitForStatus: TxStatus.PROPOSED },
	} as never)) as { receipt: { transactionFee?: bigint } }
	return sent.receipt.transactionFee ?? 0n
}
