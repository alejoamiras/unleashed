/**
 * The two same-origin locks the journal engine takes across tabs. The storage unit is the WHOLE
 * journal array, so a guarded write (load → guard → write) is only a compare-and-set while no other
 * tab writes in between; and a record's runner (claim, consume) must not run twice at once, or two
 * tabs both send. Web Locks coordinate cooperating callers only — the journal's older unlocked
 * writers stay best-effort, and this adapter changes nothing about them.
 */

export const JOURNAL_LOCK = "unleashed-bridge:journal"
export const recordLockName = (id: string): string => `unleashed-bridge:record:${id}`

/** The answer a record runner gets when another tab already holds its lock: nothing ran. */
export const HELD_ELSEWHERE = "held-elsewhere" as const

export interface JournalLocks {
	/** Run one guarded journal write once the journal lock is held (waits for a holder to release). */
	journal<T>(fn: () => T): Promise<T>
	/** Run a record's runner only when nobody holds its lock; contention answers `HELD_ELSEWHERE`
	 *  without invoking `fn`. */
	record<T>(id: string, fn: () => Promise<T>): Promise<T | typeof HELD_ELSEWHERE>
}

/** The production adapter over `navigator.locks`; undefined where the API is missing, so the engine
 *  keeps its process-local dedup and every guarded write its synchronous best effort. */
export function webJournalLocks(manager: LockManager | undefined = globalThis.navigator?.locks): JournalLocks | undefined {
	if (!manager) return undefined
	return {
		journal: (fn) => manager.request(JOURNAL_LOCK, async () => fn()),
		// Under contention `ifAvailable` still invokes the callback — with `null` — so the branch is
		// on the lock object, never on the request resolving.
		record: <T>(id: string, fn: () => Promise<T>) =>
			manager.request(
				recordLockName(id),
				{ ifAvailable: true },
				(lock): Promise<T | typeof HELD_ELSEWHERE> => (lock ? fn() : Promise.resolve(HELD_ELSEWHERE)),
			) as Promise<T | typeof HELD_ELSEWHERE>,
	}
}

/** An in-memory table with the same contract, shared by the "tabs" of a unit test. */
export function memoryJournalLocks(): JournalLocks {
	let journal: Promise<unknown> = Promise.resolve()
	const held = new Set<string>()
	return {
		journal: (fn) => {
			const run = journal.then(fn)
			journal = run.catch(() => undefined)
			return run
		},
		record: async (id, fn) => {
			if (held.has(id)) return HELD_ELSEWHERE
			held.add(id)
			try {
				return await fn()
			} finally {
				held.delete(id)
			}
		},
	}
}
