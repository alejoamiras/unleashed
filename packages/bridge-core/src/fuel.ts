/**
 * Direct Fee-Juice bridge primitives: deposit the L1 fee asset straight into the canonical
 * `FeeJuicePortal` and claim it on L2 as gas — no swap, no token leg. The naive sibling of the
 * swap-based fuel add-on (`l1.ts` / the router), and deliberately decoupled from it: the canonical
 * portal is part of the rollup, so nothing here depends on the forked-V4 swap deployment.
 *
 * Public and private deposits use the SAME L1 call (`depositToAztecPublic`) — the `FeeJuicePortal`
 * has no private deposit variant. Privacy is purely an L2-claim concern: a private deposit lands at
 * the PrivateFPC with a claimer-bound secret, a public one lands recipient-bound. The leaf index for
 * the L2 claim comes from the portal's own `DepositToAztecPublic` event, NOT the Inbox.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { FeeJuicePortalAbi } from "@aztec-foundation/l1-artifacts"
import { computeSecretHash } from "@aztec-labs/stdlib/hash"
import { ExecutionPayload, mergeExecutionPayloads } from "@aztec-labs/stdlib/tx"
import { type Hex, type Log, parseEventLogs } from "viem"
import { PRIVATE_FPC_ADDRESS, deriveBridgeSecret, privateFuelSecretHash } from "./private-fuel"

/** Re-exported so consumers get the canonical FeeJuicePortal ABI from one place (the bridge-core boundary). */
export { FeeJuicePortalAbi }

/** A planned L1 Fee-Juice deposit: the `depositToAztecPublic(to, amount, secretHash)` inputs plus the
 *  claim secret. PUBLIC ⇒ `to` is the recipient and `secret` is random (persist it). PRIVATE ⇒ `to` is
 *  the PrivateFPC and `secret = deriveBridgeSecret(salt, claimer)` (persist the `salt`; the secret is
 *  reconstructable from `msg_sender` inside `mint_and_pay_fee`). */
export interface FuelDepositPlan {
	to: Hex
	amount: bigint
	secretHash: Hex
	secret: Fr
	isPrivate: boolean
	/** Private only: the per-deposit bridge-secret salt — the SOLE recovery input for a private claim. */
	salt?: Fr
}

/** Plan a PUBLIC fee-juice deposit: lands recipient-bound, claimed to the public Fee-Juice balance.
 *  `secret` may be supplied for a DETERMINISTIC plan (e.g. derived from a deployer secret) so a
 *  crash between the L1 deposit and the L2 claim is resumable with no secret persisted anywhere;
 *  a leaked public-deposit secret is grief-free regardless (the claim is recipient-bound). */
export async function planPublicFuelDeposit(recipient: AztecAddress, amount: bigint, secret: Fr = Fr.random()): Promise<FuelDepositPlan> {
	const secretHash = await computeSecretHash(secret)
	return { to: recipient.toString() as Hex, amount, secretHash: secretHash.toString() as Hex, secret, isPrivate: false }
}

/** Plan a PRIVATE fee-juice deposit: lands at the PrivateFPC, claimer-bound. A RANDOM secret would
 *  strand the FJ forever — the claimer reconstructs `deriveBridgeSecret(salt, claimer)` from `msg_sender`,
 *  so the secret MUST be derived, never random (mirrors the private swap-fuel invariant). */
export async function planPrivateFuelDeposit(claimer: AztecAddress, amount: bigint, salt: Fr = Fr.random()): Promise<FuelDepositPlan> {
	const secret = deriveBridgeSecret(salt, claimer)
	const secretHash = await privateFuelSecretHash(salt, claimer)
	return { to: PRIVATE_FPC_ADDRESS as Hex, amount, secretHash: secretHash.toString() as Hex, secret, isPrivate: true, salt }
}

/** The viem `writeContract` args for `FeeJuicePortal.depositToAztecPublic`. */
export const feeJuiceDepositArgs = (plan: FuelDepositPlan): readonly [Hex, bigint, Hex] => [plan.to, plan.amount, plan.secretHash]

/** What a confirmed Fee-Juice deposit yields: the L1→L2 message leaf index (for the claim) + the FJ amount. */
export interface FuelDepositReceipt {
	leafIndex: bigint
	amount: bigint
	to: Hex
	key: Hex
}

/** Parse the FeeJuicePortal's `DepositToAztecPublic` event for the leaf index + amount. The leaf index
 *  is the portal event's `index` (the content-hash law), NOT an Inbox `MessageSent` read. */
export function parseFeeJuiceDeposit(logs: Log[]): FuelDepositReceipt {
	const events = parseEventLogs({ abi: FeeJuicePortalAbi, eventName: "DepositToAztecPublic", logs })
	const e = events[0] as { args?: { index?: bigint; amount?: bigint; to?: Hex; key?: Hex } } | undefined
	if (e?.args?.index === undefined || e.args.amount === undefined) {
		throw new Error("Fee-Juice deposit emitted no DepositToAztecPublic event")
	}
	return { leafIndex: e.args.index, amount: e.args.amount, to: (e.args.to ?? "0x") as Hex, key: (e.args.key ?? "0x") as Hex }
}

/** Fail-CLOSED self-pay floor: the bridged FJ must clear a POSITIVE configured floor (≈2× a real claim
 *  fee) or the private claim's `mint_and_pay_fee` would assert `amount >= max_gas_cost` and strand the FJ.
 *  A missing / non-positive floor is itself a hard failure — never silently skipped (the swap-fuel guard
 *  `if (BRIDGE_FUEL && received < floor)` fails OPEN when the config is absent; this must not). */
export function assertFuelClearsFloor(received: bigint, floorFj: bigint | undefined): void {
	if (floorFj === undefined || floorFj <= 0n) {
		throw new Error("Fuel floor is not configured — refusing to bridge (fail-closed).")
	}
	if (received < floorFj) {
		throw new Error("The bridged gas is below the safe claim floor — it can't cover its own claim. Increase the amount.")
	}
}

/** Build the carrier-less private-fuel claim payload: the FPC fee-setup (FeeJuice.claim +
 *  PrivateFPC.mint_and_pay_fee) as the ENTIRE tx body — no app call. The empty app payload is explicit
 *  (mirrors `new BatchCall(wallet, [])`, which merges the same way); the wallet sends it with
 *  feePayer = the FPC. The live sequencer's acceptance of a zero-app-call tx is provable only on a
 *  live network — not by any local gate. */
export async function buildCarrierlessFuelClaimPayload(feeMethod: FeePaymentMethod): Promise<ExecutionPayload> {
	return mergeExecutionPayloads([ExecutionPayload.empty(), await feeMethod.getExecutionPayload()])
}
