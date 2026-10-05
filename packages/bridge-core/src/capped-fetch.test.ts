import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it, vi } from "vitest"
import { cappedFetchBytes, cappedFetchJson } from "./capped-fetch"

const URL_ = "https://origin.invalid/data.json"

/** A body that materializes one pull at a time, so a cap or a deadline can bite mid-stream. */
function streamed(chunks: Uint8Array[], opts: { status?: number; pulls?: { count: number }; stallAfter?: number } = {}): Response {
	let i = 0
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (opts.pulls) opts.pulls.count++
			if (opts.stallAfter !== undefined && i >= opts.stallAfter) return new Promise(() => {})
			const next = chunks[i++]
			if (next === undefined) controller.close()
			else controller.enqueue(next)
		},
	})
	return new Response(stream, { status: opts.status ?? 200 })
}

const text = (s: string) => new TextEncoder().encode(s)
const serving = (make: () => Response | Promise<Response>) => vi.fn(async () => make()) as unknown as typeof fetch
const opts = (f: typeof fetch, over: Partial<Parameters<typeof cappedFetchBytes>[1]> = {}) => ({
	fetch: f,
	byteCap: 1024,
	timeoutMs: 1_000,
	...over,
})

describe("cappedFetchBytes / cappedFetchJson", () => {
	it("returns a non-2xx status with its parsed body, leaving its meaning to the caller", async () => {
		const res = await cappedFetchJson(URL_, opts(serving(() => new Response('{"message":"no route"}', { status: 404 }))))
		expect(res).toEqual({ ok: true, status: 404, json: { message: "no route" } })
	})

	it("stops reading the moment the running total passes the byte cap", async () => {
		const pulls = { count: 0 }
		const chunks = Array.from({ length: 40 }, () => text("x".repeat(64)))
		const res = await cappedFetchBytes(
			URL_,
			opts(
				serving(() => streamed(chunks, { pulls })),
				{ byteCap: 200 },
			),
		)
		expect(res).toEqual({ ok: false, reason: "byte-cap", byteCap: 200 })
		expect(pulls.count).toBeLessThan(10)
	})

	it.each([
		["before any response arrives", () => new Promise<Response>(() => {})],
		["when the body stalls after its first chunk", () => streamed([text('{"a":'), text("1}")], { stallAfter: 1 })],
	])("refuses with timeout %s, even when fetch ignores the abort signal", async (_, make) => {
		const res = await cappedFetchJson(URL_, opts(serving(make), { timeoutMs: 30 }))
		expect(res).toEqual({ ok: false, reason: "timeout" })
	})

	it("asks the runtime to refuse redirects and refuses any 3xx it is handed anyway", async () => {
		const f = serving(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/" } }))
		expect(await cappedFetchBytes(URL_, opts(f))).toEqual({ ok: false, reason: "redirect", status: 302 })
		const [, init] = vi.mocked(f).mock.calls[0] as unknown as [string, RequestInit]
		expect(init.redirect).toBe("error")
		expect(init.signal).toBeInstanceOf(AbortSignal)
	})

	it("is refused by the real runtime on a live redirect, whose target is never requested", async () => {
		let targetHits = 0
		const server = createServer((req, res) => {
			if (req.url === "/target") targetHits++
			if (req.url === "/start") res.writeHead(302, { location: "/target" }).end()
			else res.writeHead(200, { "content-type": "application/json" }).end("{}")
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		try {
			const { port } = server.address() as AddressInfo
			const res = await cappedFetchJson(`http://127.0.0.1:${port}/start`, opts(globalThis.fetch))
			expect(res.ok).toBe(false)
			expect(targetHits).toBe(0)
		} finally {
			server.close()
		}
	})

	it("refuses a body that is not strict UTF-8 JSON", async () => {
		const notJson = await cappedFetchJson(URL_, opts(serving(() => new Response("<html>"))))
		const badUtf8 = await cappedFetchJson(URL_, opts(serving(() => streamed([new Uint8Array([0x22, 0xff, 0x22])]))))
		expect(notJson).toEqual({ ok: false, reason: "not-json", status: 200 })
		expect(badUtf8).toEqual({ ok: false, reason: "not-json", status: 200 })
	})

	it("turns a failed request into a network refusal instead of throwing", async () => {
		const f = vi.fn(async () => {
			throw new TypeError("connection reset")
		}) as unknown as typeof fetch
		expect(await cappedFetchBytes(URL_, opts(f))).toEqual({ ok: false, reason: "network", message: "connection reset" })
	})
})
