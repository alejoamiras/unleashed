import { describe, expect, it, vi } from "vitest"
import type { RelayLine } from "./log"
import { DRIP_URL, RESTOCK_BELOW, type RestockRequest, restock } from "./restock"

const KEY = "TEST_API_KEY:0123456789abcdef:fedcba9876543210secret"
const FILLER = "0x7A4f7Be599Afa3AfB0A41bb1D44762Ce441f8fAc"
const MIDNIGHT = Date.UTC(2026, 9, 29)

function request(over: Partial<RestockRequest>, answer: () => Promise<Response> = async () => new Response(null, { status: 204 })) {
	const lines: RelayLine[] = []
	const fetch = vi.fn((_url: string, _init: RequestInit) => answer())
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

describe("restock", () => {
	it("requests one USDC drip for the filler in the minute that opens a UTC day, under one drip's worth", async () => {
		const { r, fetch, lines } = request({ balance: RESTOCK_BELOW - 1n })
		await restock(r)
		expect(fetch).toHaveBeenCalledTimes(1)
		const [url, init] = fetch.mock.calls[0] ?? []
		expect(url).toBe(DRIP_URL)
		expect(init).toMatchObject({
			method: "POST",
			headers: {
				authorization: `Bearer ${KEY}`,
				"content-type": "application/json",
				"x-request-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
			},
			redirect: "error",
			signal: expect.any(AbortSignal),
		})
		expect(JSON.parse(String(init?.body))).toEqual({ address: FILLER, blockchain: "ETH-SEPOLIA", usdc: true })
		expect(lines).toEqual([{ event: "restock-requested", balance: RESTOCK_BELOW - 1n }])
	})

	it("sends nothing without a key, outside that minute, on a manual run or at one drip's worth", async () => {
		const cases: [string, Partial<RestockRequest>][] = [
			["no key", { key: undefined }],
			["an empty key", { key: "" }],
			["a minute late", { scheduledTime: MIDNIGHT + 60_000 }],
			["a minute early", { scheduledTime: MIDNIGHT - 60_000 }],
			["a manual run", { scheduledTime: undefined }],
			["one drip's worth", { balance: RESTOCK_BELOW }],
		]
		for (const [name, over] of cases) {
			const { r, fetch, lines } = request(over)
			await restock(r)
			expect(fetch, name).not.toHaveBeenCalled()
			expect(lines).toEqual([])
		}
	})

	it("logs Circle's refusal, a failed fetch or the timeout without the key, and never throws", async () => {
		const answers: [() => Promise<Response>, RegExp][] = [
			[
				async () =>
					Response.json(
						{
							code: 2,
							message: `limit reached for ${KEY.split(":")[2]} see https://x.test/${KEY} ${"retry later ".repeat(30)}`,
						},
						{ status: 400 },
					),
				/^400 code 2: limit reached/,
			],
			[async () => new Response("<html>", { status: 502 }), /^502$/],
			[() => Promise.reject(new Error(`connect failed with ${KEY}`)), /^connect failed/],
			[() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), /timeout/],
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
})
