/**
 * A keyless li.quest client. Every response is hostile input: read through `cappedFetchJson`, parsed by schemas
 * that keep exactly the fields the decoder, the fuel quote and the UI read (extra fields are dropped, a missing or
 * ill-typed needed field is a refusal), and held to the request it answers. A quote is never trusted for what it
 * makes the user sign: `verifyRoute` decides that from the bytes. `/v1/status` is an accelerator that can only name a
 * transaction for discovery to check on chain.
 */
import { type Address, getAddress, type Hex } from "viem"
import z from "zod"
import { type CappedJson, type CappedJsonRefusal, cappedFetchJson } from "./capped-fetch"
import { LIFI_ALLOW_EXCHANGES, LIFI_INTEGRATOR, LIFI_TO_CONTRACT_GAS_LIMIT } from "./lifi-gas"

export { LIFI_INTEGRATOR }
export const LI_QUEST_API = "https://li.quest/v1"
const DEFAULT_TIMEOUT_MS = 20_000
/** Recorded quotes run to 43 KB (a contract call with swaps on both sides). */
const DEFAULT_BYTE_CAP = 256 * 1024

const address = z
	.string()
	.regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x hex address")
	.transform((a) => getAddress(a.toLowerCase()))
const uint = z
	.string()
	.regex(/^\d+$/, "expected a base-10 integer string")
	.transform((s) => BigInt(s))
const quantity = z
	.string()
	.regex(/^0x[0-9a-fA-F]+$/, "expected a 0x hex quantity")
	.transform((s) => BigInt(s))
const data = z
	.string()
	.regex(/^0x(?:[0-9a-fA-F]{2})*$/, "expected 0x hex bytes")
	.transform((s) => s as Hex)
const hash = z
	.string()
	.regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x hex hash")
	.transform((s) => s.toLowerCase() as Hex)
const chainId = z.number().int().positive()

const tokenSchema = z.object({ address, chainId, symbol: z.string(), decimals: z.number().int().min(0).max(255) })

const actionSchema = z.object({
	fromChainId: chainId,
	toChainId: chainId,
	fromToken: tokenSchema,
	toToken: tokenSchema,
	fromAmount: uint,
	fromAddress: address,
	toAddress: address,
})

const stepEstimateSchema = z.object({
	fromAmount: uint,
	toAmount: uint,
	toAmountMin: uint,
	/** Seconds. */
	executionDuration: z.number().nonnegative(),
})

const costSchema = z.object({ amount: uint, amountUSD: z.string().optional(), token: tokenSchema })

/** A same-chain quote (`GET /v1/quote`) and a contract-call quote (`POST /v1/quote/contractCalls`) share this shape. */
export const lifiQuoteSchema = z.object({
	tool: z.string().min(1),
	action: actionSchema.extend({ slippage: z.number().min(0).max(1) }),
	estimate: stepEstimateSchema.extend({
		approvalAddress: address,
		feeCosts: z.array(costSchema.extend({ name: z.string(), included: z.boolean(), percentage: z.string().optional() })),
		gasCosts: z.array(costSchema.extend({ type: z.string() })),
		fromAmountUSD: z.string().optional(),
		toAmountUSD: z.string().optional(),
	}),
	/** Every tool on the route, in order, LI.FI's own fee step included. */
	includedSteps: z
		.array(z.object({ type: z.string(), tool: z.string().min(1), action: actionSchema, estimate: stepEstimateSchema }))
		.min(1),
	transactionRequest: z.object({ to: address, data, value: quantity, chainId, gasLimit: quantity.optional() }),
})

export type LifiQuote = z.output<typeof lifiQuoteSchema>

const STATUSES = ["NOT_FOUND", "INVALID", "PENDING", "DONE", "FAILED"] as const

export const lifiStatusSchema = z.object({
	status: z.enum(STATUSES),
	substatus: z.string().optional(),
	sending: z.object({ txHash: hash, chainId }),
	receiving: z.object({ txHash: hash.optional(), chainId: chainId.optional() }).optional(),
})

/** LI.FI answers an unknown transaction with a 404, which this client turns into `NOT_FOUND`. */
export type LifiStatus = z.output<typeof lifiStatusSchema> | { status: "NOT_FOUND" }

const lifiErrorSchema = z.object({
	message: z.string(),
	code: z.number().int().optional(),
	errors: z.object({ filteredOut: z.array(z.unknown()).optional(), failed: z.array(z.unknown()).optional() }).optional(),
})
const filteredOutSchema = z.object({ overallPath: z.string(), reason: z.string() })
const failedSchema = z.object({
	overallPath: z.string(),
	subpaths: z.record(z.string(), z.array(z.object({ tool: z.string().optional(), code: z.string().optional(), message: z.string() }))),
})

/** One path LI.FI considered and dropped, flattened from its `filteredOut` and `failed` lists. */
export interface LifiPathRefusal {
	kind: "filteredOut" | "failed"
	path: string
	message: string
	tool?: string
	code?: string
}

export type LifiRefusal =
	| CappedJsonRefusal
	/** A 404 on a quote: no route exists, with LI.FI's per-path reasons as evidence. */
	| { ok: false; reason: "no-route"; message: string; code?: number; paths: LifiPathRefusal[] }
	| { ok: false; reason: "status"; status: number; message?: string }
	| { ok: false; reason: "schema"; issues: string[] }
	/** The response answers another question than the one asked: `field` names the first disagreement. */
	| { ok: false; reason: "mismatch"; field: string }

export type LifiResult<T> = { ok: true; value: T } | LifiRefusal

export interface LifiClient {
	fetch: typeof fetch
	timeoutMs?: number
	byteCap?: number
}

function liQuest(c: LifiClient, path: string, body?: unknown): Promise<CappedJson | CappedJsonRefusal> {
	return cappedFetchJson(`${LI_QUEST_API}${path}`, {
		fetch: c.fetch,
		byteCap: c.byteCap ?? DEFAULT_BYTE_CAP,
		timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		...(body === undefined
			? { headers: { accept: "application/json" } }
			: { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) }),
	})
}

function issuesOf(error: z.ZodError): string[] {
	return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
}

function pathRefusals(errors: z.output<typeof lifiErrorSchema>["errors"]): LifiPathRefusal[] {
	const paths: LifiPathRefusal[] = []
	for (const raw of errors?.filteredOut ?? []) {
		const p = filteredOutSchema.safeParse(raw)
		if (p.success) paths.push({ kind: "filteredOut", path: p.data.overallPath, message: p.data.reason })
	}
	for (const raw of errors?.failed ?? []) {
		const p = failedSchema.safeParse(raw)
		if (!p.success) continue
		for (const tool of Object.values(p.data.subpaths).flat()) {
			paths.push({ kind: "failed", path: p.data.overallPath, message: tool.message, tool: tool.tool, code: tool.code })
		}
	}
	return paths
}

/** Turns a non-200 into its refusal; a 404 on a quote keeps LI.FI's reasons. */
function errorRefusal(res: CappedJson): LifiRefusal {
	const body = lifiErrorSchema.safeParse(res.json)
	if (res.status === 404 && body.success) {
		const { message, code, errors } = body.data
		return { ok: false, reason: "no-route", message, ...(code === undefined ? {} : { code }), paths: pathRefusals(errors) }
	}
	return { ok: false, reason: "status", status: res.status, ...(body.success ? { message: body.data.message } : {}) }
}

type Echo = readonly [field: string, actual: string | number | bigint, expected: string | number | bigint]

const same = (a: Echo[1], b: Echo[2]) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b)

function firstMismatch(echoes: readonly Echo[]): LifiRefusal | undefined {
	const miss = echoes.find(([, actual, expected]) => !same(actual, expected))
	return miss === undefined ? undefined : { ok: false, reason: "mismatch", field: miss[0] }
}

function parseQuote(res: CappedJson | CappedJsonRefusal, echoes: (q: LifiQuote) => readonly Echo[]): LifiResult<LifiQuote> {
	if (!res.ok) return res
	if (res.status !== 200) return errorRefusal(res)
	const parsed = lifiQuoteSchema.safeParse(res.json)
	if (!parsed.success) return { ok: false, reason: "schema", issues: issuesOf(parsed.error) }
	return firstMismatch(echoes(parsed.data)) ?? { ok: true, value: parsed.data }
}

export interface LifiSameChainQuoteRequest {
	chainId: number
	fromToken: Address
	toToken: Address
	fromAmount: bigint
	/** Both payer and receiver: the router swaps from its own balance and keeps the output. */
	router: Address
	/** Also sent as LI.FI's `slippage`, so the venue's own minimum sits at or below our floor. */
	slippageBps: number
}

/**
 * `GET /v1/quote` for a same-chain swap paid and received by `router`, restricted to `LIFI_ALLOW_EXCHANGES` (the
 * venues proven to survive a late cross-chain fill). Refuses a response for any other chain, token, amount or
 * account, and throws only on a malformed `slippageBps`; which venue answered is the caller's to police.
 */
export async function lifiSameChainQuote(c: LifiClient, r: LifiSameChainQuoteRequest): Promise<LifiResult<LifiQuote>> {
	if (!Number.isInteger(r.slippageBps) || r.slippageBps < 0 || r.slippageBps >= 10_000) {
		throw new Error("lifi: slippageBps must be an integer in [0, 10000)")
	}
	const q = new URLSearchParams({
		fromChain: String(r.chainId),
		toChain: String(r.chainId),
		fromToken: r.fromToken,
		toToken: r.toToken,
		fromAmount: r.fromAmount.toString(),
		fromAddress: r.router,
		toAddress: r.router,
		slippage: String(r.slippageBps / 10_000),
		integrator: LIFI_INTEGRATOR,
	})
	for (const venue of LIFI_ALLOW_EXCHANGES) q.append("allowExchanges", venue)
	return parseQuote(await liQuest(c, `/quote?${q}`), (v) => [
		["action.fromChainId", v.action.fromChainId, r.chainId],
		["action.toChainId", v.action.toChainId, r.chainId],
		["transactionRequest.chainId", v.transactionRequest.chainId, r.chainId],
		["action.fromToken", v.action.fromToken.address, r.fromToken],
		["action.toToken", v.action.toToken.address, r.toToken],
		["action.fromAmount", v.action.fromAmount, r.fromAmount],
		["action.fromAddress", v.action.fromAddress, r.router],
		["action.toAddress", v.action.toAddress, r.router],
	])
}

export interface LifiContractCallRequest {
	fromChain: number
	fromToken: Address
	/** The source account: the payer, and LI.FI's fallback receiver on the destination. */
	user: Address
	toChain: number
	toToken: Address
	/** `T`: the delivery the router call is sized for. */
	toAmount: bigint
	router: Address
	routerCalldata: Hex
	/** LI.FI bridge keys to allow; the decoder accepts no other rail, so a different one only buys a refusal. */
	allowBridges?: readonly string[]
}

/**
 * `POST /v1/quote/contractCalls`: deliver `toAmount` of `toToken` to `router` and call it with `routerCalldata`
 * under `LIFI_TO_CONTRACT_GAS_LIMIT`, falling back to `user`. Refuses a response for any other chain, token or payer.
 */
export async function lifiContractCallQuote(c: LifiClient, r: LifiContractCallRequest): Promise<LifiResult<LifiQuote>> {
	const body = {
		fromChain: r.fromChain,
		fromToken: r.fromToken,
		fromAddress: r.user,
		toChain: r.toChain,
		toToken: r.toToken,
		toAmount: r.toAmount.toString(),
		toFallbackAddress: r.user,
		integrator: LIFI_INTEGRATOR,
		...(r.allowBridges ? { allowBridges: [...r.allowBridges] } : {}),
		contractCalls: [
			{
				fromAmount: r.toAmount.toString(),
				fromTokenAddress: r.toToken,
				toContractAddress: r.router,
				toContractCallData: r.routerCalldata,
				toContractGasLimit: LIFI_TO_CONTRACT_GAS_LIMIT.toString(),
			},
		],
	}
	return parseQuote(await liQuest(c, "/quote/contractCalls", body), (v) => [
		["action.fromChainId", v.action.fromChainId, r.fromChain],
		["action.toChainId", v.action.toChainId, r.toChain],
		["transactionRequest.chainId", v.transactionRequest.chainId, r.fromChain],
		["action.fromToken", v.action.fromToken.address, r.fromToken],
		["action.toToken", v.action.toToken.address, r.toToken],
		["action.fromAddress", v.action.fromAddress, r.user],
	])
}

export interface LifiStatusRequest {
	/** The source transaction. */
	txHash: Hex
	fromChain: number
	toChain: number
}

/**
 * `GET /v1/status`. LI.FI also matches the hash against `BridgeData.transactionId`, which any sender chooses, on any
 * chain, so an answer counts only when its sending leg is exactly `txHash` on `fromChain` (and its receiving leg, if
 * named, is on `toChain`); anything else is a `mismatch`. A `DONE` answer is a hint for discovery, never an outcome.
 */
export async function lifiStatus(c: LifiClient, r: LifiStatusRequest): Promise<LifiResult<LifiStatus>> {
	const q = new URLSearchParams({ txHash: r.txHash, fromChain: String(r.fromChain), toChain: String(r.toChain) })
	const res = await liQuest(c, `/status?${q}`)
	if (!res.ok) return res
	if (res.status === 404) return { ok: true, value: { status: "NOT_FOUND" } }
	if (res.status !== 200) return errorRefusal(res)
	const parsed = lifiStatusSchema.safeParse(res.json)
	if (!parsed.success) return { ok: false, reason: "schema", issues: issuesOf(parsed.error) }
	const v = parsed.data
	const echoes: Echo[] = [
		["sending.txHash", v.sending.txHash, r.txHash],
		["sending.chainId", v.sending.chainId, r.fromChain],
		["receiving.chainId", v.receiving?.chainId ?? r.toChain, r.toChain],
	]
	return firstMismatch(echoes) ?? { ok: true, value: v }
}
