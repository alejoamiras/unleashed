/** Unauthenticated probes of the zone's public hosts. They never carry the token. */

export const KEPT_HEADERS = [
	"location",
	"content-security-policy",
	"nel",
	"report-to",
	"strict-transport-security",
	"x-robots-tag",
	"content-type",
] as const

export type KeptHeader = (typeof KEPT_HEADERS)[number]

export interface Probe {
	url: string
	/** 0 when the request itself failed. */
	status: number
	headers: Partial<Record<KeptHeader, string>>
	error?: string
}

export const LANDING_URLS = [
	"https://unleashed.systems/",
	"https://www.unleashed.systems/",
	"http://unleashed.systems/",
	"http://www.unleashed.systems/",
] as const

export const APP_URLS = ["https://testnet.app.unleashed.systems/", "https://app.unleashed.systems/"] as const

export async function probe(url: string, fetcher: typeof fetch = fetch): Promise<Probe> {
	try {
		const res = await fetcher(url, {
			redirect: "manual",
			headers: { "cache-control": "no-cache" },
			signal: AbortSignal.timeout(15_000),
		})
		await res.body?.cancel()
		const headers: Probe["headers"] = {}
		for (const name of KEPT_HEADERS) {
			const value = res.headers.get(name)
			if (value !== null) headers[name] = value
		}
		return { url, status: res.status, headers }
	} catch (error) {
		return { url, status: 0, headers: {}, error: error instanceof Error ? error.message : String(error) }
	}
}
