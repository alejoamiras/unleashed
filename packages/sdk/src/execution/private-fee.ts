/**
 * The private fuel fee, a fully SEPARATE path: the fee is always the PrivateFPC (feePayer = FPC), and a retry
 * retries only that method. It never reaches the public ladder — that would claim the Fee Juice in a publicly
 * visible transaction and deanonymize the bridge.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { Gas } from "@aztec-labs/stdlib/gas"
import {
	deriveBridgeSecret,
	PRIVATE_HUB_CLAIM_GAS,
	PRIVATE_HUB_REGISTER_GAS,
	privateFeeJuicePayment,
	privateFpcFeeLimit,
	privateMintAndPayFee,
} from "../protocol/private-fuel.ts"
import type { DepositFuelBlock } from "../records.ts"
import { isWellFormedTxHash } from "./claim-receipt.ts"
import { type FeeLadderEnv, type FeeLadderRecord, patchFuel, readFeeJuiceOrNull, walletFeesOrNull } from "./fee-env.ts"
import type { FeeStop } from "./fee-stop.ts"
import { decideFuelLadder, decidePrivateFuelClaim, PRIVATE_ATTEMPT_STALE_MS } from "./fuel-claim-state.ts"
import { fuelReceiptStatus } from "./fuel-settlement.ts"
import { clampGas, type GasLimits, type MaxFees } from "./wallet-fee-budget.ts"

export type FpcFee = { paymentMethod: unknown; gasSettings: unknown }

/** The private-fuel fee, decoupled from the interaction it pays for. "none" = the record is not
 *  on the private-fuel path at all. "fee" spends the bridged Fee Juice message: on a first-time
 *  token (`registers`) the registration goes first and spends it, sized for a registration, and
 *  `registeredClaimFee` pays the claim that follows from the credit the FPC kept. "credit" is the
 *  claim of a record whose fuel is already spent — paid from that credit alone. */
export type PrivateFuelFee =
	| { kind: "none" }
	| { kind: "stop"; stop: FeeStop }
	| { kind: "fee"; fee: FpcFee; fuel: DepositFuelBlock; registers: boolean; registeredClaimFee?: FpcFee }
	| { kind: "credit"; fee: FpcFee; registers: boolean; registerFee?: FpcFee; registeredClaimFee?: FpcFee }

/**
 * The salt the private claim is rebuilt from. The sealed copy is AUTHENTICATED, the record's is a
 * mutable plaintext copy: when they disagree the sealed one wins and the record is corrected on the
 * spot, or every retry would derive a secret the deposit never committed to and loop forever on a
 * wrong-secret claim. The value itself never reaches the log.
 */
function reconcileFuelSalt(env: FeeLadderEnv, rec: FeeLadderRecord, sealedSalt?: string): DepositFuelBlock | undefined {
	// The PERSISTED block, not the ladder's captured copy: a latch from another tab must survive the restore.
	const fuel = env.records.current(rec.id)?.fuel ?? rec.fuel
	if (!sealedSalt || !fuel || fuel.bridgeSecretSalt === sealedSalt) return fuel
	env.log("journal fuel salt disagreed with the sealed envelope - restoring the sealed copy", { id: rec.id })
	patchFuel(env, rec.id, fuel, { bridgeSecretSalt: sealedSalt })
	return { ...fuel, bridgeSecretSalt: sealedSalt }
}

/** `registers`: this claim registers the token first, so the registration is the transaction that
 *  spends the fuel. `aztec`: the wallet, for a claim paid from an already-spent fuel's credit. */
export interface PrivateFeeContext {
	registers?: boolean
	aztec?: unknown
}

export async function resolvePrivateFuelFee(
	env: FeeLadderEnv,
	rec: FeeLadderRecord,
	recipientAddr: AztecAddress,
	sealedSalt?: string,
	ctx: PrivateFeeContext = {},
): Promise<PrivateFuelFee> {
	const fuel = reconcileFuelSalt(env, rec, sealedSalt)
	const incomplete = privateIncompleteStop(rec, fuel)
	if (incomplete) return { kind: "stop", stop: incomplete }
	if (!(rec.isPrivate && fuel?.received && fuel.leafIndex && fuel.bridgeSecretSalt)) return { kind: "none" }
	const fb = fuel
	const fuelReceived = BigInt(fuel.received)
	const salt = Fr.fromString(fuel.bridgeSecretSalt)
	const unsafe = privateFuelSafetyStop(env, fb, fuelReceived)
	if (unsafe) return { kind: "stop", stop: unsafe }
	if (fb.claimTxHash !== undefined && !isWellFormedTxHash(fb.claimTxHash)) return { kind: "stop", stop: "malformed-claim-hash" }
	const receiptStatus = fb.claimTxHash ? await fuelReceiptStatus(env, fb.claimTxHash) : undefined
	if (receiptStatus === "included" && fb.consumed !== true) {
		patchFuel(env, rec.id, fb, { consumed: true })
	}
	const decision = decidePrivateFuelClaim({
		attempt: fb.claimAttempt === true,
		txHashKnown: typeof fb.claimTxHash === "string",
		receiptStatus,
		consumed: fb.consumed === true || receiptStatus === "included",
		setupInsufficiency: fb.setupInsufficiency === true,
		// A missing timestamp is a record from before the field existed: aged out, or its limbo never ends.
		attemptAgedOut: fb.claimAttemptAt === undefined || Date.now() - fb.claimAttemptAt > PRIVATE_ATTEMPT_STALE_MS,
	})
	env.log("private fuel claim decision", { id: rec.id, action: decision.action })
	// Spent fuel is never re-minted (a second claim double-spends the FJ message) and never goes
	// public: the claim it was meant to pay for draws on the credit the FPC kept for this account.
	if (decision.action === "consumed") return privateCreditFee(env, fb, recipientAddr, ctx.aztec, ctx.registers === true)
	if (decision.action !== "private-fpc") return { kind: "stop", stop: "private-claim-pending" }
	return privateFpcFee(env, fb, fuelReceived, salt, recipientAddr, ctx.registers === true, ctx.aztec)
}

/** The FPC's explicit gas settings: limits sized to the transaction, teardown zero (it keeps
 *  `max_gas_cost` within the bridged amount), fees pinned to the predicted worst case. */
function fpcGasSettings(env: Pick<FeeLadderEnv, "node">, gas: GasLimits, maxFees: MaxFees) {
	const cap = { feePerDaGas: maxFees.feePerDaGas, feePerL2Gas: maxFees.feePerL2Gas }
	return {
		gasLimits: Gas.from(clampGas(env.node, gas)),
		teardownGasLimits: Gas.from({ daGas: 0, l2Gas: 0 }),
		maxFeesPerGas: cap,
		// The wallet-sdk option schema spells the cap this way; a wallet reading either spelling gets it.
		maxFeePerGas: cap,
	}
}

/** A transaction paid from the private Fee Juice this account already holds at the FPC (`pay_fee`),
 *  at the ceiling its limits commit to. */
export function fpcCreditFee(
	env: Pick<FeeLadderEnv, "node">,
	fpcAddr: AztecAddress,
	maxFees: MaxFees,
	gas: GasLimits = PRIVATE_HUB_CLAIM_GAS,
): FpcFee {
	return { paymentMethod: privateFeeJuicePayment(fpcAddr), gasSettings: fpcGasSettings(env, gas, maxFees) }
}

/** The claim of a record whose fuel is already spent (the registration ahead of it, or a prior
 *  attempt): the FPC holds the remainder as this account's private credit, and `pay_fee` deducts
 *  the committed ceiling of every transaction it pays from it — the claim's, and a registration's
 *  too when the token is still unregistered (a registration that reverted past its setup spent the
 *  fuel without binding the token) — refused here when the credit cannot cover them. */
async function privateCreditFee(
	env: FeeLadderEnv,
	fb: DepositFuelBlock,
	recipientAddr: AztecAddress,
	aztec: unknown,
	registers: boolean,
): Promise<PrivateFuelFee> {
	if (aztec === undefined) return { kind: "stop", stop: "credit-needs-wallet" }
	const fpcAddr = AztecAddress.fromStringUnsafe(fb.fpc ?? env.privateFpc)
	const [credit, maxFees] = await Promise.all([
		readFeeJuiceOrNull(env, "private FJ", () => env.readPrivateFeeJuice(aztec, recipientAddr)),
		walletFeesOrNull(env, aztec, PRIVATE_HUB_CLAIM_GAS),
	])
	if (credit === null) return { kind: "stop", stop: "credit-unreadable" }
	if (maxFees === null) return { kind: "stop", stop: "unpriced-by-wallet" }
	// Priced from the CLAMPED limits the transactions are submitted under: the FPC keeps exactly that.
	const needed =
		privateFpcFeeLimit(clampGas(env.node, PRIVATE_HUB_CLAIM_GAS), maxFees) +
		(registers ? privateFpcFeeLimit(clampGas(env.node, PRIVATE_HUB_REGISTER_GAS), maxFees) : 0n)
	if (credit < needed) return { kind: "stop", stop: registers ? "credit-short-registering" : "credit-short" }
	const claim = fpcCreditFee(env, fpcAddr, maxFees)
	return {
		kind: "credit",
		fee: claim,
		registers,
		...(registers ? { registerFee: fpcCreditFee(env, fpcAddr, maxFees, PRIVATE_HUB_REGISTER_GAS), registeredClaimFee: claim } : {}),
	}
}

/**
 * teardownGas=0 keeps max_gas_cost within the bridged amount. maxFeesPerGas is pinned to the
 * PREDICTED worst-case min fee (not current-min): the FPC asserts amount >= gasLimits*maxFeesPerGas,
 * and the claim lands seconds-to-minutes after it's built, so a current-min cap risks an
 * inclusion-time reject if the base fee rises in that window. Predicted-worst bounds the window AND
 * fixes the FPC ceiling so the bridged amount can cover it. Explicit ⇒ the wallet commits it
 * verbatim. feePayer=FPC ⇒ FeeJuice.claim + mint_and_pay_fee + the claim run as one transaction.
 * No padding on top of predicted-worst: the FPC credits `amount − max_gas_cost` and refunds nothing,
 * so padding is Fee Juice the claimer forfeits. A rare cap that still falls under the live fee fails
 * recoverably — every retry rebuilds this (re-prices). Same policy as the direct Fee Juice claim.
 */
async function privateFpcFee(
	env: FeeLadderEnv,
	fb: DepositFuelBlock,
	fuelReceived: bigint,
	salt: Fr,
	recipientAddr: AztecAddress,
	registers: boolean,
	aztec: unknown,
): Promise<PrivateFuelFee> {
	const fpcAddr = AztecAddress.fromStringUnsafe(fb.fpc ?? env.privateFpc)
	const fuelLeaf = new Fr(BigInt(fb.leafIndex as string))
	const spentBy = registers ? PRIVATE_HUB_REGISTER_GAS : PRIVATE_HUB_CLAIM_GAS
	const maxFees = await walletFeesOrNull(env, aztec, spentBy)
	if (maxFees === null) return { kind: "stop", stop: "unpriced-by-wallet" }
	// The FPC asserts the bridged amount covers the COMMITTED ceiling (limits × capped fees) of the
	// transaction that spends it, and credits only the remainder: when a registration spends it,
	// that remainder must still cover the claim's own ceiling. A short amount is refused here rather
	// than reverted there; fees are re-priced on every retry.
	const ceiling =
		privateFpcFeeLimit(clampGas(env.node, spentBy), maxFees) +
		(registers ? privateFpcFeeLimit(clampGas(env.node, PRIVATE_HUB_CLAIM_GAS), maxFees) : 0n)
	if (fuelReceived < ceiling) return { kind: "stop", stop: registers ? "fuel-short-registering" : "fuel-short" }
	return {
		kind: "fee",
		fuel: fb,
		registers,
		fee: {
			paymentMethod: privateMintAndPayFee(fpcAddr, fuelReceived, deriveBridgeSecret(salt, recipientAddr), salt, fuelLeaf),
			// Explicit limits: a wallet given none declares the network's per-tx maximum, and the
			// FPC's ceiling is limits × fees — the maximum makes it unpayable by any realistic slice.
			gasSettings: fpcGasSettings(env, spentBy, maxFees),
		},
		...(registers ? { registeredClaimFee: fpcCreditFee(env, fpcAddr, maxFees) } : {}),
	}
}

/** Structural fence: a private FUELED record reaches the private ladder or stops here. It must
 *  never fall through to the public ladder — that claims the Fee Juice in a publicly visible
 *  transaction and deanonymizes the bridge. Incomplete metadata (an older or partially restored
 *  record, or a tampered one) is exactly the fall-through that must not happen silently. */
function privateIncompleteStop(rec: FeeLadderRecord, fuel: DepositFuelBlock | undefined): FeeStop | null {
	if (decideFuelLadder({ isPrivate: rec.isPrivate, schema: rec.schema, intent: rec.intent, fuel }) !== "private-incomplete") return null
	// A retry helps only where it can restore something: a receipt rehydration needs a depositTxHash
	// and restores only the event-derived fields. The client-random salt exists nowhere but a backup.
	return fuel?.bridgeSecretSalt && rec.depositTxHash ? "private-fuel-unread" : "private-fuel-missing"
}

/** Kill-switch on a drifted FPC address (never claim to it, never downgrade to public) plus the
 *  fail-closed budget floor, below which the mint_and_pay_fee assert fails anyway. */
function privateFuelSafetyStop(env: FeeLadderEnv, fb: DepositFuelBlock, fuelReceived: bigint): FeeStop | null {
	if (fb.fpc && fb.fpc !== env.privateFpc) return "fpc-drift"
	if (env.fuel && fuelReceived < BigInt(env.fuel.minFuelFj)) return "below-fuel-floor"
	return null
}
