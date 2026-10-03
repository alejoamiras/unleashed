import { PRIVATE_FPC_ADDRESS } from "@unleashed/bridge-core"
import { describe, expect, it } from "vitest"
import { fuelRecipientFor } from "./fuel-target"

const USER = "0x1234567890abcdef1234567890abcdef12345678"

describe("fuelRecipientFor", () => {
	it("public fuel lands at the user's own Aztec address", () => {
		expect(fuelRecipientFor(false, USER)).toBe(USER)
	})

	// Equality against the canonical export, not just "address-shaped and not the user":
	// the value is what the wallet signs and the router forwards verbatim, so a stale or
	// mistyped local copy would satisfy every structural check while silently sending
	// private fuel somewhere no one can claim it from.
	it("private fuel lands at the canonical PrivateFPC — never the user's address on L1", () => {
		expect(fuelRecipientFor(true, USER)).toBe(PRIVATE_FPC_ADDRESS)
		expect(fuelRecipientFor(true, USER)).not.toBe(USER)
	})

	it("ignores the recipient entirely on the private branch", () => {
		expect(fuelRecipientFor(true, `0x${"ff".repeat(64)}`)).toBe(fuelRecipientFor(true, `0x${"00".repeat(64)}`))
	})
})
