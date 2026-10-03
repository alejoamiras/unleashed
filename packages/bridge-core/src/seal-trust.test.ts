import { describe, expect, it } from "vitest"
import type { KV } from "./journal"
import { SEAL_TRUST_KEY, isSealTrusted, markSealTrusted, revokeSealTrust } from "./seal-trust"

function memKV(initial: Record<string, string> = {}): KV {
	const store = new Map(Object.entries(initial))
	return {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => void store.set(k, v),
		removeItem: (k) => void store.delete(k),
	}
}

const ADDR = "0xEf4D9e1F4e9e2dd9E747B53f4BE3D04bfa935f2d"
const CHAIN = 11155111

describe("seal-trust", () => {
	it("absent entry is untrusted", () => {
		expect(isSealTrusted(memKV(), CHAIN, ADDR, "rabby")).toBe(false)
	})

	it("mark → trusted for the same (chain, address, provider), case-insensitive address", () => {
		const kv = memKV()
		markSealTrusted(kv, CHAIN, ADDR, "rabby")
		expect(isSealTrusted(kv, CHAIN, ADDR.toLowerCase(), "rabby")).toBe(true)
	})

	it("a DIFFERENT provider fingerprint is untrusted — same address re-earns trust", () => {
		const kv = memKV()
		markSealTrusted(kv, CHAIN, ADDR, "rabby")
		expect(isSealTrusted(kv, CHAIN, ADDR, "metamask")).toBe(false)
	})

	it("a different chain is untrusted", () => {
		const kv = memKV()
		markSealTrusted(kv, CHAIN, ADDR, "rabby")
		expect(isSealTrusted(kv, 1, ADDR, "rabby")).toBe(false)
	})

	it("revoke removes trust; revoke of a missing entry is a no-op", () => {
		const kv = memKV()
		markSealTrusted(kv, CHAIN, ADDR, "rabby")
		revokeSealTrust(kv, CHAIN, ADDR)
		expect(isSealTrusted(kv, CHAIN, ADDR, "rabby")).toBe(false)
		revokeSealTrust(kv, CHAIN, ADDR)
		expect(isSealTrusted(kv, CHAIN, ADDR, "rabby")).toBe(false)
	})

	it("mark is idempotent-overwrite (provider updates in place)", () => {
		const kv = memKV()
		markSealTrusted(kv, CHAIN, ADDR, "rabby")
		markSealTrusted(kv, CHAIN, ADDR, "metamask")
		expect(isSealTrusted(kv, CHAIN, ADDR, "metamask")).toBe(true)
		expect(isSealTrusted(kv, CHAIN, ADDR, "rabby")).toBe(false)
	})

	it("generic fingerprints (unknown/injected) NEVER earn trust — even after a mark", () => {
		const kv = memKV()
		markSealTrusted(kv, CHAIN, ADDR, "injected")
		expect(isSealTrusted(kv, CHAIN, ADDR, "injected")).toBe(false)
		markSealTrusted(kv, CHAIN, ADDR, "unknown")
		expect(isSealTrusted(kv, CHAIN, ADDR, "unknown")).toBe(false)
		// A specific fingerprint still works on the same address.
		markSealTrusted(kv, CHAIN, ADDR, "rabby")
		expect(isSealTrusted(kv, CHAIN, ADDR, "rabby")).toBe(true)
	})

	it("corrupt store JSON degrades to untrusted, never crashes", () => {
		const kv = memKV({ [SEAL_TRUST_KEY]: "{broken" })
		expect(isSealTrusted(kv, CHAIN, ADDR, "rabby")).toBe(false)
		markSealTrusted(kv, CHAIN, ADDR, "rabby")
		expect(isSealTrusted(kv, CHAIN, ADDR, "rabby")).toBe(true)
	})
})
