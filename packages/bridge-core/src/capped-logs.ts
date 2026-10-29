import { numberToHex, type Transport } from "viem"

const QUANTITY = /^0x[0-9a-f]+$/i

type LogQuery = { filter: Record<string, unknown>; from: bigint; to: bigint }

/** The numbered range of an `eth_getLogs` request that spans more than `cap` blocks; `undefined` for any other request. */
function overCap(args: { method: string; params?: unknown }, cap: bigint): LogQuery | undefined {
	if (args.method !== "eth_getLogs" || !Array.isArray(args.params) || args.params.length !== 1) return undefined
	const filter: unknown = args.params[0]
	if (typeof filter !== "object" || filter === null) return undefined
	const { fromBlock, toBlock } = filter as Record<string, unknown>
	if (typeof fromBlock !== "string" || typeof toBlock !== "string") return undefined
	if (!QUANTITY.test(fromBlock) || !QUANTITY.test(toBlock)) return undefined
	const from = BigInt(fromBlock)
	const to = BigInt(toBlock)
	return to - from + 1n > cap ? { filter: filter as Record<string, unknown>, from, to } : undefined
}

/**
 * One endpoint's transport, with every `eth_getLogs` over a numbered range wider than `maxBlocks` sent as consecutive
 * requests of at most `maxBlocks` blocks and answered as one list in block order. Any request that fails, or answers
 * anything but a list, rejects the whole call, so a caller never sees part of a range. Wrap each endpoint inside a
 * `fallback`, never the fallback itself: one call's requests must all reach the endpoint whose cap they fit.
 *
 * @throws when `maxBlocks` is not a positive integer.
 */
export function cappedLogs<const transport extends Transport>(transport: transport, maxBlocks: number): transport {
	if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) {
		throw new Error(`capped-logs: maxBlocks must be a positive integer, not ${maxBlocks}`)
	}
	const cap = BigInt(maxBlocks)
	return ((params) => {
		const inner = transport(params)
		const request = async (args: { method: string; params?: unknown }, options?: unknown) => {
			const query = overCap(args, cap)
			if (!query) return inner.request(args as never, options as never)
			const logs: unknown[] = []
			for (let start = query.from; start <= query.to; start += cap) {
				const end = start + cap - 1n < query.to ? start + cap - 1n : query.to
				const part: unknown = await inner.request(
					{
						method: "eth_getLogs",
						params: [{ ...query.filter, fromBlock: numberToHex(start), toBlock: numberToHex(end) }],
					} as never,
					options as never,
				)
				if (!Array.isArray(part)) throw new Error("capped-logs: eth_getLogs answered something other than a list")
				logs.push(...part)
			}
			return logs
		}
		return { ...inner, request: request as typeof inner.request }
	}) as transport
}
