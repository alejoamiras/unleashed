/**
 * The L2 transaction behind a hash-less exit record, by its recomputed L2→L1 message. Only index zero
 * of a transaction's messages counts — the position every reader of an exit in this app takes.
 * Uniqueness inside the window is the best evidence there is, not provenance: an identical exit from
 * another device is indistinguishable, and the message pays the record's own L1 recipient whichever
 * produced it. A window that could not be covered — a cap, a node behind it, pruned or unreadable
 * blocks, a slow read, a reorged tip, a node on another chain — is `"incomplete"`, never `"none"`.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { computeL2ToL1MessageHash } from "@aztec-labs/stdlib/hash"
import { type SendWithdrawRecord, withdrawContentHash } from "@unleashed/bridge-core"

const ZERO_L1 = `0x${"0".repeat(40)}`

/** A transaction as the node reports it inside a block body. */
export interface AttachTxEffect {
	txHash: { toString(): string }
	l2ToL1Msgs: ReadonlyArray<{ toString(): string }>
}

export interface AttachBlock {
	number: number
	hash: { toString(): string }
	header: { globalVariables: { timestamp: bigint } }
	body?: { txEffects: ReadonlyArray<AttachTxEffect> }
}

/** The narrow node surface the search reads. Block bodies are off by default on `getBlocks`; the
 *  scan asks for them, the timestamp search does not. */
export interface AttachNode {
	getNodeInfo(): Promise<{ l1ChainId: number; rollupVersion: number }>
	getBlockNumber(): Promise<number>
	getBlocks(from: number, limit: number, options?: { includeTransactions?: boolean }): Promise<ReadonlyArray<AttachBlock>>
	getTxEffect(txHash: string): Promise<{ data: { l2ToL1Msgs: ReadonlyArray<{ toString(): string }> } } | undefined>
}

export type ExitSearch = { exitTxHash: string; exitBlock: number; messageHash: string } | "none" | "ambiguous" | "incomplete"

export interface ExitSearchOptions {
	/** The active target's identity; the record and the node must both carry it. */
	chainId: number
	rollupVersion: number
	slackSeconds?: number
	maxBlocks?: number
	chunkBlocks?: number
	deadlineMs?: number
	maxReads?: number
	maxCandidates?: number
	now?: () => number
}

const DEFAULTS = {
	slackSeconds: 10 * 60,
	maxBlocks: 20_000,
	chunkBlocks: 50,
	deadlineMs: 45_000,
	maxReads: 200,
	maxCandidates: 8,
}

class Incomplete extends Error {}

/** The L2→L1 message this exit record's burn emitted: the hub sends it to the token's own portal,
 *  and the portal's `withdraw` takes no caller (`withCaller = false`), so the content binds the zero
 *  address there. */
export async function exitMessageHash(rec: SendWithdrawRecord, identity: { chainId: number; rollupVersion: number }): Promise<string> {
	const content = await withdrawContentHash(rec.recipientL1, BigInt(rec.amount), ZERO_L1)
	return computeL2ToL1MessageHash({
		l2Sender: AztecAddress.fromStringUnsafe(rec.bridge),
		l1Recipient: EthAddress.fromString(rec.token.portal),
		content: Fr.fromString(content),
		rollupVersion: new Fr(identity.rollupVersion),
		chainId: new Fr(identity.chainId),
	}).toString()
}

/** Every read goes through one budget: a count cap, a wall-clock deadline and the transport's own
 *  failures — all three read as `"incomplete"`. */
function budgetedReads(o: Required<Pick<ExitSearchOptions, "deadlineMs" | "maxReads" | "now">>) {
	const started = o.now()
	let reads = 0
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (++reads > o.maxReads) throw new Incomplete("read budget")
		const left = o.deadlineMs - (o.now() - started)
		if (left <= 0) throw new Incomplete("deadline")
		let timer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Incomplete("deadline")), left)
		})
		try {
			return await Promise.race([fn(), deadline])
		} catch (e) {
			throw e instanceof Incomplete ? e : new Incomplete(e instanceof Error ? e.message : String(e))
		} finally {
			clearTimeout(timer)
		}
	}
}

type Read = ReturnType<typeof budgetedReads>

/**
 * @param taken every exit hash and record id the journal already holds — an identical earlier exit
 *   this browser recorded is never attached twice.
 */
export async function findExitTx(
	rec: SendWithdrawRecord,
	node: AttachNode,
	taken: ReadonlySet<string>,
	options: ExitSearchOptions,
): Promise<ExitSearch> {
	const o = { ...DEFAULTS, now: Date.now, ...options }
	const read = budgetedReads(o)
	try {
		const scan = await scanExit(rec, node, taken, o, read)
		await scan.assertTipUnchanged()
		return scan.pick()
	} catch (e) {
		if (e instanceof Incomplete) return "incomplete"
		throw e
	}
}

/** The search plus the re-read the attach needs before it re-keys, on ONE budget: the found
 *  transaction's first message must still be this record's, or the answer is `"incomplete"`. */
export async function findVerifiedExitTx(
	rec: SendWithdrawRecord,
	node: AttachNode,
	taken: ReadonlySet<string>,
	options: ExitSearchOptions,
): Promise<ExitSearch> {
	const o = { ...DEFAULTS, now: Date.now, ...options }
	const read = budgetedReads(o)
	try {
		const scan = await scanExit(rec, node, taken, o, read)
		const found = scan.pick()
		if (typeof found === "string") {
			await scan.assertTipUnchanged()
			return found
		}
		const eff = await read(() => node.getTxEffect(found.exitTxHash))
		if (eff?.data.l2ToL1Msgs[0]?.toString() !== found.messageHash) return "incomplete"
		// The tip is compared LAST: a reorg during the re-read could have added a second match.
		await scan.assertTipUnchanged()
		return found
	} catch (e) {
		if (e instanceof Incomplete) return "incomplete"
		throw e
	}
}

/** The scan, with the tip check left to the caller: a reorg past the scanned tip can add or drop a
 *  match inside blocks already read, so the tip must be compared after the LAST read the caller makes. */
async function scanExit(
	rec: SendWithdrawRecord,
	node: AttachNode,
	taken: ReadonlySet<string>,
	o: Required<Omit<ExitSearchOptions, "chainEpoch">> & ExitSearchOptions,
	read: Read,
): Promise<{ pick: () => ExitSearch; assertTipUnchanged: () => Promise<void> }> {
	if (rec.chainId !== o.chainId) throw new Incomplete("chain")
	const info = await read(() => node.getNodeInfo())
	if (info.l1ChainId !== o.chainId || info.rollupVersion !== o.rollupVersion) throw new Incomplete("identity")
	const hash = await exitMessageHash(rec, o)
	const latest = await read(() => node.getBlockNumber())
	const [tipBlock] = await read(() => node.getBlocks(latest, 1))
	if (!tipBlock) throw new Incomplete("unread tip")
	const from = await windowStart(node, latest, BigInt(Math.floor(rec.createdAt / 1000) - o.slackSeconds), o.maxBlocks, read)
	const found = await scanForMessage(node, hash, from, latest, o.chunkBlocks, o.maxCandidates, read)
	const candidates = [...found].filter(([txHash]) => !taken.has(txHash))
	return {
		pick: () => {
			if (candidates.length === 0) return "none"
			if (candidates.length > 1) return "ambiguous"
			const [exitTxHash, exitBlock] = candidates[0]
			return { exitTxHash, exitBlock, messageHash: hash }
		},
		assertTipUnchanged: async () => {
			const [tipAgain] = await read(() => node.getBlocks(latest, 1))
			if (tipAgain?.hash.toString() !== tipBlock.hash.toString()) throw new Incomplete("reorg")
		},
	}
}

/** Every transaction in the window whose FIRST L2→L1 message is `hash`, by block. A range the node
 *  answers short, or a block without its body, means history the search could not read. */
async function scanForMessage(
	node: AttachNode,
	hash: string,
	from: number,
	latest: number,
	chunk: number,
	maxCandidates: number,
	read: Read,
): Promise<Map<string, number>> {
	const found = new Map<string, number>()
	for (let start = from; start <= latest; start += chunk) {
		const limit = Math.min(chunk, latest - start + 1)
		const blocks = await read(() => node.getBlocks(start, limit, { includeTransactions: true }))
		if (blocks.length !== limit) throw new Incomplete("pruned or unread blocks")
		for (const block of blocks) for (const txHash of matchesIn(block, hash)) found.set(txHash, block.number)
		if (found.size > maxCandidates) throw new Incomplete("too many candidates")
	}
	return found
}

function matchesIn(block: AttachBlock, hash: string): string[] {
	if (!block.body) throw new Incomplete("block without body")
	return block.body.txEffects.filter((tx) => tx.l2ToL1Msgs[0]?.toString() === hash).map((tx) => tx.txHash.toString())
}

/** The first block at or after `targetTs` by binary search over block timestamps inside the capped
 *  range; a range whose oldest block is still at or after the target may not reach back far enough. */
async function windowStart(node: AttachNode, latest: number, targetTs: bigint, maxBlocks: number, read: Read): Promise<number> {
	const floor = Math.max(1, latest - maxBlocks)
	const tsOf = async (n: number) => {
		const [block] = await read(() => node.getBlocks(n, 1))
		if (!block) throw new Incomplete("unread block")
		return block.header.globalVariables.timestamp
	}
	if ((await tsOf(floor)) >= targetTs && floor > 1) throw new Incomplete("window capped")
	// A node whose tip predates the window cannot answer for it: a stale node, or a clock ahead of the
	// chain by more than the slack, must not scan its latest block as if it were the window.
	if ((await tsOf(latest)) < targetTs) throw new Incomplete("node behind the window")
	let lo = floor
	let hi = latest
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2)
		if ((await tsOf(mid)) >= targetTs) hi = mid
		else lo = mid + 1
	}
	return lo
}

/** The attach re-reads the found transaction on its own before re-keying: its first L2→L1 message
 *  must still be this record's. */
export async function verifyExitTx(node: AttachNode, exitTxHash: string, expectedHash: string): Promise<boolean> {
	try {
		const eff = await node.getTxEffect(exitTxHash)
		return eff?.data.l2ToL1Msgs[0]?.toString() === expectedHash
	} catch {
		return false
	}
}
