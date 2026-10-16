/**
 * The Cloudflare v4 API, as the cutover keyed runs use it. The token arrives in the environment only;
 * it is sent as a header and never appears in an error, a file or the log.
 */
const BASE = "https://api.cloudflare.com/client/v4"

export interface CfMessage {
	code: number
	message: string
}

interface Envelope<T> {
	success?: boolean
	errors?: CfMessage[]
	result?: T
	result_info?: { page?: number; total_pages?: number }
}

export class CfApiError extends Error {
	constructor(
		readonly route: string,
		readonly status: number,
		readonly errors: readonly CfMessage[],
	) {
		super(`${route}: HTTP ${status}, ${errors.map((e) => `${e.code} ${e.message}`).join("; ") || "no error detail"}`)
	}
}

export interface Api {
	call<T>(method: "GET" | "PATCH" | "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T>
	/** Every page of a list that takes `page` and `per_page`. */
	list<T>(path: string): Promise<T[]>
}

export function tokenFromEnv(env: Record<string, string | undefined> = process.env): string {
	const token = env.CLOUDFLARE_API_TOKEN
	if (!token || !/^[\x21-\x7e]{20,}$/.test(token)) throw new Error("CLOUDFLARE_API_TOKEN is missing or malformed")
	return token
}

export function cloudflare(token: string, fetcher: typeof fetch = fetch): Api {
	async function request<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
		const route = `${method} ${path}`
		const res = await fetcher(`${BASE}${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(30_000),
		})
		const text = await res.text()
		let envelope: Envelope<T> = {}
		try {
			envelope = JSON.parse(text) as Envelope<T>
		} catch {
			throw new CfApiError(route, res.status, [{ code: 0, message: "response is not JSON" }])
		}
		if (!res.ok || envelope.success === false) throw new CfApiError(route, res.status, envelope.errors ?? [])
		return envelope
	}
	return {
		async call<T>(method: string, path: string, body?: unknown): Promise<T> {
			return (await request<T>(method, path, body)).result as T
		},
		async list<T>(path: string): Promise<T[]> {
			const out: T[] = []
			const sep = path.includes("?") ? "&" : "?"
			for (let page = 1; page <= 50; page++) {
				const { result, result_info } = await request<T[]>("GET", `${path}${sep}page=${page}&per_page=50`)
				out.push(...(result ?? []))
				if (!result_info?.total_pages || page >= result_info.total_pages) return out
			}
			throw new Error(`GET ${path}: more than 50 pages`)
		},
	}
}
