import { describe, expect, test } from "vitest"
import { type Api, CfApiError } from "./api.ts"
import { type Inventory, readInventory } from "./inventory.ts"
import type { Probe } from "./probe.ts"
import type { RedirectRule } from "./rules.ts"
import { type Build, cutover, type Deps } from "./run.ts"
import { fingerprint, readSnapshot, refusals, type Snapshot, snapshotOfInventory } from "./state.ts"

const ZONE = { id: "z1", name: "unleashed.systems", status: "active", account: { id: "a1", name: "acct" } }
const RULE: RedirectRule = {
	id: "r1",
	action: "redirect",
	enabled: true,
	expression: '(http.host eq "unleashed.systems") or (http.host eq "www.unleashed.systems")',
	action_parameters: { from_value: { target_url: { value: "https://testnet.app.unleashed.systems/" }, status_code: 302 } },
}
const BUILD: Build = { buildId: "0.1.0+4c33c630", channel: "production" }

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
	return {
		rulesetId: "rs1",
		rules: [RULE],
		settings: { rocket_loader: "off", email_obfuscation: "on", rum: "off", nel: { enabled: true } },
		dns: [
			{ id: "d1", name: "unleashed.systems", type: "A", content: "192.0.2.1", proxied: true },
			{ id: "d2", name: "www.unleashed.systems", type: "AAAA", content: "100::", proxied: true },
		],
		domains: [],
		routes: [],
		botManagement: { fight_mode: false },
		zaraz: null,
		...over,
	}
}

/** A zone that answers like Cloudflare: the rule wins while on, attached hosts serve the landing once it is off. */
function world(opts: { refuseAttach?: boolean; landingNeverServes?: boolean } = {}) {
	const writes: string[] = []
	const attached = new Set<string>()
	let ruleOn = true
	let polls = 0
	const domainsOf = (host: string) =>
		attached.has(host) ? [{ id: host, hostname: host, service: "unleashed-landing", cert_id: `c-${host}` }] : []
	const attach = (body: unknown) => {
		if (opts.refuseAttach) throw new CfApiError("PUT records", 403, [{ code: 10000, message: "Authentication error" }])
		for (const o of (body as { origins: { hostname: string }[] }).origins) attached.add(o.hostname)
	}
	const api: Api = {
		async call<T>(method: string, path: string, body?: unknown): Promise<T> {
			if (method !== "GET") writes.push(`${method} ${path} ${JSON.stringify(body)}`)
			if (path.endsWith("/domains/records")) attach(body)
			if (path.includes("/rules/r1")) ruleOn = (body as { enabled: boolean }).enabled
			return (path.includes("hostname=") ? domainsOf(path.split("hostname=")[1]!) : {}) as T
		},
		async list<T>(): Promise<T[]> {
			polls++
			return [...attached].map((h) => ({
				id: `c-${h}`,
				type: "advanced",
				hosts: [h],
				status: polls > 2 ? "active" : "pending_validation",
			})) as T[]
		},
	}
	const probe = async (url: string): Promise<Probe> => {
		const host = new URL(url).host
		if (host === "testnet.app.unleashed.systems")
			return { url, status: 200, headers: { "content-security-policy": "default-src 'self'" } }
		if (host === "app.unleashed.systems") return { url, status: 302, headers: { location: "https://acct.cloudflareaccess.com/x" } }
		if (ruleOn) return { url, status: 302, headers: { location: "https://testnet.app.unleashed.systems/" } }
		if (url.startsWith("http:")) return { url, status: 301, headers: { location: `https://${host}/` } }
		return { url, status: 200, headers: { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" } }
	}
	const build = async (origin: string): Promise<Build | null> =>
		origin.includes("workers.dev") || (!ruleOn && !opts.landingNeverServes && attached.has(new URL(origin).host)) ? BUILD : null
	const journal: Record<string, unknown>[] = []
	const deps: Deps = { api, zone: ZONE, probe, build, sleep: async () => {}, log: () => {}, journal: (e) => journal.push(e) }
	return { deps, writes, journal, state: () => ({ ruleOn, attached: [...attached] }) }
}

describe("run B", () => {
	test("turns the features off, attaches both hosts, then turns the rule off", async () => {
		const w = world()
		const outcome = await cutover(w.deps, snapshot())
		expect(outcome).toEqual({ code: 0, notes: [] })
		expect(w.writes.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
			"PATCH /zones/z1/settings/email_obfuscation",
			"PATCH /zones/z1/settings/nel",
			"PUT /accounts/a1/workers/scripts/unleashed-landing/domains/records",
			"PUT /accounts/a1/workers/scripts/unleashed-landing/domains/records",
			"PATCH /zones/z1/rulesets/rs1/rules/r1",
		])
		expect(w.writes[3]).toContain('"override_existing_origin":false')
		expect(w.writes[3]).toContain(
			'"origins":[{"hostname":"unleashed.systems","zone_id":"z1"},{"hostname":"www.unleashed.systems","zone_id":"z1"}]',
		)
		expect(w.state()).toEqual({ ruleOn: false, attached: ["unleashed.systems", "www.unleashed.systems"] })
	})

	test("a landing that never appears puts the rule and the settings back, newest first, and keeps the domains", async () => {
		const w = world({ landingNeverServes: true })
		const outcome = await cutover(w.deps, snapshot())
		expect(outcome.code).toBe(1)
		expect(outcome.notes[0]).toContain("landing served")
		expect(w.writes.slice(5)).toEqual([
			expect.stringMatching(/^PATCH \/zones\/z1\/rulesets\/rs1\/rules\/r1 .*"enabled":true/),
			'PATCH /zones/z1/settings/nel {"value":{"enabled":true}}',
			'PATCH /zones/z1/settings/email_obfuscation {"value":"on"}',
		])
		expect(w.state()).toEqual({ ruleOn: true, attached: ["unleashed.systems", "www.unleashed.systems"] })
	})

	test("a refused attach reverts the settings and never touches the rule", async () => {
		const w = world({ refuseAttach: true })
		const outcome = await cutover(w.deps, snapshot())
		expect(outcome.code).toBe(1)
		expect(outcome.notes[0]).toContain("10000 Authentication error")
		expect(w.writes.filter((line) => line.includes("/rules/"))).toEqual([])
		expect(w.writes.slice(-2).map((line) => line.split(" ")[1])).toEqual([
			"/zones/z1/settings/nel",
			"/zones/z1/settings/email_obfuscation",
		])
	})

	test("a journal that stops writing after a change still gets that change reverted", async () => {
		const w = world()
		let writes = 0
		w.deps.journal = () => {
			if (++writes > 3) throw new Error("disk full")
		}
		const outcome = await cutover(w.deps, snapshot())
		expect(outcome.code).toBe(1)
		expect(outcome.notes[0]).toContain("disk full")
		expect(w.writes.at(-1)).toBe('PATCH /zones/z1/settings/email_obfuscation {"value":"on"}')
	})
})

test("a run A record of an unchanged zone shows no drift, and one changed setting does", async () => {
	const zoneState = { email: "on" }
	const answers: Record<string, unknown> = {
		"/zones/z1/rulesets/phases/http_request_dynamic_redirect/entrypoint": { id: "rs1", rules: [RULE] },
		"/zones/z1/workers/routes": [],
		"/accounts/a1/workers/domains?zone_id=z1": [],
		"/zones/z1/bot_management": { fight_mode: false },
		"/zones/z1/settings/zaraz/config": { tools: {} },
		"/zones/z1/settings/nel": { value: { enabled: true } },
	}
	const api: Api = {
		async call<T>(_method: string, path: string): Promise<T> {
			if (path === "/zones/z1/settings/email_obfuscation") return { value: zoneState.email } as T
			if (path.startsWith("/zones/z1/settings/") && !(path in answers)) return { value: "off" } as T
			return (answers[path] ?? {}) as T
		},
		async list<T>(path: string): Promise<T[]> {
			return (path.includes("dns_records") ? snapshot().dns : []) as T[]
		},
	}
	const look = async (url: string): Promise<Probe> => ({ url, status: 302, headers: {} })
	const recorded = JSON.parse(JSON.stringify(await readInventory(api, ZONE, look))) as Inventory
	expect(fingerprint(await readSnapshot(api, ZONE))).toBe(fingerprint(snapshotOfInventory(recorded)))
	zoneState.email = "off"
	expect(fingerprint(await readSnapshot(api, ZONE))).not.toBe(fingerprint(snapshotOfInventory(recorded)))
})

test("run B refuses before any change", () => {
	expect(refusals(snapshot())).toEqual([])
	expect(refusals(snapshot({ botManagement: { fight_mode: true } }))).toEqual(["Bot Fight Mode is on"])
	expect(refusals(snapshot({ zaraz: { tools: { ga: { enabled: true } } } }))).toEqual(["Zaraz has an enabled tool"])
	expect(
		refusals(snapshot({ dns: [{ id: "d", name: "www.unleashed.systems", type: "CNAME", content: "x.example", proxied: true }] })),
	).toEqual(["www.unleashed.systems is a CNAME"])
	expect(
		refusals(snapshot({ rules: [{ ...RULE, expression: `${RULE.expression} or (http.host eq "app.unleashed.systems")` }] })),
	).toEqual(["rule r1 also names app.unleashed.systems"])
	expect(refusals(snapshot({ rules: [{ ...RULE, enabled: false }] }))).toEqual(["rule r1 is already off"])
})
