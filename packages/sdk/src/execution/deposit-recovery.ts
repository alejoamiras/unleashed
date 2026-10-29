/**
 * Deposit-leg recovery: the leg is chain-recoverable from the recorded `depositTxHash` alone (every flow
 * persists the hash BEFORE waiting), so a flow that died mid-wait — an L1 timeout, a closed tab — completes
 * here instead of stranding a confirmed deposit.
 */
import type { Log } from "viem"
import type { DepositRecord } from "../records.ts"
import { type FeeLadderEnv, patchFuel, type RecordPatch } from "./fee-env.ts"
import { FeeStopError } from "./fee-stop.ts"
import { emittedBy, readLegacySendLeaves } from "./legacy-router.ts"
import { depositExpectationOf } from "./router-receipt.ts"
import { type FuelRoute, readSendInbox, readSendReceiptLeaves, type SendGeneration, type SendResult } from "./send-flow.ts"

type Hex = `0x${string}`

/** The reads the recovery needs: the receipt, and the factory's frozen Inbox the leaves are checked against. */
export interface RecoveryL1Client {
	getTransactionReceipt: (args: { hash: Hex }) => Promise<{ status: string; logs: unknown[] } | null>
	readContract: (args: never) => Promise<unknown>
}

/** The leaves a landed send produced. A deposit through a retired router reads that router's own
 *  events; any other must be the deposit router's one `Deposited` for this record, authenticated
 *  leg by leg. A first deposit's receipt also carries the factory's register leaf, so the Inbox
 *  events alone would name the wrong one. Store-free; `FeeStopError("no-bridge")` when no router of
 *  the receipt is known. */
export async function readDepositLeaves(
	rec: DepositRecord,
	logs: Log[],
	pub: RecoveryL1Client,
	generation: FuelRoute | undefined,
	legacyRouters: readonly Hex[],
): Promise<Partial<SendResult>> {
	const hash = rec.depositTxHash as Hex
	const legacy = legacyRouters.find((router) => emittedBy(router, logs))
	if (legacy && !(generation && emittedBy(generation.router, logs))) return readLegacySendLeaves(legacy, rec.intent, hash, logs)
	if (!generation) throw new FeeStopError("no-bridge")
	const inbox = await readSendInbox(pub as never, generation)
	return readSendReceiptLeaves(generation, inbox, depositExpectationOf(rec), hash, logs as never)
}

function recoverSendLeg(env: Pick<FeeLadderEnv, "records" | "log">, rec: DepositRecord, leaves: Partial<SendResult>): "recovered" {
	const patch: RecordPatch = {}
	if (leaves.tokenLeafIndex !== undefined) {
		patch.leafIndex = leaves.tokenLeafIndex.toString()
		patch.messageHash = leaves.tokenMessageHashHex
	}
	if (leaves.fuelLeafIndex !== undefined && rec.fuel) {
		if (rec.intent === "gas") patch.leafIndex = leaves.fuelLeafIndex.toString()
		const fuel = {
			leafIndex: leaves.fuelLeafIndex.toString(),
			messageHash: leaves.fuelMessageHashHex,
			received: (leaves.fuelReceived ?? 0n).toString(),
		}
		if (!patchFuel(env, rec.id, rec.fuel, fuel, patch)) throw new FeeStopError("record-changed")
		return "recovered"
	}
	env.records.merge(rec.id, patch)
	return "recovered"
}

/**
 * Recover a deposit leg from its receipt, patching the fields the live flow writes after it. `depositL2Block`
 * stays unset, so a claim engine skips the display countdown and goes straight to its consumability gate: a
 * recovered deposit is old, and its message is likely consumable already. "pending" while the receipt is not
 * readable yet.
 */
export async function recoverDepositLeg(
	env: Pick<FeeLadderEnv, "records" | "log">,
	rec: DepositRecord | { schema: 1 | 2 },
	publicClient: RecoveryL1Client,
	generation: SendGeneration | undefined,
	legacyRouters: readonly Hex[],
): Promise<"pending" | "recovered"> {
	if (rec.schema !== 3) throw new FeeStopError("record-predates-send")
	const receipt = await publicClient.getTransactionReceipt({ hash: rec.depositTxHash as Hex }).catch(() => null)
	if (!receipt) return "pending"
	if (receipt.status !== "success") throw new FeeStopError("deposit-reverted")
	return recoverSendLeg(env, rec, await readDepositLeaves(rec, receipt.logs as Log[], publicClient, generation, legacyRouters))
}
