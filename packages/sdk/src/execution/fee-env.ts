/**
 * What the claim fee ladder takes from its host — the record store, the network and the account's balances — and the
 * helpers every rung shares. The ladder holds no state of its own.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { DepositFuelBlock, DepositRecord } from "../records.ts"
import { type GasLimits, type MaxFees, walletMaxFees } from "./wallet-fee-budget.ts"

/** The record facts the ladder reads. Every deposit record shape satisfies it, a hub claim's and a gas-only one's. */
export interface FeeLadderRecord {
	id: string
	isPrivate: boolean
	schema: 1 | 2 | 3
	intent?: "token" | "token+gas" | "gas"
	depositTxHash?: string
	fuel?: DepositFuelBlock
}

/** A stored record as the ladder re-reads it. */
export type StoredRecord = { fuel?: DepositFuelBlock }

/** What the ladder writes: the fuel block, and the fields a recovered deposit leg or a registration fills in. */
export type RecordPatch = Partial<Pick<DepositRecord, "fuel" | "leafIndex" | "messageHash" | "registerTxHash">>

export interface FeeLadderStore {
	/** The PERSISTED record, which may be newer than the copy a claim was built from; undefined when the id is gone. */
	current: (id: string) => StoredRecord | undefined
	/** Writes `patch(current)` when `when(current)` holds, guard and merge over one synchronous load; false when the id
	 *  is gone or the guard refuses. The merge is shallow: a `fuel` in the patch replaces the stored block. */
	mergeWhen: (id: string, when: (current: StoredRecord) => boolean, patch: (current: StoredRecord) => RecordPatch) => boolean
	merge: (id: string, patch: RecordPatch) => void
}

export interface FeeLadderEnv {
	records: FeeLadderStore
	/** The network's node: receipts, nullifier witnesses, fee predictions and the per-transaction gas maximum. */
	node: AztecNode
	/** The network's canonical PrivateFPC. */
	privateFpc: string
	/** The send route's calibrated fuel budget; undefined on a network without one. */
	fuel: { minFuelFj: string } | undefined
	/** The floor a direct Fee Juice claim must clear to pay for itself; undefined refuses every such claim. */
	minFloorFj: bigint | undefined
	/** The account's public Fee Juice. A throw reads as unread, never as zero. */
	readPublicFeeJuice: (aztec: unknown, account: AztecAddress) => Promise<bigint>
	/** The account's private Fee Juice credit at the PrivateFPC. A throw reads as unread, never as zero. */
	readPrivateFeeJuice: (aztec: unknown, account: AztecAddress) => Promise<bigint>
	/** The highest max fees per gas a wallet's quote may carry (`feeBoundOf`); a throw leaves the fee unpriced. */
	feeBound: () => Promise<MaxFees>
	/** Receives ids, decisions and transaction hashes only, never a secret or a salt. */
	log: (...args: unknown[]) => void
}

/** Whether `live` is the fuel block `captured` describes: the same secret commitment and, once
 *  both know it, the same message key. A re-send under the same id swaps in a block with neither. */
function sameFuelBlock(live: DepositFuelBlock, captured: DepositFuelBlock): boolean {
	if (live.secretHashHex !== captured.secretHashHex) return false
	return !live.messageHash || !captured.messageHash || live.messageHash === captured.messageHash
}

/** Merge explicit fields into the record's PERSISTED fuel block (never a captured copy: the store's
 *  merge is shallow, so a nested `fuel` write replaces the block, and every claim-path write runs
 *  long after its builder captured the record). The captured block is the fallback when the record
 *  holds no live copy (a wiped block). A live block that is not the captured one is another
 *  deposit's fuel (a re-send swapped it in under the same id): a patch computed for the captured
 *  block would settle a message nobody consumed, so the write is refused and `false` says so.
 *  `topLevel` rides in the same write so a site that also patches record fields keeps one write. */
export function patchFuel(
	env: Pick<FeeLadderEnv, "records" | "log">,
	id: string,
	captured: DepositFuelBlock | undefined,
	patch: Partial<DepositFuelBlock>,
	topLevel: RecordPatch = {},
): boolean {
	const written = env.records.mergeWhen(
		id,
		(rec) => !!(rec.fuel ?? captured) && !(rec.fuel && captured && !sameFuelBlock(rec.fuel, captured)),
		(rec) => ({ ...topLevel, fuel: { ...(rec.fuel ?? captured), ...patch } as DepositFuelBlock }),
	)
	if (!written) env.log("fuel patch refused: the record is gone or holds a different fuel block", id)
	return written
}

/** The max fees the connected wallet will submit under, or null when it cannot say or says more than
 *  `env.feeBound` allows (logged): every ceiling is `limits × this`, kept in full by the FPC, so a
 *  figure the wallet did not give, or one above the bound, is not one to fund an irreversible step on. */
export async function walletFeesOrNull(
	env: Pick<FeeLadderEnv, "node" | "log" | "feeBound">,
	aztec: unknown,
	gas: GasLimits,
): Promise<MaxFees | null> {
	try {
		return await walletMaxFees(env.node, aztec, gas, env.feeBound)
	} catch (e) {
		env.log("wallet fee quote failed (fail-closed → null):", e instanceof Error ? e.message : String(e))
		return null
	}
}

/** A Fee Juice balance, with a read FAILURE as `null` (≠ a real zero), so a fee-source decision can
 *  FAIL CLOSED: never fabricate a spendable balance, never a false "no gas", when a transient read
 *  error hides whether the account holds gas. */
export async function readFeeJuiceOrNull(
	env: Pick<FeeLadderEnv, "log">,
	label: string,
	read: () => Promise<bigint>,
): Promise<bigint | null> {
	try {
		return await read()
	} catch (e) {
		env.log(`${label} balance read failed (fail-closed → null):`, e instanceof Error ? e.message : String(e))
		return null
	}
}
