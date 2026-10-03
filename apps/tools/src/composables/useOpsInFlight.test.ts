import { describe, expect, it } from "vitest"
import { __resetOpsInFlightForTests, opsInFlight, useOpsInFlight, withOperation } from "./useOpsInFlight"

describe("useOpsInFlight", () => {
	it("busy is true exactly for the span of the wrapped operation", async () => {
		__resetOpsInFlightForTests()
		const { busy } = useOpsInFlight()
		expect(busy.value).toBe(false)

		let resolve: () => void = () => {}
		const op = withOperation(
			() =>
				new Promise<void>((res) => {
					resolve = res
				}),
		)
		expect(busy.value).toBe(true)
		expect(opsInFlight()).toBe(true)
		resolve()
		await op
		expect(busy.value).toBe(false)
		expect(opsInFlight()).toBe(false)
	})

	it("releases in finally: a throwing operation still frees the gate, and the error propagates", async () => {
		__resetOpsInFlightForTests()
		await expect(
			withOperation(async () => {
				throw new Error("boom")
			}),
		).rejects.toThrow("boom")
		expect(opsInFlight()).toBe(false)
	})

	it("nested/concurrent spans count — the gate holds until the LAST span closes", async () => {
		__resetOpsInFlightForTests()
		let resolveA: () => void = () => {}
		let resolveB: () => void = () => {}
		const a = withOperation(() => new Promise<void>((res) => (resolveA = res)))
		const b = withOperation(() => new Promise<void>((res) => (resolveB = res)))
		expect(opsInFlight()).toBe(true)
		resolveA()
		await a
		expect(opsInFlight()).toBe(true) // b still open
		resolveB()
		await b
		expect(opsInFlight()).toBe(false)
	})

	it("returns the operation's result", async () => {
		__resetOpsInFlightForTests()
		await expect(withOperation(async () => 42)).resolves.toBe(42)
	})
})
