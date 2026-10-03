import { JOURNAL_KEY } from "@unleashed/bridge-core"
import { ref } from "vue"

/**
 * Whether the activity dock is open, and which records it has already opened itself for.
 *
 * Two persisted facts, both untrusted on read: the user's explicit choice (`open` / `hidden`,
 * hidden until they say otherwise) and the ids the dock has shown or been hidden on. The dock
 * opens ITSELF only for a record it has never opened for — once per record, across reloads and
 * tabs — and never writes the choice when it does, so an auto-open cannot overrule a hide.
 */
export const DOCK_KEY = "unleashed:tools-dock"
export const DOCK_SEEN_KEY = "unleashed:tools-dock-seen"

export type DockPreference = "open" | "hidden"

function isPreference(value: unknown): value is DockPreference {
	return value === "open" || value === "hidden"
}

export function readDockPreference(): DockPreference {
	try {
		const stored = localStorage.getItem(DOCK_KEY)
		return isPreference(stored) ? stored : "hidden"
	} catch {
		return "hidden"
	}
}

function writeDockPreference(next: DockPreference): void {
	try {
		localStorage.setItem(DOCK_KEY, next)
	} catch {
		// best-effort; the in-memory flag still drives this session
	}
}

/** The seen set is re-read on every use rather than cached: another tab's hide must count here. */
export function readSeen(): Set<string> {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(DOCK_SEEN_KEY) ?? "[]")
		return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [])
	} catch {
		return new Set()
	}
}

/** Ids the stored journal holds at this instant. The caller's `liveIds` can lag another tab's
 *  write until the storage event lands; a record that tab just hid must not be pruned meanwhile. */
function storedJournalIds(): Set<string> {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? "null")
		const records = parsed && typeof parsed === "object" ? (parsed as { records?: unknown }).records : undefined
		return new Set(
			Array.isArray(records)
				? records.map((r) => (r as { id?: unknown })?.id).filter((id): id is string => typeof id === "string")
				: [],
		)
	} catch {
		return new Set()
	}
}

/** Pruned to records that still exist: the journal never evicts an unfinished record, so a cap
 *  could forget a live bridge, while ids of discarded records would only accumulate. */
function writeSeen(seen: Set<string>, liveIds: ReadonlySet<string>): void {
	try {
		const stored = storedJournalIds()
		localStorage.setItem(DOCK_SEEN_KEY, JSON.stringify([...seen].filter((id) => liveIds.has(id) || stored.has(id))))
	} catch {
		// best-effort
	}
}

const open = ref(readDockPreference() === "open")

export function useDockState() {
	function show(): void {
		open.value = true
		writeDockPreference("open")
	}

	/** Records the ids as answered — the dock never opens itself for them — and leaves the choice alone. */
	function markSeen(ids: readonly string[], liveIds: ReadonlySet<string>): void {
		const seen = readSeen()
		for (const id of ids) seen.add(id)
		writeSeen(seen, liveIds)
	}

	/** Hiding on a needs-you record is the user's answer for that record: it never re-opens for it. */
	function hide(currentNeedsYouIds: readonly string[], liveIds: ReadonlySet<string>): void {
		open.value = false
		writeDockPreference("hidden")
		markSeen(currentNeedsYouIds, liveIds)
	}

	/** Opens the session flag — never the persisted choice — for any id not yet seen, then marks it. */
	function autoOpenFor(needsYouIds: readonly string[], liveIds: ReadonlySet<string>): void {
		const seen = readSeen()
		const fresh = needsYouIds.filter((id) => !seen.has(id))
		if (fresh.length === 0) return
		for (const id of fresh) seen.add(id)
		writeSeen(seen, liveIds)
		open.value = true
	}

	return { open, show, hide, markSeen, autoOpenFor }
}

/** Test-only: back to the boot state (storage is the test's to clear). */
export function __resetDockStateForTests(): void {
	open.value = readDockPreference() === "open"
}
