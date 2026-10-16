/**
 * The unleashed.systems cutover through the Cloudflare API, never in CI. The token comes only from
 * this process's `CLOUDFLARE_API_TOKEN`: an owner-approved keyed run (`cloudflare-cutover.env.example`)
 * or the owner's own shell.
 *   inventory   read-only: records the zone's current state under ~/.cache, changes nothing
 *   cutover     features off, both domains attached, the redirect rule off, each step checked; refuses
 *               without an inventory record, on drift since the latest one, or before any change it
 *               cannot make safely; puts back what it changed when a check fails
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { type Api, cloudflare, tokenFromEnv } from "./cutover/api.ts"
import { failedReads, findZone, type Inventory, readInventory, STATE_DIR, saveRecord, summarize } from "./cutover/inventory.ts"
import { probe } from "./cutover/probe.ts"
import { type Build, cutover, type Deps } from "./cutover/run.ts"
import { fingerprint, readSnapshot, refusals, snapshotOfInventory } from "./cutover/state.ts"

async function inventory(api: Api): Promise<number> {
	const zone = await findZone(api)
	const record = await readInventory(api, zone)
	for (const line of summarize(record)) console.log(line)
	if (record.redirects.ok) console.log(`REDIRECT_RULESET=${JSON.stringify(record.redirects.value)}`)
	console.log(`record: ${saveRecord("inventory", record)}`)
	const failed = failedReads(record)
	for (const line of failed) console.error(`cutover: ${line}`)
	return failed.length ? 3 : 0
}

function lastInventory(): Inventory {
	const names = (existsSync(STATE_DIR) ? readdirSync(STATE_DIR) : []).filter((name) => /^inventory-.*\.json$/.test(name)).sort()
	const last = names.at(-1)
	if (!last) throw new Error(`no inventory record in ${STATE_DIR}: run inventory first`)
	console.log(`drift check against ${last}`)
	return JSON.parse(readFileSync(join(STATE_DIR, last), "utf8")) as Inventory
}

function driftLines(before: string, now: string): string[] {
	const a = JSON.parse(before) as Record<string, unknown>
	const b = JSON.parse(now) as Record<string, unknown>
	return Object.keys(b)
		.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
		.map((key) => `drift in ${key}: was ${JSON.stringify(a[key])}, now ${JSON.stringify(b[key])}`)
}

async function build(origin: string): Promise<Build | null> {
	try {
		const res = await fetch(`${origin}/build.json`, {
			redirect: "manual",
			headers: { "cache-control": "no-cache" },
			signal: AbortSignal.timeout(15_000),
		})
		return res.status === 200 ? ((await res.json()) as Build) : null
	} catch {
		return null
	}
}

let interrupted = false
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => {
		interrupted = true
	})
}

async function sleep(ms: number): Promise<void> {
	if (interrupted) throw new Error("interrupted")
	await wait(ms)
	if (interrupted) throw new Error("interrupted")
}

function journalAt(path: string): Deps["journal"] {
	const entries: unknown[] = []
	return (entry) => {
		entries.push({ at: new Date().toISOString(), ...entry })
		writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 })
	}
}

async function runCutover(api: Api): Promise<number> {
	const recorded = fingerprint(snapshotOfInventory(lastInventory()))
	const zone = await findZone(api)
	const now = await readSnapshot(api, zone)
	const drift = driftLines(recorded, fingerprint(now))
	const refused = [...drift, ...refusals(now)]
	if (refused.length) {
		for (const line of refused) console.error(`cutover: refused: ${line}`)
		return 2
	}
	const path = saveRecord("cutover", [])
	console.log(`journal: ${path}`)
	const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)
	const outcome = await cutover({ api, zone, probe, build, sleep, log, journal: journalAt(path) }, now)
	for (const note of outcome.notes) console.log(`${outcome.code === 0 ? "note" : "cutover"}: ${note}`)
	console.log(
		outcome.code === 0 ? "CUTOVER PASSED" : outcome.code === 1 ? "CUTOVER ROLLED BACK" : "CUTOVER NEEDS A HAND: see NOT REVERTED",
	)
	return outcome.code
}

const MODES = { inventory, cutover: runCutover } as const
const mode = process.argv[2]
if (mode !== "inventory" && mode !== "cutover") {
	console.error(`cutover: usage: cutover.ts inventory|cutover, got '${mode ?? ""}'`)
	process.exit(2)
}
try {
	process.exit(await MODES[mode](cloudflare(tokenFromEnv())))
} catch (error) {
	console.error(`cutover: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}
