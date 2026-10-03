/**
 * Guard-PRECEDENCE pins for `buildFuelClaimInteraction`: when several fail-closed
 * guards would fire at once, the surfaced reason is the FIRST in the ladder — no-claimable → floor →
 * fee limit → (private) FPC drift → missing salt / (public) missing secret. `fuelClaim.test.ts` proves
 * each guard alone; these prove their order, which the per-branch split must keep.
 */

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { DepositJournalRecord } from "@unleashed/bridge-core"
import { describe, expect, it, vi } from "vitest"

vi.mock("@aztec-labs/aztec.js/contracts", () => ({
	BatchCall: vi.fn(function () {
		return { request: async () => ({}), simulate: async () => ({}), send: async () => ({ receipt: { txHash: "0x" } }) }
	}),
	toSimulateOptions: vi.fn((o: unknown) => o),
}))
vi.mock("@unleashed/bridge-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@unleashed/bridge-core")>()
	return {
		...actual,
		privateMintAndPayFee: vi.fn(() => ({})),
		publicFeeJuicePayment: vi.fn(() => ({})),
		deriveBridgeSecret: vi.fn(() => Fr.fromString("0xdead")),
	}
})

import { buildFuelClaimInteraction } from "./fuelClaim"

const RECIPIENT = AztecAddress.fromNumberUnsafe(0x1234)
const ABOVE_FLOOR = "100000000000000000000"
const BELOW_FLOOR = "1000"
const FLOOR = 11_000_000_000_000_000_000n
/** Fees so high that even ABOVE_FLOOR can't cover the explicit gas limits. */
const SPIKED_FEES = { feePerDaGas: 10n ** 30n, feePerL2Gas: 10n ** 30n }
const DRIFTED_FPC = "0x0000000000000000000000000000000000000000000000000000000000000bad"

const rec = (over: Record<string, unknown>, fuelOver: Record<string, unknown> = {}): DepositJournalRecord =>
	({
		schema: 2,
		id: "0xfuel",
		direction: "deposit",
		isPrivate: false,
		amount: "100",
		createdAt: 1,
		updatedAt: 1,
		chainId: 11155111,
		portal: "0xfjportal",
		bridge: "0xfjL2",
		recipient: "0xrecipient",
		secretHashHex: "0xfuel",
		assetKind: "fee-juice",
		fuel: {
			amount: ABOVE_FLOOR,
			secret: "0x1234",
			secretHashHex: "0xfh",
			minOutput: "0",
			received: ABOVE_FLOOR,
			leafIndex: "7",
			...fuelOver,
		},
		...over,
	}) as DepositJournalRecord

async function reason(record: DepositJournalRecord, depsOver: Record<string, unknown> = {}): Promise<string> {
	const built = await buildFuelClaimInteraction(record, { aztec: {}, recipient: RECIPIENT, minFloorFj: FLOOR, ...depsOver })
	try {
		await built.simulate()
		return "<no stop>"
	} catch (e) {
		return e instanceof Error ? e.message : String(e)
	}
}

describe("buildFuelClaimInteraction — guard precedence under conflicts", () => {
	it("no claimable FJ wins over every other private guard", async () => {
		const only = await reason(rec({ isPrivate: true }, { received: undefined }))
		const conflict = await reason(rec({ isPrivate: true }, { received: undefined, fpc: DRIFTED_FPC, bridgeSecretSalt: undefined }), {
			minFloorFj: undefined,
			maxFeesPerGas: SPIKED_FEES,
		})
		expect(conflict).toBe(only)
		expect(only).toBe("This Fuel bridge has no claimable Fee Juice.")
	})

	it("PRIVATE: floor over fee limit, FPC drift and missing salt", async () => {
		const floorOnly = await reason(rec({ isPrivate: true }, { received: BELOW_FLOOR }))
		const conflict = await reason(rec({ isPrivate: true }, { received: BELOW_FLOOR, fpc: DRIFTED_FPC, bridgeSecretSalt: undefined }), {
			maxFeesPerGas: SPIKED_FEES,
		})
		expect(conflict).toBe(floorOnly)
		expect(floorOnly).not.toMatch(/fee limit|FPC|salt/)
	})

	it("PRIVATE: fee limit over FPC drift and missing salt", async () => {
		const conflict = await reason(rec({ isPrivate: true }, { fpc: DRIFTED_FPC, bridgeSecretSalt: undefined }), {
			maxFeesPerGas: SPIKED_FEES,
		})
		expect(conflict).toBe("The bridged gas can't cover this claim's fee limit right now (fees spiked). Try again shortly.")
	})

	it("PRIVATE: FPC drift over a missing salt", async () => {
		const conflict = await reason(rec({ isPrivate: true }, { fpc: DRIFTED_FPC, bridgeSecretSalt: undefined }))
		expect(conflict).toBe("Private fuel FPC address mismatch (version drift), refusing to claim. Reselect a mode.")
		const saltOnly = await reason(rec({ isPrivate: true }, { bridgeSecretSalt: undefined }))
		expect(saltOnly).toBe("This private Fuel bridge is missing its recovery salt, cannot claim.")
	})

	it("PUBLIC: floor over fee limit and missing secret; fee limit over missing secret", async () => {
		const floorOnly = await reason(rec({}, { received: BELOW_FLOOR }))
		const floorConflict = await reason(rec({}, { received: BELOW_FLOOR, secret: undefined }), { maxFeesPerGas: SPIKED_FEES })
		expect(floorConflict).toBe(floorOnly)
		const feeConflict = await reason(rec({}, { secret: undefined }), { maxFeesPerGas: SPIKED_FEES })
		expect(feeConflict).toBe("The bridged gas can't cover this claim's fee limit right now (fees spiked). Try again shortly.")
		const secretOnly = await reason(rec({}, { secret: undefined }))
		expect(secretOnly).toBe("This Fuel bridge is missing its claim secret.")
	})
})
