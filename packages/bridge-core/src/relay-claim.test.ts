import { Fr } from "@aztec-labs/aztec.js/fields"
import { describe, expect, it } from "vitest"
import { parseClaimDescriptor, redactDescriptorForLog, requireRelayerSecret } from "./relay-claim"

const RECIPIENT = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
const BRIDGE = "0x00000000000000000000000000000000000000000000000000000000000000aa"
const SALT = "0x0000000000000000000000000000000000000000000000000000000000000abc"

const validRaw = () => ({ bridge: BRIDGE, recipient: RECIPIENT, amount: "1000", salt: SALT, leafIndex: 7 })

describe("parseClaimDescriptor", () => {
	it("parses a well-formed descriptor into typed fields (salt → Fr)", () => {
		const d = parseClaimDescriptor(validRaw())
		expect(d.bridge).toBe(BRIDGE)
		expect(d.recipient).toBe(RECIPIENT)
		expect(d.amount).toBe(1000n)
		expect(d.leafIndex).toBe(7n)
		expect(d.salt).toBeInstanceOf(Fr)
		expect(d.salt.toString()).toBe(Fr.fromString(SALT).toString())
	})

	it("accepts amount as string, number, or bigint; leafIndex 0 is valid", () => {
		expect(parseClaimDescriptor({ ...validRaw(), amount: 5, leafIndex: 0 }).amount).toBe(5n)
		expect(parseClaimDescriptor({ ...validRaw(), amount: 5n }).amount).toBe(5n)
		expect(parseClaimDescriptor({ ...validRaw(), leafIndex: "0" }).leafIndex).toBe(0n)
	})

	it("fail-closed on a non-object", () => {
		expect(() => parseClaimDescriptor(null)).toThrow(/not a JSON object/)
		expect(() => parseClaimDescriptor("x")).toThrow(/not a JSON object/)
	})

	it("fail-closed on missing/invalid bridge or recipient", () => {
		expect(() => parseClaimDescriptor({ ...validRaw(), bridge: undefined })).toThrow(/bridge/)
		expect(() => parseClaimDescriptor({ ...validRaw(), recipient: "not-hex" })).toThrow(/recipient/)
	})

	it("fail-closed on a non-positive amount", () => {
		expect(() => parseClaimDescriptor({ ...validRaw(), amount: 0 })).toThrow(/greater than zero/)
		expect(() => parseClaimDescriptor({ ...validRaw(), amount: -3 })).toThrow(/non-negative integer|greater than zero/)
	})

	it("fail-closed on a malformed salt WITHOUT echoing its value", () => {
		const badSalt = "0xZZZ_not_a_field_but_looks_secret"
		try {
			parseClaimDescriptor({ ...validRaw(), salt: badSalt })
			throw new Error("expected throw")
		} catch (e) {
			expect((e as Error).message).toMatch(/salt/)
			expect((e as Error).message).not.toContain(badSalt)
		}
	})
})

describe("requireRelayerSecret", () => {
	it("returns an Fr for a valid key", () => {
		const key = Fr.random().toString()
		expect(requireRelayerSecret({ RELAYER_L2_SECRET_KEY: key })).toBeInstanceOf(Fr)
	})

	it("fail-closed when the key is absent", () => {
		expect(() => requireRelayerSecret({})).toThrow(/RELAYER_L2_SECRET_KEY is required/)
	})

	it("fail-closed on a zero key", () => {
		expect(() => requireRelayerSecret({ RELAYER_L2_SECRET_KEY: Fr.ZERO.toString() })).toThrow(/zero/)
	})

	it("never echoes the raw key in the error on an invalid value", () => {
		const junk = "0xnot-a-valid-field-element-secret-material"
		try {
			requireRelayerSecret({ RELAYER_L2_SECRET_KEY: junk })
			throw new Error("expected throw")
		} catch (e) {
			expect((e as Error).message).not.toContain(junk)
		}
	})
})

describe("redactDescriptorForLog", () => {
	it("redacts the salt AND the linkage (recipient, amount, leaf); keeps only the public bridge", () => {
		const view = redactDescriptorForLog(parseClaimDescriptor(validRaw()))
		expect(view.salt).toBe("<redacted>")
		expect(view.recipient).toBe("<redacted>")
		expect(view.amount).toBe("<redacted>")
		expect(view.leafIndex).toBe("<redacted>")
		expect(view.bridge).toBe(BRIDGE) // the public contract, shared by every deposit — not linkage
		// The linkage credentials (salt + recipient) never leak into the log view.
		const s = JSON.stringify(view)
		expect(s).not.toContain(SALT)
		expect(s).not.toContain(RECIPIENT)
	})
})
