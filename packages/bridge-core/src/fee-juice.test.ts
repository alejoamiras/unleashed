import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { FEE_JUICE_ADDRESS } from "@aztec-labs/constants"
import { describe, expect, test } from "vitest"
import { GasFees } from "@aztec-labs/stdlib/gas"
import {
	DEPLOY_SEQUENCE_TX_COUNT,
	deploySequenceFeeBudget,
	feeJuiceAddress,
	feeJuiceClaimArgs,
	type MinFeeNode,
	predictedWorstMinFees,
	publicFeeJuicePayment,
	preexistingFeeJuicePayment,
	selfPaidFeeJuicePayment,
	sponsoredFeePayment,
} from "./fee-juice"

describe("fee-juice", () => {
	// (B-19 PIN) predictedWorstMinFees may fall back to the (possibly stale)
	// getCurrentMinFees ONLY when the node genuinely doesn't implement
	// getPredictedMinFees. A TRANSIENT RPC error ("block not found", etc.) must
	// PROPAGATE — silently downgrading to current-min under-prices the
	// inclusion-safe fee cap and can get the tx rejected.
	describe("(B-19 PIN) predictedWorstMinFees fee-fallback error match", () => {
		test("a transient 'block not found' error PROPAGATES (no fee downgrade)", async () => {
			const box = { currentCalls: 0 }
			const n: MinFeeNode = {
				getPredictedMinFees: async () => {
					throw new Error("block not found")
				},
				getCurrentMinFees: async () => {
					box.currentCalls++
					return new GasFees(1n, 1n)
				},
			}
			await expect(predictedWorstMinFees(n)).rejects.toThrow(/block not found/)
			expect(box.currentCalls).toBe(0)
		})

		test("a genuine 'method not found' STILL falls back to getCurrentMinFees", async () => {
			const box = { currentCalls: 0 }
			const n: MinFeeNode = {
				getPredictedMinFees: async () => {
					throw new Error("method not found")
				},
				getCurrentMinFees: async () => {
					box.currentCalls++
					return new GasFees(1n, 1n)
				},
			}
			await expect(predictedWorstMinFees(n)).resolves.toBeInstanceOf(GasFees)
			expect(box.currentCalls).toBe(1)
		})

		test("a JSON-RPC -32601 (via error.cause.code) falls back even without the phrase", async () => {
			const box = { currentCalls: 0 }
			const err = Object.assign(new Error("rpc error"), { cause: { code: -32601 } })
			const n: MinFeeNode = {
				getPredictedMinFees: async () => {
					throw err
				},
				getCurrentMinFees: async () => {
					box.currentCalls++
					return new GasFees(1n, 1n)
				},
			}
			await expect(predictedWorstMinFees(n)).resolves.toBeInstanceOf(GasFees)
			expect(box.currentCalls).toBe(1)
		})
	})
	test("feeJuiceAddress is the canonical protocol Fee Juice address", () => {
		expect(feeJuiceAddress).toMatch(/^0x[0-9a-f]{64}$/)
		expect(feeJuiceAddress).not.toBe(`0x${"0".repeat(64)}`)
		// Derived from the protocol constant — pins the wiring, not a hand-typed literal.
		expect(feeJuiceAddress).toBe(AztecAddress.fromNumberUnsafe(FEE_JUICE_ADDRESS).toString())
	})

	test("publicFeeJuicePayment pays from the sender, in fee juice", async () => {
		const sender = AztecAddress.fromNumberUnsafe(0x1234)
		const claim = { claimAmount: 1000n, claimSecret: Fr.fromString("0x2a"), messageLeafIndex: 7n }
		const method = publicFeeJuicePayment(sender, claim)
		expect((await method.getFeePayer()).toString()).toBe(sender.toString())
		expect((await method.getAsset()).toString()).toBe(feeJuiceAddress)
	})

	test("sponsoredFeePayment routes the fee through the given FPC", async () => {
		const fpc = AztecAddress.fromNumberUnsafe(0xf9c)
		const method = sponsoredFeePayment(fpc)
		expect((await method.getFeePayer()).toString()).toBe(fpc.toString())
	})

	test("preexistingFeeJuicePayment keeps its payload empty and names no payer in it - an EmbeddedWallet routes a sender payer as a claim in setup", async () => {
		const sender = AztecAddress.fromNumberUnsafe(0x5e4d)
		const method = preexistingFeeJuicePayment(sender)
		const payload = await method.getExecutionPayload()
		expect(payload.calls).toHaveLength(0)
		expect(payload.feePayer).toBeUndefined()
		expect((await method.getFeePayer()).toString()).toBe(sender.toString())
	})

	test("selfPaidFeeJuicePayment names the sender as payer inside its payload, with no fee call - the shape the Nulo wallet routes as a self-pay", async () => {
		const sender = AztecAddress.fromNumberUnsafe(0x5e4d)
		const payload = await selfPaidFeeJuicePayment(sender).getExecutionPayload()
		expect(payload.calls).toHaveLength(0)
		expect(payload.feePayer?.toString()).toBe(sender.toString())
	})

	test("feeJuiceClaimArgs builds the FeeJuice claim tuple verbatim", () => {
		const to = AztecAddress.fromNumberUnsafe(0xbeef).toString()
		expect(feeJuiceClaimArgs(to, 1000n, "0x2a", 7n)).toEqual([to, 1000n, "0x2a", 7n])
	})

	// The fee-juice budget covers the WHOLE ~7-tx deploy sequence, not one claim.
	test("deploySequenceFeeBudget sizes the FULL sequence (7 txs by default) and fails closed on bad input", () => {
		expect(DEPLOY_SEQUENCE_TX_COUNT).toBe(7)
		expect(deploySequenceFeeBudget(10n ** 18n)).toBe(7n * 10n ** 18n)
		expect(deploySequenceFeeBudget(5n, 3)).toBe(15n)
		expect(() => deploySequenceFeeBudget(0n)).toThrow(/positive/)
		expect(() => deploySequenceFeeBudget(1n, 0)).toThrow(/positive integer/)
		expect(() => deploySequenceFeeBudget(1n, 1.5)).toThrow(/positive integer/)
	})
})
