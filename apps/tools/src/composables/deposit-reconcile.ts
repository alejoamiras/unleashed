/**
 * The router transaction behind a hash-less deposit record, from Ethereum alone: the deposit router
 * first, then every retired router a record still in flight may have gone through. Identity: a
 * router's events are only a sieve; a candidate counts only when its own calldata is the call this
 * record's send would have made and its receipt is a success on the canonical chain. Uniqueness: one
 * verified transaction across every router is the answer, two is `"ambiguous"`, and any search that
 * could not cover the window — cap, failed or slow read, chain switch, reorg — is `"incomplete"`,
 * never `"none"`.
 */
import {
	assertCanonical,
	type BudgetedRead,
	budgetedReads,
	DEPOSIT_ROUTER_ABI,
	firstBlockAfter,
	hexEq,
	openChainScan,
	PRIVATE_FPC_ADDRESS,
	ScanIncomplete,
	type SendDepositRecord,
	LEGACY_ROUTER_ABI,
	scanRange,
} from "@unleashed/bridge-core"
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
	/** The deposit router. */
	router: Hex
	/** Retired `SwapBridgeRouter`s, read through their frozen ABI. */
	legacyRouters?: readonly Hex[]
	/** How far before the record's `createdAt` the window starts (clock skew, a slow wallet). */
	slackSeconds?: number
	/** The largest range searched; a window that would start earlier is `"incomplete"`. */
	maxBlocks?: number
	/** `getLogs` range per call — public RPCs cap the range. */
	chunkBlocks?: number
	deadlineMs?: number
	maxReads?: number
	/** Per router. */
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

type LogArgs = Record<string, unknown> | undefined

/** How one router's deposits are recognised: the event that sieves a record's candidates, and the call its send made. */
interface RouterShape {
	eventFor(rec: SendDepositRecord): unknown
	logMatches(rec: SendDepositRecord, args: LogArgs): boolean
	calldataMatches(rec: SendDepositRecord, input: Hex): boolean
}

interface SearchedRouter {
	address: Hex
	shape: RouterShape
}

export async function findDepositTx(rec: SendDepositRecord, l1: ReconcileL1Client, options: DepositSearchOptions): Promise<DepositSearch> {
	const o = { ...DEFAULTS, now: Date.now, ...options }
	if (rec.intent === "gas" || !rec.token) return "none"
	if (rec.chainId !== o.chainId) return "incomplete"
	const read = budgetedReads(o)
	const routers: SearchedRouter[] = [
		{ address: o.router, shape: DEPOSIT_ROUTER_SHAPE },
		...(o.legacyRouters ?? []).map((address) => ({ address, shape: LEGACY_ROUTER_SHAPE })),
	]
	try {
		// The scan is only as good as the chain it read: a wallet switched away and back, or a reorg
		// past the tip that was scanned, may have answered some reads from a chain that is not this one.
		const scan = await openChainScan(l1, o.chainId, read, o.chainEpoch)
		const from = await windowStart(
			l1,
			scan.latest,
			BigInt(Math.floor(rec.createdAt / 1000) - o.slackSeconds),
			BigInt(o.maxBlocks),
			read,
		)
		const verified: Hex[] = []
		for (const router of routers) {
			const hashes = await candidateHashes(rec, l1, router, from, scan.latest, BigInt(o.chunkBlocks), read)
			if (hashes.length > o.maxCandidates) return "incomplete"
			verified.push(...(await verifiedOf(rec, l1, router, hashes, read)))
		}
		await scan.close()
		if (verified.length === 0) return "none"
		if (verified.length > 1) return "ambiguous"
		return { txHash: verified[0] }
	} catch (e) {
		if (e instanceof ScanIncomplete) return "incomplete"
		throw e
	}
}

async function verifiedOf(
	rec: SendDepositRecord,
	l1: ReconcileL1Client,
	router: SearchedRouter,
	hashes: readonly Hex[],
	read: BudgetedRead,
): Promise<Hex[]> {
	const verified: Hex[] = []
	for (const hash of hashes) if (await verifyCandidate(rec, l1, router, hash, read)) verified.push(hash)
	return verified
}

/** The first block at or after `targetTs`, by binary search over block timestamps inside the capped
 *  range. A range whose oldest block is still at or after the target may not reach back far enough. */
async function windowStart(
	l1: ReconcileL1Client,
	latest: bigint,
	targetTs: bigint,
	maxBlocks: bigint,
	read: BudgetedRead,
): Promise<bigint> {
	const floor = latest > maxBlocks ? latest - maxBlocks : 0n
	const tsOf = async (n: bigint) => (await read(() => l1.getBlock({ blockNumber: n }))).timestamp
	if ((await tsOf(floor)) >= targetTs && floor > 0n) throw new ScanIncomplete("window capped")
	// A chain whose tip predates the window cannot answer for it (a stale node, or a clock ahead of
	// the chain by more than the slack): its latest block is not the window.
	if ((await tsOf(latest)) < targetTs) throw new ScanIncomplete("chain behind the window")
	return firstBlockAfter(l1, read, floor, latest, targetTs - 1n)
}

/** The router's own events over the window, kept only when the decoded secret hash(es) are this
 *  record's. No recipient filter: a private deposit publishes a zero one. */
async function candidateHashes(
	rec: SendDepositRecord,
	l1: ReconcileL1Client,
	router: SearchedRouter,
	from: bigint,
	to: bigint,
	chunk: bigint,
	read: BudgetedRead,
): Promise<Hex[]> {
	const event = router.shape.eventFor(rec)
	const logs = await scanRange(from, to, chunk, (start, end) =>
		read(() => l1.getLogs({ address: router.address, event, fromBlock: start, toBlock: end })),
	)
	return [...new Set(logs.filter((log) => router.shape.logMatches(rec, log.args)).map((log) => log.transactionHash))]
}

/** A candidate counts only when its calldata is the call this record's send would have made and its
 *  receipt is a success on the canonical chain. */
async function verifyCandidate(
	rec: SendDepositRecord,
	l1: ReconcileL1Client,
	router: SearchedRouter,
	hash: Hex,
	read: BudgetedRead,
): Promise<boolean> {
	const tx = await read(() => l1.getTransaction({ hash }))
	if (!tx || !hexEq(tx.to, router.address) || !router.shape.calldataMatches(rec, tx.input)) return false
	const receipt = await read(() => l1.getTransactionReceipt({ hash }))
	if (receipt?.status !== "success") return false
	await assertCanonical(l1, read, receipt)
	return true
}

/** The fuel recipient a record's send names: the account itself, or the fee contract that mints private gas. */
const fuelRecipientOf = (rec: SendDepositRecord): string => (rec.isPrivate ? (rec.fuel?.fpc ?? PRIVATE_FPC_ADDRESS) : rec.recipient)

/** A private recipient is committed through the secret hash and never published. */
const publishedRecipientOf = (rec: SendDepositRecord): string => (rec.isPrivate ? ZERO_BYTES32 : rec.recipient)

// ── the deposit router ───────────────────────────────────────────────────────

type DepositIntentArgs = {
	token: Hex
	aztecRecipient: Hex
	tokenSecretHash: Hex
	isPrivate: boolean
	fuelSlice: bigint
	fuelRecipient: Hex
	fuelSecretHash: Hex
	minFuelOutput: bigint
}

/** The intent a token or token+gas send signs; a token-only one carries no fuel fields at all. */
function depositIntentMatches(rec: SendDepositRecord, i: DepositIntentArgs, amount: bigint): boolean {
	const common =
		hexEq(i.token, rec.token?.erc20) &&
		hexEq(i.aztecRecipient, publishedRecipientOf(rec)) &&
		hexEq(i.tokenSecretHash, rec.secretHashHex) &&
		i.isPrivate === rec.isPrivate
	if (!common) return false
	if (rec.intent === "token") return amount === BigInt(rec.amount) && i.fuelSlice === 0n && hexEq(i.fuelSecretHash, ZERO_BYTES32)
	const fuel = rec.fuel
	if (!fuel) return false
	return (
		amount === BigInt(rec.amount) + BigInt(fuel.amount) &&
		i.fuelSlice === BigInt(fuel.amount) &&
		i.minFuelOutput === BigInt(fuel.minOutput) &&
		hexEq(i.fuelSecretHash, fuel.secretHashHex) &&
		hexEq(i.fuelRecipient, fuelRecipientOf(rec))
	)
}

const DEPOSITED_EVENT = getAbiItem({ abi: DEPOSIT_ROUTER_ABI, name: "Deposited" })

const DEPOSIT_ROUTER_SHAPE: RouterShape = {
	eventFor: () => DEPOSITED_EVENT,
	logMatches: (rec, args) =>
		hexEq(args?.tokenSecretHash, rec.secretHashHex) &&
		hexEq(args?.fuelSecretHash, rec.intent === "token+gas" ? rec.fuel?.secretHashHex : ZERO_BYTES32),
	calldataMatches(rec, input) {
		let decoded: ReturnType<typeof decodeFunctionData<typeof DEPOSIT_ROUTER_ABI>>
		try {
			decoded = decodeFunctionData({ abi: DEPOSIT_ROUTER_ABI, data: input })
		} catch {
			return false
		}
		if (decoded.functionName !== "bridgeWithPermit") return false
		const [intent, , amount] = decoded.args
		return depositIntentMatches(rec, intent as DepositIntentArgs, amount)
	},
}

// ── the retired SwapBridgeRouter ─────────────────────────────────────────────

const BRIDGE_EVENT = getAbiItem({ abi: LEGACY_ROUTER_ABI, name: "Bridge" })
const BRIDGE_WITH_FUEL_EVENT = getAbiItem({ abi: LEGACY_ROUTER_ABI, name: "BridgeWithFuel" })

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

function legacyCalldataMatches(rec: SendDepositRecord, input: Hex): boolean {
	let decoded: { functionName: string; args?: readonly unknown[] }
	try {
		decoded = decodeFunctionData({ abi: LEGACY_ROUTER_ABI, data: input })
	} catch {
		return false
	}
	const p = decoded.args?.[0] as Record<string, unknown> | undefined
	if (!p || !rec.token) return false
	const common =
		hexEq(p.tokenPortal, rec.portal) &&
		hexEq(p.bridgeToken, rec.token.erc20) &&
		hexEq(p.aztecRecipient, publishedRecipientOf(rec)) &&
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
		hexEq(f.fuelRecipient, fuelRecipientOf(rec))
	)
}

const LEGACY_ROUTER_SHAPE: RouterShape = {
	eventFor: (rec) => (rec.intent === "token+gas" ? BRIDGE_WITH_FUEL_EVENT : BRIDGE_EVENT),
	logMatches: (rec, args) =>
		rec.intent === "token+gas"
			? hexEq(args?.tokenSecretHash, rec.secretHashHex) && hexEq(args?.fuelSecretHash, rec.fuel?.secretHashHex)
			: hexEq(args?.secretHash, rec.secretHashHex),
	calldataMatches: legacyCalldataMatches,
}
