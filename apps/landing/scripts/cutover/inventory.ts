/**
 * The cutover's read-only inventory: the redirect rule, DNS, the zone features that touch a page,
 * the Workers attachments, the certificates and what each public host answers. Only GET requests.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { type Api, CfApiError } from "./api.ts"
import { APP_URLS, LANDING_URLS, type Probe, probe } from "./probe.ts"
import { landingRedirects, type RedirectRule, targetOf } from "./rules.ts"

export const ZONE_NAME = "unleashed.systems"
/** Outside the repository: a keyed run needs a clean tree, and this record is never committed. */
export const STATE_DIR = join(homedir(), ".cache", "unleashed-landing-cutover")

const SETTINGS = [
	"rocket_loader",
	"email_obfuscation",
	"nel",
	"rum",
	"speed_brain",
	"automatic_https_rewrites",
	"server_side_exclude",
	"always_use_https",
] as const

type Outcome<T> = { ok: true; value: T } | { ok: false; needs: string; error: string }

async function attempt<T>(needs: string, read: () => Promise<T>): Promise<Outcome<T>> {
	try {
		return { ok: true, value: await read() }
	} catch (error) {
		return { ok: false, needs, error: error instanceof Error ? error.message : String(error) }
	}
}

export interface Zone {
	id: string
	name: string
	status: string
	account: { id: string; name: string }
	plan?: { name?: string }
}

export async function findZone(api: Api): Promise<Zone> {
	const zones = await api.call<Zone[]>("GET", `/zones?name=${ZONE_NAME}`)
	const zone = zones.find((candidate) => candidate.name === ZONE_NAME)
	if (!zone || zones.length !== 1) throw new Error(`expected exactly one zone named ${ZONE_NAME}, got ${zones.length}`)
	return zone
}

export interface Ruleset {
	id: string
	version?: string
	rules?: RedirectRule[]
}

/** The zone's Single Redirects entrypoint, or null when the phase has none (the API answers 404). */
export async function redirectEntrypoint(api: Api, zoneId: string): Promise<Ruleset | null> {
	try {
		return await api.call<Ruleset>("GET", `/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`)
	} catch (error) {
		if (error instanceof CfApiError && error.status === 404) return null
		throw error
	}
}

export async function readInventory(api: Api, zone: Zone, look: (url: string) => Promise<Probe> = probe) {
	const z = `/zones/${zone.id}`
	const settings = await Promise.all(
		SETTINGS.map(async (id) => [id, await attempt("Zone › Zone Settings", () => api.call("GET", `${z}/settings/${id}`))] as const),
	)
	return {
		zone,
		token: await attempt("a user token", () => api.call<{ status?: string; expires_on?: string }>("GET", "/user/tokens/verify")),
		redirects: await attempt("Zone › Single Redirect", () => redirectEntrypoint(api, zone.id)),
		pageRules: await attempt("Zone › Zone", () => api.call<unknown[]>("GET", `${z}/pagerules`)),
		dns: await attempt("Zone › DNS", () => api.list<DnsRecord>(`${z}/dns_records`)),
		settings: Object.fromEntries(settings),
		allSettings: await attempt("Zone › Zone Settings", () => api.call("GET", `${z}/settings`)),
		zaraz: await attempt("Zone › Zaraz", () => api.call("GET", `${z}/settings/zaraz/config`)),
		botManagement: await attempt("Zone › Bot Management", () => api.call("GET", `${z}/bot_management`)),
		customDomains: await attempt("Account › Workers Scripts", () =>
			api.call<CustomDomain[]>("GET", `/accounts/${zone.account.id}/workers/domains?zone_id=${zone.id}`),
		),
		workerRoutes: await attempt("Zone › Workers Routes", () => api.call<unknown[]>("GET", `${z}/workers/routes`)),
		certificatePacks: await attempt("Zone › SSL and Certificates", () => api.list<CertPack>(`${z}/ssl/certificate_packs?status=all`)),
		probes: await Promise.all([...LANDING_URLS, ...APP_URLS].map((url) => look(url))),
	}
}

export type Inventory = Awaited<ReturnType<typeof readInventory>>

export interface DnsRecord {
	id: string
	name: string
	type: string
	content: string
	proxied?: boolean
	ttl?: number
}

export interface CustomDomain {
	id: string
	hostname: string
	service: string
	environment?: string
	zone_id?: string
	cert_id?: string
}

export interface CertPack {
	id: string
	type: string
	hosts: string[]
	status: string
}

/** Every read that failed, with the token permission it needs. */
export function failedReads(inventory: Inventory): string[] {
	const named: [string, Outcome<unknown>][] = [
		["redirects", inventory.redirects],
		["pageRules", inventory.pageRules],
		["dns", inventory.dns],
		["allSettings", inventory.allSettings],
		["zaraz", inventory.zaraz],
		["botManagement", inventory.botManagement],
		["customDomains", inventory.customDomains],
		["workerRoutes", inventory.workerRoutes],
		["certificatePacks", inventory.certificatePacks],
		...Object.entries(inventory.settings).map(([id, outcome]) => [`settings.${id}`, outcome] as [string, Outcome<unknown>]),
	]
	return named.flatMap(([name, outcome]) => (outcome.ok ? [] : [`${name}: needs ${outcome.needs}: ${outcome.error}`]))
}

function show(value: unknown): string {
	return JSON.stringify(value)
}

function probeLine(p: Probe): string {
	const h = p.headers
	return `  ${p.url} ${p.status}${h.location ? ` -> ${h.location}` : ""} csp=${h["content-security-policy"] ? "yes" : "no"} nel=${h.nel ? "yes" : "no"}${p.error ? ` error=${p.error}` : ""}`
}

function redirectLines(inventory: Inventory): string[] {
	if (!inventory.redirects.ok) return ["redirect rules: unreadable"]
	const rules = inventory.redirects.value?.rules ?? []
	const ours = new Set(landingRedirects(rules).map((rule) => rule.id))
	return [
		`redirect rules (ruleset ${inventory.redirects.value?.id ?? "none"}): ${rules.length}`,
		...rules.map(
			(rule, i) =>
				`  #${i + 1} ${ours.has(rule.id) ? "LANDING " : ""}id=${rule.id} enabled=${rule.enabled} ${show(rule.description ?? "")} if ${rule.expression} -> ${targetOf(rule)} ${rule.action_parameters?.from_value?.status_code ?? ""}`,
		),
		`landing redirect rules found: ${ours.size}`,
	]
}

export function summarize(inventory: Inventory): string[] {
	const { zone } = inventory
	const settings = Object.entries(inventory.settings).map(
		([id, o]) => `${id}=${o.ok ? show((o.value as { value?: unknown })?.value) : "?"}`,
	)
	return [
		`zone ${zone.name} id=${zone.id} status=${zone.status} plan=${zone.plan?.name ?? "?"} account=${zone.account.id}`,
		`token: ${inventory.token.ok ? `${inventory.token.value.status} until ${inventory.token.value.expires_on ?? "no expiry"}` : "unverified"}`,
		...redirectLines(inventory),
		`page rules: ${inventory.pageRules.ok ? show(inventory.pageRules.value) : "unreadable"}`,
		"dns:",
		...(inventory.dns.ok
			? inventory.dns.value.map((r) => `  ${r.name} ${r.type} ${r.content} proxied=${r.proxied}`)
			: ["  unreadable"]),
		`settings: ${settings.join(" ")}`,
		`zaraz: ${inventory.zaraz.ok ? show(inventory.zaraz.value).slice(0, 600) : "unreadable"}`,
		`bot management: ${inventory.botManagement.ok ? show(inventory.botManagement.value) : "unreadable"}`,
		`custom domains: ${inventory.customDomains.ok ? inventory.customDomains.value.map((d) => `${d.hostname}->${d.service}`).join(" ") || "none" : "unreadable"}`,
		`worker routes: ${inventory.workerRoutes.ok ? show(inventory.workerRoutes.value) : "unreadable"}`,
		`certificate packs: ${inventory.certificatePacks.ok ? inventory.certificatePacks.value.map((c) => `${c.type}[${c.hosts.join(",")}]=${c.status}`).join(" ") : "unreadable"}`,
		"probes:",
		...inventory.probes.map(probeLine),
	]
}

/** Writes the record with owner-only permissions; returns its path. */
export function saveRecord(kind: string, record: unknown): string {
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
	chmodSync(STATE_DIR, 0o700)
	const path = join(STATE_DIR, `${kind}-${new Date().toISOString().replaceAll(":", "")}.json`)
	writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" })
	return path
}
