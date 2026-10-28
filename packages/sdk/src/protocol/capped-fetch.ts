/**
 * One bounded HTTP read from a hostile origin: no redirects, a byte cap enforced on the running total while the body
 * streams, and one deadline covering the request and the whole body. Nothing here throws; every failure is a typed
 * refusal. The status is returned, not judged: whether a 404 carries a meaning is the caller's protocol.
 */

export interface CappedFetchOptions {
	fetch: typeof fetch
	byteCap: number
	/** One deadline for the response and the full body; a body that stalls after its headers is cut off too. */
	timeoutMs: number
	method?: "GET" | "POST"
	headers?: Readonly<Record<string, string>>
	body?: string
}

export type CappedFetchRefusal =
	| { ok: false; reason: "timeout" }
	| { ok: false; reason: "redirect"; status: number }
	| { ok: false; reason: "byte-cap"; byteCap: number }
	| { ok: false; reason: "network"; message: string }

export interface CappedBytes {
	ok: true
	status: number
	bytes: Uint8Array<ArrayBuffer>
}

export type CappedJsonRefusal = CappedFetchRefusal | { ok: false; reason: "not-json"; status: number }

export interface CappedJson {
	ok: true
	status: number
	json: unknown
}

class Refused extends Error {
	constructor(readonly refusal: CappedFetchRefusal) {
		super(refusal.reason)
	}
}

/**
 * Rejects once `signal` aborts. Raced against every await, so the deadline holds even against a `fetch` or a body
 * stream that ignores the signal.
 */
function deadline(signal: AbortSignal): Promise<never> {
	const p = new Promise<never>((_, reject) => {
		const fail = () => reject(new Refused({ ok: false, reason: "timeout" }))
		if (signal.aborted) fail()
		else signal.addEventListener("abort", fail, { once: true })
	})
	p.catch(() => {})
	return p
}

async function readCapped(res: Response, byteCap: number, expired: Promise<never>): Promise<Uint8Array<ArrayBuffer>> {
	if (res.body === null) return new Uint8Array(0)
	const reader = res.body.getReader()
	const chunks: Uint8Array[] = []
	let seen = 0
	try {
		for (;;) {
			const chunk = await Promise.race([reader.read(), expired])
			if (chunk.done) break
			seen += chunk.value.byteLength
			// The running total, so a hostile origin never gets to hand over the whole body first.
			if (seen > byteCap) throw new Refused({ ok: false, reason: "byte-cap", byteCap })
			chunks.push(chunk.value)
		}
	} catch (e) {
		reader.cancel().catch(() => {})
		throw e
	}
	const bytes = new Uint8Array(seen)
	let offset = 0
	for (const part of chunks) {
		bytes.set(part, offset)
		offset += part.byteLength
	}
	return bytes
}

function isRedirect(res: Response): boolean {
	return res.redirected || res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)
}

/**
 * Fetches `url` and returns its status and body bytes, or a refusal: `timeout` (the deadline passed before the body
 * ended), `redirect` (any 3xx; `redirect: "error"` makes a conforming runtime reject first, which lands as `network`),
 * `byte-cap` (the body outgrew `byteCap`; reading stops at once) or `network` (the request or the stream failed).
 */
export async function cappedFetchBytes(url: string, o: CappedFetchOptions): Promise<CappedBytes | CappedFetchRefusal> {
	const controller = new AbortController()
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, o.timeoutMs)
	const expired = deadline(controller.signal)
	// Called detached: a native `fetch` invoked as a method of an options object throws "Illegal invocation".
	const request = o.fetch
	try {
		const res = await Promise.race([
			request(url, {
				method: o.method ?? "GET",
				...(o.headers ? { headers: { ...o.headers } } : {}),
				...(o.body === undefined ? {} : { body: o.body }),
				// A response that redirects is no longer from the origin the caller pinned.
				redirect: "error",
				signal: controller.signal,
			}),
			expired,
		])
		if (isRedirect(res)) return { ok: false, reason: "redirect", status: res.status }
		return { ok: true, status: res.status, bytes: await readCapped(res, o.byteCap, expired) }
	} catch (e) {
		if (e instanceof Refused) return e.refusal
		if (timedOut) return { ok: false, reason: "timeout" }
		return { ok: false, reason: "network", message: e instanceof Error ? e.message : String(e) }
	} finally {
		clearTimeout(timer)
		// Releases the connection on every early exit; after a complete read it is a no-op.
		controller.abort()
	}
}

/** `cappedFetchBytes`, then a strict UTF-8 decode and `JSON.parse`; a body that is neither is `not-json`. */
export async function cappedFetchJson(url: string, o: CappedFetchOptions): Promise<CappedJson | CappedJsonRefusal> {
	const res = await cappedFetchBytes(url, o)
	if (!res.ok) return res
	try {
		return { ok: true, status: res.status, json: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(res.bytes)) }
	} catch {
		return { ok: false, reason: "not-json", status: res.status }
	}
}
