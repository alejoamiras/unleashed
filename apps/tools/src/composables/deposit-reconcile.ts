/**
 * The router transaction behind a hash-less deposit record, from Ethereum alone. Identity: the
 * router's events are only a sieve (they carry no token or portal); a candidate counts only when its
 * own calldata is the call this record's send would have made and its receipt is a success on the
 * canonical chain. Uniqueness: one verified transaction is the answer, two is `"ambiguous"`, and any
 * search that could not cover the window — cap, failed or slow read, chain switch, reorg — is
 * `"incomplete"`, never `"none"`.
 */
import { PRIVATE_FPC_ADDRESS, type SendDepositRecord, SWAP_BRIDGE_ROUTER_ABI } from "@unleashed/bridge-core"
import { decodeFunctionData, getAbiItem } from "viem"

type Hex = `0x${string}`

/** The narrow viem surface the search reads. `getLogs` takes ONE event per call: viem drops `args`
 *  when a list of `events` is passed, and the secret-hash filter below needs them decoded. */
export interface ReconcileL1Client {
	getChainId(): Promise<number>
	getBlockNumber(): Promise<bigint>
	getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint; timestamp: bigint; hash: Hex }>
	getLogs(args: {
		address: Hex
		event: unknown
		fromBlock: bigint
		toBlock: bigint
	}): Promise<ReadonlyArray<{ transactionHash: Hex; args?: Record<string, unknown> }>>
	getTransaction(args: { hash: Hex }): Promise<{ to: Hex | null; input: Hex } | null>
	getTransactionReceipt(args: { hash: Hex }): Promise<{ status: string; blockNumber: bigint; blockHash: Hex } | null>
}

export type DepositSearch = { txHash: Hex } | "none" | "ambiguous" | "incomplete"

export interface DepositSearchOptions {
	/** The chain the record and the generation live on; a client answering from another is `"incomplete"`. */
	chainId: number
	router: Hex
	/** How far before the record's `createdAt` the window starts (clock skew, a slow wallet). */
	slackSeconds?: number
	/** The largest range searched; a window that would start earlier is `"incomplete"`. */
	maxBlocks?: number
	/** `getLogs` range per call — public RPCs cap the range. */
	chunkBlocks?: number
	deadlineMs?: number
	maxReads?: number
	maxCandidates?: number
	now?: () => number
	/** How many chain changes the provider has reported so far: a change during the scan — even
	 *  away and back — means some reads answered from another chain. */
	chainEpoch?: () => number
}

const DEFAULTS = {
	slackSeconds: 10 * 60,
	maxBlocks: 50_000,
	chunkBlocks: 2_000,
	deadlineMs: 45_000,
	maxReads: 200,
	maxCandidates: 8,
}

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex
const BRIDGE_EVENT = getAbiItem({ abi: SWAP_BRIDGE_ROUTER_ABI, name: "Bridge" })
const BRIDGE_WITH_FUEL_EVENT = getAbiItem({ abi: SWAP_BRIDGE_ROUTER_ABI, name: "BridgeWithFuel" })

class Incomplete extends Error {}

const hexEq = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase()

/** Every read goes through one budget: a count cap, a wall-clock deadline (the L1 client has no
 *  transport timeout of its own) and the transport's own failures — all three read as `"incomplete"`. */
function budgetedReads(o: Required<Pick<DepositSearchOptions, "deadlineMs" | "maxReads" | "now">>) {
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

export async function findDepositTx(rec: SendDepositRecord, l1: ReconcileL1Client, options: DepositSearchOptions): Promise<DepositSearch> {
	const o = { ...DEFAULTS, now: Date.now, ...options }
	if (rec.intent === "gas" || !rec.token) return "none"
	if (rec.chainId !== o.chainId) return "incomplete"
	const read = budgetedReads(o)
	const epoch = o.chainEpoch?.()
	try {
		await assertChain(l1, o.chainId, read)
		const latest = await read(() => l1.getBlockNumber())
		const tip = (await read(() => l1.getBlock({ blockNumber: latest }))).hash
		const from = await windowStart(l1, latest, BigInt(Math.floor(rec.createdAt / 1000) - o.slackSeconds), BigInt(o.maxBlocks), read)
		const hashes = await candidateHashes(rec, l1, o.router, from, latest, BigInt(o.chunkBlocks), read)
		if (hashes.length > o.maxCandidates) return "incomplete"
		const verified: Hex[] = []
		for (const hash of hashes) if (await verifyCandidate(rec, l1, o.router, hash, read)) verified.push(hash)
		// The scan is only as good as the chain it read: a wallet switched away and back, or a reorg
		// past the tip that was scanned, may have answered some reads from a chain that is not this one.
		// The epoch is compared LAST, after the final awaited read, so a switch during that read counts.
		if (!hexEq((await read(() => l1.getBlock({ blockNumber: latest }))).hash, tip)) throw new Incomplete("reorg")
		await assertChain(l1, o.chainId, read)
		if (o.chainEpoch?.() !== epoch) throw new Incomplete("chain changed")
		if (verified.length === 0) return "none"
		if (verified.length > 1) return "ambiguous"
		return { txHash: verified[0] }
	} catch (e) {
		if (e instanceof Incomplete) return "incomplete"
		throw e
	}
}

type Read = ReturnType<typeof budgetedReads>

async function assertChain(l1: ReconcileL1Client, chainId: number, read: Read): Promise<void> {
	if ((await read(() => l1.getChainId())) !== chainId) throw new Incomplete("chain")
}

/** The first block at or after `targetTs`, by binary search over block timestamps inside the capped
 *  range. A range whose oldest block is still at or after the target may not reach back far enough. */
async function windowStart(l1: ReconcileL1Client, latest: bigint, targetTs: bigint, maxBlocks: bigint, read: Read): Promise<bigint> {
	const floor = latest > maxBlocks ? latest - maxBlocks : 0n
	const tsOf = async (n: bigint) => (await read(() => l1.getBlock({ blockNumber: n }))).timestamp
	if ((await tsOf(floor)) >= targetTs && floor > 0n) throw new Incomplete("window capped")
	// A chain whose tip predates the window cannot answer for it (a stale node, or a clock ahead of
	// the chain by more than the slack): its latest block is not the window.
	if ((await tsOf(latest)) < targetTs) throw new Incomplete("chain behind the window")
	let lo = floor
	let hi = latest
	while (lo < hi) {
		const mid = (lo + hi) / 2n
		if ((await tsOf(mid)) >= targetTs) hi = mid
		else lo = mid + 1n
	}
	return lo
}

/** The router's own events over the window, one shape per intent, kept only when the decoded
 *  secret hash(es) are this record's. No recipient filter: a private deposit publishes a zero one. */
async function candidateHashes(
	rec: SendDepositRecord,
	l1: ReconcileL1Client,
	router: Hex,
	from: bigint,
	to: bigint,
	chunk: bigint,
	read: Read,
): Promise<Hex[]> {
	const fueled = rec.intent === "token+gas"
	const event = fueled ? BRIDGE_WITH_FUEL_EVENT : BRIDGE_EVENT
	const matches = (args: Record<string, unknown> | undefined): boolean =>
		fueled
			? hexEq(args?.tokenSecretHash, rec.secretHashHex) && hexEq(args?.fuelSecretHash, rec.fuel?.secretHashHex)
			: hexEq(args?.secretHash, rec.secretHashHex)
	const out = new Set<Hex>()
	for (let start = from; start <= to; start += chunk) {
		const end = start + chunk - 1n < to ? start + chunk - 1n : to
		const logs = await read(() => l1.getLogs({ address: router, event, fromBlock: start, toBlock: end }))
		for (const log of logs) if (matches(log.args)) out.add(log.transactionHash)
	}
	return [...out]
}

/** A candidate counts only when its calldata is the call this record's send would have made and its
 *  receipt is a success on the canonical chain. */
async function verifyCandidate(rec: SendDepositRecord, l1: ReconcileL1Client, router: Hex, hash: Hex, read: Read): Promise<boolean> {
	const tx = await read(() => l1.getTransaction({ hash }))
	if (!tx || !hexEq(tx.to, router) || !calldataMatches(rec, tx.input)) return false
	const receipt = await read(() => l1.getTransactionReceipt({ hash }))
	if (receipt?.status !== "success") return false
	const block = await read(() => l1.getBlock({ blockNumber: receipt.blockNumber }))
	if (!hexEq(block.hash, receipt.blockHash)) throw new Incomplete("reorg")
	return true
}

type BridgeArgs = { tokenPortal: Hex; bridgeToken: Hex; amount: bigint; aztecRecipient: Hex; secretHash: Hex; isPrivate: boolean }
type BridgeWithFuelArgs = {
	tokenPortal: Hex
	bridgeToken: Hex
	totalAmount: bigint
	fuelAmount: bigint
	aztecRecipient: Hex
	fuelRecipient: Hex
	tokenSecretHash: Hex
	fuelSecretHash: Hex
	minFuelOutput: bigint
	isPrivate: boolean
}

function calldataMatches(rec: SendDepositRecord, input: Hex): boolean {
	let decoded: { functionName: string; args?: readonly unknown[] }
	try {
		decoded = decodeFunctionData({ abi: SWAP_BRIDGE_ROUTER_ABI, data: input })
	} catch {
		return false
	}
	const p = decoded.args?.[0] as Record<string, unknown> | undefined
	if (!p || !rec.token) return false
	// A private recipient is committed through the secret hash and never published.
	const recipient = rec.isPrivate ? ZERO_BYTES32 : rec.recipient
	const common =
		hexEq(p.tokenPortal, rec.portal) &&
		hexEq(p.bridgeToken, rec.token.erc20) &&
		hexEq(p.aztecRecipient, recipient) &&
		p.isPrivate === rec.isPrivate
	if (!common) return false
	if (rec.intent === "token") {
		if (decoded.functionName !== "bridge") return false
		const b = p as BridgeArgs
		return b.amount === BigInt(rec.amount) && hexEq(b.secretHash, rec.secretHashHex)
	}
	if (decoded.functionName !== "bridgeWithFuel" || !rec.fuel) return false
	const f = p as BridgeWithFuelArgs
	return (
		f.totalAmount === BigInt(rec.amount) + BigInt(rec.fuel.amount) &&
		f.fuelAmount === BigInt(rec.fuel.amount) &&
		f.minFuelOutput === BigInt(rec.fuel.minOutput) &&
		hexEq(f.tokenSecretHash, rec.secretHashHex) &&
		hexEq(f.fuelSecretHash, rec.fuel.secretHashHex) &&
		hexEq(f.fuelRecipient, rec.isPrivate ? (rec.fuel.fpc ?? PRIVATE_FPC_ADDRESS) : rec.recipient)
	)
}
