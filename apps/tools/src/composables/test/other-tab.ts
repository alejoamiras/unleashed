import { type JournalLocks, memoryJournalLocks } from "@/lib/journal-locks"

type Lanes = Pick<Storage, "getItem" | "setItem">

/**
 * Another tab's whole-lane write under the journal lock, for lost-write tests. `hold` loads `key` inside the lock and
 * keeps it until `release`, then writes the loaded lane back with `extra` appended. Connect `locks` to the engine:
 * `behind` counts the journal requests made once a hold is up.
 */
export function otherTab() {
	const shared = memoryJournalLocks()
	let holder: Promise<unknown> | undefined
	let behind = 0
	let loaded: string | null = null
	let open = () => {}
	const locks: JournalLocks = {
		...shared,
		journal: (fn) => {
			if (holder) behind++
			return shared.journal(fn)
		},
	}
	return {
		locks,
		hold(kv: Lanes, key: string, extra: unknown): void {
			holder = locks.journal(() => {
				loaded = kv.getItem(key)
				return new Promise<void>((r) => {
					open = r
				}).then(() => {
					const lane = JSON.parse(loaded ?? '{"schema":1,"records":[]}') as { records: unknown[] }
					kv.setItem(key, JSON.stringify({ ...lane, records: [...lane.records, extra] }))
				})
			})
		},
		get behind() {
			return behind
		},
		/** The lane as the other tab loaded it: storage reads the same while the hold is up. */
		get loaded() {
			return loaded
		},
		/** Ends the hold; settles once the other tab's write has landed. */
		release(): Promise<unknown> | undefined {
			open()
			return holder
		},
	}
}
