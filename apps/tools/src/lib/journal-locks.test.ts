import { describe, expect, it, vi } from "vitest"
import { HELD_ELSEWHERE, JOURNAL_LOCK, memoryJournalLocks, recordLockName, webJournalLocks } from "./journal-locks"

type Granted = (lock: Lock | null) => unknown

/** A `navigator.locks` fake with the real request shapes: a waiting request queues behind the
 *  holder; an `ifAvailable` request runs its callback at once, with `null` when the name is held. */
function fakeLockManager() {
	const held = new Map<string, Promise<unknown>>()
	const request = vi.fn((name: string, optionsOrCb: LockOptions | Granted, cb?: Granted) => {
		const callback = (typeof optionsOrCb === "function" ? optionsOrCb : cb) as Granted
		const options = typeof optionsOrCb === "function" ? {} : optionsOrCb
		const lock = { name, mode: "exclusive" } as Lock
		if (options.ifAvailable) {
			if (held.has(name)) return Promise.resolve(callback(null))
			const run = Promise.resolve().then(() => callback(lock))
			held.set(name, run)
			return run.finally(() => held.delete(name))
		}
		const run = (held.get(name) ?? Promise.resolve()).catch(() => undefined).then(() => callback(lock))
		held.set(name, run)
		return run.finally(() => {
			if (held.get(name) === run) held.delete(name)
		})
	})
	return { request } as unknown as LockManager & { request: typeof request }
}

describe("webJournalLocks — the Web Locks adapter", () => {
	it("is absent without a lock manager", () => {
		expect(webJournalLocks(undefined)).toBeUndefined()
	})

	it("record: a held lock answers HELD_ELSEWHERE from the null-lock callback without running the body", async () => {
		const manager = fakeLockManager()
		const locks = webJournalLocks(manager) as NonNullable<ReturnType<typeof webJournalLocks>>
		let release: () => void = () => {}
		const first = locks.record("r1", () => new Promise<string>((r) => (release = () => r("ran"))))
		await Promise.resolve()
		const body = vi.fn(async () => "never")
		await expect(locks.record("r1", body)).resolves.toBe(HELD_ELSEWHERE)
		expect(body).not.toHaveBeenCalled()
		expect(manager.request).toHaveBeenLastCalledWith(recordLockName("r1"), { ifAvailable: true }, expect.any(Function))
		release()
		await expect(first).resolves.toBe("ran")
		// Released ⇒ the next runner gets the lock and its own result back.
		await expect(locks.record("r1", async () => "again")).resolves.toBe("again")
	})

	it("journal: the second write waits for the first to release, then sees its result", async () => {
		const manager = fakeLockManager()
		const locks = webJournalLocks(manager) as NonNullable<ReturnType<typeof webJournalLocks>>
		const order: string[] = []
		let release: () => void = () => {}
		const first = locks.journal(() => new Promise<void>((r) => (release = () => r())).then(() => order.push("first")))
		await Promise.resolve()
		const second = locks.journal(() => order.push("second"))
		await Promise.resolve()
		expect(order).toEqual([])
		release()
		await first
		await second
		expect(order).toEqual(["first", "second"])
		expect(manager.request).toHaveBeenCalledWith(JOURNAL_LOCK, expect.any(Function))
	})
})

describe("memoryJournalLocks — the in-memory fake two test tabs share", () => {
	it("record: one runs, the other is held elsewhere, and the name frees on completion", async () => {
		const locks = memoryJournalLocks()
		let release: () => void = () => {}
		const first = locks.record("r", () => new Promise<string>((r) => (release = () => r("ran"))))
		await expect(locks.record("r", async () => "second")).resolves.toBe(HELD_ELSEWHERE)
		await expect(locks.record("other", async () => "other")).resolves.toBe("other")
		release()
		await expect(first).resolves.toBe("ran")
		await expect(locks.record("r", async () => "second")).resolves.toBe("second")
	})

	it("record: a throwing body releases the name for the next runner", async () => {
		const locks = memoryJournalLocks()
		await expect(
			locks.record("r", async () => {
				throw new Error("boom")
			}),
		).rejects.toThrow("boom")
		await expect(locks.record("r", async () => "next")).resolves.toBe("next")
	})

	it("journal: writes serialize in order, and a throwing write does not wedge the next", async () => {
		const locks = memoryJournalLocks()
		const order: number[] = []
		let release: () => void = () => {}
		const first = locks.journal(() => new Promise<void>((r) => (release = () => r())).then(() => order.push(1)))
		const failing = locks.journal(() => {
			throw new Error("boom")
		})
		const third = locks.journal(() => order.push(3))
		await Promise.resolve()
		release()
		await first
		await expect(failing).rejects.toThrow("boom")
		await third
		expect(order).toEqual([1, 3])
	})
})
