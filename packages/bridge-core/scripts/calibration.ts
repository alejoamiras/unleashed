/**
 * Fuel budgets from measured L2 fees: `fjPerTx` is what one ordinary transaction costs and
 * `fjRegister` the extra a token's first claim pays for registering it. Both are worst cases over
 * the measured matrix plus a margin, so a quote sized from them survives a fee bump.
 */
import type { ManifestV2 } from "../src/manifest-v2"

export type CalibrationShape = "claim_public" | "claim_private" | "transfer" | "register_and_claim_public" | "register_token"

export interface CalibrationSample {
	shape: CalibrationShape
	feeMode: "sponsored" | "fee-juice" | "private-fpc"
	/** The landed transaction's `transactionFee`, in fee-juice base units. */
	transactionFee: bigint
}

export interface FuelBudgets {
	fjPerTx: bigint
	fjRegister: bigint
}

const BPS = 10_000n
const REGISTER_SHAPES: ReadonlySet<CalibrationShape> = new Set(["register_and_claim_public", "register_token"])

function withMargin(v: bigint, marginBps: bigint): bigint {
	return (v * (BPS + marginBps) + BPS - 1n) / BPS
}

function maxFee(samples: readonly CalibrationSample[]): bigint {
	return samples.reduce((m, s) => (s.transactionFee > m ? s.transactionFee : m), 0n)
}

/**
 * A sponsored sample carries a zero `transactionFee` and says nothing about cost — it is excluded
 * rather than allowed to drag the maximum down to a budget no paying user could claim with.
 */
export function calibrateFuelBudgets(samples: readonly CalibrationSample[], marginBps = 2_000n): FuelBudgets {
	const paid = samples.filter((s) => s.feeMode !== "sponsored")
	const plain = paid.filter((s) => !REGISTER_SHAPES.has(s.shape))
	const registering = paid.filter((s) => REGISTER_SHAPES.has(s.shape))
	if (plain.length === 0) throw new Error("calibration: no paid plain-claim sample — cannot size fjPerTx")
	const perTx = maxFee(plain)
	if (perTx === 0n) throw new Error("calibration: every paid plain claim reported a zero fee — the fee mode is not what it claims")
	const registerExtra = registering.length === 0 ? 0n : maxFee(registering) - perTx
	return {
		fjPerTx: withMargin(perTx, marginBps),
		fjRegister: withMargin(registerExtra > 0n ? registerExtra : 0n, marginBps),
	}
}

/**
 * `m` with `budgets` in every block that carries fuel budgets: the DepositRouter's `fuel` and the legacy router's
 * `swap`, side by side while both routers are live. The budgets measure L2 claim fees, so one calibration serves
 * both. Throws when `m` has neither block, since a manifest with no fuel route has nothing to calibrate.
 */
export function applyFuelBudgets(m: ManifestV2, budgets: FuelBudgets): ManifestV2 {
	const l1 = m.bridge?.l1
	if (!m.bridge || !l1 || (!l1.fuel && !l1.swap)) throw new Error(`manifest for ${m.network} carries no fuel budgets to calibrate — STOP`)
	const measured = { fjPerTx: budgets.fjPerTx.toString(), fjRegister: budgets.fjRegister.toString() }
	return {
		...m,
		bridge: {
			...m.bridge,
			l1: {
				...l1,
				...(l1.fuel ? { fuel: { ...l1.fuel, ...measured } } : {}),
				...(l1.swap ? { swap: { ...l1.swap, ...measured } } : {}),
			},
		},
	}
}
