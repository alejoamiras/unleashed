import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { type Durations, planShards, recordDurations } from "./shard-plan"

const browser = join(dirname(fileURLToPath(import.meta.url)), "../../tests/browser")
const RECORD = JSON.parse(readFileSync(join(browser, "shard-durations.json"), "utf8")) as Durations
const suite = readdirSync(join(browser, "specs"))
	.filter((file) => file.endsWith(".spec.ts") && !file.startsWith("zz-"))
	.map((file) => ({ file, tests: (readFileSync(join(browser, "specs", file), "utf8").match(/^test\(/gm) ?? []).length }))

describe("planShards", () => {
	it("places every spec file of the suite in exactly one shard, at any shard count", () => {
		const names = suite.map((spec) => spec.file).sort()
		for (let total = 1; total <= suite.length + 1; total++) {
			expect(
				planShards(suite, total, RECORD)
					.flatMap((shard) => shard.files)
					.sort(),
			).toEqual(names)
		}
	})

	it("names no spec file the suite no longer has", () => {
		expect(Object.keys(RECORD).filter((file) => !suite.some((spec) => spec.file === file))).toEqual([])
	})

	it("scales a file by its test count, prices an unknown file at the record's rate, and ignores input order", () => {
		const record: Durations = { "a.spec.ts": { tests: 2, seconds: 100 }, "b.spec.ts": { tests: 1, seconds: 20 } }
		const specs = [
			{ file: "a.spec.ts", tests: 4 },
			{ file: "b.spec.ts", tests: 1 },
			{ file: "c.spec.ts", tests: 3 },
		]
		const expected = [
			{ files: ["a.spec.ts"], seconds: 200 },
			{ files: ["c.spec.ts", "b.spec.ts"], seconds: 140 },
		]
		expect(planShards(specs, 2, record)).toEqual(expected)
		expect(planShards([...specs].reverse(), 2, record)).toEqual(expected)
	})

	it("splits by test count when the record is empty, and refuses a bad shard count or a repeated file", () => {
		const specs = [
			{ file: "x.spec.ts", tests: 3 },
			{ file: "y.spec.ts", tests: 2 },
			{ file: "z.spec.ts", tests: 2 },
		]
		expect(planShards(specs, 2, {}).map((shard) => shard.files)).toEqual([["x.spec.ts"], ["y.spec.ts", "z.spec.ts"]])
		expect(() => planShards(specs, 0, {})).toThrow("not a shard count")
		expect(() => planShards([...specs, specs[0]!], 2, {})).toThrow("listed twice")
	})
})

describe("recordDurations", () => {
	const job = (n: number) => `Shards (${n}) / tools e2e (${n}/6)\tUNKNOWN STEP\t`
	const log = [
		`${job(1)}2026-10-20T21:20:00.0000000Z [e2e:tools] running playwright (--shard=1/6)`,
		`${job(1)}2026-10-20T21:20:10.1234567Z Running 3 tests using 1 worker, shard 1 of 6`,
		`${job(2)}2026-10-20T21:20:20.0000000Z Running 1 test using 1 worker, shard 2 of 6`,
		`${job(1)}2026-10-20T21:21:10.1234567Z   ✓   1 [chromium] › tests/browser/specs/a.spec.ts:5:1 › first (45.0s)`,
		`${job(2)}2026-10-20T21:20:50.0000000Z   ✓   1 [chromium] › tests/browser/specs/c.spec.ts:9:1 › only (20.0s)`,
		`${job(1)}2026-10-20T21:21:40.1234567Z   ✓   2 [chromium] › tests/browser/specs/a.spec.ts:20:1 › second (28.0s)`,
		`${job(1)}2026-10-20T21:22:00.1234567Z   ✓   3 [chromium] › tests/browser/specs/b c.spec.ts:7:1 › third › with › steps (12.5s)`,
		`${job(1)}2026-10-20T21:22:01.0000000Z   3 passed (1.9m)`,
	].join("\n")

	it("charges each test the wall-clock since the previous one ended in its job", () => {
		expect(recordDurations(log)).toEqual({
			"a.spec.ts": { tests: 2, seconds: 90 },
			"b c.spec.ts": { tests: 1, seconds: 20 },
			"c.spec.ts": { tests: 1, seconds: 30 },
		})
	})

	it("refuses a failed test, a test line it cannot attribute, and a log with no test lines", () => {
		const failed = log.replace("✓   2", "✘   2")
		expect(() => recordDurations(failed)).toThrow("record from a green run")
		const unanchored = `${log}\n${job(3)}2026-10-20T21:23:00.0000000Z   ✓   1 [chromium] › tests/browser/specs/d.spec.ts:1:1 › early (1.0s)`
		expect(() => recordDurations(unanchored)).toThrow("cannot attribute")
		const unreadable = log.replace("specs/c.spec.ts:9:1", "c.ts:9:1")
		expect(() => recordDurations(unreadable)).toThrow("cannot attribute")
		expect(() => recordDurations(`${job(1)}2026-10-20T21:20:00.0000000Z hello`)).toThrow("no browser-suite test lines")
	})
})
