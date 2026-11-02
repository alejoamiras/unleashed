/**
 * The L2→L1 withdraw consumption the frontend drives and the sandbox smoke proves, and the connected
 * L1 context every flow takes. Deposits live in `send-flow.ts`. Framework-agnostic (no Vue).
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { waitForProven } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { computeL2ToL1MessageHash } from "@aztec-labs/stdlib/hash"
import { computeL2ToL1MembershipWitness, getL2ToL1MessageLeafId } from "@aztec-labs/stdlib/messaging"
import { OutboxContract } from "@aztec-labs/ethereum/contracts"
import type { Abi, Account, Address, Hex, PublicClient, WalletClient } from "viem"
import { withdrawContentHash } from "../protocol/content-hash.ts"
import { PORTAL_IMPL_CONSTANTS_ABI } from "../protocol/factory-abi.ts"

/** The connected L1 surface the flows need (a viem wallet + public client + account). */
export interface L1Ctx {
	pub: PublicClient
	wallet: WalletClient
	account: Account
}

type AztecNodeClient = ReturnType<typeof createAztecNodeClient>

/** L2→L1 withdraw finalization stages, surfaced to the UI for the loading bar. */
export type WithdrawFlowStage = "proving" | "consuming" | "done"

/** What the L1 Outbox `withdraw` consume needs: the L1 recipient + amount + the canonical portal. */
export interface WithdrawConsumeParams {
	recipientL1: Address
	amount: bigint
	portal: Address
	portalAbi: Abi
	/** Seconds to wait for the burn's epoch to prove (aztec.js default 600 — raise for slow networks like the live testnet). */
	provenTimeoutSec?: number
	/** The consume hash the moment it exists — a caller with a journal records it here so a crash mid-wait still knows
	 *  which transaction to finish. Awaited before the receipt wait; a throw rejects the call although the transaction
	 *  is already sent. */
	onSent?: (txHash: Hex) => void | Promise<void>
}

/**
 * Finalize an L2→L1 withdraw once the `exit_to_l1` tx has landed on L2: wait for it to be
 * proven, build the L2→L1 membership witness, and consume it on the L1 Outbox via the portal's
 * `withdraw`. Identical for public + private exits — only the L2 burn authwit (done by the
 * caller before the exit) differs. The sandbox smoke runs exactly this tail for both flows.
 */
export async function consumeWithdrawal(
	l1: L1Ctx,
	node: AztecNodeClient,
	exitReceipt: { txHash: unknown },
	p: WithdrawConsumeParams,
	onStage?: (s: WithdrawFlowStage) => void,
): Promise<{ consumeTxHash: Hex }> {
	onStage?.("proving")
	await waitForProven(node, exitReceipt as never, (p.provenTimeoutSec ? { provenTimeout: p.provenTimeoutSec } : undefined) as never)
	const eff = await node.getTxEffect(exitReceipt.txHash as never)
	if (!eff) throw new Error("no tx effect for exit")
	const messageHash = eff.data.l2ToL1Msgs[0]
	if (!messageHash) throw new Error("no L2→L1 message in exit tx")
	// 5.0: computeL2ToL1MembershipWitness needs the L1 Outbox roots reader (2nd arg) to pick the
	// partial-proof root covering the tx's checkpoint. OutboxContract.getRoots satisfies OutboxRootsReader.
	const { l1ContractAddresses } = await node.getNodeInfo()
	const outbox = new OutboxContract(l1.pub as never, l1ContractAddresses.outboxAddress)
	const wit = await computeL2ToL1MembershipWitness(node, outbox, messageHash, exitReceipt.txHash as never, 0)
	if (!wit) throw new Error("L2→L1 witness not available")
	const path = wit.siblingPath.toBufferArray().map((b: Buffer) => `0x${b.toString("hex")}` as `0x${string}`)
	onStage?.("consuming")
	const req = await l1.pub.simulateContract({
		address: p.portal,
		abi: p.portalAbi,
		functionName: "withdraw",
		// 5.0 portal `withdraw` args: (recipient, amount, withCaller, epoch, numCheckpointsInEpoch, leafIndex, path).
		// numCheckpointsInEpoch is new (sits BEFORE leafIndex) — the witness now carries it.
		args: [p.recipientL1, p.amount, false, BigInt(wit.epochNumber), BigInt(wit.numCheckpointsInEpoch), wit.leafIndex, path] as never,
		account: l1.account,
	})
	const consumeTxHash = (await l1.wallet.writeContract(req.request as never)) as Hex
	await p.onSent?.(consumeTxHash)
	await l1.pub.waitForTransactionReceipt({ hash: consumeTxHash })
	onStage?.("done")
	return { consumeTxHash }
}

const ZERO_L1 = `0x${"0".repeat(40)}`

/** The facts an exit's L2→L1 message commits to: the hub that sent it, the token portal it names, the withdraw's
 *  recipient and amount, and the rollup it was sent on. */
export interface WithdrawMessageFacts {
	hub: string
	portal: string
	recipientL1: string
	amount: bigint
	chainId: number
	rollupVersion: number
}

/** The L2→L1 message an exit's burn emits. The portal's `withdraw` takes no caller (`withCaller = false`), so the
 *  content binds the zero address there. The hash carries no nonce: two exits with the same facts share it. */
export async function withdrawMessageHash(m: WithdrawMessageFacts): Promise<string> {
	const content = await withdrawContentHash(m.recipientL1, m.amount, ZERO_L1)
	return computeL2ToL1MessageHash({
		l2Sender: AztecAddress.fromStringUnsafe(m.hub),
		l1Recipient: EthAddress.fromString(m.portal),
		content: Fr.fromString(content),
		rollupVersion: new Fr(m.rollupVersion),
		chainId: new Fr(m.chainId),
	}).toString()
}

/**
 * Whether the Outbox the token portal is bound to has consumed `expected.messageHash` at the position the node
 * reports for this exit. The Outbox is read from the portal on L1, never from the node, and a transaction whose
 * first message is not the expected one reads as not consumed.
 *
 * `true` says a message with this hash was consumed; exits with the same hub, portal, recipient and amount share the
 * hash, so it never establishes that a given record finished. Unknowable answers (a missing effect, an unproven
 * epoch) read as `false`.
 */
export async function isOutboxMessageConsumed(
	l1: L1Ctx,
	node: AztecNodeClient,
	exitReceipt: { txHash: unknown },
	expected: { portal: Address; messageHash: string },
): Promise<boolean> {
	const message = Fr.fromString(expected.messageHash)
	const eff = await node.getTxEffect(exitReceipt.txHash as never)
	const reported = eff?.data.l2ToL1Msgs[0]
	if (!reported?.equals(message)) return false
	const outboxAddress = (await l1.pub.readContract({
		address: expected.portal,
		abi: PORTAL_IMPL_CONSTANTS_ABI,
		functionName: "OUTBOX",
	})) as Address
	const outbox = new OutboxContract(l1.pub as never, outboxAddress)
	const wit = await computeL2ToL1MembershipWitness(node, outbox, message, exitReceipt.txHash as never, 0)
	if (!wit) return false
	return outbox.hasMessageBeenConsumedAtEpoch(wit.epochNumber, getL2ToL1MessageLeafId(wit))
}
