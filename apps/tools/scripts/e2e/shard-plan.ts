/**
 * Splits the browser suite's spec files across CI shards by measured wall-clock instead of test count.
 * A file is the unit: it owns a worker and an actor pool, so splitting one would pay its setup twice.
 * Every shard computes the same plan from the same inputs, so the shards are disjoint and complete.
 */

/** Per spec file (its path under `specs/`): how many tests it had and the seconds its shard spent on it,
 *  worker start and actor pool included. */
export type Durations = Readonly<Record<string, { readonly tests: number; readonly seconds: number }>>

export interface SpecFile {
	readonly file: string
	readonly tests: number
}

export interface Shard {
	readonly files: string[]
	readonly seconds: number
}

/**
 * Longest-first greedy assignment: each file, costliest first, joins the least-loaded shard (ties go to
 * the lower index, equal costs order by name). A file costs its recorded seconds per test times its
 * current test count; a file the record lacks costs the record's overall rate, or 1 s per test when the
 * record is empty, which degrades to a split by count.
 * @throws when `total` is not a positive integer or a file appears twice.
 */
export function planShards(specs: readonly SpecFile[], total: number, record: Durations): Shard[] {
	if (!Number.isInteger(total) || total < 1) throw new Error(`shard-plan: ${total} is not a shard count`)
	const known = new Map(Object.entries(record))
	let tests = 0
	let seconds = 0
	for (const entry of known.values()) {
		tests += entry.tests
		seconds += entry.seconds
	}
	const fallback = tests > 0 ? seconds / tests : 1
	const costs = new Map<string, number>()
	for (const spec of specs) {
		if (costs.has(spec.file)) throw new Error(`shard-plan: ${spec.file} is listed twice`)
		const entry = known.get(spec.file)
		const rate = entry && entry.tests > 0 ? entry.seconds / entry.tests : fallback
		costs.set(spec.file, rate * spec.tests)
	}
	const order = [...costs].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
	const shards = Array.from({ length: total }, () => ({ files: [] as string[], seconds: 0 }))
	for (const [file, cost] of order) {
		const lightest = shards.reduce((min, shard) => (shard.seconds < min.seconds ? shard : min))
		lightest.files.push(file)
		lightest.seconds += cost
	}
	return shards
}

const LOG_LINE = /^([^\t]+)\t[^\t]*\t(\S+) (.*)$/
const RUNNING = /^Running \d+ tests? using \d+ workers?/
const TEST_END = /^\s*([✓✘-])\s+\d+ \[[^\]]+\] › /
const SPEC_AT = /^(?:\S*\/)?specs\/(.+?\.spec\.ts):\d+:\d+ › /

type LogEvent =
	| { kind: "start"; job: string; at: number }
	| { kind: "test"; job: string; at: number; file: string; text: string }
	| { kind: "unreadable"; job: string; text: string }

const unattributable = ({ job, text }: { job: string; text: string }) =>
	new Error(`shard-plan: cannot attribute "${text.trim()}" in ${job}`)

/** A job's `Running N tests` line, a test's result line, a result line whose location does not parse, or
 *  null for any other line. */
function readLine(line: string): LogEvent | null {
	const [, job, stamp, text] = LOG_LINE.exec(line) ?? []
	if (!job || !stamp || text === undefined) return null
	const at = Date.parse(stamp.replace(/(\.\d{3})\d+/, "$1"))
	if (RUNNING.test(text)) return { job, at, kind: "start" }
	const [end, mark] = TEST_END.exec(text) ?? []
	if (!end) return null
	const [, file] = SPEC_AT.exec(text.slice(end.length)) ?? []
	if (!file) return { kind: "unreadable", job, text }
	if (mark === "✘") throw new Error(`shard-plan: ${file} failed in ${job}; record from a green run`)
	return { job, at, kind: "test", file, text }
}

/**
 * Reads `gh run view <id> --log` of a green browser-suite run. A test costs the gap since the previous
 * test ended in its job (or since the job's `Running N tests` line), so a file's seconds include its
 * worker start and actor pool, which the reporter's own durations leave out.
 * @throws on a failed test, whose time is not its cost; on a test line it cannot attribute, whose time
 *   would land on the next test; or on a log with no test lines.
 */
export function recordDurations(log: string): Durations {
	const last = new Map<string, number>()
	const files = new Map<string, { tests: number; seconds: number }>()
	for (const line of log.split("\n")) {
		const event = readLine(line)
		if (!event) continue
		if (event.kind === "unreadable") throw unattributable(event)
		if (event.kind === "test") {
			const since = last.get(event.job)
			if (since === undefined) throw unattributable(event)
			const entry = files.get(event.file) ?? { tests: 0, seconds: 0 }
			entry.tests++
			entry.seconds += (event.at - since) / 1000
			files.set(event.file, entry)
		}
		last.set(event.job, event.at)
	}
	if (files.size === 0) throw new Error("shard-plan: the log holds no browser-suite test lines")
	return Object.fromEntries(
		[...files]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([file, { tests, seconds }]) => [file, { tests, seconds: Math.round(seconds) }]),
	)
}
