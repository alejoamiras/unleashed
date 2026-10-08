/**
 * Across `/suggested-fees`, read for our own Across deposits (the app's testnet route and the canary's): the relay fee and timing a quote
 * prices for our exact message (the relayer's gas depends on it), and the deposit limits. Every answer is
 * hostile input: a bounded read, the fields we use parsed, echoes checked, and amounts and times bounded.
 * No quote is a normal testnet answer (a message too expensive for the deposit cap), never an error.
 */
import { type Address, type Hex, isAddress } from "viem"
import z from "zod"
import { cappedFetchJson } from "./capped-fetch"

/** Across's testnet API; a sandbox serves the same paths from its own base. */
export const ACROSS_TESTNET_API = "https://testnet.across.to/api"

const BYTE_CAP = 64 * 1024
const TIMEOUT_MS = 15_000
/** `SpokePool.depositQuoteTimeBuffer`: a deposit whose quote time is further off reverts. */
const QUOTE_SKEW_S = 3_600
/** Far beyond any fill window Across quotes (two hours on testnet); a deadline past it is not a quote. */
const MAX_FILL_WINDOW_S = 24 * 3_600

export interface AcrossClient {
	fetch: typeof fetch
	/** No trailing slash; `/suggested-fees` is appended. */
	base: string
}

export interface AcrossFeesRequest {
	originChainId: number
	destinationChainId: number
	inputToken: Address
	outputToken: Address
	amount: bigint
	/** LI.FI's ReceiverAcrossV4: the relay recipient that runs the message. */
	recipient: Address
	message: Hex
	/** The source SpokePool and the destination one the quote must name. */
	spokePool: Address
	destinationSpokePool: Address
}

export interface AcrossLimits {
	minDeposit: bigint
	maxDeposit: bigint
}

export interface AcrossQuote {
	/** What a relayer delivers: the input minus the relay fee. */
	outputAmount: bigint
	quoteTimestamp: number
	fillDeadline: number
	limits: AcrossLimits
	estimatedFillTimeSec: number
}

export type AcrossFeesResult = { ok: true; quote: AcrossQuote } | { ok: false; reason: string }

const uint = z.string().regex(/^\d+$/).transform(BigInt)
const seconds = z
	.string()
	.regex(/^\d{1,10}$/)
	.transform(Number)
const address = z.string().refine((a) => isAddress(a, { strict: false }), "not an address")
const token = z.object({ address, chainId: z.number().int() })

const feesSchema = z.object({
	outputAmount: uint,
	timestamp: seconds,
	fillDeadline: seconds,
	isAmountTooLow: z.boolean(),
	estimatedFillTimeSec: z.number().nonnegative(),
	spokePoolAddress: address,
	destinationSpokePoolAddress: address,
	inputToken: token,
	outputToken: token,
	limits: z.object({ minDeposit: uint, maxDeposit: uint }),
})

const errorSchema = z.object({ code: z.string().min(1) })

type Fees = z.output<typeof feesSchema>

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The first field of a parsed answer that does not answer `r`, or is out of bounds at `nowSec`. */
function badField(f: Fees, r: AcrossFeesRequest, nowSec: number): string | undefined {
	const echoes: [string, boolean][] = [
		["spokePoolAddress", same(f.spokePoolAddress, r.spokePool)],
		["destinationSpokePoolAddress", same(f.destinationSpokePoolAddress, r.destinationSpokePool)],
		["inputToken", same(f.inputToken.address, r.inputToken) && f.inputToken.chainId === r.originChainId],
		["outputToken", same(f.outputToken.address, r.outputToken) && f.outputToken.chainId === r.destinationChainId],
		["isAmountTooLow", !f.isAmountTooLow],
		["outputAmount", f.outputAmount > 0n && f.outputAmount <= r.amount],
		["timestamp", Math.abs(f.timestamp - nowSec) <= QUOTE_SKEW_S],
		["fillDeadline", f.fillDeadline > nowSec && f.fillDeadline <= nowSec + MAX_FILL_WINDOW_S],
		["limits", f.limits.minDeposit <= f.limits.maxDeposit],
	]
	return echoes.find(([, ok]) => !ok)?.[0]
}

/** The quote for `r`, or why there is none: Across's own error code, or the first field we refuse. */
export async function acrossSuggestedFees(c: AcrossClient, r: AcrossFeesRequest, nowSec: number): Promise<AcrossFeesResult> {
	const query = new URLSearchParams({
		inputToken: r.inputToken,
		outputToken: r.outputToken,
		originChainId: String(r.originChainId),
		destinationChainId: String(r.destinationChainId),
		amount: r.amount.toString(),
		recipient: r.recipient,
		message: r.message,
	})
	const res = await cappedFetchJson(`${c.base}/suggested-fees?${query}`, { fetch: c.fetch, byteCap: BYTE_CAP, timeoutMs: TIMEOUT_MS })
	if (!res.ok) return { ok: false, reason: `fetch ${res.reason}` }
	if (res.status !== 200) {
		const err = errorSchema.safeParse(res.json)
		return { ok: false, reason: err.success ? err.data.code : `HTTP ${res.status}` }
	}
	const parsed = feesSchema.safeParse(res.json)
	if (!parsed.success) return { ok: false, reason: `unparseable answer (${parsed.error.issues[0]?.path.join(".")})` }
	const field = badField(parsed.data, r, nowSec)
	if (field) return { ok: false, reason: `refused field ${field}` }
	const f = parsed.data
	return {
		ok: true,
		quote: {
			outputAmount: f.outputAmount,
			quoteTimestamp: f.timestamp,
			fillDeadline: f.fillDeadline,
			limits: f.limits,
			estimatedFillTimeSec: f.estimatedFillTimeSec,
		},
	}
}
