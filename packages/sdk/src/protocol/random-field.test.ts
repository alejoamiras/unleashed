import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { afterAll, describe, expect, it, vi } from "vitest"
import { planPrivateFuelDeposit } from "./fuel.ts"
import { randomField } from "./random-field.ts"

const asUint = (byte: number): bigint => BigInt(`0x${byte.toString(16).padStart(2, "0").repeat(64)}`)

describe("randomField", () => {
	afterAll(() => vi.unstubAllEnvs())

	it("reduces 64 WebCrypto bytes into the field on every call", () => {
		const fills = [0xff, 0x01]
		const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
			;(array as Uint8Array).fill(fills[spy.mock.calls.length - 1] ?? 0)
			return array
		})
		try {
			const draws = [randomField(), randomField()].map((f) => f.toBigInt())
			expect(spy.mock.calls.map(([array]) => (array as Uint8Array).length)).toEqual([64, 64])
			expect(draws).toEqual(fills.map((byte) => asUint(byte) % Fr.MODULUS))
		} finally {
			spy.mockRestore()
		}
	})

	it("draws fresh protocol fields from WebCrypto", async () => {
		vi.stubEnv("SEED", "x")
		expect(Fr.random().equals(Fr.random())).toBe(true)
		expect(randomField().equals(randomField())).toBe(false)
		const claimer = AztecAddress.fromBigIntUnsafe(0xc0ffeen)
		const [a, b] = await Promise.all([planPrivateFuelDeposit(claimer, 1n), planPrivateFuelDeposit(claimer, 1n)])
		expect(a.secretHash).not.toBe(b.secretHash)
	})
})
