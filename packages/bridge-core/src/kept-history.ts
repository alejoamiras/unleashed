import { RpcRequestError, type Transport } from "viem"

const QUANTITY = /^0x[0-9a-f]+$/i
const HEAD_TAGS = new Set(["latest", "pending", "safe", "finalized"])

/** PublicNode's own "pruned history unavailable" code: viem's `fallback` moves past it and nothing retries it. */
const PRUNED = 4444

/**
 * How far below the head a transaction must be mined before a `null` receipt reads as pruned rather than not indexed
 * yet: every measured endpoint keeps at least 10,000 blocks, and a healthy one indexes a receipt within seconds.
 */
const PRUNED_AFTER_BLOCKS = 1_000n

type Args = { method: string; params?: unknown }
type Inner = ReturnType<Transport>

function refusal(inner: Inner, args: Args, message: string): RpcRequestError {
	const url = (inner.value as { url?: unknown } | undefined)?.url
	return new RpcRequestError({ body: args, error: { code: PRUNED, message }, url: typeof url === "string" ? url : "" })
}

async function headOf(inner: Inner): Promise<bigint | undefined> {
	const head: unknown = await inner.request({ method: "eth_blockNumber" } as never)
	return typeof head === "string" && QUANTITY.test(head) ? BigInt(head) : undefined
}

/** A log query's first block, `"head"` for a head tag, `undefined` when unknowable; `"other"` for any other request. */
function startOf(args: Args): bigint | "head" | "other" | undefined {
	if (args.method !== "eth_getLogs" || !Array.isArray(args.params) || args.params.length !== 1) return "other"
	const filter: unknown = args.params[0]
	if (typeof filter !== "object" || filter === null) return "other"
	const { fromBlock, blockHash } = filter as Record<string, unknown>
	if (blockHash !== undefined) return undefined
	if (fromBlock === undefined || (typeof fromBlock === "string" && HEAD_TAGS.has(fromBlock))) return "head"
	return typeof fromBlock === "string" && QUANTITY.test(fromBlock) ? BigInt(fromBlock) : undefined
}

/**
 * One endpoint's transport that sends an `eth_getLogs` only when it starts within the endpoint's latest `blocks`
 * blocks, read from the endpoint's own head. A log query it cannot place (a `blockHash`, `earliest`) or that starts
 * older is refused with code 4444 before it is sent, so a `fallback` asks the next endpoint and a lone
 * endpoint fails the read instead of answering short. Wrap each endpoint inside a `fallback`, outside `cappedLogs`.
 * Complete answers inside the retention remain the endpoint's promise, not this wrapper's.
 *
 * @throws when `blocks` is not a positive integer.
 */
export function keptLogs<const transport extends Transport>(transport: transport, blocks: number): transport {
	if (!Number.isSafeInteger(blocks) || blocks < 1) {
		throw new Error(`kept-history: blocks must be a positive integer, not ${blocks}`)
	}
	const kept = BigInt(blocks)
	return ((params) => {
		const inner = transport(params)
		const request = async (args: Args, options?: unknown) => {
			const start = startOf(args)
			if (start === "other" || start === "head") return inner.request(args as never, options as never)
			if (start === undefined) throw refusal(inner, args, "pruned history unavailable: this log filter's start is unknown")
			const head = await headOf(inner)
			if (head === undefined) throw refusal(inner, args, "pruned history unavailable: the endpoint's head is unknown")
			const first = head - kept + 1n
			if (start < first) throw refusal(inner, args, `pruned history unavailable: logs are kept from block ${first}`)
			return inner.request(args as never, options as never)
		}
		return { ...inner, request: request as typeof inner.request }
	}) as transport
}

/** The endpoint reports `hash` mined at least `PRUNED_AFTER_BLOCKS` below its head; any failed probe says no. */
async function minedLongAgo(inner: Inner, hash: unknown): Promise<boolean> {
	try {
		const tx: unknown = await inner.request({ method: "eth_getTransactionByHash", params: [hash] } as never)
		const mined = (tx as { blockNumber?: unknown } | null)?.blockNumber
		if (typeof mined !== "string" || !QUANTITY.test(mined)) return false
		const head = await headOf(inner)
		return head !== undefined && head - BigInt(mined) >= PRUNED_AFTER_BLOCKS
	} catch {
		return false
	}
}

/**
 * One endpoint's transport whose `null` receipt for a transaction it reports mined long ago (`PRUNED_AFTER_BLOCKS`)
 * is refused with code 4444, so a `fallback` asks the next endpoint: such a `null` means pruned, not absent. An
 * unknown, pending or freshly mined transaction, or a failed probe, keeps the `null`, so polling a fresh send sees no
 * new error. Wrap every endpoint of a `fallback` but the last, whose `null` must stay viem's "not found".
 */
export function receiptOrNext<const transport extends Transport>(transport: transport): transport {
	return ((params) => {
		const inner = transport(params)
		const request = async (args: Args, options?: unknown) => {
			const answer: unknown = await inner.request(args as never, options as never)
			if (args.method !== "eth_getTransactionReceipt" || (answer !== null && answer !== undefined)) return answer
			const hash = Array.isArray(args.params) ? args.params[0] : undefined
			if (await minedLongAgo(inner, hash)) {
				throw refusal(inner, args, "pruned history unavailable: the transaction is mined but its receipt is not kept")
			}
			return answer
		}
		return { ...inner, request: request as typeof inner.request }
	}) as transport
}
