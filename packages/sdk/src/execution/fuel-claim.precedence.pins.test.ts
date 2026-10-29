/**
 * Guard-PRECEDENCE pins for `buildFuelClaimInteraction`: when several fail-closed
 * guards would fire at once, the surfaced reason is the FIRST in the ladder — no-claimable → floor →
 * fee limit → (private) FPC drift → missing salt / (public) missing secret. `fuel-claim.test.ts` proves
 * each guard alone; these prove their order, which the per-branch split must keep.
 */

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { describe, expect, it, vi } from "vitest"

vi.mock("@aztec-labs/aztec.js/contracts", () => ({
	BatchCall: vi.fn(function () {
		return { request: async () => ({}), simulate: async () => ({}), send: async () => ({ receipt: { txHash: "0x" } }) }
	}),
	toSimulateOptions: vi.fn((o: unknown) => o),
}))
vi.mock("../protocol/private-fuel.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../protocol/private-fuel.ts")>()),
	privateMintAndPayFee: vi.fn(() => ({})),
	deriveBridgeSecret: vi.fn(() => Fr.fromString("0xdead")),
}))
vi.mock("../protocol/fee-juice.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../protocol/fee-juice.ts")>()),
	publicFeeJuicePayment: vi.fn(() => ({})),
}))

import { PRIVATE_FPC_ADDRESS } from "../protocol/private-fuel.ts"
import { FeeStopError } from "./fee-stop.ts"
import { buildFuelClaimInteraction } from "./fuel-claim.ts"
import type { DepositFuelBlock } from "../records.ts"

type FuelClaimRecord = { isPrivate: boolean; fuel?: DepositFuelBlock }

/** Nodes report no per-transaction maximum here, so limits pass through unclamped. */
const NODE = { getNodeInfo: async () => ({}) } as never
const FPC = PRIVATE_FPC_ADDRESS

const RECIPIENT = AztecAddress.fromNumberUnsafe(0x1234)
const ABOVE_FLOOR = "100000000000000000000"
const BELOW_FLOOR = "1000"
const FLOOR = 11_000_000_000_000_000_000n
/** Fees so high that even ABOVE_FLOOR can't cover the explicit gas limits. */
const SPIKED_FEES = { feePerDaGas: 10n ** 30n, feePerL2Gas: 10n ** 30n }
const DRIFTED_FPC = "0x0000000000000000000000000000000000000000000000000000000000000bad"

const rec = (over: Record<string, unknown>, fuelOver: Record<string, unknown> = {}): FuelClaimRecord =>
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
	}) as FuelClaimRecord

async function reason(record: FuelClaimRecord, depsOver: Record<string, unknown> = {}): Promise<string> {
	const built = await buildFuelClaimInteraction(record, {
		aztec: {},
		node: NODE,
		privateFpc: FPC,
		recipient: RECIPIENT,
		minFloorFj: FLOOR,
		...depsOver,
	})
	try {
		await built.simulate()
		return "<no stop>"
	} catch (e) {
		return e instanceof FeeStopError ? e.stop : String(e)
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
		expect(only).toBe("no-claimable-fuel")
	})

	it("PRIVATE: floor over fee limit, FPC drift and missing salt", async () => {
		const floorOnly = await reason(rec({ isPrivate: true }, { received: BELOW_FLOOR }))
		const conflict = await reason(rec({ isPrivate: true }, { received: BELOW_FLOOR, fpc: DRIFTED_FPC, bridgeSecretSalt: undefined }), {
			maxFeesPerGas: SPIKED_FEES,
		})
		expect(conflict).toBe(floorOnly)
		expect(floorOnly).toBe("below-claim-floor")
	})

	it("PRIVATE: fee limit over FPC drift and missing salt", async () => {
		const conflict = await reason(rec({ isPrivate: true }, { fpc: DRIFTED_FPC, bridgeSecretSalt: undefined }), {
			maxFeesPerGas: SPIKED_FEES,
		})
		expect(conflict).toBe("fee-limit-spiked")
	})

	it("PRIVATE: FPC drift over a missing salt", async () => {
		const conflict = await reason(rec({ isPrivate: true }, { fpc: DRIFTED_FPC, bridgeSecretSalt: undefined }))
		expect(conflict).toBe("fpc-drift")
		const saltOnly = await reason(rec({ isPrivate: true }, { bridgeSecretSalt: undefined }))
		expect(saltOnly).toBe("missing-salt")
	})

	it("PUBLIC: floor over fee limit and missing secret; fee limit over missing secret", async () => {
		const floorOnly = await reason(rec({}, { received: BELOW_FLOOR }))
		const floorConflict = await reason(rec({}, { received: BELOW_FLOOR, secret: undefined }), { maxFeesPerGas: SPIKED_FEES })
		expect(floorConflict).toBe(floorOnly)
		const feeConflict = await reason(rec({}, { secret: undefined }), { maxFeesPerGas: SPIKED_FEES })
		expect(feeConflict).toBe("fee-limit-spiked")
		const secretOnly = await reason(rec({}, { secret: undefined }))
		expect(secretOnly).toBe("missing-secret")
	})
})
