/**
 * Replaces Playwright's count-based `--shard` split with `planShards` over `shard-durations.json`.
 * Without `--shard` it does nothing. A shard whose run does not hold exactly its planned tests fails,
 * so a change in how Playwright applies the exclusions cannot drop a test while the run stays green.
 */
import { readFileSync } from "node:fs"
import type { FullConfig, FullResult, Reporter, Suite, TestRun } from "@playwright/test/reporter"
import { type Durations, planShards } from "../../scripts/e2e/shard-plan"

const RECORD = new URL("./shard-durations.json", import.meta.url)

function fileSuites(root: Suite): Suite[] {
	return root.suites.flatMap((project) => project.suites)
}

export default class ShardByDuration implements Reporter {
	/** This shard's test ids, each to its file. */
	private planned: Map<string, string> | null = null
	private mismatch: string | null = null

	async preprocess({ config, suite, testRun }: { config: FullConfig; suite: Suite; testRun: TestRun }): Promise<void> {
		if (!config.shard) return
		testRun.skipSharding()
		const tests = new Map<string, number>()
		for (const file of fileSuites(suite)) tests.set(file.title, (tests.get(file.title) ?? 0) + file.allTests().length)
		const record = JSON.parse(readFileSync(RECORD, "utf8")) as Durations
		const plan = planShards(
			[...tests].map(([file, n]) => ({ file, tests: n })),
			config.shard.total,
			record,
		)
		const mine = plan[config.shard.current - 1]
		if (!mine) throw new Error(`shard-reporter: no shard ${config.shard.current} of ${config.shard.total}`)
		const files = new Set(mine.files)
		this.planned = new Map()
		for (const file of fileSuites(suite)) {
			if (!files.has(file.title)) testRun.exclude(file)
			else for (const test of file.allTests()) this.planned.set(test.id, file.title)
		}
		const minutes = (s: number) => (s / 60).toFixed(1)
		const all = plan.reduce((sum, shard) => sum + shard.seconds, 0)
		console.log(
			`[shard] ${config.shard.current}/${config.shard.total} by duration: ${mine.files.join(", ") || "nothing"} (≈${minutes(mine.seconds)} of ${minutes(all)} min)`,
		)
	}

	onBegin(_config: FullConfig, suite: Suite): void {
		const planned = this.planned
		if (!planned) return
		const ran = suite.allTests()
		const ranIds = new Set(ran.map((test) => test.id))
		const extra = ran.filter((test) => !planned.has(test.id))
		// `--last-failed` narrows the run after `preprocess`, so there only an unplanned test is wrong.
		const narrowed = process.argv.includes("--last-failed")
		const missing = narrowed ? [] : [...planned].filter(([id]) => !ranIds.has(id))
		if (missing.length || extra.length) {
			const files = (pairs: string[]) => [...new Set(pairs)].join(", ") || "none"
			this.mismatch = `[shard] the run does not hold the planned tests: ${missing.length} missing (${files(missing.map(([, file]) => file))}), ${extra.length} unplanned`
			console.error(this.mismatch)
		}
	}

	async onEnd(_result: FullResult): Promise<{ status?: FullResult["status"] } | undefined> {
		if (!this.mismatch) return undefined
		console.error(this.mismatch)
		return { status: "failed" }
	}

	printsToStdio(): boolean {
		return false
	}
}
