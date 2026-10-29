import { describe, expect, it } from "vitest"
import { isMsgConsumed, isMsgNotReady } from "./message-errors.ts"

describe("isMsgNotReady / isMsgConsumed — the 5.0.0 L1→L2 message-state split", () => {
	// The two upstream (@aztec-labs/stdlib) shapes must map to OPPOSITE conditions: not-anchored keeps
	// polling; nullified settles. Conflating them strands funds either way.
	const NOT_READY = "No L1 to L2 message found for message hash 0xabc"
	const CONSUMED = "No non-nullified L1 to L2 message found for message hash 0xabc"

	it("not-ready shape ⇒ isMsgNotReady only", () => {
		expect(isMsgNotReady(NOT_READY)).toBe(true)
		expect(isMsgConsumed(NOT_READY)).toBe(false)
	})
	it("consumed (nullified) shape ⇒ isMsgConsumed only (NOT isMsgNotReady)", () => {
		expect(isMsgConsumed(CONSUMED)).toBe(true)
		expect(isMsgNotReady(CONSUMED)).toBe(false)
	})
	it("kernel/pxe not-ready wordings stay in isMsgNotReady", () => {
		expect(isMsgNotReady("l1_to_l2_msg_exists returned false")).toBe(true)
		expect(isMsgNotReady("message not in state")).toBe(true)
		expect(isMsgConsumed("l1_to_l2_msg_exists returned false")).toBe(false)
	})
})
