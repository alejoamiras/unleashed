/**
 * Budgeted reads for scanning one chain from read-only clients. A scan answers for its whole window or
 * not at all: a read over the budget or past the deadline, a transport failure, a chain switch or a
 * reorg past the tip it read all throw {@link ScanIncomplete}, which callers report as "incomplete" and
 * retry, never as absence. Nothing is cached between scans, so a retry re-derives every fact.
 */
import type { Hex } from "viem"

/** A scan that could not cover its window. Never a terminal answer. */
export class ScanIncomplete extends Error {}

export const hexEq = (a: unknown, b: unknown): boolean =>
	typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase()

export interface ReadBudget {
	/** Wall-clock budget for the whole scan: the read clients have no transport timeout of their own. */
	deadlineMs: number
	maxReads: number
	now: () => number
}

/** Runs one read under the shared budget; any failure of the read itself becomes {@link ScanIncomplete}. */
export type BudgetedRead = <T>(fn: () => Promise<T>) => Promise<T>

/** Every read goes through one budget: a count cap, a wall-clock deadline and the transport's own
 *  failures — all three read as {@link ScanIncomplete}. */
export function budgetedReads(o: ReadBudget): BudgetedRead {
	const started = o.now()
	let reads = 0
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (++reads > o.maxReads) throw new ScanIncomplete("read budget")
		const left = o.deadlineMs - (o.now() - started)
		if (left <= 0) throw new ScanIncomplete("deadline")
		let timer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new ScanIncomplete("deadline")), left)
		})
		try {
			return await Promise.race([fn(), deadline])
		} catch (e) {
			throw e instanceof ScanIncomplete ? e : new ScanIncomplete(e instanceof Error ? e.message : String(e))
		} finally {
			clearTimeout(timer)
		}
	}
}

/** The head reads that pin a scan to one chain. */
export interface ChainHeadClient {
	getChainId(): Promise<number>
	getBlockNumber(): Promise<bigint>
	getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex }>
}

export interface ChainScan {
	/** The head the scan covers. */
	latest: bigint
	/** Call after the scan's last read: throws {@link ScanIncomplete} unless the chain is still the one
	 *  opened, the head block still has the hash read at open, and the epoch has not moved. */
	close(): Promise<void>
}

async function assertChain(client: ChainHeadClient, chainId: number, read: BudgetedRead): Promise<void> {
	if ((await read(() => client.getChainId())) !== chainId) throw new ScanIncomplete("chain")
}

/**
 * Opens a scan of `chainId` at its current head. `chainEpoch` counts the chain changes the provider has
 * reported: a change during the scan, even away and back, means some reads answered from another chain.
 */
export async function openChainScan(
	client: ChainHeadClient,
	chainId: number,
	read: BudgetedRead,
	chainEpoch?: () => number,
): Promise<ChainScan> {
	const epoch = chainEpoch?.()
	await assertChain(client, chainId, read)
	const latest = await read(() => client.getBlockNumber())
	const tip = (await read(() => client.getBlock({ blockNumber: latest }))).hash
	return {
		latest,
		// The epoch is compared last, after the final awaited read, so a switch during that read counts.
		close: async () => {
			if (!hexEq((await read(() => client.getBlock({ blockNumber: latest }))).hash, tip)) throw new ScanIncomplete("reorg")
			await assertChain(client, chainId, read)
			if (chainEpoch?.() !== epoch) throw new ScanIncomplete("chain changed")
		},
	}
}

/** Fetches `[from, to]` in consecutive `chunk`-block ranges with no gap — public RPCs cap the range of
 *  one log query — and returns every result in range order. */
export async function scanRange<T>(
	from: bigint,
	to: bigint,
	chunk: bigint,
	fetch: (start: bigint, end: bigint) => Promise<readonly T[]>,
): Promise<T[]> {
	const out: T[] = []
	for (let start = from; start <= to; start += chunk) {
		const end = start + chunk - 1n < to ? start + chunk - 1n : to
		out.push(...(await fetch(start, end)))
	}
	return out
}

/** Throws {@link ScanIncomplete} when the canonical block at the receipt's height has another hash: the
 *  receipt came from a fork the chain has left. */
export async function assertCanonical(
	client: ChainHeadClient,
	read: BudgetedRead,
	receipt: { blockNumber: bigint; blockHash: Hex },
): Promise<void> {
	const block = await read(() => client.getBlock({ blockNumber: receipt.blockNumber }))
	if (!hexEq(block.hash, receipt.blockHash)) throw new ScanIncomplete("reorg")
}
