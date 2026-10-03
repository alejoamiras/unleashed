/**
 * Fuel budgets from measured L2 fees: `fjPerTx` is what one ordinary transaction costs and
 * `fjRegister` the extra a token's first claim pays for registering it. Both are worst cases over
 * the measured matrix plus a margin, so a quote sized from them survives a fee bump.
 */

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
