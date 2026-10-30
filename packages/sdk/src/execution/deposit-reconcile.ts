/**
 * The router transaction behind a hash-less deposit record, from Ethereum alone: the deposit router
 * first, then every retired router a record still in flight may have gone through. Identity: a
 * router's events are only a sieve; a candidate counts only when its own calldata is the call this
 * record's send would have made and its receipt is a success on the canonical chain. Uniqueness: one
 * verified transaction across every router is the answer, two is `"ambiguous"`, and any search that
 * could not cover the window — cap, failed or slow read, chain switch, reorg — is `"incomplete"`,
 * never `"none"`. A record that names its signer counts only that account's candidates, before the
 * candidate cap: by the payer the router's event names or, on a retired router whose events name none,
 * by the transaction's sender.
 */
import { decodeFunctionData, getAbiItem } from "viem"
import { DEPOSIT_ROUTER_ABI } from "../protocol/deposit-router-abi.ts"
import { LEGACY_ROUTER_ABI } from "../protocol/legacy-router-abi.ts"
import type { DepositRecord } from "../records.ts"
import {
	assertCanonical,
	type BudgetedRead,
	budgetedReads,
	firstBlockAfter,
	hexEq,
	openChainScan,
	ScanIncomplete,
	scanRange,
} from "./chain-scan.ts"

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
	getTransaction(args: { hash: Hex }): Promise<{ from: Hex; to: Hex | null; input: Hex } | null>
	getTransactionReceipt(args: { hash: Hex }): Promise<{ status: string; blockNumber: bigint; blockHash: Hex } | null>
}

export type DepositSearch = { txHash: Hex } | "none" | "ambiguous" | "incomplete"

type SearchRecord = DepositRecord

export interface DepositSearchOptions {
	/** The chain the record and the generation live on; a client answering from another is `"incomplete"`. */
	chainId: number
	/** The deposit router. */
	router: Hex
	/** Retired `SwapBridgeRouter`s, read through their frozen ABI. They carried no gas-only deposit. */
	legacyRouters?: readonly Hex[]
	/** The network's PrivateFPC: a private gas leg's fuel recipient when the record names none. */
	privateFpc: string
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
	eventFor(rec: SearchRecord): unknown
	logMatches(rec: SearchRecord, args: LogArgs): boolean
	calldataMatches(rec: SearchRecord, input: Hex, privateFpc: string): boolean
	/** Whether `logMatches` checks the record's signer against a payer the event names. */
	logNamesPayer: boolean
}

interface SearchedRouter {
	address: Hex
	shape: RouterShape
}

export async function findDepositTx(rec: SearchRecord, l1: ReconcileL1Client, options: DepositSearchOptions): Promise<DepositSearch> {
	const o = { ...DEFAULTS, now: Date.now, ...options }
	const gasOnly = rec.intent === "gas"
	if (gasOnly ? !rec.fuel : !rec.token) return "none"
	if (rec.chainId !== o.chainId) return "incomplete"
	const read = budgetedReads(o)
	const routers: SearchedRouter[] = [
		{ address: o.router, shape: DEPOSIT_ROUTER_SHAPE },
		...(gasOnly ? [] : (o.legacyRouters ?? []).map((address) => ({ address, shape: LEGACY_ROUTER_SHAPE }))),
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
			const found = await verifiedOf(rec, l1, router, hashes, read, o)
			if (found === "incomplete") return "incomplete"
			verified.push(...found)
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

/** The candidates that verify, or `"incomplete"` past the cap; each transaction is read once. */
async function verifiedOf(
	rec: SearchRecord,
	l1: ReconcileL1Client,
	router: SearchedRouter,
	hashes: readonly Hex[],
	read: BudgetedRead,
	o: { maxCandidates: number; privateFpc: string },
): Promise<Hex[] | "incomplete"> {
	const signerFirst = !router.shape.logNamesPayer && rec.sender !== undefined
	const isCall = (hash: Hex) => isRecordCall(rec, l1, router, hash, read, o.privateFpc)
	const calls = signerFirst ? await sequentialFilter(hashes, isCall) : hashes
	if (calls.length > o.maxCandidates) return "incomplete"
	const verified: Hex[] = []
	for (const hash of calls) if ((signerFirst || (await isCall(hash))) && (await landed(l1, hash, read))) verified.push(hash)
	return verified
}

async function sequentialFilter(hashes: readonly Hex[], keep: (hash: Hex) => Promise<boolean>): Promise<Hex[]> {
	const kept: Hex[] = []
	for (const hash of hashes) if (await keep(hash)) kept.push(hash)
	return kept
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
	rec: SearchRecord,
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

/** The transaction is the call this record's send would have made and, where the router's events cannot say who
 *  paid, was sent by the record's signer: only a direct call matches, so its sender is the `msg.sender` the router
 *  pulled the tokens from. */
async function isRecordCall(
	rec: SearchRecord,
	l1: ReconcileL1Client,
	router: SearchedRouter,
	hash: Hex,
	read: BudgetedRead,
	privateFpc: string,
): Promise<boolean> {
	const tx = await read(() => l1.getTransaction({ hash }))
	// The scan's own logs named this hash: a `null` for it or its receipt (a lagging backend, a reorg) is not an answer.
	if (!tx) throw new ScanIncomplete("a logged transaction was not served")
	if (!hexEq(tx.to, router.address) || !router.shape.calldataMatches(rec, tx.input, privateFpc)) return false
	return router.shape.logNamesPayer || rec.sender === undefined || hexEq(tx.from, rec.sender)
}

async function landed(l1: ReconcileL1Client, hash: Hex, read: BudgetedRead): Promise<boolean> {
	const receipt = await read(() => l1.getTransactionReceipt({ hash }))
	if (!receipt) throw new ScanIncomplete("a logged transaction has no receipt")
	if (receipt.status !== "success") return false
	await assertCanonical(l1, read, receipt)
	return true
}

/** The fuel recipient a record's send names: the account itself, or the fee contract that mints private gas. */
const fuelRecipientOf = (rec: SearchRecord, privateFpc: string): string => (rec.isPrivate ? (rec.fuel?.fpc ?? privateFpc) : rec.recipient)

/** A private recipient is committed through the secret hash and never published. */
const publishedRecipientOf = (rec: SearchRecord): string => (rec.isPrivate ? ZERO_BYTES32 : rec.recipient)

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

/** The intent a gas-only send signs: no token leg, the whole amount is the slice. The record keeps no input token,
 *  so the fuel secret hash, which is random per deposit, carries the identity. */
function gasIntentMatches(rec: SearchRecord, i: DepositIntentArgs, amount: bigint, privateFpc: string): boolean {
	const fuel = rec.fuel
	if (!fuel) return false
	return (
		hexEq(i.aztecRecipient, ZERO_BYTES32) &&
		hexEq(i.tokenSecretHash, ZERO_BYTES32) &&
		i.isPrivate === rec.isPrivate &&
		amount === BigInt(fuel.amount) &&
		i.fuelSlice === BigInt(fuel.amount) &&
		i.minFuelOutput === BigInt(fuel.minOutput) &&
		hexEq(i.fuelSecretHash, fuel.secretHashHex) &&
		hexEq(i.fuelRecipient, fuelRecipientOf(rec, privateFpc))
	)
}

/** The intent a token or token+gas send signs; a token-only one carries no fuel fields at all. */
function depositIntentMatches(rec: SearchRecord, i: DepositIntentArgs, amount: bigint, privateFpc: string): boolean {
	if (rec.intent === "gas") return gasIntentMatches(rec, i, amount, privateFpc)
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
		hexEq(i.fuelRecipient, fuelRecipientOf(rec, privateFpc))
	)
}

const DEPOSITED_EVENT = getAbiItem({ abi: DEPOSIT_ROUTER_ABI, name: "Deposited" })

const DEPOSIT_ROUTER_SHAPE: RouterShape = {
	logNamesPayer: true,
	eventFor: () => DEPOSITED_EVENT,
	logMatches: (rec, args) =>
		(rec.sender === undefined || hexEq(args?.payer, rec.sender)) &&
		hexEq(args?.tokenSecretHash, rec.intent === "gas" ? ZERO_BYTES32 : rec.secretHashHex) &&
		hexEq(args?.fuelSecretHash, rec.intent === "token" ? ZERO_BYTES32 : rec.fuel?.secretHashHex),
	calldataMatches(rec, input, privateFpc) {
		let decoded: ReturnType<typeof decodeFunctionData<typeof DEPOSIT_ROUTER_ABI>>
		try {
			decoded = decodeFunctionData({ abi: DEPOSIT_ROUTER_ABI, data: input })
		} catch {
			return false
		}
		if (decoded.functionName !== "bridgeWithPermit") return false
		const [intent, , amount] = decoded.args
		return depositIntentMatches(rec, intent as DepositIntentArgs, amount, privateFpc)
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

function legacyCalldataMatches(rec: SearchRecord, input: Hex, privateFpc: string): boolean {
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
		hexEq(f.fuelRecipient, fuelRecipientOf(rec, privateFpc))
	)
}

const LEGACY_ROUTER_SHAPE: RouterShape = {
	logNamesPayer: false,
	eventFor: (rec) => (rec.intent === "token+gas" ? BRIDGE_WITH_FUEL_EVENT : BRIDGE_EVENT),
	logMatches: (rec, args) =>
		rec.intent === "token+gas"
			? hexEq(args?.tokenSecretHash, rec.secretHashHex) && hexEq(args?.fuelSecretHash, rec.fuel?.secretHashHex)
			: hexEq(args?.secretHash, rec.secretHashHex),
	calldataMatches: legacyCalldataMatches,
}
