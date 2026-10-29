/**
 * Whether a fuel message is settled, and the standalone self-paid claim that settles it. Only inclusion-grade
 * evidence settles: an included receipt, or the message's own nullifier at a checkpoint. A PROPOSED block can
 * still drop, and a latch taken on it would hide the recovery of Fee Juice that was never claimed.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { PRIVATE_HUB_CLAIM_GAS } from "../protocol/private-fuel.ts"
import type { DepositFuelBlock } from "../records.ts"
import { type FeeLadderEnv, patchFuel, walletFeesOrNull } from "./fee-env.ts"
import { FeeStopError } from "./fee-stop.ts"
import { buildFuelClaimInteraction } from "./fuel-claim.ts"
import type { FuelReceiptStatus } from "./fuel-claim-state.ts"
import { isMsgConsumed } from "./message-errors.ts"
import { feeJuiceMessageNullifier } from "./message-nullifier.ts"

const FUEL_POLL_MS = 6000
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** How long a settlement poll may run: `tries` reads, `pollMs` apart, each given `readMs` before
 *  a node that accepted the request but never answers counts as unreadable. */
export interface PollBudget {
	tries?: number
	pollMs?: number
	readMs?: number
}

/** `read` raced against `ms`: a transport with no deadline of its own must not hold the caller's
 *  operation span open forever. */
function withDeadline<T>(read: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const expiry = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("read timed out")), ms)
	})
	return Promise.race([read, expiry]).finally(() => clearTimeout(timer))
}

/** Whether the fuel message's own nullifier is CHECKPOINTED, polled at the inclusion cadence. A
 *  consumed-shaped send error proves only a PROPOSED consumption; a block that later drops leaves
 *  the Fee Juice unclaimed, so the latch waits for the checkpoint. `"unknown"` when the block holds
 *  no message key or public secret, or the node cannot answer — never a latch. */
export async function fuelMessageCheckpointed(
	env: Pick<FeeLadderEnv, "node">,
	fuel: DepositFuelBlock,
	budget: PollBudget = {},
): Promise<boolean | "unknown"> {
	const { tries = 40, pollMs = FUEL_POLL_MS, readMs = 30_000 } = budget
	if (!fuel.messageHash || fuel.secret === undefined) return "unknown"
	let nullifier: Fr
	try {
		nullifier = await feeJuiceMessageNullifier({ messageHash: fuel.messageHash, secret: fuel.secret })
	} catch {
		return "unknown"
	}
	for (let i = 0; i < tries; i++) {
		try {
			if ((await withDeadline(env.node.getNullifierMembershipWitness("checkpointed", nullifier), readMs)) !== undefined) return true
		} catch {
			return "unknown"
		}
		if (i + 1 < tries) await pause(pollMs)
	}
	return false
}

export async function fuelReceiptStatus(env: Pick<FeeLadderEnv, "node">, txHash: string): Promise<FuelReceiptStatus> {
	try {
		const receipt = await env.node.getTxReceipt(TxHash.fromString(txHash))
		const status = String(receipt?.status ?? "pending").toLowerCase()
		// A mined status is inclusion whatever the execution result: a transaction that reverted past
		// its setup still landed, the fee was charged and the Fee Juice message its setup consumed is
		// spent — so it counts as included for the fuel's sake, never as a claim to retry.
		if (/checkpointed|proven|finalized|success|mined/.test(status)) return "included"
		if (status.includes("dropped")) return "dropped"
		return "pending"
	} catch {
		return "pending" // an unreachable node is not-yet-evidence, never consumption.
	}
}

/** Poll a just-sent claim to INCLUSION (bounded). PROPOSED is not consumption; only an included
 *  receipt settles the Fee Juice message. "pending" on timeout, so the caller leaves the record
 *  unsettled and the recovery stays offered. */
export async function waitForFuelInclusion(env: Pick<FeeLadderEnv, "node">, txHash: string, tries = 40): Promise<FuelReceiptStatus> {
	for (let i = 0; i < tries; i++) {
		const s = await fuelReceiptStatus(env, txHash)
		if (s !== "pending") return s
		await pause(FUEL_POLL_MS)
	}
	return "pending"
}

/** Claim a public fueled deposit's Fee Juice as a standalone SELF-PAID transaction (the claim pays its
 *  own fee from the Fee Juice it lands — no sponsor, on any network), INCLUSION-GATED. The message is
 *  recipient-bound, so this is safe whenever the fuel isn't known-consumed; an already-consumed message
 *  reverts but still reads INCLUDED (its nullifier exists), which settles it just the same.
 *  `standaloneClaimed` latches ONLY after inclusion: a dropped or timed-out claim leaves it unset so the
 *  recovery stays offered. Under a fee spike the bridged amount cannot cover its own claim and the
 *  builder refuses: the Fee Juice stays claimable until fees ease. */
export async function sendStandaloneFjClaim(
	env: FeeLadderEnv,
	aztec: unknown,
	recipientAddr: AztecAddress,
	fuel: DepositFuelBlock,
	id: string,
	budget: PollBudget = {},
): Promise<void> {
	const claimMaxFees = await walletFeesOrNull(env, aztec, recipientAddr, PRIVATE_HUB_CLAIM_GAS)
	if (claimMaxFees === null) throw new FeeStopError("unpriced-by-wallet")
	const claim = await buildFuelClaimInteraction(
		{ fuel, isPrivate: false },
		{
			aztec,
			node: env.node,
			privateFpc: env.privateFpc,
			recipient: recipientAddr,
			minFloorFj: env.minFloorFj,
			maxFeesPerGas: { feePerDaGas: claimMaxFees.feePerDaGas, feePerL2Gas: claimMaxFees.feePerL2Gas },
			resolvedSecret: fuel.secret,
		},
	)
	let receiptTxHash: string
	try {
		receiptTxHash = (await claim.send()).txHash
	} catch (e) {
		// A consumed-shaped refusal says an earlier claim spent the message — but only as far as a
		// PROPOSED block; the latch needs the nullifier checkpointed, or a dropped block would hide
		// the recovery of Fee Juice that was never claimed. Must be the consumed shape, NOT
		// not-ready: a not-yet-anchored message has no nullifier to read.
		if (!isMsgConsumed(e instanceof Error ? e.message : String(e))) throw e
		const settled = await fuelMessageCheckpointed(env, fuel, budget)
		if (settled !== true) throw new FeeStopError(settled === false ? "consumed-unconfirmed" : "consumed-unreadable")
		patchFuel(env, id, fuel, { standaloneClaimed: true })
		env.log("standalone FJ claim: message already consumed and checkpointed - gas already in wallet", id)
		return
	}
	if ((await waitForFuelInclusion(env, receiptTxHash)) !== "included") throw new FeeStopError("standalone-unconfirmed")
	patchFuel(env, id, fuel, { standaloneClaimed: true })
	env.log("standalone FJ claim confirmed", id)
}
