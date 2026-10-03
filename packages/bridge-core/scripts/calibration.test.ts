import { describe, expect, it } from "vitest"
import { type CalibrationSample, calibrateFuelBudgets } from "./calibration"

const s = (shape: CalibrationSample["shape"], transactionFee: bigint, feeMode: CalibrationSample["feeMode"] = "fee-juice") => ({
	shape,
	feeMode,
	transactionFee,
})

describe("calibrateFuelBudgets", () => {
	it("takes the worst paid plain claim plus the margin, and the register extra over it", () => {
		const b = calibrateFuelBudgets([
			s("claim_public", 100n),
			s("claim_private", 150n, "private-fpc"),
			s("transfer", 90n),
			s("register_and_claim_public", 400n),
			s("register_token", 300n),
		])
		expect(b).toEqual({ fjPerTx: 180n, fjRegister: 300n })
	})

	it("sponsored samples never shrink the budget, and a register no dearer than a claim costs nothing extra", () => {
		expect(calibrateFuelBudgets([s("claim_public", 100n), s("claim_private", 0n, "sponsored"), s("register_token", 80n)])).toEqual({
			fjPerTx: 120n,
			fjRegister: 0n,
		})
	})

	it("refuses to size from nothing or from zero fees", () => {
		expect(() => calibrateFuelBudgets([s("claim_public", 0n, "sponsored")])).toThrow(/no paid plain-claim/)
		expect(() => calibrateFuelBudgets([s("claim_public", 0n)])).toThrow(/zero fee/)
	})
})
