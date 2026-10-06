/**
 * Where a cross-chain deposit stands, from read-only chain data on its source chain and on Ethereum.
 *
 * Authority is the rail's transport identity, never a secret hash: the source receipt yields the
 * rail's own event (Across `FundsDeposited`, Stargate `OFTSent`), and the intended outcome is the
 * LI.FI marker of the execution that delivered that transport, read from the marker's callback side of
 * the transport event inside one transaction. Anyone can drive the permissionless Executor, fill an
 * Across relay with caller-supplied data, or bridge their own funds to a public secret hash; those
 * logs are at most extra deposits, and only when the record can claim them, never the outcome.
 * Every address that authenticates a log comes from the caller's pinned context; every read goes
 * through one budget, and a run that cannot answer for its window is `incomplete`, never a verdict.
 */
import { InboxAbi } from "@aztec-foundation/l1-artifacts"
import {
	type Abi,
	type AbiEvent,
	type Address,
	decodeAbiParameters,
	decodeEventLog,
	decodeFunctionData,
	encodeAbiParameters,
	getAbiItem,
	type Hex,
	keccak256,
	type Log,
	pad,
	parseAbi,
	parseAbiItem,
	parseAbiParameters,
	toEventSelector,
	toFunctionSelector,
	toHex,
	zeroHash,
} from "viem"
import { ACROSS_V4_FACET_ABI } from "./across-v4"
import {
	assertCanonical,
	type BudgetedRead,
	budgetedReads,
	type ChainHeadClient,
	hexEq,
	openChainScan,
	ScanIncomplete,
	scanRange,
} from "./chain-scan"
import { bytesFromHex, mintToPrivateContentHash, mintToPublicContentHash, sha256ToField, word } from "./content-hash"
import { DEPOSIT_ROUTER_ABI } from "./deposit-router-abi"
import { TOKEN_PORTAL_ABI } from "./factory-abi"
import { parseFeeJuiceDeposit } from "./fuel"
import {
	type ChainBlock,
	type CrossChainDepositRecord,
	type CrossChainExtraDeposit,
	type CrossChainOutcome,
	type CrossChainRoute,
	type CrossChainTransport,
	type OutcomeObservation,
	outcomePatch,
} from "./journal"
import { LIFI_BRIDGE_DATA_COMPONENTS, LIFI_RECEIVER_MESSAGE_PARAMS } from "./lifi-abi"
import { PRIVATE_FPC_ADDRESS } from "./private-fuel"
import { STARGATE_FACET_V2_ABI } from "./stargate"

// ── public types ─────────────────────────────────────────────────────────────

/** A log as `eth_getLogs` returns it. */
export interface DiscoveryLog {
	address: Address
	topics: readonly Hex[]
	data: Hex
	transactionHash: Hex
	blockNumber: bigint
}

export interface DiscoveryReceipt {
	status: "success" | "reverted"
	from: Address
	transactionHash: Hex
	blockNumber: bigint
	blockHash: Hex
	logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[]
}

/** The read-only surface discovery needs of one chain (a viem public client's shape). `getLogs` takes
 *  one event with its indexed `args` as the filter; the logs are decoded and re-checked here. */
export interface DiscoveryChainReads extends ChainHeadClient {
	getBlock(args: { blockNumber: bigint } | { blockTag: "finalized" }): Promise<{ number: bigint; timestamp: bigint; hash: Hex }>
	getLogs(args: {
		address: Address
		event: AbiEvent
		args: Record<string, unknown>
		fromBlock: bigint
		toBlock: bigint
	}): Promise<readonly DiscoveryLog[]>
	/** `null`, or viem's `TransactionReceiptNotFoundError`, when the node has no receipt for `hash`. */
	getTransactionReceipt(args: { hash: Hex }): Promise<DiscoveryReceipt | null>
	/** `to` is `null` for a contract creation. */
	getTransaction(args: { hash: Hex }): Promise<{ input: Hex; to: Address | null }>
	readContract(args: {
		address: Address
		abi: Abi
		functionName: string
		args: readonly unknown[]
		blockNumber: bigint
	}): Promise<unknown>
	/** How many chain changes the provider has reported; a change during a run makes it `incomplete`. */
	chainEpoch?: () => number
}

export interface DiscoveryReads {
	source: DiscoveryChainReads
	ethereum: DiscoveryChainReads
}

/**
 * The deployed `MessageSent` shape of a network's Inbox, which differs by Aztec line: `artifact` is the
 * pinned `@aztec-foundation/l1-artifacts` event (`bytes32 indexed hash`, then the whole message);
 * `checkpoint` is the older line mainnet runs (`uint256 indexed checkpointNumber, uint256 index,
 * bytes32 indexed hash, bytes16 rollingHash`).
 */
export type InboxEventShape = "artifact" | "checkpoint"

/** What recomputing an L1→L2 leaf needs: the Inbox and the actors its messages name. */
export interface InboxContext {
	address: Address
	shape: InboxEventShape
	rollupVersion: bigint
	/** L2 actor of token messages: the hub. */
	l2Hub: Hex
	/** The Fee Juice L2 actor, and the L1 sender the Inbox records for the FeeJuicePortal (a protocol
	 *  constant on lines that seed it at genesis, the portal itself otherwise). */
	feeJuice: { l2: Hex; l1Sender: Address }
}

export interface AcrossRailContext {
	kind: "acrossV4"
	sourceSpokePool: Address
	destinationSpokePool: Address
	/** LI.FI's ReceiverAcrossV4 on Ethereum: the relay recipient, and the emitter of `LiFiTransferRecovered`. */
	receiver: Address
}

export interface StargateRailContext {
	kind: "stargateV2"
	/** The source-chain pool that emits `OFTSent`. */
	sourcePool: Address
	/** The Ethereum pool that queues the compose: `ComposeDelivered.from`. */
	destinationPool: Address
	/** LayerZero EndpointV2 on Ethereum, the emitter of `ComposeDelivered`. */
	endpoint: Address
	/** LI.FI's ReceiverStargateV2 on Ethereum: the composer, and the emitter of `LiFiTransferRecovered`. */
	receiver: Address
	/** Ethereum's LayerZero endpoint id. */
	destinationEid: number
}

/** Every address that authenticates a log, pinned by the caller (the LI.FI address book, the manifest). */
export interface CrossChainDiscoveryContext {
	source: { chainId: number; diamond: Address }
	ethereum: {
		chainId: number
		router: Address
		executor: Address
		feeJuicePortal: Address
		/** The record token's portal clone; required unless the send is gas only. */
		tokenPortal?: Address
		inbox: InboxContext
	}
	rail: AcrossRailContext | StargateRailContext
}

export interface DiscoveryOptions {
	/** `getLogs` range per call: public RPCs cap it. */
	chunkBlocks?: number
	deadlineMs?: number
	maxReads?: number
	/** Receipts read per scan before the run gives up as `incomplete`. */
	maxCandidates?: number
	now?: () => number
}

/** The legs of the intended `Deposited`, each checked against its portal's event and a recomputed leaf. */
export interface DepositedFacts {
	depositTxHash: Hex
	/** What the router pulled. */
	received: string
	/** Absent for a gas-only send. */
	token?: { amount: string; leafIndex: string; messageHash: Hex }
	/** Absent for a send without a gas slice. `consumed` is in token units, `received` in Fee Juice. */
	fuel?: { consumed: string; received: string; leafIndex: string; messageHash: Hex }
}

/** What one router `Deposited` must carry for an intent, however the funds reached Ethereum. */
export interface DepositExpectation {
	l1ChainId: number
	isPrivate: boolean
	/** The public recipient; for private fuel the leg pays `fuel.fpc` instead. */
	recipient: Hex
	/** Absent for a gas-only intent. */
	token?: { erc20: Address; secretHash: Hex }
	/**
	 * Absent when the intent bridges no gas. The leg pays `recipient` when set (an Ethereum-origin send names its
	 * own), else `fpc` (default the pinned PrivateFPC) for private fuel and the intent's recipient for public.
	 */
	fuel?: { secretHash: Hex; fpc?: Hex; recipient?: Hex }
}

/** The Ethereum addresses that authenticate a deposit's logs. */
export type DepositLogContext = Pick<CrossChainDiscoveryContext["ethereum"], "router" | "feeJuicePortal" | "tokenPortal" | "inbox">

/** Facts a run established, whatever its verdict. */
export interface DiscoveryFacts {
	/** The source transaction, confirmed from the record or found by the `Transfer` scan. */
	srcTxHash?: Hex
	transport?: CrossChainTransport
	/** Router `Deposited` events the record can claim, at or above its floor, other than the intended one. */
	extraDeposits: CrossChainExtraDeposit[]
}

export type CrossChainDiscovery =
	| { verdict: "incomplete"; reason: string }
	| (DiscoveryFacts &
			(
				| { verdict: "pending" }
				| { verdict: "deposited"; deposit: DepositedFacts; decidedAt: ChainBlock; finalized: ChainBlock }
				| { verdict: CrossChainOutcome; observation: OutcomeObservation }
			))

// ── events ───────────────────────────────────────────────────────────────────

const FUNDS_DEPOSITED = parseAbiItem(
	"event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
)
const FILLED_RELAY = parseAbiItem(
	"event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, (bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)",
)
/** The selector of the `FilledRelay` a SpokePool logs for every fill it executes. */
export const FILLED_RELAY_TOPIC = toEventSelector(FILLED_RELAY)
const OFT_SENT = parseAbiItem(
	"event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)",
)
const COMPOSE_DELIVERED = parseAbiItem("event ComposeDelivered(address from, address to, bytes32 guid, uint16 index)")
const LIFI_TRANSFER_STARTED: AbiEvent = {
	type: "event",
	name: "LiFiTransferStarted",
	inputs: [{ name: "bridgeData", type: "tuple", indexed: false, components: LIFI_BRIDGE_DATA_COMPONENTS }],
}
const LIFI_TRANSFER_COMPLETED = parseAbiItem(
	"event LiFiTransferCompleted(bytes32 indexed transactionId, address receivingAssetId, address receiver, uint256 amount, uint256 timestamp)",
)
const LIFI_TRANSFER_RECOVERED = parseAbiItem(
	"event LiFiTransferRecovered(bytes32 indexed transactionId, address receivingAssetId, address receiver, uint256 amount, uint256 timestamp)",
)
const ERC20_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)")
const MESSAGE_SENT: Record<InboxEventShape, AbiEvent> = {
	artifact: getAbiItem({ abi: InboxAbi, name: "MessageSent" }) as AbiEvent,
	checkpoint: parseAbiItem(
		"event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)",
	),
}
const DEPOSITED = getAbiItem({ abi: DEPOSIT_ROUTER_ABI, name: "Deposited" }) as AbiEvent
const PORTAL_PUBLIC = getAbiItem({ abi: TOKEN_PORTAL_ABI, name: "DepositToAztecPublic" }) as AbiEvent
const PORTAL_PRIVATE = getAbiItem({ abi: TOKEN_PORTAL_ABI, name: "DepositToAztecPrivate" }) as AbiEvent
const FILL_STATUSES_ABI = parseAbi(["function fillStatuses(bytes32) view returns (uint256)"])
const CLAIM_SELECTOR = toFunctionSelector("claim(bytes32,uint256)")

/** `SpokePool.FillStatus`. */
const FILL_STATUS = { unfilled: 0n, requestedSlowFill: 1n, filled: 2n } as const

const DEFAULTS = { chunkBlocks: 2_000, deadlineMs: 45_000, maxReads: 200, maxCandidates: 8 }

type Args = Record<string, unknown>
type RawLog = { address: Address; topics: readonly Hex[]; data: Hex }

const selectors = new WeakMap<AbiEvent, Hex>()
function selectorOf(event: AbiEvent): Hex {
	const cached = selectors.get(event)
	if (cached) return cached
	const s = toEventSelector(event)
	selectors.set(event, s)
	return s
}

/** The log's arguments when `emitter` emitted exactly `event`; a look-alike from any other address, or
 *  a log that does not decode strictly, is not that event. */
function eventFrom(emitter: Address, event: AbiEvent, log: RawLog): Args | undefined {
	if (!hexEq(log.address, emitter) || !hexEq(log.topics[0], selectorOf(event))) return undefined
	try {
		return decodeEventLog({ abi: [event], data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }).args as Args
	} catch {
		return undefined
	}
}

// ── Across relay identity ────────────────────────────────────────────────────

/** `V3SpokePoolInterface.V3RelayData`, field for field. */
export interface AcrossRelayData {
	depositor: Hex
	recipient: Hex
	exclusiveRelayer: Hex
	inputToken: Hex
	outputToken: Hex
	inputAmount: bigint
	outputAmount: bigint
	originChainId: bigint
	depositId: bigint
	fillDeadline: number
	exclusivityDeadline: number
	message: Hex
}

const RELAY_DATA = {
	type: "tuple",
	components: [
		{ name: "depositor", type: "bytes32" },
		{ name: "recipient", type: "bytes32" },
		{ name: "exclusiveRelayer", type: "bytes32" },
		{ name: "inputToken", type: "bytes32" },
		{ name: "outputToken", type: "bytes32" },
		{ name: "inputAmount", type: "uint256" },
		{ name: "outputAmount", type: "uint256" },
		{ name: "originChainId", type: "uint256" },
		{ name: "depositId", type: "uint256" },
		{ name: "fillDeadline", type: "uint32" },
		{ name: "exclusivityDeadline", type: "uint32" },
		{ name: "message", type: "bytes" },
	],
} as const

/** `SpokePool.getV3RelayHash` on the chain `destinationChainId`: every relay field, the full message
 *  included, so a fill that alters any of them is another relay. */
export function acrossRelayHash(relay: AcrossRelayData, destinationChainId: number): Hex {
	return keccak256(encodeAbiParameters([RELAY_DATA, { type: "uint256" }], [relay, BigInt(destinationChainId)]))
}

/** The `messageHash` a `FilledRelay` logs: zero for an empty message. */
const relayMessageHash = (message: Hex): Hex => (message === "0x" ? zeroHash : keccak256(message))

type SourceTransport = { kind: "across"; relay: AcrossRelayData; relayHash: Hex } | { kind: "stargate"; guid: Hex; pool: Address }

/** A fill is ours only when the relay hash recomputed from its fields and its message hash equals ours. */
function fillIsOurs(fill: Args, transport: Extract<SourceTransport, { kind: "across" }>, destinationChainId: number): boolean {
	if (!hexEq(fill.messageHash, relayMessageHash(transport.relay.message))) return false
	const relay: AcrossRelayData = {
		depositor: fill.depositor as Hex,
		recipient: fill.recipient as Hex,
		exclusiveRelayer: fill.exclusiveRelayer as Hex,
		inputToken: fill.inputToken as Hex,
		outputToken: fill.outputToken as Hex,
		inputAmount: fill.inputAmount as bigint,
		outputAmount: fill.outputAmount as bigint,
		originChainId: fill.originChainId as bigint,
		depositId: fill.depositId as bigint,
		fillDeadline: fill.fillDeadline as number,
		exclusivityDeadline: fill.exclusivityDeadline as number,
		message: transport.relay.message,
	}
	return hexEq(acrossRelayHash(relay, destinationChainId), transport.relayHash)
}

// ── source chain ─────────────────────────────────────────────────────────────

type SourceFacts =
	| { kind: "unknown" }
	| { kind: "reverted"; srcTxHash: Hex; decidedAt: ChainBlock; finalized: ChainBlock }
	| { kind: "sent"; srcTxHash: Hex; transport: SourceTransport }

const startedId = (log: RawLog, diamond: Address): unknown =>
	(eventFrom(diamond, LIFI_TRANSFER_STARTED, log)?.bridgeData as { transactionId?: unknown } | undefined)?.transactionId

function messageTransactionId(message: Hex): Hex | undefined {
	try {
		return decodeAbiParameters(LIFI_RECEIVER_MESSAGE_PARAMS, message)[0]
	} catch {
		return undefined
	}
}

function acrossDeposit(log: RawLog, rec: CrossChainDepositRecord, rail: AcrossRailContext): SourceTransport | undefined {
	const a = eventFrom(rail.sourceSpokePool, FUNDS_DEPOSITED, log)
	if (!a || a.destinationChainId !== BigInt(rec.chainId) || !hexEq(a.recipient, pad(rail.receiver, { size: 32 }))) return undefined
	if (!hexEq(messageTransactionId(a.message as Hex), rec.route.lifiTxId)) return undefined
	const relay: AcrossRelayData = {
		depositor: a.depositor as Hex,
		recipient: a.recipient as Hex,
		exclusiveRelayer: a.exclusiveRelayer as Hex,
		inputToken: a.inputToken as Hex,
		outputToken: a.outputToken as Hex,
		inputAmount: a.inputAmount as bigint,
		outputAmount: a.outputAmount as bigint,
		originChainId: BigInt(rec.route.srcChainId),
		depositId: a.depositId as bigint,
		fillDeadline: a.fillDeadline as number,
		exclusivityDeadline: a.exclusivityDeadline as number,
		message: a.message as Hex,
	}
	return { kind: "across", relay, relayHash: acrossRelayHash(relay, rec.chainId) }
}

function stargateSend(log: RawLog, ctx: CrossChainDiscoveryContext, rail: StargateRailContext): SourceTransport | undefined {
	const a = eventFrom(rail.sourcePool, OFT_SENT, log)
	if (!a || !hexEq(a.fromAddress, ctx.source.diamond) || a.dstEid !== rail.destinationEid) return undefined
	return { kind: "stargate", guid: a.guid as Hex, pool: rail.sourcePool }
}

/**
 * The transport a source receipt started for this record: the last pinned rail event before the
 * Diamond's `LiFiTransferStarted(lifiTxId)` and after its previous one (the facet calls the rail, then
 * logs the start). `undefined` when the receipt starts no transfer of ours; a start without a rail
 * event is a contradiction, never a guess.
 */
function bindSource(logs: readonly RawLog[], rec: CrossChainDepositRecord, ctx: CrossChainDiscoveryContext): SourceTransport | undefined {
	const diamond = ctx.source.diamond
	const started = logs.findIndex((l) => hexEq(startedId(l, diamond), rec.route.lifiTxId))
	if (started < 0) return undefined
	for (let i = started - 1; i >= 0 && startedId(logs[i], diamond) === undefined; i--) {
		const t = ctx.rail.kind === "acrossV4" ? acrossDeposit(logs[i], rec, ctx.rail) : stargateSend(logs[i], ctx, ctx.rail)
		if (t) return t
	}
	throw new ScanIncomplete("the source transaction starts this transfer without a pinned rail event")
}

type Ctx = {
	rec: CrossChainDepositRecord
	ctx: CrossChainDiscoveryContext
	read: BudgetedRead
	o: typeof DEFAULTS
}

const epochOf = (client: DiscoveryChainReads) => client.chainEpoch?.bind(client)

/** A head below the height the record was planned at is a stale node, which cannot answer for the window. */
function scanStart(from: string, latest: bigint): bigint {
	if (BigInt(from) > latest) throw new ScanIncomplete("the chain's head is below the record's scan start")
	return BigInt(from)
}

/** The node has no receipt for `hash` (a replaced or dropped transaction). Matched by name, since a second viem
 *  copy defeats `instanceof`; every other failure stays a failed read. */
async function receiptOrNull(client: DiscoveryChainReads, hash: Hex): Promise<DiscoveryReceipt | null> {
	try {
		return await client.getTransactionReceipt({ hash })
	} catch (e) {
		if (e instanceof Error && e.name === "TransactionReceiptNotFoundError") return null
		throw e
	}
}

/** The `BridgeData.transactionId` of a call to the rail's facet, or `undefined` when it does not decode. */
function diamondCallId(input: Hex, rail: CrossChainDiscoveryContext["rail"]["kind"]): unknown {
	try {
		const abi = rail === "acrossV4" ? ACROSS_V4_FACET_ABI : STARGATE_FACET_V2_ABI
		return decodeFunctionData({ abi, data: input }).args[0].transactionId
	} catch {
		return undefined
	}
}

/** The batch entrypoints EIP-5792 wallets call on an EIP-7702 account: ERC-7821 / ERC-7579 `execute` and `executeBatch`. */
const BATCH_ABI = parseAbi([
	"function execute(bytes32 mode, bytes executionData)",
	"function executeBatch((address target, uint256 value, bytes data)[] calls)",
])
const BATCH_CALLS = parseAbiParameters("(address target, uint256 value, bytes data)[]")

/** The calls of a batch in either shape, or none when `input` is neither. */
function batchedCalls(input: Hex): readonly { target: Address; data: Hex }[] {
	try {
		const call = decodeFunctionData({ abi: BATCH_ABI, data: input })
		if (call.functionName === "executeBatch") return call.args[0]
		// The mode's first byte is the call type; 0x01 is a batch, whose data opens with `abi.encode(calls)`.
		const [mode, data] = call.args
		return mode.startsWith("0x01") ? decodeAbiParameters(BATCH_CALLS, data)[0] : []
	} catch {
		return []
	}
}

/**
 * A reverted receipt has no logs to authenticate, so it is this record's only when the record's sender signed it
 * and it calls the source Diamond with a rail entrypoint whose decoded `BridgeData.transactionId` is `lifiTxId`:
 * directly, or as one call of a batch the sender addresses to itself. Any other shape, an undecoded batch included,
 * leaves the verdict to the scan: the public id can ride in a call that is not this transfer, which may still land.
 */
async function revertedIsOurs(c: Ctx, client: DiscoveryChainReads, receipt: DiscoveryReceipt): Promise<boolean> {
	const { srcSender, lifiTxId } = c.rec.route
	if (!hexEq(receipt.from, srcSender)) return false
	const tx = await c.read(() => client.getTransaction({ hash: receipt.transactionHash }))
	const diamond = c.ctx.source.diamond
	const isOurs = (target: Address | null, data: Hex) => hexEq(target, diamond) && hexEq(diamondCallId(data, c.ctx.rail.kind), lifiTxId)
	if (isOurs(tx.to, tx.input)) return true
	return hexEq(tx.to, srcSender) && batchedCalls(tx.input).some((call) => isOurs(call.target, call.data))
}

async function fromRecordedHash(c: Ctx, client: DiscoveryChainReads, hash: Hex): Promise<SourceFacts | undefined> {
	const chainId = c.rec.route.srcChainId
	const receipt = await c.read(() => receiptOrNull(client, hash))
	if (!receipt) return undefined
	await assertCanonical(client, c.read, receipt)
	if (receipt.status === "reverted") {
		if (!(await revertedIsOurs(c, client, receipt))) return undefined
		const finalized = await c.read(() => client.getBlock({ blockTag: "finalized" }))
		return {
			kind: "reverted",
			srcTxHash: hash,
			decidedAt: { chainId, blockNumber: receipt.blockNumber },
			finalized: { chainId, blockNumber: finalized.number },
		}
	}
	if (receipt.status !== "success") throw new ScanIncomplete("unknown receipt status")
	const transport = bindSource(receipt.logs, c.rec, c.ctx)
	return transport ? { kind: "sent", srcTxHash: hash, transport } : undefined
}

/** A lost source hash: `LiFiTransferStarted` indexes nothing, so the candidates are the indexed
 *  `Transfer(srcSender → Diamond)` of `srcToken`, in chain order, each bound through its receipt. */
async function fromTransferScan(c: Ctx, client: DiscoveryChainReads, latest: bigint): Promise<SourceFacts> {
	const { srcToken, srcSender } = c.rec.route
	const diamond = c.ctx.source.diamond
	const args = { from: srcSender, to: diamond }
	const logs = await scanRange(scanStart(c.rec.route.srcScanFromBlock, latest), latest, BigInt(c.o.chunkBlocks), (start, end) =>
		c.read(() => client.getLogs({ address: srcToken, event: ERC20_TRANSFER, args, fromBlock: start, toBlock: end })),
	)
	const isOurs = (l: DiscoveryLog) => {
		const t = eventFrom(srcToken, ERC20_TRANSFER, l)
		return !!t && hexEq(t.from, srcSender) && hexEq(t.to, diamond)
	}
	const hashes = [...new Set(logs.filter(isOurs).map((l) => l.transactionHash))]
	if (hashes.length > c.o.maxCandidates) throw new ScanIncomplete("too many source candidates")
	for (const hash of hashes) {
		const receipt = await c.read(() => client.getTransactionReceipt({ hash }))
		if (!receipt) throw new ScanIncomplete("a logged source transaction has no receipt")
		const transport = receipt.status === "success" ? bindSource(receipt.logs, c.rec, c.ctx) : undefined
		if (!transport) continue
		await assertCanonical(client, c.read, receipt)
		return { kind: "sent", srcTxHash: hash, transport }
	}
	return { kind: "unknown" }
}

/** A recorded hash that does not bind (missing, someone else's, not ours) is treated as lost. */
async function readSource(c: Ctx, client: DiscoveryChainReads): Promise<SourceFacts> {
	const scan = await openChainScan(client, c.rec.route.srcChainId, c.read, epochOf(client))
	const recorded = c.rec.route.srcTxHash ? await fromRecordedHash(c, client, c.rec.route.srcTxHash) : undefined
	// A reverted attempt can be resent with the same calldata, so a transfer that went through outranks it.
	const scanned = recorded?.kind === "sent" ? undefined : await fromTransferScan(c, client, scan.latest)
	const facts = scanned?.kind === "sent" || !recorded ? (scanned as SourceFacts) : recorded
	await scan.close()
	return facts
}

// ── Ethereum ─────────────────────────────────────────────────────────────────

interface DepositedArgs {
	tokenSecretHash: Hex
	fuelSecretHash: Hex
	token: Address
	payer: Address
	received: bigint
	tokenAmount: bigint
	tokenKey: Hex
	tokenIndex: bigint
	fuelIn: bigint
	fuelOut: bigint
	fuelKey: Hex
	fuelIndex: bigint
	isPrivate: boolean
}

interface RouterDeposit {
	txHash: Hex
	args: DepositedArgs
}

type Marker = { index: number; kind: "completed" | "recovered"; amount: bigint }

type Execution =
	| { kind: "recovered"; txHash: Hex; blockNumber: bigint; amount: bigint }
	| { kind: "completed"; txHash: Hex; blockNumber: bigint; deposit: DepositedFacts }

interface EthereumFacts {
	finalized: { number: bigint; timestamp: bigint }
	/** The router's deposits for the record's secret hash that the record can claim. */
	claimable: RouterDeposit[]
	execution?: Execution
	expired?: boolean
}

type Range = { from: bigint; to: bigint; chunk: bigint }

/** The indexed secret hash a record's `Deposited` carries: the token one, or the fuel one for gas only. */
function depositTopic(rec: CrossChainDepositRecord): { name: "tokenSecretHash" | "fuelSecretHash"; hash: Hex } {
	if (rec.intent !== "gas") return { name: "tokenSecretHash", hash: rec.secretHashHex as Hex }
	return { name: "fuelSecretHash", hash: (rec.fuel?.secretHashHex ?? rec.secretHashHex) as Hex }
}

async function logsOf(c: Ctx, client: DiscoveryChainReads, range: Range, address: Address, event: AbiEvent, args: Args) {
	return scanRange(range.from, range.to, range.chunk, (start, end) =>
		c.read(() => client.getLogs({ address, event, args, fromBlock: start, toBlock: end })),
	)
}

/** Every `Deposited` the router itself emitted for the record's secret hash. */
async function routerDeposits(c: Ctx, client: DiscoveryChainReads, range: Range): Promise<RouterDeposit[]> {
	const topic = depositTopic(c.rec)
	const router = c.ctx.ethereum.router
	const logs = await logsOf(c, client, range, router, DEPOSITED, { [topic.name]: topic.hash })
	return logs.flatMap((l) => {
		const args = eventFrom(router, DEPOSITED, l) as DepositedArgs | undefined
		return args && hexEq(args[topic.name], topic.hash) ? [{ txHash: l.transactionHash, args }] : []
	})
}

function markerAt(log: RawLog, c: Ctx): Marker | undefined {
	const id = c.rec.route.lifiTxId
	const done = eventFrom(c.ctx.ethereum.executor, LIFI_TRANSFER_COMPLETED, log)
	if (done && hexEq(done.transactionId, id)) return { index: -1, kind: "completed", amount: done.amount as bigint }
	const back = eventFrom(c.ctx.rail.receiver, LIFI_TRANSFER_RECOVERED, log)
	if (back && hexEq(back.transactionId, id)) return { index: -1, kind: "recovered", amount: back.amount as bigint }
	return undefined
}

type Span = { start: number; marker?: Marker }

/** The SpokePool logs `FilledRelay` before it calls the recipient's handler (pinned by the Sepolia rail
 *  receipts), so our marker is the first one after our fill and before the pool's next fill. */
function acrossSpan(logs: readonly RawLog[], c: Ctx, transport: Extract<SourceTransport, { kind: "across" }>): Span | undefined {
	const pool = (c.ctx.rail as AcrossRailContext).destinationSpokePool
	const isFill = (l: RawLog) => eventFrom(pool, FILLED_RELAY, l)
	const fill = logs.findIndex((l) => {
		const f = isFill(l)
		return !!f && fillIsOurs(f, transport, c.rec.chainId)
	})
	if (fill < 0) return undefined
	for (let i = fill + 1; i < logs.length && !isFill(logs[i]); i++) {
		const marker = markerAt(logs[i], c)
		if (marker) return { start: fill, marker: { ...marker, index: i } }
	}
	return { start: fill }
}

/** EndpointV2 logs `ComposeDelivered` (guid in its data, nothing indexed) after the composer returns, so
 *  our marker is the last one before our delivery and after the endpoint's previous one. */
function stargateSpan(logs: readonly RawLog[], c: Ctx, guid: Hex): Span | undefined {
	const rail = c.ctx.rail as StargateRailContext
	const delivery = (l: RawLog) => eventFrom(rail.endpoint, COMPOSE_DELIVERED, l)
	const ours = logs.findIndex((l) => {
		const d = delivery(l)
		return !!d && hexEq(d.from, rail.destinationPool) && hexEq(d.to, rail.receiver) && hexEq(d.guid, guid) && d.index === 0
	})
	if (ours < 0) return undefined
	let i = ours - 1
	for (; i >= 0 && !delivery(logs[i]); i--) {
		const marker = markerAt(logs[i], c)
		if (marker) return { start: lastDeliveryBefore(logs, i, delivery), marker: { ...marker, index: i } }
	}
	return { start: i }
}

function lastDeliveryBefore(logs: readonly RawLog[], from: number, isDelivery: (l: RawLog) => unknown): number {
	let i = from - 1
	while (i >= 0 && !isDelivery(logs[i])) i--
	return i
}

// ── the intended deposit ─────────────────────────────────────────────────────

/** `Hash.sha256ToField(L1ToL2Msg)`: the leaf the Inbox inserts for a message. */
function inboxLeaf(m: {
	sender: Address
	l1ChainId: number
	recipient: Hex
	version: bigint
	content: string
	secretHash: Hex
	index: bigint
}): Promise<string> {
	const words = [m.sender, toHex(m.l1ChainId), m.recipient, toHex(m.version), m.content, m.secretHash, toHex(m.index)].map(word)
	return sha256ToField(bytesFromHex(words.join("")))
}

/** The key the router logged must be the leaf recomputed from the record's own facts, and the pinned
 *  Inbox must have inserted it, in the network's own `MessageSent` shape. */
function assertLeaf(logs: readonly RawLog[], inbox: InboxContext, leaf: string, key: Hex, leg: string): void {
	if (!hexEq(leaf, key)) throw new ScanIncomplete(`the ${leg} leaf does not recompute from this record`)
	if (!logs.some((l) => hexEq(eventFrom(inbox.address, MESSAGE_SENT[inbox.shape], l)?.hash, leaf))) {
		throw new ScanIncomplete(`the Inbox inserted no ${leg} leaf`)
	}
}

/** The leaf `d`'s token leg inserts when it mints for `x`: publicly to its recipient, or privately. */
async function tokenLeaf(d: DepositedArgs, x: DepositExpectation, eth: DepositLogContext): Promise<string> {
	const content = x.isPrivate ? await mintToPrivateContentHash(d.tokenAmount) : await mintToPublicContentHash(x.recipient, d.tokenAmount)
	return inboxLeaf({
		sender: eth.tokenPortal as Address,
		l1ChainId: x.l1ChainId,
		recipient: eth.inbox.l2Hub,
		version: eth.inbox.rollupVersion,
		content,
		secretHash: d.tokenSecretHash,
		index: d.tokenIndex,
	})
}

/** Who `x`'s Fee Juice is claimed for. */
const fuelRecipient = (x: DepositExpectation): Hex =>
	x.fuel?.recipient ?? (x.isPrivate ? (x.fuel?.fpc ?? PRIVATE_FPC_ADDRESS) : x.recipient)

/** The leaf `d`'s fuel leg inserts when it pays `x`'s Fee Juice recipient. */
async function fuelLeaf(d: DepositedArgs, x: DepositExpectation, eth: DepositLogContext): Promise<string> {
	const { inbox } = eth
	return inboxLeaf({
		sender: inbox.feeJuice.l1Sender,
		l1ChainId: x.l1ChainId,
		recipient: inbox.feeJuice.l2,
		version: inbox.rollupVersion,
		content: await sha256ToField(bytesFromHex(CLAIM_SELECTOR.slice(2) + word(fuelRecipient(x)) + word(toHex(d.fuelOut)))),
		secretHash: d.fuelSecretHash,
		index: d.fuelIndex,
	})
}

async function tokenLeg(
	logs: readonly RawLog[],
	d: DepositedArgs,
	x: DepositExpectation,
	eth: DepositLogContext,
): Promise<DepositedFacts["token"]> {
	const event = x.isPrivate ? PORTAL_PRIVATE : PORTAL_PUBLIC
	const own = logs.map((l) => eventFrom(eth.tokenPortal as Address, event, l)).find((a) => hexEq(a?.key, d.tokenKey))
	if (!own || own.amount !== d.tokenAmount || own.index !== d.tokenIndex || (!x.isPrivate && !hexEq(own.to, x.recipient))) {
		throw new ScanIncomplete("the token portal did not log this deposit")
	}
	assertLeaf(logs, eth.inbox, await tokenLeaf(d, x, eth), d.tokenKey, "token")
	return { amount: d.tokenAmount.toString(), leafIndex: d.tokenIndex.toString(), messageHash: d.tokenKey }
}

/** One log at a time through the emitter-filtered parser, so a look-alike cannot shadow ours. */
function feeJuiceDeposit(log: RawLog, portal: Address) {
	try {
		return parseFeeJuiceDeposit([log] as unknown as Log[], portal)
	} catch {
		return undefined
	}
}

async function fuelLeg(
	logs: readonly RawLog[],
	d: DepositedArgs,
	x: DepositExpectation,
	eth: DepositLogContext,
): Promise<DepositedFacts["fuel"]> {
	const own = logs.map((l) => feeJuiceDeposit(l, eth.feeJuicePortal)).find((e) => hexEq(e?.key, d.fuelKey))
	if (!own || own.amount !== d.fuelOut || own.leafIndex !== d.fuelIndex || !hexEq(own.to, fuelRecipient(x))) {
		throw new ScanIncomplete("the FeeJuicePortal did not log this deposit")
	}
	assertLeaf(logs, eth.inbox, await fuelLeaf(d, x, eth), d.fuelKey, "fuel")
	return { consumed: d.fuelIn.toString(), received: d.fuelOut.toString(), leafIndex: d.fuelIndex.toString(), messageHash: d.fuelKey }
}

/** The record facts a deposit's expectation is built from; every schema-3 and schema-4 deposit has them. */
export type DepositRecordFacts = Pick<CrossChainDepositRecord, "chainId" | "isPrivate" | "recipient" | "secretHashHex" | "fuel"> &
	({ intent: "gas" } | { intent: "token" | "token+gas"; token: { erc20: string } })

/** What the router's `Deposited` must carry for a journal record, whichever chain the send started on. */
export function depositExpectationOf(rec: DepositRecordFacts): DepositExpectation {
	return {
		l1ChainId: rec.chainId,
		isPrivate: rec.isPrivate,
		recipient: rec.recipient as Hex,
		...(rec.intent === "gas" ? {} : { token: { erc20: rec.token.erc20 as Address, secretHash: rec.secretHashHex as Hex } }),
		...(rec.fuel ? { fuel: { secretHash: rec.fuel.secretHashHex as Hex, fpc: rec.fuel.fpc as Hex | undefined } } : {}),
	}
}

function isIntent(d: DepositedArgs, x: DepositExpectation): boolean {
	return (
		hexEq(d.tokenSecretHash, x.token?.secretHash ?? zeroHash) &&
		hexEq(d.fuelSecretHash, x.fuel?.secretHash ?? zeroHash) &&
		d.isPrivate === x.isPrivate &&
		(!x.token || hexEq(d.token, x.token.erc20))
	)
}

async function depositFacts(
	logs: readonly RawLog[],
	d: DepositedArgs,
	x: DepositExpectation,
	eth: DepositLogContext,
	txHash: Hex,
): Promise<DepositedFacts> {
	return {
		depositTxHash: txHash,
		received: d.received.toString(),
		...(x.token ? { token: await tokenLeg(logs, d, x, eth) } : {}),
		...(x.fuel ? { fuel: await fuelLeg(logs, d, x, eth) } : {}),
	}
}

/**
 * The one router `Deposited` in a transaction's logs that matches `expected`, each leg authenticated by
 * its portal's own event and the Inbox leaf recomputed from `expected`. For a transaction whose deposit is
 * the caller's own (an Ethereum-origin send); a LI.FI delivery goes through {@link discoverCrossChain},
 * which also binds the deposit to its transport. Throws {@link ScanIncomplete} when no event or more than
 * one matches, or a leg does not authenticate.
 */
export async function readRouterDeposit(
	logs: readonly RawLog[],
	txHash: Hex,
	eth: DepositLogContext,
	expected: DepositExpectation,
): Promise<DepositedFacts> {
	const at = logs.flatMap((l, i) => {
		const d = eventFrom(eth.router, DEPOSITED, l) as DepositedArgs | undefined
		return d && isIntent(d, expected) ? [i] : []
	})
	if (at.length !== 1) throw new ScanIncomplete(`the transaction carries ${at.length} router Deposited events for this intent, not one`)
	const d = eventFrom(eth.router, DEPOSITED, logs[at[0]]) as unknown as DepositedArgs
	return depositFacts(logs.slice(0, at[0]), d, expected, eth, txHash)
}

/** The router and the Executor are non-reentrant, so the last router `Deposited` before a completion
 *  marker inside its span is the one our execution produced. */
async function intendedDeposit(logs: readonly RawLog[], span: Span, markerIndex: number, txHash: Hex, c: Ctx): Promise<DepositedFacts> {
	const router = c.ctx.ethereum.router
	let at = markerIndex - 1
	while (at > span.start && !eventFrom(router, DEPOSITED, logs[at])) at--
	if (at <= span.start) throw new ScanIncomplete("a completed transfer without the router's Deposited")
	const d = eventFrom(router, DEPOSITED, logs[at]) as unknown as DepositedArgs
	const x = depositExpectationOf(c.rec)
	if (!isIntent(d, x)) throw new ScanIncomplete("the router's Deposited is not this record's intent")
	return depositFacts(logs.slice(span.start + 1, at), d, x, c.ctx.ethereum, txHash)
}

async function executionIn(receipt: DiscoveryReceipt, c: Ctx, transport: SourceTransport): Promise<Execution | undefined> {
	const logs = receipt.logs
	const span = transport.kind === "across" ? acrossSpan(logs, c, transport) : stargateSpan(logs, c, transport.guid)
	if (!span) return undefined
	const { marker } = span
	if (!marker) throw new ScanIncomplete("our transport was delivered without a LI.FI marker on its callback side")
	const at = { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber }
	if (marker.kind === "recovered") return { kind: "recovered", ...at, amount: marker.amount }
	return { kind: "completed", ...at, deposit: await intendedDeposit(logs, span, marker.index, receipt.transactionHash, c) }
}

/** Transactions that may carry our execution: Across fills indexed by `(originChainId, depositId)` whose
 *  recomputed relay hash is ours; on Stargate (whose delivery event indexes nothing) the transactions
 *  of the receiver's recoveries for `lifiTxId` and of the Executor-paid deposits for our secret. */
async function executionCandidates(
	c: Ctx,
	client: DiscoveryChainReads,
	range: Range,
	t: SourceTransport,
	deposits: RouterDeposit[],
): Promise<{ transactionHash: Hex }[]> {
	if (t.kind === "across") {
		const pool = (c.ctx.rail as AcrossRailContext).destinationSpokePool
		const args = { originChainId: t.relay.originChainId, depositId: t.relay.depositId }
		const fills = await logsOf(c, client, range, pool, FILLED_RELAY, args)
		return fills.filter((l) => {
			const f = eventFrom(pool, FILLED_RELAY, l)
			return !!f && fillIsOurs(f, t, c.rec.chainId)
		})
	}
	const receiver = c.ctx.rail.receiver
	const recovered = await logsOf(c, client, range, receiver, LIFI_TRANSFER_RECOVERED, { transactionId: c.rec.route.lifiTxId })
	const paid = deposits.filter((d) => hexEq(d.args.payer, c.ctx.ethereum.executor)).map((d) => ({ transactionHash: d.txHash }))
	return [...recovered.filter((l) => !!markerAt(l, c)), ...paid]
}

async function findExecution(c: Ctx, client: DiscoveryChainReads, range: Range, t: SourceTransport, deposits: RouterDeposit[]) {
	const candidates = await executionCandidates(c, client, range, t, deposits)
	const hashes = [...new Set(candidates.map((l) => l.transactionHash.toLowerCase() as Hex))]
	if (hashes.length > c.o.maxCandidates) throw new ScanIncomplete("too many destination candidates")
	const found: Execution[] = []
	for (const hash of hashes) {
		const receipt = await c.read(() => client.getTransactionReceipt({ hash }))
		if (!receipt) throw new ScanIncomplete("a logged destination transaction has no receipt")
		const execution = receipt.status === "success" ? await executionIn(receipt, c, t) : undefined
		if (!execution) continue
		await assertCanonical(client, c.read, receipt)
		found.push(execution)
	}
	if (found.length > 1) throw new ScanIncomplete("one transport delivered twice")
	return found[0]
}

/** Across only: unfilled (a requested slow fill included) at the finalized block, whose timestamp is past
 *  the deadline — after which every fill, slow fills included, reverts. */
async function expiredOnSource(c: Ctx, client: DiscoveryChainReads, t: SourceTransport, finalized: EthereumFacts["finalized"]) {
	if (t.kind !== "across") return false
	const pool = (c.ctx.rail as AcrossRailContext).destinationSpokePool
	const status = await c.read(() =>
		client.readContract({
			address: pool,
			abi: FILL_STATUSES_ABI,
			functionName: "fillStatuses",
			args: [t.relayHash],
			blockNumber: finalized.number,
		}),
	)
	if (status === FILL_STATUS.filled) throw new ScanIncomplete("filled by the finalized block, yet no fill was found")
	if (status !== FILL_STATUS.unfilled && status !== FILL_STATUS.requestedSlowFill) throw new ScanIncomplete("unknown fill status")
	return finalized.timestamp > BigInt(t.relay.fillDeadline)
}

/** Anyone can deposit to a public secret hash for another recipient or privacy mode, which this record
 *  can never claim. The pinned router's args are authentic, so a deposit is the record's when the key it
 *  logged is the leaf recomputed from the record's privacy, recipient and portal with the event's own
 *  amount, secret hash and index. */
async function claimableBy(d: DepositedArgs, x: DepositExpectation, eth: DepositLogContext): Promise<boolean> {
	if (d.isPrivate !== x.isPrivate) return false
	if (!x.token) return hexEq(await fuelLeaf(d, x, eth), d.fuelKey)
	return hexEq(d.token, x.token.erc20) && hexEq(await tokenLeaf(d, x, eth), d.tokenKey)
}

async function claimableDeposits(c: Ctx, deposits: RouterDeposit[]): Promise<RouterDeposit[]> {
	const x = depositExpectationOf(c.rec)
	const keep = await Promise.all(deposits.map(({ args }) => claimableBy(args, x, c.ctx.ethereum)))
	return deposits.filter((_, i) => keep[i])
}

async function readEthereum(c: Ctx, client: DiscoveryChainReads, source: SourceFacts): Promise<EthereumFacts> {
	const scan = await openChainScan(client, c.rec.chainId, c.read, epochOf(client))
	const head = await c.read(() => client.getBlock({ blockTag: "finalized" }))
	const finalized = { number: head.number, timestamp: head.timestamp }
	const range = { from: scanStart(c.rec.route.scanFromBlock, scan.latest), to: scan.latest, chunk: BigInt(c.o.chunkBlocks) }
	const deposits = await routerDeposits(c, client, range)
	const transport = source.kind === "sent" ? source.transport : undefined
	const execution = transport ? await findExecution(c, client, range, transport, deposits) : undefined
	const expired = transport && !execution ? await expiredOnSource(c, client, transport, finalized) : false
	await scan.close()
	return { finalized, claimable: await claimableDeposits(c, deposits), execution, expired }
}

// ── verdict ──────────────────────────────────────────────────────────────────

/** The floor an extra must reach: the token leg's `minReceived − fuelSlice`, or the signed fuel floor
 *  for a gas-only send. */
function extraFloor(rec: CrossChainDepositRecord): bigint {
	if (rec.intent === "gas") return BigInt(rec.fuel?.minOutput ?? "0")
	return BigInt(rec.route.minReceived) - BigInt(rec.fuel?.amount ?? "0")
}

function extrasOf(rec: CrossChainDepositRecord, claimable: RouterDeposit[], intended?: { txHash: Hex; leafIndex: string }) {
	const floor = extraFloor(rec)
	const out: CrossChainExtraDeposit[] = []
	for (const { txHash, args: d } of claimable) {
		const [amount, leafIndex] = rec.intent === "gas" ? [d.fuelOut, d.fuelIndex] : [d.tokenAmount, d.tokenIndex]
		if (amount < floor) continue
		if (intended && hexEq(txHash, intended.txHash) && leafIndex.toString() === intended.leafIndex) continue
		out.push({ txHash, leafIndex: leafIndex.toString(), amount: amount.toString() })
	}
	return out
}

function persistedTransport(t: SourceTransport): CrossChainTransport {
	if (t.kind === "stargate") return { kind: "stargate", guid: t.guid, pool: t.pool }
	return { kind: "across", originChainId: Number(t.relay.originChainId), depositId: t.relay.depositId.toString(), relayHash: t.relayHash }
}

function decide(rec: CrossChainDepositRecord, source: SourceFacts, eth: EthereumFacts): CrossChainDiscovery {
	const x = eth.execution
	const intended = x?.kind === "completed" ? (x.deposit.token ?? x.deposit.fuel) : undefined
	const facts: DiscoveryFacts = {
		...(source.kind === "unknown" ? {} : { srcTxHash: source.srcTxHash }),
		...(source.kind === "sent" ? { transport: persistedTransport(source.transport) } : {}),
		extraDeposits: extrasOf(rec, eth.claimable, intended && x ? { txHash: x.txHash, leafIndex: intended.leafIndex } : undefined),
	}
	const onEthereum = (blockNumber: bigint): ChainBlock => ({ chainId: rec.chainId, blockNumber })
	const finalized = onEthereum(eth.finalized.number)
	if (source.kind === "reverted") {
		const { srcTxHash: txHash, decidedAt, finalized: srcFinalized } = source
		return { ...facts, verdict: "not-sent", observation: { outcome: "not-sent", txHash, decidedAt, finalized: srcFinalized } }
	}
	if (x?.kind === "recovered") {
		const observation: OutcomeObservation = {
			outcome: "delivered-to-wallet",
			txHash: x.txHash,
			amount: x.amount.toString(),
			decidedAt: onEthereum(x.blockNumber),
			finalized,
		}
		return { ...facts, verdict: "delivered-to-wallet", observation }
	}
	if (x?.kind === "completed")
		return { ...facts, verdict: "deposited", deposit: x.deposit, decidedAt: onEthereum(x.blockNumber), finalized }
	if (eth.expired) {
		return { ...facts, verdict: "expired-on-source", observation: { outcome: "expired-on-source", decidedAt: finalized, finalized } }
	}
	return { ...facts, verdict: "pending" }
}

function assertContext(rec: CrossChainDepositRecord, ctx: CrossChainDiscoveryContext): void {
	const mismatch =
		ctx.rail.kind !== rec.route.rail ||
		ctx.ethereum.chainId !== rec.chainId ||
		ctx.source.chainId !== rec.route.srcChainId ||
		!hexEq(ctx.ethereum.router, rec.route.router) ||
		(rec.intent !== "gas" && !hexEq(ctx.ethereum.tokenPortal, rec.token.portal))
	if (mismatch) throw new Error("The discovery context does not pin this record's chains, rail, router or portal.")
}

/**
 * Where `rec` stands, re-derived from the chains on every run (a stored outcome is never an input).
 *
 * Verdicts: `pending` (nothing decided yet; a send with no known hash stays here), `incomplete` (an RPC
 * failure, an exhausted budget, a chain switch, a reorg during the run, or chain data contradicting the
 * record: retry, never terminal), `not-sent` (the source receipt reverted; final only once its block is
 * finalized on the source chain), `deposited` (our execution completed into the router), `delivered-to-wallet`
 * (LI.FI recovered the delivery to the user), `expired-on-source` (Across only: unfilled and past its
 * deadline at the same finalized Ethereum block). Outcome verdicts carry the observation `outcomePatch`
 * takes; `discoveryPatch` turns any verdict into a journal patch.
 *
 * @throws when `ctx` does not pin the record's chains, rail, router or token portal.
 */
export async function discoverCrossChain(
	rec: CrossChainDepositRecord,
	ctx: CrossChainDiscoveryContext,
	reads: DiscoveryReads,
	options: DiscoveryOptions = {},
): Promise<CrossChainDiscovery> {
	assertContext(rec, ctx)
	const { now = Date.now, ...rest } = options
	const o = { ...DEFAULTS, ...rest }
	const c: Ctx = { rec, ctx, read: budgetedReads({ ...o, now }), o }
	try {
		const source = await readSource(c, reads.source)
		const eth = await readEthereum(c, reads.ethereum, source)
		return decide(rec, source, eth)
	} catch (e) {
		if (e instanceof ScanIncomplete) return { verdict: "incomplete", reason: e.message }
		throw e
	}
}

// ── journal patch ────────────────────────────────────────────────────────────

function mergeExtras(kept: CrossChainExtraDeposit[] = [], seen: CrossChainExtraDeposit[]): CrossChainExtraDeposit[] {
	const key = (e: CrossChainExtraDeposit) => `${e.txHash.toLowerCase()}:${e.leafIndex}`
	const known = new Set(kept.map(key))
	return [...kept, ...seen.filter((e) => !known.has(key(e)))]
}

function withFacts(route: CrossChainRoute, d: DiscoveryFacts): CrossChainRoute {
	const extras = mergeExtras(route.extraDeposits, d.extraDeposits)
	return {
		...route,
		...(d.srcTxHash ? { srcTxHash: d.srcTxHash } : {}),
		...(d.transport ? { transport: d.transport } : {}),
		...(extras.length ? { extraDeposits: extras } : {}),
	}
}

const withoutOutcome = (route: CrossChainRoute): CrossChainRoute => ({
	...route,
	outcome: undefined,
	outcomeTxHash: undefined,
	outcomeAmount: undefined,
})

function depositPatch(rec: CrossChainDepositRecord, deposit: DepositedFacts): Partial<CrossChainDepositRecord> {
	const fuel =
		rec.fuel && deposit.fuel
			? { ...rec.fuel, received: deposit.fuel.received, leafIndex: deposit.fuel.leafIndex, messageHash: deposit.fuel.messageHash }
			: rec.fuel
	const leg = deposit.token ?? {
		amount: deposit.fuel?.consumed ?? rec.amount,
		leafIndex: deposit.fuel?.leafIndex,
		messageHash: undefined,
	}
	return {
		amount: leg.amount,
		leafIndex: leg.leafIndex,
		...(leg.messageHash ? { messageHash: leg.messageHash } : {}),
		depositTxHash: deposit.depositTxHash,
		...(fuel ? { fuel } : {}),
	}
}

/** Clears what `depositPatch` derived from a deposit the canonical chain no longer carries, so no claim
 *  targets a vanished leaf. `amount` is required and claims nothing without a leaf, so it stays. */
function withoutDeposit(rec: CrossChainDepositRecord): Partial<CrossChainDepositRecord> {
	const fuel = rec.fuel && { ...rec.fuel, received: undefined, leafIndex: undefined, messageHash: undefined }
	return { leafIndex: undefined, messageHash: undefined, depositTxHash: undefined, ...(fuel ? { fuel } : {}) }
}

/**
 * The journal patch a discovery implies, or `undefined` for `incomplete` (a partial run proves nothing).
 * Facts merge (extras are only ever added, so a lying read cannot make a record retirable). A final
 * record (`completedAt`) keeps its outcome and deposit; otherwise every run replaces both provisional
 * facts: a deposit clears the outcome, `pending` clears both, an outcome goes through `outcomePatch`
 * and clears the deposit.
 */
export function discoveryPatch(
	rec: CrossChainDepositRecord,
	d: CrossChainDiscovery,
	now: number,
): Partial<CrossChainDepositRecord> | undefined {
	if (d.verdict === "incomplete") return undefined
	const route = withFacts(rec.route, d)
	if (rec.completedAt !== undefined) return { route }
	if (d.verdict === "deposited") return { route: withoutOutcome(route), ...depositPatch(rec, d.deposit) }
	if (d.verdict === "pending") return { route: withoutOutcome(route), ...withoutDeposit(rec) }
	return { ...withoutDeposit(rec), ...outcomePatch({ ...rec, route }, d.observation, now) }
}
