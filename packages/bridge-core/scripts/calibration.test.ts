import { describe, expect, it } from "vitest"
import type { ManifestV2 } from "../src/manifest-v2"
import { applyFuelBudgets, type CalibrationSample, calibrateFuelBudgets } from "./calibration"

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

describe("applyFuelBudgets", () => {
	const budgets = { fjPerTx: 7n, fjRegister: 3n }
	const fuel = { slippageBps: 300, crossChainSlippageBps: 300, minFuelFj: "100", fjPerTx: "1", fjRegister: "1" }
	const swap = { slippageBps: 300, minFuelFj: "100", fjPerTx: "1", fjRegister: "1" }
	// Only the fields applyFuelBudgets reads; the writer re-validates the whole manifest.
	const manifest = (l1: object) => ({ network: "t", bridge: { l1 } }) as unknown as ManifestV2

	it("writes the measured budgets into the fuel block, beside the legacy swap block, touching nothing else", () => {
		const out = applyFuelBudgets(manifest({ router: "0xr", fuel, swap }), budgets)
		expect(out.bridge?.l1).toEqual({
			router: "0xr",
			fuel: { ...fuel, fjPerTx: "7", fjRegister: "3" },
			swap: { ...swap, fjPerTx: "7", fjRegister: "3" },
		})
		expect(applyFuelBudgets(manifest({ fuel }), budgets).bridge?.l1).toEqual({ fuel: { ...fuel, fjPerTx: "7", fjRegister: "3" } })
	})

	it("refuses a manifest with no fuel route to calibrate", () => {
		expect(() => applyFuelBudgets(manifest({ router: "0xr" }), budgets)).toThrow(/no fuel budgets/)
	})
})
