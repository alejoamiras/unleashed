import { describe, expect, it } from "vitest"
import {
	MANUAL_OFFER_THRESHOLD,
	PRIVATE_FUEL_INSUFFICIENCY_MSG,
	decideFuelClaim,
	decideFuelLadder,
	decideOwnGasCredit,
	decideOwnGasSource,
	decidePrivateFuelClaim,
	decideStandaloneFuelRecovery,
	isPrivateFuelInsufficiency,
	type FuelClaimEvidence,
	type PrivateFuelClaimEvidence,
} from "./fuel-claim-state"

const base: FuelClaimEvidence = {
	attempt: false,
	txHashKnown: false,
	persistentFailureCount: 0,
	userOverride: false,
}

describe("decideFuelClaim truth table", () => {
	it("default path: no attempt, healthy fuel ⇒ fjwc", () => {
		expect(decideFuelClaim({ ...base, fuelReceived: 500n, currentMinFee: 100n })).toEqual({
			action: "fjwc",
			offerManual: false,
		})
	})

	it("crash window: included attempt ⇒ sponsored (the FJ message is consumed, even app-reverted)", () => {
		expect(decideFuelClaim({ ...base, attempt: true, txHashKnown: true, receiptStatus: "included" })).toEqual({
			action: "own-gas",
			offerManual: false,
		})
	})

	it("a dropped attempt retries fjwc (nothing was consumed)", () => {
		expect(decideFuelClaim({ ...base, attempt: true, txHashKnown: true, receiptStatus: "dropped" }).action).toBe("fjwc")
	})

	it("a pending attempt WAITS - never re-embed while the tx may land", () => {
		expect(decideFuelClaim({ ...base, attempt: true, txHashKnown: true, receiptStatus: "pending" }).action).toBe("wait")
	})

	it("attempt latched but no hash (crash mid-prompt) WAITS - unknowable, never guess", () => {
		expect(decideFuelClaim({ ...base, attempt: true }).action).toBe("wait")
	})

	it("fee spike: fuel below margin × min fee ⇒ sponsored + standalone FJ claim", () => {
		expect(decideFuelClaim({ ...base, fuelReceived: 150n, currentMinFee: 100n })).toEqual({
			action: "own-gas-plus-standalone-fj",
			offerManual: false,
		})
	})

	it("fuel exactly at the margin self-pays (boundary)", () => {
		expect(decideFuelClaim({ ...base, fuelReceived: 200n, currentMinFee: 100n }).action).toBe("fjwc")
	})

	it("unknown min fee never triggers the fee-spike path", () => {
		expect(decideFuelClaim({ ...base, fuelReceived: 1n }).action).toBe("fjwc")
	})

	it("user override ⇒ sponsored, regardless of other evidence", () => {
		expect(decideFuelClaim({ ...base, userOverride: true, attempt: true, txHashKnown: true, receiptStatus: "pending" })).toEqual({
			action: "own-gas",
			offerManual: false,
		})
	})

	it("the manual escape is OFFERED after the threshold, only on ambiguous waits", () => {
		const waiting = decideFuelClaim({
			...base,
			attempt: true,
			persistentFailureCount: MANUAL_OFFER_THRESHOLD,
		})
		expect(waiting).toEqual({ action: "wait", offerManual: true })
		// Below the threshold: wait without the offer.
		expect(decideFuelClaim({ ...base, attempt: true, persistentFailureCount: 1 })).toEqual({
			action: "wait",
			offerManual: false,
		})
	})

	it("durable consumed=true settles to sponsored when the node is UNREACHABLE (receipt pending)", () => {
		// The unreachable-node stranding the live-only probe introduced: consumed is the fallback.
		expect(decideFuelClaim({ ...base, attempt: true, txHashKnown: true, receiptStatus: "pending", consumed: true }).action).toBe(
			"own-gas",
		)
		// And even with no hash (crash mid-prompt) a durable consumed flag settles it.
		expect(decideFuelClaim({ ...base, attempt: true, consumed: true }).action).toBe("own-gas")
	})

	it("a conclusive dropped receipt OVERRIDES a stale consumed flag (dropped consumed nothing)", () => {
		expect(decideFuelClaim({ ...base, attempt: true, txHashKnown: true, receiptStatus: "dropped", consumed: true }).action).toBe("fjwc")
	})

	it("a user already holding FJ changes NOTHING (no balance input exists)", () => {
		// The v2 aggregate-balance probe was withdrawn: the decision
		// surface has no balance parameter at all - this pin keeps it that way.
		const keys = Object.keys({ ...base, fuelReceived: 0n, currentMinFee: 0n, receiptStatus: "pending" })
		expect(keys).not.toContain("fjBalance")
		expect(keys).not.toContain("balance")
	})
})

const privBase: PrivateFuelClaimEvidence = { attempt: false, txHashKnown: false, setupInsufficiency: false, attemptAgedOut: false }

describe("decidePrivateFuelClaim (Option A — never public/Sponsored)", () => {
	it("fresh record (no attempt) ⇒ private-fpc", () => {
		expect(decidePrivateFuelClaim(privBase).action).toBe("private-fpc")
	})
	it("included attempt ⇒ consumed (no re-mint)", () => {
		expect(decidePrivateFuelClaim({ ...privBase, attempt: true, txHashKnown: true, receiptStatus: "included" }).action).toBe("consumed")
	})
	it("durable consumed flag ⇒ consumed", () => {
		expect(decidePrivateFuelClaim({ ...privBase, attempt: true, txHashKnown: true, consumed: true }).action).toBe("consumed")
	})
	it("dropped attempt (not included ⇒ FJ unconsumed) ⇒ private-fpc retry", () => {
		expect(decidePrivateFuelClaim({ ...privBase, attempt: true, txHashKnown: true, receiptStatus: "dropped" }).action).toBe(
			"private-fpc",
		)
	})
	it("pending receipt, FRESH attempt ⇒ wait (never guess)", () => {
		expect(decidePrivateFuelClaim({ ...privBase, attempt: true, txHashKnown: true, receiptStatus: "pending" }).action).toBe("wait")
	})
	it("pending receipt, AGED-OUT attempt ⇒ private-fpc (limbo escape; simulate gate guards the re-send)", () => {
		expect(
			decidePrivateFuelClaim({ ...privBase, attempt: true, txHashKnown: true, receiptStatus: "pending", attemptAgedOut: true })
				.action,
		).toBe("private-fpc")
	})
	it("aged-out NEVER overrides positive consumption evidence", () => {
		expect(
			decidePrivateFuelClaim({ ...privBase, attempt: true, txHashKnown: true, receiptStatus: "included", attemptAgedOut: true })
				.action,
		).toBe("consumed")
		expect(decidePrivateFuelClaim({ ...privBase, attempt: true, txHashKnown: true, consumed: true, attemptAgedOut: true }).action).toBe(
			"consumed",
		)
	})
	it("attempt, no hash, setup-insufficiency ⇒ private-fpc (the narrow retry allow-list)", () => {
		expect(decidePrivateFuelClaim({ ...privBase, attempt: true, txHashKnown: false, setupInsufficiency: true }).action).toBe(
			"private-fpc",
		)
	})
	it("attempt, no hash, NOT insufficiency, not consumed, fresh ⇒ wait (fail-closed)", () => {
		expect(decidePrivateFuelClaim({ ...privBase, attempt: true, txHashKnown: false, setupInsufficiency: false }).action).toBe("wait")
	})
	it("attempt, no hash, aged out ⇒ private-fpc (crashed-mid-send limbo escape)", () => {
		expect(decidePrivateFuelClaim({ ...privBase, attempt: true, txHashKnown: false, attemptAgedOut: true }).action).toBe("private-fpc")
	})
	it("attempt, no hash, consumed ⇒ consumed", () => {
		expect(decidePrivateFuelClaim({ ...privBase, attempt: true, txHashKnown: false, consumed: true }).action).toBe("consumed")
	})
	it("INVARIANT: no evidence EVER yields a public/Sponsored action", () => {
		const cases: PrivateFuelClaimEvidence[] = [
			privBase,
			{ ...privBase, attempt: true, txHashKnown: true, receiptStatus: "included" },
			{ ...privBase, attempt: true, txHashKnown: true, receiptStatus: "dropped" },
			{ ...privBase, attempt: true, txHashKnown: true, receiptStatus: "pending" },
			{ ...privBase, attempt: true, setupInsufficiency: true },
			{ ...privBase, attempt: true, consumed: true },
		]
		for (const c of cases) expect(["private-fpc", "consumed", "wait"]).toContain(decidePrivateFuelClaim(c).action)
	})
	it("the insufficiency classifier matches the installed assert + fails closed otherwise", () => {
		expect(isPrivateFuelInsufficiency(`Tx invalid: ${PRIVATE_FUEL_INSUFFICIENCY_MSG}`)).toBe(true)
		expect(isPrivateFuelInsufficiency("some other revert")).toBe(false)
	})
})

describe("decideOwnGasCredit (the private balance at the FPC is the only payer a held-gas claim can name)", () => {
	const at = (privateFeeJuice: bigint | null) => decideOwnGasCredit({ privateFeeJuice, ceiling: 100n })

	it("pays when the balance covers the ceiling, exactly at it included", () => {
		expect(at(100n)).toBe("pays")
		expect(at(1_000n)).toBe("pays")
	})

	it("a balance under the ceiling is short - refused before the FPC refuses it, since it refunds nothing", () => {
		expect(at(99n)).toBe("short")
		expect(at(1n)).toBe("short")
	})

	it("known and zero is a cold account", () => {
		expect(at(0n)).toBe("none")
	})

	it("FAIL-CLOSED: a failed read is unverifiable, never a false 'no gas'", () => {
		expect(at(null)).toBe("unverifiable")
	})
})

describe("decideOwnGasSource (the public balance joins once the wallet routes a dApp-named payer)", () => {
	const at = (
		publicFeeJuice: bigint | null,
		privateFeeJuice: bigint | null,
		over: Partial<{ privateBridge: boolean; publicAllowed: boolean }> = {},
	) => decideOwnGasSource({ publicFeeJuice, privateFeeJuice, ceiling: 100n, privateBridge: false, publicAllowed: true, ...over })

	it("a public record prefers its public Fee Juice when it covers, else its private balance", () => {
		expect(at(100n, 100n)).toBe("public")
		expect(at(99n, 100n)).toBe("private")
	})

	it("a private bridge pays only from its private balance - public Fee Juice never pays it, however much is held", () => {
		expect(at(100n, 100n, { privateBridge: true })).toBe("private")
		expect(at(100n, 99n, { privateBridge: true })).toBe("short")
		expect(at(10n ** 21n, 0n, { privateBridge: true })).toBe("none")
		expect(at(10n ** 21n, null, { privateBridge: true })).toBe("unverifiable")
		expect(at(null, 100n, { privateBridge: true })).toBe("private")
	})

	it("a balance under the ceiling never pays - not even a public one the wallet would estimate lower", () => {
		expect(at(99n, 0n)).toBe("short")
		expect(at(0n, 99n)).toBe("short")
		expect(at(0n, 0n)).toBe("none")
	})

	it("FAIL-CLOSED: a failed read with no balance known to cover is unverifiable", () => {
		expect(at(null, 0n)).toBe("unverifiable")
		expect(at(0n, null)).toBe("unverifiable")
		expect(at(null, 100n)).toBe("private")
		expect(at(100n, null)).toBe("public")
	})

	it("a wallet that cannot route a public payer keeps the private-only rule, whatever the public balance", () => {
		expect(at(1_000n, 100n, { publicAllowed: false })).toBe("private")
		expect(at(1_000n, 99n, { publicAllowed: false })).toBe("short")
		expect(at(1_000n, 0n, { publicAllowed: false })).toBe("none")
		expect(at(1_000n, null, { publicAllowed: false })).toBe("unverifiable")
	})
})

describe("decideFuelLadder — the privacy fence", () => {
	const complete = { received: "1000", leafIndex: "7", bridgeSecretSalt: "0xsalt" }

	it("a well-formed private fueled record routes to the private ladder", () => {
		expect(decideFuelLadder({ isPrivate: true, schema: 2, fuel: complete })).toBe("private")
	})

	it("public records use the public ladder", () => {
		expect(decideFuelLadder({ isPrivate: false, schema: 2, fuel: complete })).toBe("public")
	})

	it("a private record with NO fuel is unaffected — it never bridged FJ", () => {
		expect(decideFuelLadder({ isPrivate: true, schema: 1, fuel: undefined })).toBe("public")
	})

	// The regression this pins: a private fueled record must NEVER reach the public /
	// sponsored ladder, whichever piece of claim metadata is missing (never written, partially
	// restored, tampered): falling through would claim the FJ in a public tx.
	it.each([
		["missing salt", { received: "1000", leafIndex: "7" }],
		["missing leafIndex", { received: "1000", bridgeSecretSalt: "0xsalt" }],
		["missing received", { leafIndex: "7", bridgeSecretSalt: "0xsalt" }],
		["empty fuel block", {}],
	])("private + %s fails closed, never public", (_label, fuel) => {
		expect(decideFuelLadder({ isPrivate: true, schema: 2, fuel })).toBe("private-incomplete")
	})
})

describe("decideStandaloneFuelRecovery — one source for the card and the action", () => {
	const base = { isPrivate: false, isFeeJuiceAsset: false, schema: 2 as const, completedAt: 1 }
	const fuel = { received: "1000", leafIndex: "7" }

	it("offers recovery for a completed PUBLIC record with unsettled fuel", () => {
		expect(decideStandaloneFuelRecovery({ ...base, fuel })).toBe("offer")
	})

	it.each([
		["no fuel block", { ...base, fuel: undefined }],
		["a direct-Fuel record (its completion IS the gas claim)", { ...base, isFeeJuiceAsset: true, fuel }],
		["an unfinished claim (retried by the normal action)", { ...base, completedAt: undefined, fuel }],
		["fuel already consumed", { ...base, fuel: { ...fuel, consumed: true } }],
		["fuel already recovered standalone", { ...base, fuel: { ...fuel, standaloneClaimed: true } }],
	])("offers nothing for %s", (_label, input) => {
		expect(decideStandaloneFuelRecovery(input)).toBe("none")
	})

	it("a token another submitter claimed counts as finished for the fuel: PUBLIC offers, PRIVATE stays silent", () => {
		const claimedByOther = { ...base, completedAt: undefined, claimedByOther: true }
		expect(decideStandaloneFuelRecovery({ ...claimedByOther, fuel })).toBe("offer")
		expect(decideStandaloneFuelRecovery({ ...claimedByOther, fuel: { ...fuel, standaloneClaimed: true } })).toBe("none")
		expect(decideStandaloneFuelRecovery({ ...claimedByOther, isPrivate: true, fuel: { ...fuel, bridgeSecretSalt: "0xsalt" } })).toBe(
			"none",
		)
	})

	it("a well-formed completed PRIVATE record is settled — silence, not an affordance", () => {
		// Its FJ paid for the tx that completed it, so an unlatched `consumed` is a stale flag.
		const input = { ...base, isPrivate: true, fuel: { ...fuel, bridgeSecretSalt: "0xsalt" } }
		expect(decideStandaloneFuelRecovery(input)).toBe("private-settled")
	})

	it.each([
		["missing its salt", { received: "1000", leafIndex: "7" }],
		["missing event-derived fields", { received: "1000", bridgeSecretSalt: "0xsalt" }],
	])("a PRIVATE record %s is unknown — surfaced, never offered", (_label, f) => {
		expect(decideStandaloneFuelRecovery({ ...base, isPrivate: true, fuel: f })).toBe("private-unknown")
	})

	// The durable marker, not the block's presence: a schema-2 record whose fuel block was lost to
	// tampering still HAS a live FJ message, so it must not be read as a no-fuel deposit.
	it("a private schema-2 record with NO fuel block is unknown, never 'none'", () => {
		expect(decideStandaloneFuelRecovery({ ...base, isPrivate: true, fuel: undefined })).toBe("private-unknown")
		expect(decideFuelLadder({ isPrivate: true, schema: 2, fuel: undefined })).toBe("private-incomplete")
	})

	it("a schema-3 record is fueled only when its intent bought gas", () => {
		expect(decideFuelLadder({ isPrivate: true, schema: 3, intent: "token", fuel: undefined })).toBe("public")
		expect(decideFuelLadder({ isPrivate: true, schema: 3, intent: "token+gas", fuel: undefined })).toBe("private-incomplete")
		expect(decideStandaloneFuelRecovery({ ...base, isPrivate: true, schema: 3, intent: "token", fuel: undefined })).toBe("none")
		expect(decideStandaloneFuelRecovery({ ...base, isPrivate: true, schema: 3, intent: "gas", fuel: undefined })).toBe(
			"private-unknown",
		)
	})

	it("a genuine no-fuel private deposit (schema 1) is untouched", () => {
		expect(decideStandaloneFuelRecovery({ ...base, isPrivate: true, schema: 1, fuel: undefined })).toBe("none")
		expect(decideFuelLadder({ isPrivate: true, schema: 1, fuel: undefined })).toBe("public")
	})

	it("no private record can ever reach 'offer'", () => {
		for (const f of [fuel, { ...fuel, bridgeSecretSalt: "0xsalt" }, { received: "1000" }, {}, undefined]) {
			for (const schema of [1, 2] as const) {
				expect(decideStandaloneFuelRecovery({ ...base, isPrivate: true, schema, fuel: f })).not.toBe("offer")
			}
		}
	})
})
