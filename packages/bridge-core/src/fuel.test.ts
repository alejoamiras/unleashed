import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { computeSecretHash } from "@aztec-labs/stdlib/hash"
import { encodeAbiParameters, encodeEventTopics, type Hex, type Log } from "viem"
import { describe, expect, it } from "vitest"
import {
	assertFuelClearsFloor,
	FeeJuicePortalAbi,
	buildCarrierlessFuelClaimPayload,
	feeJuiceDepositArgs,
	parseFeeJuiceDeposit,
	planPrivateFuelDeposit,
	planPublicFuelDeposit,
} from "./fuel"
import { PRIVATE_FPC_ADDRESS, deriveBridgeSecret, privateMintAndPayFee } from "./private-fuel"

const recipient = AztecAddress.fromNumberUnsafe(0x1234)

describe("fuel — deposit planning", () => {
	it("public: recipient-bound, random secret, matching secretHash, correct args", async () => {
		const plan = await planPublicFuelDeposit(recipient, 1000n)
		expect(plan.isPrivate).toBe(false)
		expect(plan.to).toBe(recipient.toString())
		expect(plan.salt).toBeUndefined()
		expect(plan.secretHash).toBe((await computeSecretHash(plan.secret)).toString())
		expect(feeJuiceDepositArgs(plan)).toEqual([recipient.toString(), 1000n, plan.secretHash])
		// Random: a second plan must not reuse the secret.
		const plan2 = await planPublicFuelDeposit(recipient, 1000n)
		expect(plan2.secret.toString()).not.toBe(plan.secret.toString())
	})

	it("private: FPC-bound, secret DERIVED from salt+claimer (never random — anti-stranding), reproducible", async () => {
		const salt = new Fr(42n)
		const plan = await planPrivateFuelDeposit(recipient, 2000n, salt)
		expect(plan.isPrivate).toBe(true)
		expect(plan.to).toBe(PRIVATE_FPC_ADDRESS)
		expect(plan.salt?.toString()).toBe(salt.toString())
		// The claimer reconstructs this from msg_sender; a random secret would strand the FJ forever.
		expect(plan.secret.toString()).toBe(deriveBridgeSecret(salt, recipient).toString())
		// Same salt + claimer ⇒ same secret (the recovery guarantee).
		const plan2 = await planPrivateFuelDeposit(recipient, 2000n, salt)
		expect(plan2.secret.toString()).toBe(plan.secret.toString())
	})
})

describe("fuel — event parse", () => {
	const PORTAL = "0x00000000000000000000000000000000000f1e1d"
	const depositLog = (address: Hex, amount: bigint, index: bigint) =>
		({
			address,
			topics: encodeEventTopics({ abi: FeeJuicePortalAbi, eventName: "DepositToAztecPublic", args: { to: `0x${"12".repeat(32)}` } }),
			data: encodeAbiParameters(
				[{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
				[amount, `0x${"ab".repeat(32)}`, `0x${"cd".repeat(32)}`, index],
			),
			blockNumber: 1n,
			blockHash: `0x${"0".repeat(64)}`,
			logIndex: 0,
			transactionHash: `0x${"0".repeat(64)}`,
			transactionIndex: 0,
			removed: false,
		}) as unknown as Log

	it("throws when no DepositToAztecPublic event is present", () => {
		expect(() => parseFeeJuiceDeposit([], PORTAL)).toThrow(/DepositToAztecPublic/)
	})

	it("reads only the named portal's event, never a look-alike from another emitter", () => {
		const forged = depositLog("0x00000000000000000000000000000000000bad00", 10n ** 24n, 999n)
		const real = depositLog(PORTAL, 5n, 7n)
		expect(parseFeeJuiceDeposit([forged, real], PORTAL)).toMatchObject({ amount: 5n, leafIndex: 7n })
		expect(() => parseFeeJuiceDeposit([forged], PORTAL)).toThrow(/DepositToAztecPublic/)
	})
})

describe("fuel — fail-closed floor", () => {
	it("undefined floor fails CLOSED (never silently skipped)", () => {
		expect(() => assertFuelClearsFloor(10n ** 30n, undefined)).toThrow(/not configured/)
	})
	it("zero / non-positive floor fails CLOSED", () => {
		expect(() => assertFuelClearsFloor(10n ** 30n, 0n)).toThrow(/not configured/)
	})
	it("received below the floor throws", () => {
		expect(() => assertFuelClearsFloor(5n, 10n)).toThrow(/below the safe claim floor/)
	})
	it("received at or above the floor passes", () => {
		expect(() => assertFuelClearsFloor(10n, 10n)).not.toThrow()
		expect(() => assertFuelClearsFloor(11n, 10n)).not.toThrow()
	})
})

// Proves the carrier-less private claim is CONSTRUCTABLE + correctly shaped/scoped locally. It does
// NOT (cannot) prove the live sequencer accepts a zero-app-call tx — only a live network can.
describe("fuel — carrierless private claim construction", () => {
	const fpc = AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS)

	it("payload is carrier-less: exactly the 2 FPC setup calls (no app call), feePayer = FPC", async () => {
		const salt = new Fr(99n)
		const method = privateMintAndPayFee(fpc, 12_000n, deriveBridgeSecret(salt, recipient), salt, new Fr(7n))
		const payload = await buildCarrierlessFuelClaimPayload(method)
		// Empty app payload contributes nothing ⇒ exactly FeeJuice.claim + PrivateFPC.mint_and_pay_fee.
		expect(payload.calls).toHaveLength(2)
		expect((await method.getFeePayer()).toString()).toBe(PRIVATE_FPC_ADDRESS)
	})

	it("routes to the embedded 'fpc' fee path: feePayer (FPC) is never the claimer (from)", async () => {
		const salt = new Fr(1n)
		const method = privateMintAndPayFee(fpc, 12_000n, deriveBridgeSecret(salt, recipient), salt, new Fr(0n))
		// detectEmbeddedFeePayment classifies "fpc" exactly when feePayer !== from; the claimer is `from`.
		expect((await method.getFeePayer()).toString()).not.toBe(recipient.toString())
	})
})
