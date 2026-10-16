/**
 * What run B needs to know before it changes anything: the zone's current state, whether it drifted
 * since run A, and every reason to refuse. Reading and judging are separate so the judging is pure.
 */
import type { Api } from "./api.ts"
import { type CustomDomain, type DnsRecord, type Inventory, redirectEntrypoint, type Zone } from "./inventory.ts"
import { LANDING_HOSTS, landingRedirects, namesHost, type RedirectRule, targetOf } from "./rules.ts"

export const WORKER = "unleashed-landing"
export const TOGGLES = ["rocket_loader", "email_obfuscation", "rum"] as const
export type Toggle = (typeof TOGGLES)[number]

export interface Route {
	id: string
	pattern: string
	script?: string
}

export interface Snapshot {
	rulesetId: string
	rules: RedirectRule[]
	settings: Record<Toggle, string> & { nel: { enabled?: boolean } }
	dns: DnsRecord[]
	domains: CustomDomain[]
	routes: Route[]
	botManagement: { fight_mode?: boolean; enable_js?: boolean }
	zaraz: { tools?: Record<string, { enabled?: boolean }> } | null
}

const onHost = (name: string) => (LANDING_HOSTS as readonly string[]).includes(name)
const routeHost = (pattern: string) => pattern.replace(/^https?:\/\//, "").replace(/\/.*$/, "")

async function setting<T>(api: Api, zoneId: string, id: string): Promise<T> {
	return (await api.call<{ value: T }>("GET", `/zones/${zoneId}/settings/${id}`)).value
}

export async function readSnapshot(api: Api, zone: Zone): Promise<Snapshot> {
	const z = `/zones/${zone.id}`
	const ruleset = await redirectEntrypoint(api, zone.id)
	const toggles = await Promise.all(TOGGLES.map(async (id) => [id, await setting<string>(api, zone.id, id)] as const))
	return {
		rulesetId: ruleset?.id ?? "",
		rules: landingRedirects(ruleset?.rules ?? []),
		settings: { ...(Object.fromEntries(toggles) as Record<Toggle, string>), nel: await setting(api, zone.id, "nel") },
		dns: (await api.list<DnsRecord>(`${z}/dns_records`)).filter((record) => onHost(record.name)),
		domains: (await api.call<CustomDomain[]>("GET", `/accounts/${zone.account.id}/workers/domains?zone_id=${zone.id}`)).filter((d) =>
			onHost(d.hostname),
		),
		routes: (await api.call<Route[]>("GET", `${z}/workers/routes`)).filter((route) => onHost(routeHost(route.pattern))),
		botManagement: await api.call("GET", `${z}/bot_management`),
		zaraz: await api.call("GET", `${z}/settings/zaraz/config`),
	}
}

/** The same view of a run A record, so the two can be compared. */
export function snapshotOfInventory(inventory: Inventory): Snapshot {
	const value = <T>(outcome: { ok: boolean; value?: unknown }): T => {
		if (!outcome.ok) throw new Error("the run A record has a failed read; run A again")
		return outcome.value as T
	}
	const settings = inventory.settings as Record<string, { ok: boolean; value?: unknown }>
	const settingValue = (id: string) => value<{ value: unknown }>(settings[id] ?? { ok: false }).value
	const ruleset = value<{ id: string; rules?: RedirectRule[] } | null>(inventory.redirects)
	return {
		rulesetId: ruleset?.id ?? "",
		rules: landingRedirects(ruleset?.rules ?? []),
		settings: {
			...(Object.fromEntries(TOGGLES.map((id) => [id, settingValue(id)])) as Record<Toggle, string>),
			nel: settingValue("nel") as { enabled?: boolean },
		},
		dns: value<DnsRecord[]>(inventory.dns).filter((record) => onHost(record.name)),
		domains: value<CustomDomain[]>(inventory.customDomains).filter((d) => onHost(d.hostname)),
		routes: value<Route[]>(inventory.workerRoutes).filter((route) => onHost(routeHost(route.pattern))),
		botManagement: value(inventory.botManagement),
		zaraz: value(inventory.zaraz),
	}
}

/** The fields whose change since run A means the plan no longer fits the zone. */
export function fingerprint(s: Snapshot): string {
	return JSON.stringify({
		ruleset: s.rulesetId,
		rules: s.rules.map((r) => [r.id, r.enabled, r.expression, targetOf(r), r.version ?? ""]),
		settings: s.settings,
		dns: s.dns.map((r) => [r.name, r.type, r.content, r.proxied]).sort(),
		domains: s.domains.map((d) => [d.hostname, d.service]).sort(),
		routes: s.routes.map((r) => [r.pattern, r.script ?? ""]).sort(),
	})
}

export type AttachMode = "attached" | "attach" | "override"

function modeOf(s: Snapshot, host: string): AttachMode | { refuse: string } {
	const domain = s.domains.find((d) => d.hostname === host)
	const records = s.dns.filter((r) => r.name === host && ["A", "AAAA", "CNAME"].includes(r.type))
	if (domain) return domain.service === WORKER ? "attached" : { refuse: `${host} is a custom domain of ${domain.service}` }
	if (s.routes.some((route) => routeHost(route.pattern) === host)) return { refuse: `${host} has a Workers route` }
	if (records.some((r) => r.type === "CNAME")) return { refuse: `${host} is a CNAME` }
	if (records.some((r) => !r.proxied)) return { refuse: `${host} has a record that is not proxied` }
	return records.length ? "override" : "attach"
}

/** How each landing host gets the Worker: no record yet, an A or AAAA record to replace, or already attached. */
export function attachModes(s: Snapshot): Record<string, AttachMode | { refuse: string }> {
	return Object.fromEntries(LANDING_HOSTS.map((host) => [host, modeOf(s, host)]))
}

const NAMED_HOST = /["/]((?:[a-z0-9-]+\.)*unleashed\.systems)["/]/g

function zarazOn(zaraz: Snapshot["zaraz"]): boolean {
	return Object.values(zaraz?.tools ?? {}).some((tool) => tool.enabled === true)
}

/** Every reason run B must not start. Empty means go. */
export function refusals(s: Snapshot): string[] {
	const out: string[] = []
	if (!s.rules.length) out.push("no redirect rule sends a landing host to the app")
	for (const rule of s.rules) {
		if (!rule.enabled) out.push(`rule ${rule.id} is already off`)
		const others = [...rule.expression.matchAll(NAMED_HOST)].map((m) => m[1]).filter((host) => !onHost(host ?? ""))
		if (others.length) out.push(`rule ${rule.id} also names ${others.join(", ")}`)
	}
	for (const host of LANDING_HOSTS) {
		if (!s.rules.some((rule) => namesHost(rule.expression, host))) out.push(`no rule names ${host}`)
	}
	if (s.botManagement.fight_mode === true) out.push("Bot Fight Mode is on")
	if (s.botManagement.enable_js === true) out.push("Bot Management JavaScript detections are on")
	if (zarazOn(s.zaraz)) out.push("Zaraz has an enabled tool")
	for (const mode of Object.values(attachModes(s))) if (typeof mode === "object") out.push(mode.refuse)
	return out
}
