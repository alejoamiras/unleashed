/**
 * A Circle faucet-API drip for the filler's Sepolia USDC. Circle documents no rate for the API, so the cadence is the
 * clock's: an attempt only in the scheduled minute that opens a UTC day, with no state behind it.
 */
import type { Address } from "viem"
import { errorLine, type RelayLog } from "./log"

export const DRIP_URL = "https://api.circle.com/v1/faucet/drips"
export const RESTOCK_PERIOD_MS = 86_400_000
/** One drip's worth: the faucet's 20 USDC, in 6 decimals. */
export const RESTOCK_BELOW = 20_000_000n

const MINUTE_MS = 60_000
const TIMEOUT_MS = 10_000
const REASON_CHARS = 200

export interface RestockRequest {
	key: string | undefined
	filler: Address
	balance: bigint
	/** The cron trigger's scheduled time in ms; absent on a manual run, which never restocks. */
	scheduledTime: number | undefined
	fetch: (url: string, init: RequestInit) => Promise<Response>
	log: RelayLog
}

/** Whether a drip may be attempted: a key is set and `scheduledTime` falls in the first minute of a UTC day. */
export function restockDue(key: string | undefined, scheduledTime: number | undefined): key is string {
	return !!key && scheduledTime !== undefined && scheduledTime % RESTOCK_PERIOD_MS < MINUTE_MS
}

/**
 * URLs masked, the key replaced, each long `PREFIX:ID:SECRET` segment too (an error may echo one alone), then cut:
 * in that order, so the cut cannot leave part of a key behind.
 */
function redact(text: string, key: string): string {
	const parts = [key, ...key.split(":").filter((p) => p.length >= 8)]
	return parts.reduce((t, p) => t.split(p).join("<key>"), errorLine(text)).slice(0, REASON_CHARS)
}

/** Circle's `{ code, message }` error body, or nothing when the body is not one. */
async function circleError(res: Response): Promise<string> {
	const body: unknown = await res.json().catch(() => null)
	if (typeof body !== "object" || body === null) return ""
	const { code, message } = body as { code?: unknown; message?: unknown }
	return [typeof code === "number" ? `code ${code}` : "", typeof message === "string" ? message : ""].filter(Boolean).join(": ")
}

/**
 * Requests one USDC drip to `filler` on Ethereum Sepolia when {@link restockDue} holds and `balance` is under
 * {@link RESTOCK_BELOW}; otherwise sends nothing. Logs `restock-requested` on Circle's `204` and `restock-refused` on
 * anything else, a failed fetch or the timeout. Never throws and never retries.
 */
export async function restock(r: RestockRequest): Promise<void> {
	const { key } = r
	if (!restockDue(key, r.scheduledTime) || r.balance >= RESTOCK_BELOW) return
	try {
		const res = await r.fetch(DRIP_URL, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-request-id": crypto.randomUUID() },
			body: JSON.stringify({ address: r.filler, blockchain: "ETH-SEPOLIA", usdc: true }),
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		})
		if (res.status === 204) r.log({ event: "restock-requested", balance: r.balance })
		else
			r.log({
				event: "restock-refused",
				reason: redact([res.status, await circleError(res)].filter(Boolean).join(" "), key),
				balance: r.balance,
			})
	} catch (e) {
		r.log({ event: "restock-refused", reason: redact(errorLine(e), key), balance: r.balance })
	}
}
