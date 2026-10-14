/**
 * Run B: O2 steps 1 to 5 against the live zone, each followed by its check. Every change is journalled
 * with the value it replaced, and a failed check puts back what changed, newest first. A custom domain
 * stays attached on rollback: detaching one deletes its DNS record, and the re-enabled rule runs
 * before the Worker anyway, so the rule alone decides what visitors get.
 */
import type { Api } from "./api.ts"
import type { CertPack, CustomDomain, Zone } from "./inventory.ts"
import { APP_URLS, type Probe } from "./probe.ts"
import { APP_HOST, LANDING_HOSTS, type RedirectRule } from "./rules.ts"
import { type AttachMode, attachModes, type Snapshot, TOGGLES, WORKER } from "./state.ts"

export const WORKERS_DEV = "https://unleashed-landing.alejo-amiras.workers.dev"

export interface Build {
	buildId?: string
	channel?: string
}

export interface Deps {
	api: Api
	zone: Zone
	probe(url: string): Promise<Probe>
	/** `/build.json` of an origin, or null when it does not answer one. */
	build(origin: string): Promise<Build | null>
	sleep(ms: number): Promise<void>
	log(line: string): void
	/** Persists one journal entry before the run goes on. */
	journal(entry: Record<string, unknown>): void
}

interface Undo {
	what: string
	/** False while the change's own call is in flight: a refused call changed nothing. */
	applied: boolean
	run(): Promise<void>
}

class CheckFailed extends Error {}

const locationHost = (p: Probe) => (p.headers.location ? (URL.parse(p.headers.location)?.host ?? p.headers.location) : "")
const shape = (p: Probe) => `${p.status} ${locationHost(p)} csp=${Boolean(p.headers["content-security-policy"])}`

async function retry(deps: Deps, label: string, attempts: number, everyMs: number, check: () => Promise<string[]>): Promise<void> {
	let failures: string[] = []
	for (let i = 0; i < attempts; i++) {
		failures = await check()
		if (!failures.length) return
		await deps.sleep(everyMs)
	}
	throw new CheckFailed(`${label}: ${failures.join("; ")}`)
}

async function appHostsAsRecorded(deps: Deps, baseline: Map<string, string>): Promise<string[]> {
	const now = await Promise.all(APP_URLS.map((url) => deps.probe(url)))
	return now.filter((p) => shape(p) !== baseline.get(p.url)).map((p) => `${p.url} answers ${shape(p)}, was ${baseline.get(p.url)}`)
}

async function landingRedirects(deps: Deps): Promise<string[]> {
	const now = await Promise.all(LANDING_HOSTS.map((host) => deps.probe(`https://${host}/`)))
	return now
		.filter((p) => p.status !== 302 || locationHost(p) !== APP_HOST)
		.map((p) => `${p.url} answers ${shape(p)}, not 302 to the app`)
}

/** The step checks: app hosts unchanged, and (until the rule is off) both landing hosts still 302. */
function checkpoint(deps: Deps, baseline: Map<string, string>, label: string, ruleOn = true): Promise<void> {
	return retry(deps, label, 3, 5_000, async () => [
		...(await appHostsAsRecorded(deps, baseline)),
		...(ruleOn ? await landingRedirects(deps) : []),
	])
}

async function change(deps: Deps, undo: Undo[], what: string, apply: () => Promise<void>, revert: () => Promise<void>): Promise<void> {
	deps.journal({ step: what, phase: "start" })
	const entry: Undo = { what, applied: false, run: revert }
	undo.push(entry)
	await apply()
	entry.applied = true
	deps.journal({ step: what, phase: "done" })
	deps.log(`done: ${what}`)
}

function patchSetting(deps: Deps, id: string, value: unknown): () => Promise<void> {
	return async () => {
		await deps.api.call("PATCH", `/zones/${deps.zone.id}/settings/${id}`, { value })
	}
}

function patchRule(deps: Deps, rulesetId: string, rule: RedirectRule, enabled: boolean): () => Promise<void> {
	const { action, action_parameters, description, expression, ref } = rule
	const logging = (rule as { logging?: unknown }).logging
	return async () => {
		await deps.api.call("PATCH", `/zones/${deps.zone.id}/rulesets/${rulesetId}/rules/${rule.id}`, {
			action,
			action_parameters,
			description,
			enabled,
			expression,
			ref,
			...(logging === undefined ? {} : { logging }),
		})
	}
}

async function domainOf(deps: Deps, host: string): Promise<CustomDomain | undefined> {
	const domains = await deps.api.call<CustomDomain[]>("GET", `/accounts/${deps.zone.account.id}/workers/domains?hostname=${host}`)
	return domains.find((d) => d.hostname === host)
}

/** Wrangler's own attach call: the Worker's custom domains become exactly `hosts`, never taking one from another Worker. */
async function attach(deps: Deps, hosts: string[], replaceRecord: boolean): Promise<void> {
	await deps.api.call("PUT", `/accounts/${deps.zone.account.id}/workers/scripts/${WORKER}/domains/records`, {
		override_scope: true,
		override_existing_origin: false,
		override_existing_dns_record: replaceRecord,
		origins: hosts.map((hostname) => ({ hostname, zone_id: deps.zone.id })),
	})
	const host = hosts.at(-1)!
	const domain = await domainOf(deps, host)
	if (domain?.service !== WORKER) throw new CheckFailed(`${host} is not attached to ${WORKER} after the attach call`)
}

type Pack = CertPack & { certificates?: { id: string }[] }

function certificatePacks(deps: Deps): Promise<Pack[]> {
	return deps.api.list<Pack>(`/zones/${deps.zone.id}/ssl/certificate_packs?status=all`)
}

/**
 * The custom domain's own certificate: the pack its `cert_id` names, or an advanced pack for the host
 * that did not exist before the attach. The app domains' older packs also list the apex, so they never count.
 */
async function certificateActive(deps: Deps, host: string, before: ReadonlySet<string>): Promise<string[]> {
	const domain = await domainOf(deps, host)
	const packs = await certificatePacks(deps)
	const ours = packs.filter(
		(p) =>
			(domain?.cert_id && (p.id === domain.cert_id || p.certificates?.some((c) => c.id === domain.cert_id))) ||
			(p.type === "advanced" && p.hosts.includes(host) && !before.has(p.id)),
	)
	if (ours.some((p) => p.status === "active")) return []
	return [`${host}: certificate ${ours.map((p) => p.status).join(",") || "not issued yet"}`]
}

async function servesLanding(deps: Deps, expected: Build): Promise<string[]> {
	const failures: string[] = []
	for (const host of LANDING_HOSTS) {
		const [page, build] = await Promise.all([deps.probe(`https://${host}/`), deps.build(`https://${host}`)])
		const csp = page.headers["content-security-policy"] ?? ""
		if (page.status !== 200 || !csp.includes("default-src 'none'")) failures.push(`https://${host}/ answers ${shape(page)}`)
		if (build?.buildId !== expected.buildId || build?.channel !== "production")
			failures.push(`${host} serves build ${JSON.stringify(build)}`)
	}
	return failures
}

/** Not failures: phase 7 checks these again, and neither puts a visitor at risk. */
async function softChecks(deps: Deps): Promise<string[]> {
	const notes: string[] = []
	for (const host of LANDING_HOSTS) {
		const [secure, plain] = await Promise.all([deps.probe(`https://${host}/`), deps.probe(`http://${host}/`)])
		if (secure.headers.nel || secure.headers["report-to"]) notes.push(`https://${host}/ still sends nel or report-to`)
		if (plain.status !== 301 || plain.headers.location !== `https://${host}/`) notes.push(`http://${host}/ answers ${shape(plain)}`)
	}
	return notes
}

export interface Outcome {
	code: 0 | 1 | 4
	notes: string[]
}

async function settingsOff(deps: Deps, s: Snapshot, undo: Undo[], baseline: Map<string, string>): Promise<void> {
	for (const id of TOGGLES) {
		if (s.settings[id] !== "on") continue
		await change(deps, undo, `${id} off`, patchSetting(deps, id, "off"), patchSetting(deps, id, s.settings[id]))
		await checkpoint(deps, baseline, `after ${id} off`)
	}
	if (s.settings.nel.enabled !== false) {
		await change(deps, undo, "nel off", patchSetting(deps, "nel", { enabled: false }), patchSetting(deps, "nel", s.settings.nel))
		await checkpoint(deps, baseline, "after nel off")
	}
}

async function attachAll(deps: Deps, s: Snapshot, baseline: Map<string, string>): Promise<void> {
	const modes = attachModes(s)
	const before = new Set((await certificatePacks(deps)).map((p) => p.id))
	const hosts: string[] = s.domains.filter((d) => d.service === WORKER).map((d) => d.hostname)
	for (const host of LANDING_HOSTS) {
		const mode = modes[host] as AttachMode
		if (mode === "attached") continue
		hosts.push(host)
		deps.journal({ step: `attach ${host}`, mode, replacedRecords: s.dns.filter((r) => r.name === host) })
		await attach(deps, [...hosts], mode === "override")
		deps.log(`done: attach ${host} (${mode})`)
		await checkpoint(deps, baseline, `after attaching ${host}`)
	}
	await retry(deps, "certificates", 80, 15_000, async () =>
		(await Promise.all(LANDING_HOSTS.map((h) => certificateActive(deps, h, before)))).flat(),
	)
	deps.log("done: both certificates active")
}

async function rollback(deps: Deps, undo: Undo[]): Promise<string[]> {
	const failed: string[] = []
	for (const step of [...undo].reverse()) {
		try {
			await step.run()
			deps.journal({ step: step.what, phase: "reverted" })
			deps.log(`reverted: ${step.what}`)
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error)
			if (step.applied) failed.push(`${step.what}: ${why}`)
			else deps.log(`skipped: ${step.what} (its call failed, so it changed nothing; the revert said: ${why})`)
		}
	}
	return failed
}

/** Runs the cutover from a snapshot that has passed `refusals`. */
export async function cutover(deps: Deps, s: Snapshot): Promise<Outcome> {
	const undo: Undo[] = []
	const baseline = new Map((await Promise.all(APP_URLS.map((url) => deps.probe(url)))).map((p) => [p.url, shape(p)]))
	const expected = await deps.build(WORKERS_DEV)
	if (expected?.channel !== "production" || !expected.buildId)
		return { code: 1, notes: [`${WORKERS_DEV} serves ${JSON.stringify(expected)}`] }
	deps.journal({ step: "start", baseline: Object.fromEntries(baseline), expected, snapshot: s })
	try {
		await checkpoint(deps, baseline, "before any change")
		await settingsOff(deps, s, undo, baseline)
		await attachAll(deps, s, baseline)
		for (const rule of s.rules) {
			await change(
				deps,
				undo,
				`rule ${rule.id} off`,
				patchRule(deps, s.rulesetId, rule, false),
				patchRule(deps, s.rulesetId, rule, true),
			)
		}
		await retry(deps, "landing served", 30, 10_000, async () => [
			...(await servesLanding(deps, expected)),
			...(await appHostsAsRecorded(deps, baseline)),
		])
		deps.journal({ step: "verified" })
		return { code: 0, notes: await softChecks(deps) }
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		deps.log(`FAILED: ${reason}`)
		deps.journal({ step: "failed", reason })
		const failed = await rollback(deps, undo)
		if (failed.length) return { code: 4, notes: [reason, ...failed.map((f) => `NOT REVERTED: ${f}`)] }
		await retry(deps, "back to 302", 18, 10_000, () => landingRedirects(deps)).catch((e: unknown) => {
			failed.push(`after rollback: ${e instanceof Error ? e.message : String(e)}`)
		})
		return { code: failed.length ? 4 : 1, notes: [reason, ...failed] }
	}
}
