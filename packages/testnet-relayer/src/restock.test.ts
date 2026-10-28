import { afterEach, describe, expect, it, vi } from "vitest"
import type { RelayLine } from "./log"
import { RESTOCK_BELOW, type RestockRequest, restock } from "./restock"

const KEY = "TEST_API_KEY:0123456789abcdef:fedcba9876543210secret"
const FILLER = "0x7A4f7Be599Afa3AfB0A41bb1D44762Ce441f8fAc"
const MIDNIGHT = Date.UTC(2026, 9, 29)

type Answer = (init: RequestInit) => Promise<Response>

function request(over: Partial<RestockRequest>, answer: Answer = async () => new Response(null, { status: 204 })) {
	const lines: RelayLine[] = []
	const fetch = vi.fn((_url: string, init: RequestInit) => answer(init))
	const r: RestockRequest = {
		key: KEY,
		filler: FILLER,
		balance: 5_000_000n,
		scheduledTime: MIDNIGHT,
		fetch,
		log: (l) => lines.push(l),
		...over,
	}
	return { r, fetch, lines }
}

/** A fetch that settles only when its signal aborts, as one past its deadline does. */
const hangs: Answer = (init) =>
	new Promise((_, reject) => {
		const signal = init.signal as AbortSignal
		if (signal.aborted) reject(signal.reason)
		signal.addEventListener("abort", () => reject(signal.reason))
	})

/** A 400 whose body never ends, counting the bytes the reader pulled and whether it was cancelled. */
function endless() {
	const seen = { bytes: 0, cancelled: false }
	const body = new ReadableStream<Uint8Array>({
		pull(c) {
			seen.bytes += 1_024
			c.enqueue(new Uint8Array(1_024).fill(0x20))
		},
		cancel() {
			seen.cancelled = true
		},
	})
	return { seen, answer: async () => new Response(body, { status: 400 }) }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("restock", () => {
	it("requests one USDC drip for the filler from Circle alone, in the minute that opens a UTC day, under 20 USDC", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout")
		const { r, fetch, lines } = request({ balance: RESTOCK_BELOW - 1n })
		await restock(r)
		expect(fetch).toHaveBeenCalledTimes(1)
		const [url, init] = fetch.mock.calls[0] ?? []
		expect(url).toBe("https://api.circle.com/v1/faucet/drips")
		expect(init).toMatchObject({
			method: "POST",
			headers: {
				authorization: `Bearer ${KEY}`,
				"content-type": "application/json",
				"x-request-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
			},
			redirect: "manual",
			signal: expect.any(AbortSignal),
		})
		expect(timeout).toHaveBeenCalledWith(10_000)
		expect(JSON.parse(String(init?.body))).toEqual({ address: FILLER, blockchain: "ETH-SEPOLIA", usdc: true })
		expect(lines).toEqual([{ event: "restock-requested", balance: RESTOCK_BELOW - 1n }])
	})

	it("sends nothing without a key, outside that minute, on a manual run or at 20 USDC", async () => {
		const cases: [string, Partial<RestockRequest>][] = [
			["no key", { key: undefined }],
			["an empty key", { key: "" }],
			["a minute late", { scheduledTime: MIDNIGHT + 60_000 }],
			["a minute early", { scheduledTime: MIDNIGHT - 60_000 }],
			["a manual run", { scheduledTime: undefined }],
			["20 USDC", { balance: RESTOCK_BELOW }],
		]
		for (const [name, over] of cases) {
			const { r, fetch, lines } = request(over)
			await restock(r)
			expect(fetch, name).not.toHaveBeenCalled()
			expect(lines).toEqual([])
		}
	})

	it("logs Circle's refusal, a redirect, a failed fetch or the deadline without the key, and never throws", async () => {
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(new DOMException("signal timed out", "TimeoutError")))
		const long = `limit reached for ${KEY.split(":")[2]} see https://x.test/${KEY} ${"retry later ".repeat(30)}`
		const answers: [Answer, RegExp][] = [
			[async () => Response.json({ code: 2, message: long }, { status: 400 }), /^400 code 2: limit reached/],
			[async () => new Response("<html>", { status: 502 }), /^502$/],
			[async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }), /^302$/],
			[() => Promise.reject(new Error(`connect failed with ${KEY}`)), /^connect failed/],
			[hangs, /timed out/],
		]
		for (const [answer, reason] of answers) {
			const { r, lines } = request({}, answer)
			await expect(restock(r)).resolves.toBeUndefined()
			expect(lines).toEqual([{ event: "restock-refused", reason: expect.stringMatching(reason), balance: 5_000_000n }])
			const logged = String(lines[0]?.reason)
			for (const part of KEY.split(":").slice(1)) expect(logged).not.toContain(part)
			expect(logged.length).toBeLessThanOrEqual(200)
		}
	})

	it("cancels an error body past 4 KiB unread and logs its status alone", async () => {
		const { seen, answer } = endless()
		const { r, lines } = request({}, answer)
		await restock(r)
		expect(lines).toEqual([{ event: "restock-refused", reason: "400", balance: 5_000_000n }])
		expect(seen.cancelled).toBe(true)
		expect(seen.bytes).toBeLessThan(64 * 1_024)
	})
})
