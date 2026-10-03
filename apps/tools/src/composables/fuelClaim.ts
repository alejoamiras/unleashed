/**
 * The Fuel claim builder — the fee-juice branch the journal's `claim` dep dispatches to by
 * `assetKind`. NON-composable: imports only bridge-core / the Aztec SDK / the pure `fuel-claim-state`
 * lib, and takes the wallet + floor as ARGUMENTS — never a tools-app singleton — so
 * `useDeposit → fuelClaim → bridge-core` stays acyclic.
 *
 * PUBLIC: the carrier-less self-pay tx — `new BatchCall(wallet, [])` (no app call) paid by
 * `publicFeeJuicePayment` (`FeeJuicePaymentMethodWithClaim` → `claim_and_end_setup` as setup); it claims
 * the bridged FJ and pays this tx's fee from it (NOT the Sponsored FPC — absent on mainnet).
 * PRIVATE: the carrier-less embedded-FPC tx — `new BatchCall(wallet, [])` (no app call) paid by
 * `privateMintAndPayFee`, which runs `FeeJuice.claim` + `PrivateFPC.mint_and_pay_fee` as setup and
 * credits `(amount − max_gas_cost)` to the claimer. BOTH paths are now zero-app-call — the live
 * sequencer's acceptance of that is provable only on a live network.
 *
 * A direct Fuel record carries its FJ claim material in the `fuel` block (assetKind "fee-juice"):
 * `received` (the FJ), `secret` (public), `bridgeSecretSalt`/`fpc` (private), `leafIndex`. There is
 * NO token leg — this builds ONLY the fee-juice claim.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { BatchCall, toSimulateOptions } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { Gas } from "@aztec-labs/stdlib/gas"
import type { DepositJournalRecord } from "@unleashed/bridge-core"
import {
	PRIVATE_FPC_ADDRESS,
	PRIVATE_FUEL_CLAIM_GAS as PRIVATE_CLAIM_GAS,
	PUBLIC_FUEL_CLAIM_GAS as PUBLIC_CLAIM_GAS,
	assertFuelClearsFloor,
	deriveBridgeSecret,
	privateMintAndPayFee,
	publicFeeJuicePayment,
} from "@unleashed/bridge-core"
import { isPrivateFuelInsufficiency } from "@/lib/fuel-claim-state"
import { clampGas } from "@/lib/wallet-fee-budget"

export interface FuelClaimInteraction {
	simulate: () => Promise<unknown>
	send: () => Promise<{ txHash: string }>
}

export interface FuelClaimDeps {
	/** The connected Aztec wallet. */
	aztec: unknown
	recipient: AztecAddress
	/** The fail-CLOSED self-pay floor (FUEL_MIN_FJ). Undefined/zero ⇒ the claim refuses (BOTH paths). */
	minFloorFj: bigint | undefined
	/** V5: the worst-case maxFeesPerGas (predictedWorstMinFees, NO padding), computed by the caller (which
	 *  owns the node). This is a SELF-PAY claim — the bridged amount is the whole budget and the FPC asserts
	 *  amount >= gasLimits*maxFeesPerGas with no refund, so any fee padding inflates max_gas_cost past the
	 *  amount ("Amount too low to cover gas cost"). predicted-worst already covers base-fee drift. Absent ⇒
	 *  the wallet fills current-min (pre-V5 behavior). BOTH public + private now self-pay. */
	maxFeesPerGas?: { feePerDaGas: bigint; feePerL2Gas: bigint }
	/** PRIVATE: the AUTHORITATIVE salt the engine unsealed from the envelope (the sole recovery input).
	 *  Used in preference to the journal's plaintext `fuel.bridgeSecretSalt` display copy, which can be
	 *  missing or corrupted while the sealed copy is intact — trusting it would strand a recoverable
	 *  deposit. The plaintext is a fallback only (records with no salt seal). */
	resolvedSalt?: string
	/** PUBLIC: the AUTHORITATIVE claim secret the engine gated on. Used in preference to `fuel.secret`
	 *  so the gate and the claim never read different copies. */
	resolvedSecret?: string
	/** Journal-latch callbacks (the wrapper supplies these; this module stays journal-agnostic). */
	onAttempt?: () => void
	onTxHash?: (txHash: string) => void
	onSetupInsufficiency?: () => void
	/** Wraps the fee-payload simulate so a `CONTRACT_NOT_REGISTERED` re-registers once and retries.
	 *  The caller (which owns the session) binds it; absent ⇒ the simulate runs bare. This module
	 *  stays singleton-free — the wrapper arrives as an argument, exactly like `aztec`. */
	retry?: FuelClaimRetry
}

/** Retry-once wrapper for a single pre-submission wallet call, pre-bound to a session by the caller. */
export type FuelClaimRetry = (op: () => Promise<unknown>) => Promise<unknown>

/** A fail-stop {simulate, send} pair that surfaces `why` (a guard refused before any wallet call). */
const stop = (why: string): FuelClaimInteraction => ({
	simulate: async () => {
		throw new Error(why)
	},
	send: async () => {
		throw new Error(why)
	},
})

/** Fail-CLOSED on the ACTUAL fee LIMIT: the protocol reverts the setup claim when the claimed balance can't
 *  cover getFeeLimit() (Σ gasLimit[d]*maxFee[d]) — the LIMIT, not the actual charge — so a bridge that clears
 *  the static FUEL_MIN_FJ floor can still fail once fees spike. Returns true (skip) only when the
 *  caller passes no predicted fees (pre-V5 fallback), where the floor is the sole guard. */
function clearsFeeLimit(
	received: bigint,
	gas: { daGas: number; l2Gas: number },
	maxFees?: { feePerDaGas: bigint; feePerL2Gas: bigint },
): boolean {
	if (!maxFees) return true
	return received >= BigInt(gas.l2Gas) * maxFees.feePerL2Gas + BigInt(gas.daGas) * maxFees.feePerDaGas
}

type FuelBlock = NonNullable<DepositJournalRecord["fuel"]>
type PayloadSimulator = (fee: { paymentMethod: unknown }) => Promise<unknown>

/** Build the {simulate, send} for a direct Fee-Juice claim. Guards fail CLOSED (return a `stop`).
 *  Stays `async` on purpose: a throwing parse (a malformed salt) surfaces as a rejection, never a
 *  synchronous throw at the call site. */
export async function buildFuelClaimInteraction(rec: DepositJournalRecord, deps: FuelClaimDeps): Promise<FuelClaimInteraction> {
	const fuel = rec.fuel
	if (!fuel?.received || !fuel.leafIndex) return stop("This Fuel bridge has no claimable Fee Juice.")
	const received = BigInt(fuel.received)
	const leaf = new Fr(BigInt(fuel.leafIndex))
	const simulateViaPayload = makePayloadSimulator(deps)
	return rec.isPrivate
		? buildPrivateFuelClaim(fuel, received, leaf, deps, simulateViaPayload)
		: buildPublicFuelClaim(fuel, received, deps, simulateViaPayload)
}

/** Simulate the FULLY BUILT payload: request() merges the fee's claim setup into the tx, whereas
 *  BatchCall([]).simulate() IGNORES options.fee for an empty batch (SDK batch_call.ts) and no-ops. That
 *  no-op would make the caller's message-availability gate AND its recordMessageConsumed probe silently
 *  pass, so a claim could send before the L1→L2 message anchors and a consumed message could look
 *  claimable forever. simulateTx runs the SAME l1_to_l2_message check send does, so it throws the
 *  isMsgNotReady / isMsgConsumed shapes those consumers key off. Used by BOTH self-pay branches.
 *  toSimulateOptions carries the claim's EXPLICIT gasSettings into the wallet call — without it the
 *  wallet simulates with estimation defaults (max limits + padded fees), which mismatches send and can
 *  spuriously fail the self-pay budget check. Mirrors BatchCall.simulate's own
 *  non-empty-batch path: [request payload, toSimulateOptions(interaction options)]. */
function makePayloadSimulator(deps: FuelClaimDeps): PayloadSimulator {
	return (fee) => simulateFeePayload(deps.aztec, deps.recipient, fee, deps.retry)
}

/** Simulate a fee payment's setup on its own — a carrier-less transaction whose whole body is the
 *  fee's claim — with the fee's explicit gas settings. The one prompt-free probe of whether a bridged
 *  Fee Juice message can be spent yet by a transaction the wallet cannot dry-run itself. */
export async function simulateFeePayload(
	aztec: unknown,
	recipient: AztecAddress,
	fee: { paymentMethod: unknown },
	retry: FuelClaimRetry = (op) => op(),
): Promise<unknown> {
	const payload = await new BatchCall(aztec as never, []).request({ fee: { paymentMethod: fee.paymentMethod } } as never)
	return await retry(() =>
		(aztec as { simulateTx: (p: unknown, o: unknown) => Promise<unknown> }).simulateTx(
			payload,
			toSimulateOptions({ from: recipient, fee } as never),
		),
	)
}

/** The two budget guards both branches share, in order: the fail-CLOSED floor (the bridged FJ must
 *  cover its own claim, or the setup reverts post-mint/post-claim), then the fee LIMIT. */
function checkClaimBudget(received: bigint, gas: { daGas: number; l2Gas: number }, deps: FuelClaimDeps): FuelClaimInteraction | null {
	try {
		assertFuelClearsFloor(received, deps.minFloorFj)
	} catch (e) {
		return stop(e instanceof Error ? e.message : "The bridged gas is below the safe claim floor.")
	}
	if (!clearsFeeLimit(received, gas, deps.maxFeesPerGas)) {
		return stop("The bridged gas can't cover this claim's fee limit right now (fees spiked). Try again shortly.")
	}
	return null
}

function buildPrivateFuelClaim(
	fuel: FuelBlock,
	received: bigint,
	leaf: Fr,
	deps: FuelClaimDeps,
	simulateViaPayload: PayloadSimulator,
): FuelClaimInteraction {
	const { aztec, recipient } = deps
	const budgetStop = checkClaimBudget(received, clampGas(PRIVATE_CLAIM_GAS), deps)
	if (budgetStop) return budgetStop
	// FPC version-drift kill-switch — never claim to a drifted FPC, never downgrade to public.
	if (fuel.fpc && fuel.fpc !== PRIVATE_FPC_ADDRESS) {
		return stop("Private fuel FPC address mismatch (version drift), refusing to claim. Reselect a mode.")
	}
	// Authoritative-first: the engine-unsealed salt wins over the plaintext journal copy (which can be
	// missing/corrupted while the seal is intact). Plaintext is a fallback only (a record without a salt envelope).
	const saltHex = deps.resolvedSalt ?? fuel.bridgeSecretSalt
	if (!saltHex) return stop("This private Fuel bridge is missing its recovery salt, cannot claim.")
	const salt = Fr.fromString(saltHex)
	const fpcAddr = AztecAddress.fromStringUnsafe(fuel.fpc ?? PRIVATE_FPC_ADDRESS)
	// teardownGas=0 keeps max_gas_cost within the bridged amount. maxFeesPerGas is the caller's
	// predicted-worst snapshot (NO padding) — a self-pay claim spends the bridged amount as its whole
	// budget, so any padding inflates max_gas_cost past it and the FPC reverts "Amount too low to cover
	// gas cost". predicted-worst still covers base-fee drift; a rare overshoot fails recoverably (retry).
	const privateFee = {
		paymentMethod: privateMintAndPayFee(fpcAddr, received, deriveBridgeSecret(salt, recipient), salt, leaf),
		gasSettings: {
			// EXPLICIT gasLimits is REQUIRED for the carrier-less claim. The empty BatchCall([]) gives the
			// wallet's gas estimator nothing to estimate, so it defaults gasLimits to the network per-tx
			// MAX (txsLimits.gas ≈ 6.5M L2 on V5). applyEmbeddedFpcGasCap then caps maxFeesPerGas but NOT
			// gasLimits, so max_gas_cost = MAX_gasLimits × fee (≈23 FJ) and no realistic bridge self-pays
			// it ("Amount too low to cover gas cost"). The wallet honors a dApp-supplied gasLimits
			// (suggestGasLimits), so size it to the 2-call setup ({@link PRIVATE_CLAIM_GAS}). The fee is
			// billed on ACTUAL gas, not the limit, so a generous limit does not overpay — but it IS the
			// balance-check bound (getFeeLimit), so {@link clearsFeeLimit} above fail-closes on it.
			gasLimits: Gas.from(clampGas(PRIVATE_CLAIM_GAS)),
			teardownGasLimits: Gas.from({ daGas: 0, l2Gas: 0 }),
			// Both spellings: the wallet-sdk option schema names the cap `maxFeePerGas`, the wallets read `maxFeesPerGas`.
			...(deps.maxFeesPerGas ? { maxFeesPerGas: deps.maxFeesPerGas, maxFeePerGas: deps.maxFeesPerGas } : {}),
		},
	}
	const carrier = () => new BatchCall(aztec as never, [])
	return {
		simulate: () => simulateViaPayload(privateFee),
		send: async () => {
			deps.onAttempt?.()
			try {
				const { receipt } = (await carrier().send({
					from: recipient,
					fee: privateFee,
					wait: { waitForStatus: TxStatus.PROPOSED },
				} as never)) as { receipt: { txHash: unknown } }
				const txHash = String(receipt.txHash)
				deps.onTxHash?.(txHash)
				return { txHash }
			} catch (e) {
				// A setup-insufficiency throw ⇒ the tx was INVALID (FJ unconsumed) ⇒ authorise a retry.
				// Never fall back to public/Sponsored on the private path.
				if (isPrivateFuelInsufficiency(e instanceof Error ? e.message : String(e))) deps.onSetupInsufficiency?.()
				throw e
			}
		},
	}
}

/** PUBLIC: SELF-PAY — claim the bridged Fee Juice and pay THIS tx's own fee from it in ONE tx
 *  (`FeeJuicePaymentMethodWithClaim` → `claim_and_end_setup` in the setup phase). Deliberately NOT the
 *  Sponsored FPC: the sponsor does not exist on mainnet, and masking a real
 *  self-pay failure behind it would HIDE the bug instead of surfacing it. Fuel-only has no app call, so
 *  like the private path this is a CARRIER-LESS zero-app-call tx (`BatchCall([])`) — the mechanism the
 *  private path already proves live; the public self-pay is proven by fee-juice-canary-testnet.ts. */
function buildPublicFuelClaim(
	fuel: FuelBlock,
	received: bigint,
	deps: FuelClaimDeps,
	simulateViaPayload: PayloadSimulator,
): FuelClaimInteraction {
	const { aztec, recipient } = deps
	const budgetStop = checkClaimBudget(received, clampGas(PUBLIC_CLAIM_GAS), deps)
	if (budgetStop) return budgetStop
	// Authoritative-first: the engine-gated `rec.secret` wins over the `fuel.secret` display copy so the
	// gate and the claim can never read divergent secrets. Plaintext is a fallback only.
	const secretHex = deps.resolvedSecret ?? fuel.secret
	if (!secretHex) return stop("This Fuel bridge is missing its claim secret.")
	const publicFee = {
		paymentMethod: publicFeeJuicePayment(recipient, {
			claimAmount: received,
			claimSecret: Fr.fromString(secretHex),
			messageLeafIndex: BigInt(fuel.leafIndex as string),
		}),
		// {@link PUBLIC_CLAIM_GAS}: explicit + canary-calibrated (the empty BatchCall gives the estimator
		// nothing). teardownGas=0; maxFeesPerGas is the caller's predicted-worst snapshot (NO padding),
		// since this self-pays and the bridged amount is the whole budget.
		gasSettings: {
			gasLimits: Gas.from(clampGas(PUBLIC_CLAIM_GAS)),
			teardownGasLimits: Gas.from({ daGas: 0, l2Gas: 0 }),
			...(deps.maxFeesPerGas ? { maxFeesPerGas: deps.maxFeesPerGas, maxFeePerGas: deps.maxFeesPerGas } : {}),
		},
	}
	const carrier = () => new BatchCall(aztec as never, [])
	return {
		simulate: () => simulateViaPayload(publicFee),
		send: async () => {
			deps.onAttempt?.()
			const { receipt } = (await carrier().send({
				from: recipient,
				fee: publicFee,
				wait: { waitForStatus: TxStatus.PROPOSED },
			} as never)) as { receipt: { txHash: unknown } }
			const txHash = String(receipt.txHash)
			deps.onTxHash?.(txHash)
			return { txHash }
		},
	}
}
