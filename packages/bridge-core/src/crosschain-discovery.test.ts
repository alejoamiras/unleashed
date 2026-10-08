import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { L1Actor, L1ToL2Message, L2Actor } from "@aztec-labs/stdlib/messaging"
import {
	type AbiEvent,
	type Address,
	decodeEventLog,
	decodeFunctionData,
	encodeAbiParameters,
	encodeEventTopics,
	encodeFunctionData,
	getAbiItem,
	type Hex,
	keccak256,
	pad,
	parseAbi,
	parseAbiItem,
	parseAbiParameters,
	toEventSelector,
	toFunctionSelector,
	toHex,
} from "viem"
import { describe, expect, it } from "vitest"
import { ACROSS_V4_FACET_ABI } from "./across-v4"
import { bytesFromHex, mintToPrivateContentHash, mintToPublicContentHash, sha256ToField, word } from "./content-hash"
import {
	acrossRelayHash,
	type CrossChainDiscovery,
	type CrossChainDiscoveryContext,
	type DiscoveryChainReads,
	type DiscoveryLog,
	discoverCrossChain,
	discoveryPatch,
	readRouterDeposit,
} from "./crosschain-discovery"
import { DEPOSIT_ROUTER_ABI } from "./deposit-router-abi"
import { TOKEN_PORTAL_ABI } from "./factory-abi"
import { type CrossChainDepositRecord, deriveCrossChainDepositStage, outcomeFinality } from "./journal"
import { LIFI_RECEIVER_MESSAGE_PARAMS } from "./lifi-abi"
import { CROSSCHAIN_TOKEN, crossChainRecord } from "./test/crosschain-record"

// ── recorded fork receipts ───────────────────────────────────────────────────

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm", "test", "fixtures", "lifi")
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, name), "utf8")) as T

interface RawLog {
	address: Address
	topics: Hex[]
	data: Hex
}
interface Receipts {
	depositId: string
	source: { chainId: number; block: number; logs: RawLog[] }
	destination: { chainId: number; block: number; logs: RawLog[] }
}
interface Variant {
	transactionId: Hex
	/** The source Diamond call. */
	calldata: Hex
	intent: { tokenSecretHash: Hex; fuelSecretHash: Hex; aztecRecipient: Hex; fuelSlice: string; minFuelOutput: string }
}
interface Rail {
	source: { chainId: number; diamond: Address; spokePool: Address; usdc: Address }
	destination: { chainId: number; spokePool: Address; receiverAcrossV4: Address; executor: Address; usdc: Address; portal: Address }
	inputs: { transactionId: Hex; user: Address; fillDeadline: number; secretHash: Hex; aztecRecipient: Hex; outputAmount: string }
	router: {
		router: Address
		feeJuicePortal: Address
		minReceived: string
		maxPull: string
		variants: { public: Variant; floorUnmet: Variant }
	}
}
interface Compose {
	guid: Hex
	dstEid: string
	composeMsg: Hex
	base: { chainId: number; block: number; pool: Address }
	sourceLogs: RawLog[]
}
interface Mainnet {
	user: Address
	base: { diamond: Address; usdc: Address }
}

const RAIL = fixture<Rail>("testnet-rail.json")
// Phase 0: the Executor deposits straight into the clone, or recovers when deposits are paused.
const PLAIN = fixture<Receipts>("testnet-rail.receipts.json")
const PLAIN_RECOVERED = fixture<Receipts>("testnet-rail.recovered.receipts.json")
// The router's public token+gas variant, and its unmet-floor variant that recovers.
const ROUTED = fixture<Receipts>("testnet-rail.router.receipts.json")
const ROUTED_RECOVERED = fixture<Receipts>("testnet-rail.router-recovered.receipts.json")
// The Base → Ethereum Stargate send LifiReplayFork captured (source side only).
const COMPOSE = fixture<Compose>("mainnet.compose.json")
const MAINNET = fixture<Mainnet>("mainnet.json")

const ETH = RAIL.destination.chainId
const SRC_BLOCK = BigInt(ROUTED.source.block)
const ETH_BLOCK = BigInt(ROUTED.destination.block)
const PUBLIC = RAIL.router.variants.public
const FLOOR_UNMET = RAIL.router.variants.floorUnmet
const DELIVERED = RAIL.inputs.outputAmount
const FLOOR = BigInt(RAIL.router.minReceived) - BigInt(PUBLIC.intent.fuelSlice)
const ATTACKER: Address = `0x${"ad".repeat(20)}`
const label = (s: string): Hex => keccak256(toHex(s))
const eq = (a: string | undefined, b: string | undefined) => a?.toLowerCase() === b?.toLowerCase()
const SRC_TX = label("source")
const FILL_TX = label("fill")

// The Sepolia generation's Inbox and the L2 actors its messages name, as the recorded `MessageSent`s carry them.
const INBOX: Address = "0x816ce1861ec258F99279E75a3EE6B5Dfc9571E30"
const HUB: Hex = "0x1a0a913173a8b010a87b703748767e15a031b6c01a314e9b905de3df85fcb715"
const FEE_JUICE: Address = "0x0000000000000000000000000000000000000003"

const ACROSS_CTX: CrossChainDiscoveryContext = {
	source: { chainId: RAIL.source.chainId, diamond: RAIL.source.diamond },
	ethereum: {
		chainId: ETH,
		router: RAIL.router.router,
		executor: RAIL.destination.executor,
		feeJuicePortal: RAIL.router.feeJuicePortal,
		tokenPortal: RAIL.destination.portal,
		inbox: {
			address: INBOX,
			shape: "artifact",
			rollupVersion: 2914217885n,
			l2Hub: HUB,
			feeJuice: { l2: pad(FEE_JUICE), l1Sender: FEE_JUICE },
		},
	},
	rail: {
		kind: "acrossV4",
		sourceSpokePool: RAIL.source.spokePool,
		destinationSpokePool: RAIL.destination.spokePool,
		receiver: RAIL.destination.receiverAcrossV4,
	},
}

// The Stargate rail reuses the Sepolia delivery logs behind a synthetic EndpointV2 and pool.
const ENDPOINT: Address = `0x${"e0".repeat(20)}`
const ETH_POOL: Address = `0x${"e1".repeat(20)}`
const BASE_CHAIN = 8453
const STARGATE_CTX: CrossChainDiscoveryContext = {
	...ACROSS_CTX,
	source: { chainId: BASE_CHAIN, diamond: MAINNET.base.diamond },
	rail: {
		kind: "stargateV2",
		sourcePool: COMPOSE.base.pool,
		destinationPool: ETH_POOL,
		endpoint: ENDPOINT,
		receiver: RAIL.destination.receiverAcrossV4,
		destinationEid: Number(COMPOSE.dstEid),
	},
}

/** A public token+gas record for `variant`, signed on the source chain and journalled before it. */
function record(variant: Variant = PUBLIC, route: Partial<CrossChainDepositRecord["route"]> = {}): CrossChainDepositRecord {
	const fuelSlice = variant.intent.fuelSlice
	return crossChainRecord(
		{
			id: variant.intent.tokenSecretHash,
			isPrivate: false,
			chainId: ETH,
			portal: RAIL.destination.portal,
			recipient: variant.intent.aztecRecipient,
			secretHashHex: variant.intent.tokenSecretHash,
			amount: (BigInt(RAIL.router.minReceived) - BigInt(fuelSlice)).toString(),
			token: { ...CROSSCHAIN_TOKEN, erc20: RAIL.destination.usdc, portal: RAIL.destination.portal },
			fuel: {
				amount: fuelSlice,
				secret: label("fuel"),
				secretHashHex: variant.intent.fuelSecretHash,
				minOutput: variant.intent.minFuelOutput,
			},
		},
		{
			srcChainId: RAIL.source.chainId,
			srcToken: RAIL.source.usdc,
			srcSender: RAIL.inputs.user,
			srcScanFromBlock: (SRC_BLOCK - 20n).toString(),
			srcTxHash: SRC_TX,
			lifiTxId: variant.transactionId,
			transport: undefined,
			router: RAIL.router.router,
			minReceived: RAIL.router.minReceived,
			maxPull: RAIL.router.maxPull,
			scanFromBlock: (ETH_BLOCK - 20n).toString(),
			fillDeadline: RAIL.inputs.fillDeadline,
			...route,
		},
	)
}

/** The Phase 0 send: a public token-only deposit the Executor made into the clone itself. */
const plainRecord = (): CrossChainDepositRecord =>
	({
		...record(),
		intent: "token",
		fuel: undefined,
		amount: DELIVERED,
		secretHashHex: RAIL.inputs.secretHash,
		recipient: RAIL.inputs.aztecRecipient,
		route: { ...record().route, lifiTxId: RAIL.inputs.transactionId },
	}) as CrossChainDepositRecord

/** The Stargate send whose source LifiReplayFork recorded on Base; LI.FI's message opens with its id. */
const stargateRecord = () =>
	record(PUBLIC, {
		rail: "stargateV2",
		srcChainId: BASE_CHAIN,
		srcToken: MAINNET.base.usdc,
		srcSender: MAINNET.user,
		srcScanFromBlock: (BigInt(COMPOSE.base.block) - 20n).toString(),
		lifiTxId: COMPOSE.composeMsg.slice(0, 66) as Hex,
		fillDeadline: undefined,
	})

// ── a chain made of transactions ─────────────────────────────────────────────

interface Tx {
	hash: Hex
	block: bigint
	logs: RawLog[]
	status?: "success" | "reverted"
	from?: Address
	input?: Hex
	to?: Address | null
}

interface ChainOptions {
	chainId: number
	txs: Tx[]
	finalized?: bigint
	timestamp?: (n: bigint) => bigint
	fillStatus?: bigint
	chainIdOf?: (call: number) => number
	blockHash?: (n: bigint, readNo: number) => Hex
	epoch?: () => number
	/** Logs a lying RPC adds to every `getLogs` answer. */
	lie?: DiscoveryLog[]
}

/** A chain whose head is ten blocks above its last transaction; `getLogs` filters by emitter and by the
 *  indexed `args`, as a node does. */
function chain(o: ChainOptions): DiscoveryChainReads & { fillReads: unknown[] } {
	const head = o.txs.reduce((m, t) => (t.block > m ? t.block : m), o.finalized ?? 0n) + 10n
	let reads = 0
	let chainIdCalls = 0
	const hashOf = (n: bigint) => (o.blockHash ?? ((k: bigint) => pad(toHex(k))))(n, reads)
	const fillReads: unknown[] = []
	return {
		fillReads,
		chainEpoch: o.epoch,
		getChainId: async () => (o.chainIdOf ?? (() => o.chainId))(chainIdCalls++),
		getBlockNumber: async () => head,
		getBlock: async (args) => {
			reads++
			const n = "blockTag" in args ? (o.finalized ?? head - 2n) : args.blockNumber
			return { number: n, timestamp: o.timestamp?.(n) ?? 0n, hash: hashOf(n) }
		},
		getLogs: async ({ address, event, args, fromBlock, toBlock }) => {
			reads++
			const want = encodeEventTopics({ abi: [event], eventName: event.name, args } as never) as (Hex | null)[]
			const found = o.txs.flatMap((tx) =>
				tx.status === "reverted" || tx.block < fromBlock || tx.block > toBlock
					? []
					: tx.logs
							.filter((l) => eq(l.address, address) && want.every((t, i) => t === null || eq(t, l.topics[i])))
							.map((l) => ({ ...l, transactionHash: tx.hash, blockNumber: tx.block })),
			)
			return [...found, ...(o.lie ?? [])]
		},
		getTransactionReceipt: async ({ hash }) => {
			reads++
			const tx = o.txs.find((t) => eq(t.hash, hash))
			if (!tx) return null
			const status = tx.status ?? "success"
			const logs = status === "success" ? tx.logs : []
			return {
				status,
				from: tx.from ?? RAIL.inputs.user,
				transactionHash: tx.hash,
				blockNumber: tx.block,
				blockHash: hashOf(tx.block),
				logs,
			}
		},
		getTransaction: async ({ hash }) => {
			reads++
			const tx = o.txs.find((t) => eq(t.hash, hash))
			if (!tx) throw new Error(`no transaction ${hash}`)
			return { input: tx.input ?? "0x", to: tx.to ?? null }
		},
		readContract: async (args) => {
			fillReads.push(args)
			return o.fillStatus ?? 0n
		},
	}
}

const sourceTx = (r: Receipts): Tx => ({ hash: SRC_TX, block: SRC_BLOCK, logs: r.source.logs })
const baseTx = (): Tx => ({ hash: SRC_TX, block: BigInt(COMPOSE.base.block), logs: COMPOSE.sourceLogs, from: MAINNET.user })
const fillTx = (logs: RawLog[], over: Partial<Tx> = {}): Tx => ({ hash: FILL_TX, block: ETH_BLOCK, logs, ...over })

function reads(sourceTxs: Tx[], ethTxs: Tx[], eth: Partial<ChainOptions> = {}, source: Partial<ChainOptions> = {}) {
	return {
		source: chain({ chainId: RAIL.source.chainId, txs: sourceTxs, finalized: SRC_BLOCK, ...source }),
		ethereum: chain({ chainId: ETH, txs: ethTxs, finalized: ETH_BLOCK, ...eth }),
	}
}
const baseReads = (ethTxs: Tx[]) => reads([baseTx()], ethTxs, {}, { chainId: BASE_CHAIN, finalized: BigInt(COMPOSE.base.block) })

const discover = (rec: CrossChainDepositRecord, r: ReturnType<typeof reads>, ctx = ACROSS_CTX) => discoverCrossChain(rec, ctx, r)
const verdictOf = (d: CrossChainDiscovery) => (d.verdict === "incomplete" ? `incomplete: ${d.reason}` : d.verdict)

// ── synthetic logs spliced into the real receipts ────────────────────────────

const DEPOSITED = getAbiItem({ abi: DEPOSIT_ROUTER_ABI, name: "Deposited" }) as AbiEvent
const COMPLETED = parseAbiItem(
	"event LiFiTransferCompleted(bytes32 indexed transactionId, address receivingAssetId, address receiver, uint256 amount, uint256 timestamp)",
)
const RECOVERED = parseAbiItem(
	"event LiFiTransferRecovered(bytes32 indexed transactionId, address receivingAssetId, address receiver, uint256 amount, uint256 timestamp)",
)
const COMPOSE_DELIVERED = parseAbiItem("event ComposeDelivered(address from, address to, bytes32 guid, uint16 index)")
const FJ_DEPOSIT = parseAbiItem(
	"event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
)
const MESSAGE_SENT_CHECKPOINT = parseAbiItem(
	"event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)",
)

function log(address: Address, event: AbiEvent, args: Record<string, unknown>): RawLog {
	const topics = encodeEventTopics({ abi: [event], eventName: event.name, args } as never) as Hex[]
	const body = event.inputs.filter((i) => !i.indexed)
	return {
		address,
		topics,
		data: encodeAbiParameters(
			body,
			body.map((i) => args[i.name as string]),
		),
	}
}

/** The Inbox leaf of a message from `sender` to the L2 actor `l2`, hashed by stdlib's own `L1ToL2Message`. */
const leafOf = (sender: Address, l2: Hex, content: string, secretHash: Hex, index: bigint): Hex =>
	new L1ToL2Message(
		new L1Actor(EthAddress.fromString(sender), ETH),
		new L2Actor(AztecAddress.fromStringUnsafe(l2), Number(ACROSS_CTX.ethereum.inbox.rollupVersion)),
		Fr.fromHexString(content),
		Fr.fromHexString(secretHash),
		new Fr(index),
	)
		.hash()
		.toString() as Hex

const NO_DEPOSIT = {
	tokenSecretHash: pad("0x00"),
	fuelSecretHash: pad("0x00"),
	token: RAIL.destination.usdc,
	payer: ATTACKER,
	received: 0n,
	tokenAmount: 0n,
	tokenKey: pad("0x00"),
	tokenIndex: 0n,
	fuelIn: 0n,
	fuelOut: 0n,
	fuelKey: pad("0x00"),
	fuelIndex: 0n,
	isPrivate: false,
}

/** A router `Deposited` for the record's token secret hash, as anyone bridging their own funds emits it.
 *  Its key is the portal's leaf for a public mint to `to` (the record's recipient by default), or a private one. */
async function gift(
	tokenAmount: bigint,
	tokenIndex: bigint,
	o: { emitter?: Address; payer?: Address; to?: Hex; isPrivate?: boolean } = {},
): Promise<RawLog> {
	const { emitter = RAIL.router.router, payer = ATTACKER, to = PUBLIC.intent.aztecRecipient, isPrivate = false } = o
	const secretHash = PUBLIC.intent.tokenSecretHash
	const content = isPrivate ? await mintToPrivateContentHash(tokenAmount) : await mintToPublicContentHash(to, tokenAmount)
	const tokenKey = leafOf(RAIL.destination.portal, HUB, content, secretHash, tokenIndex)
	return log(emitter, DEPOSITED, {
		...NO_DEPOSIT,
		tokenSecretHash: secretHash,
		payer,
		received: tokenAmount,
		tokenAmount,
		tokenKey,
		tokenIndex,
		isPrivate,
	})
}

/** A gas-only `Deposited` for the record's fuel secret hash, whose Fee Juice is claimed for `to`. */
async function fuelGift(fuelOut: bigint, fuelIndex: bigint, to: Hex = PUBLIC.intent.aztecRecipient): Promise<RawLog> {
	const secretHash = PUBLIC.intent.fuelSecretHash
	const claim = toFunctionSelector("claim(bytes32,uint256)").slice(2)
	const content = await sha256ToField(bytesFromHex(claim + word(to) + word(toHex(fuelOut))))
	const fuelKey = leafOf(FEE_JUICE, pad(FEE_JUICE), content, secretHash, fuelIndex)
	return log(RAIL.router.router, DEPOSITED, {
		...NO_DEPOSIT,
		fuelSecretHash: secretHash,
		received: fuelOut,
		fuelIn: fuelOut,
		fuelOut,
		fuelKey,
		fuelIndex,
	})
}

const marker = (event: AbiEvent, emitter: Address, id: Hex) =>
	log(emitter, event, { transactionId: id, receivingAssetId: RAIL.destination.usdc, receiver: ATTACKER, amount: 1n, timestamp: 0n })

const withId = (logs: RawLog[], from: Hex, to: Hex): RawLog[] =>
	logs.map((l) => ({ ...l, topics: l.topics.map((t) => (eq(t, from) ? to : t)) }))

/** The same execution delivered by Stargate: the fill's callback logs, then EndpointV2's `ComposeDelivered`. */
function composed(r: Receipts, variant: Variant): RawLog[] {
	const delivered = log(ENDPOINT, COMPOSE_DELIVERED, { from: ETH_POOL, to: STARGATE_CTX.rail.receiver, guid: COMPOSE.guid, index: 0 })
	return [...withId(r.destination.logs.slice(1), variant.transactionId, stargateRecord().route.lifiTxId), delivered]
}

/** What discovery must return for a delivery: the router's own `Deposited` in the receipt. */
function depositedFacts(r: Receipts, depositTxHash: Hex) {
	const l = r.destination.logs.find((x) => eq(x.address, RAIL.router.router) && eq(x.topics[0], toEventSelector(DEPOSITED)))
	if (!l) throw new Error("the receipt has no router Deposited")
	const d = decodeEventLog({ abi: [DEPOSITED], data: l.data, topics: l.topics as [Hex, ...Hex[]] }).args as unknown as Record<
		string,
		bigint
	>
	const hex = (v: unknown) => v as Hex
	return {
		depositTxHash,
		received: d.received.toString(),
		token: { amount: d.tokenAmount.toString(), leafIndex: d.tokenIndex.toString(), messageHash: hex(d.tokenKey) },
		fuel: {
			consumed: d.fuelIn.toString(),
			received: d.fuelOut.toString(),
			leafIndex: d.fuelIndex.toString(),
			messageHash: hex(d.fuelKey),
		},
	}
}
const FACTS = depositedFacts(ROUTED, FILL_TX)
/** The routed relay filled into a recovery: the same transfer delivered to the wallet instead. */
const ROUTED_RECOVERY = [
	ROUTED.destination.logs[0],
	...withId(ROUTED_RECOVERED.destination.logs.slice(1), FLOOR_UNMET.transactionId, PUBLIC.transactionId),
]

describe("discoverCrossChain", () => {
	it("hashes a relay exactly as the deployed Sepolia SpokePool's getV3RelayHash does", () => {
		// The Phase 0 relay, with the value `getV3RelayHash` returned for it on the deployed SpokePool.
		const portal: Address = "0x0B56c297C320C3c6cDFc4f3A6122aA1B251c4319"
		const usdc: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
		const user: Address = "0xEa2fbc69542E51f55D666A8b1c5AE838a64dA6c3"
		const callData = encodeFunctionData({
			abi: TOKEN_PORTAL_ABI,
			functionName: "depositToAztecPublic",
			args: [pad("0xa11ce0"), 4_500_000n, pad("0x05ec7e")],
		})
		const step = {
			callTo: portal,
			approveTo: portal,
			sendingAssetId: usdc,
			receivingAssetId: usdc,
			fromAmount: 4_500_000n,
			callData,
			requiresDeposit: false,
		}
		const txId: Hex = "0xe189d18cd210430692d271caea9de89b750e09d12d3b3cab49ed2b47a5efd8df"
		const relay = {
			depositor: pad(user),
			recipient: pad("0x51Cd54Fab6Bc72c4c313C7d2DD4E0bE1A4390f44"),
			exclusiveRelayer: pad("0x00"),
			inputToken: pad("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
			outputToken: pad(usdc),
			inputAmount: 5_000_000n,
			outputAmount: 4_500_000n,
			originChainId: 84532n,
			depositId: 1003293n,
			fillDeadline: 1791241440,
			exclusivityDeadline: 0,
			message: encodeAbiParameters(LIFI_RECEIVER_MESSAGE_PARAMS, [txId, [step], user]),
		}
		expect(acrossRelayHash(relay, 11155111)).toBe("0x621d6bd57b6aadf07d94b5291ed2be9f7f5a0b29268cabcf435f5fdbb8c55c97")
	})

	it("reaches the right verdict on the committed Phase 0 and Phase 2 fork receipts (relay hash, marker side, Deposited)", async () => {
		const routed = await discover(record(), reads([sourceTx(ROUTED)], [fillTx(ROUTED.destination.logs)]))
		expect(routed).toEqual({
			verdict: "deposited",
			srcTxHash: SRC_TX,
			transport: {
				kind: "across",
				originChainId: RAIL.source.chainId,
				depositId: ROUTED.depositId,
				relayHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
			},
			extraDeposits: [],
			deposit: FACTS,
			decidedAt: { chainId: ETH, blockNumber: ETH_BLOCK },
			finalized: { chainId: ETH, blockNumber: ETH_BLOCK },
		})

		const recovered = await discover(
			record(FLOOR_UNMET),
			reads([sourceTx(ROUTED_RECOVERED)], [fillTx(ROUTED_RECOVERED.destination.logs)]),
		)
		expect(recovered).toMatchObject({ verdict: "delivered-to-wallet", observation: { txHash: FILL_TX, amount: DELIVERED } })

		const plainRecovered = await discover(plainRecord(), reads([sourceTx(PLAIN_RECOVERED)], [fillTx(PLAIN_RECOVERED.destination.logs)]))
		expect(plainRecovered).toMatchObject({ verdict: "delivered-to-wallet", observation: { amount: DELIVERED } })

		// Phase 0's Executor step bypassed the router: a completion without the router's `Deposited` is never a deposit.
		const plain = await discover(plainRecord(), reads([sourceTx(PLAIN)], [fillTx(PLAIN.destination.logs)]))
		expect(verdictOf(plain)).toBe("incomplete: a completed transfer without the router's Deposited")

		expect(await discover(stargateRecord(), baseReads([]), STARGATE_CTX)).toMatchObject({
			verdict: "pending",
			transport: { kind: "stargate", guid: COMPOSE.guid, pool: COMPOSE.base.pool },
		})
	})

	it("not-sent comes only from a reverted source transaction of the record's signer for its LI.FI id, final once that block is finalized; absence is pending", async () => {
		// EIP-5792 through an EIP-7702 account: an ERC-7821 batch (approve, then the Diamond call) sent to itself.
		const batch = parseAbi([
			"function execute(bytes32 mode, bytes executionData)",
			"function executeBatch((address target, uint256 value, bytes data)[] calls)",
		])
		const calls = (diamondCall: { target: Address; data: Hex }) => [
			{ target: RAIL.source.usdc, value: 0n, data: "0x095ea7b3" as Hex },
			{ ...diamondCall, value: 0n },
		]
		const erc7821 = (diamondCall: { target: Address; data: Hex }) =>
			encodeFunctionData({
				abi: batch,
				functionName: "execute",
				args: [
					pad("0x01", { dir: "right" }),
					encodeAbiParameters(parseAbiParameters("(address target, uint256 value, bytes data)[]"), [calls(diamondCall)]),
				],
			})
		const ours = { target: RAIL.source.diamond, data: PUBLIC.calldata }
		const input = erc7821(ours)
		const reverted: Tx = { hash: SRC_TX, block: SRC_BLOCK, logs: [], status: "reverted", input, to: RAIL.inputs.user }
		const final = await discover(record(), reads([reverted], []))
		expect(final).toMatchObject({
			verdict: "not-sent",
			observation: { decidedAt: { chainId: RAIL.source.chainId, blockNumber: SRC_BLOCK } },
		})
		expect(discoveryPatch(record(), final, 7)).toMatchObject({ completedAt: 7, route: { outcome: "not-sent" } })

		const early = await discover(record(), reads([reverted], [], {}, { finalized: SRC_BLOCK - 1n }))
		expect(discoveryPatch(record(), early, 7)).not.toHaveProperty("completedAt")

		expect((await discover(record(), reads([{ ...reverted, from: ATTACKER }], []))).verdict).toBe("pending")
		expect((await discover(record(), reads([], []))).verdict).toBe("pending")

		// A direct Diamond call is ours by its decoded `BridgeData.transactionId`, not by the id its Across message
		// also carries; the public id in a call to any other contract is not this transfer.
		const direct: Tx = { ...reverted, input: PUBLIC.calldata, to: RAIL.source.diamond }
		expect((await discover(record(), reads([direct], []))).verdict).toBe("not-sent")
		const abi = ACROSS_V4_FACET_ABI
		const [bridgeData, acrossData] = decodeFunctionData({ abi, data: PUBLIC.calldata }).args
		const otherId = encodeFunctionData({ abi, args: [{ ...bridgeData, transactionId: label("another transfer") }, acrossData] })
		expect((await discover(record(), reads([{ ...direct, input: otherId }], []))).verdict).toBe("pending")
		expect((await discover(record(), reads([{ ...direct, to: ATTACKER }], []))).verdict).toBe("pending")

		// A batch is ours only through a decoded Diamond call: the id handed to another contract, or an encoding
		// that does not decode, leaves the scan to decide.
		const executeBatch = encodeFunctionData({ abi: batch, functionName: "executeBatch", args: [calls(ours)] })
		expect((await discover(record(), reads([{ ...reverted, input: executeBatch }], []))).verdict).toBe("not-sent")
		const elsewhere = erc7821({ target: ATTACKER, data: PUBLIC.calldata })
		expect((await discover(record(), reads([{ ...reverted, input: elsewhere }], []))).verdict).toBe("pending")
		const opaque: Hex = `0x12345678${"00".repeat(36)}${PUBLIC.transactionId.slice(2)}`
		expect((await discover(record(), reads([{ ...reverted, input: opaque }], []))).verdict).toBe("pending")
		expect((await discover(record(), reads([{ ...reverted, to: ATTACKER }], []))).verdict).toBe("pending")

		// The recorded hash names another reverted transaction of the same sender: the transfer itself landed elsewhere.
		const unrelated: Tx = { ...reverted, input: `0x12345678${"00".repeat(68)}` }
		const landed: Tx = { hash: label("landed"), block: SRC_BLOCK, logs: ROUTED.source.logs }
		const d = await discover(record(), reads([unrelated, landed], [fillTx(ROUTED.destination.logs)]))
		expect(d).toMatchObject({ verdict: "deposited", srcTxHash: landed.hash })

		// The recorded attempt reverted and the same calldata was resent: the transfer that went through decides.
		const resent = await discover(record(), reads([reverted, landed], [fillTx(ROUTED.destination.logs)]))
		expect(resent).toMatchObject({ verdict: "deposited", srcTxHash: landed.hash })
	})

	it("a recorded hash viem finds no receipt for falls back to the scan; any other receipt failure is incomplete", async () => {
		const replacement: Tx = { hash: label("replacement"), block: SRC_BLOCK, logs: ROUTED.source.logs }
		const failing = (name: string) => {
			const r = reads([replacement], [fillTx(ROUTED.destination.logs)])
			const receipt = r.source.getTransactionReceipt
			r.source.getTransactionReceipt = async (args) => {
				if (eq(args.hash, SRC_TX)) throw Object.assign(new Error(`${name} for ${args.hash}`), { name })
				return receipt(args)
			}
			return r
		}
		const replaced = await discover(record(), failing("TransactionReceiptNotFoundError"))
		expect(replaced).toMatchObject({ verdict: "deposited", srcTxHash: replacement.hash })
		expect(verdictOf(await discover(record(), failing("HttpRequestError")))).toBe(`incomplete: HttpRequestError for ${SRC_TX}`)
	})

	it("a decoy before the real fill is an extra deposit, never the intended one", async () => {
		const decoy: Tx = { hash: label("decoy"), block: ETH_BLOCK - 5n, logs: [await gift(5_000_000n, 900n)] }
		const d = await discover(record(), reads([sourceTx(ROUTED)], [decoy, fillTx(ROUTED.destination.logs)]))
		expect(d).toMatchObject({
			verdict: "deposited",
			deposit: FACTS,
			extraDeposits: [{ txHash: decoy.hash, leafIndex: "900", amount: "5000000" }],
		})
	})

	it("ignores dust below the floor and keeps a deposit exactly at it", async () => {
		const dust: Tx = { hash: label("dust"), block: ETH_BLOCK - 5n, logs: [await gift(FLOOR - 1n, 900n)] }
		const atFloor: Tx = { hash: label("at-floor"), block: ETH_BLOCK - 4n, logs: [await gift(FLOOR, 901n)] }
		const d = await discover(record(), reads([sourceTx(ROUTED)], [dust, atFloor, fillTx(ROUTED.destination.logs)]))
		expect(d).toMatchObject({
			verdict: "deposited",
			extraDeposits: [{ txHash: atFloor.hash, leafIndex: "901", amount: FLOOR.toString() }],
		})
	})

	it("a deposit to the record's secret hash for another recipient or the other privacy mode is never an extra", async () => {
		const elsewhere = await gift(5_000_000n, 900n, { to: label("someone else") })
		const privately = await gift(5_000_000n, 901n, { isPrivate: true })
		const gifts: Tx = { hash: label("unclaimable"), block: ETH_BLOCK - 5n, logs: [elsewhere, privately] }
		const d = await discover(record(), reads([sourceTx(ROUTED)], [gifts, fillTx(ROUTED.destination.logs)]))
		expect(d).toMatchObject({ verdict: "deposited", deposit: FACTS, extraDeposits: [] })
	})

	it("a gas-only record's extras are the Fee Juice deposits claimed for its own recipient", async () => {
		const gas = { ...record(), intent: "gas", token: undefined } as CrossChainDepositRecord
		const floor = BigInt(PUBLIC.intent.minFuelOutput)
		const ours: Tx = { hash: label("fuel gift"), block: ETH_BLOCK - 5n, logs: [await fuelGift(floor, 900n)] }
		const theirs: Tx = {
			hash: label("fuel elsewhere"),
			block: ETH_BLOCK - 4n,
			logs: [await fuelGift(floor, 901n, label("someone else"))],
		}
		const d = await discover(gas, reads([sourceTx(ROUTED)], [ours, theirs]))
		expect(d).toMatchObject({ verdict: "pending", extraDeposits: [{ txHash: ours.hash, leafIndex: "900", amount: floor.toString() }] })
	})

	it("ignores look-alike events from any emitter but the pinned ones", async () => {
		const logs = [...ROUTED.destination.logs]
		const at = (event: AbiEvent, emitter: Address) =>
			logs.findIndex((l) => eq(l.address, emitter) && eq(l.topics[0], toEventSelector(event)))
		// Spliced back to front so each index still names the real log: before the real marker, a foreign
		// `Deposited` with other amounts; before the real FeeJuicePortal event, a foreign one with its key;
		// right after the fill, a foreign recovery marker.
		const foreign = await gift(9_000_000n, 999n, { emitter: ATTACKER, payer: RAIL.destination.executor })
		logs.splice(at(COMPLETED, RAIL.destination.executor), 0, foreign)
		const fjLookAlike = { to: pad("0xa11ce0"), amount: 1n, secretHash: pad("0x00"), key: FACTS.fuel.messageHash, index: 1n }
		logs.splice(at(FJ_DEPOSIT, RAIL.router.feeJuicePortal), 0, log(ATTACKER, FJ_DEPOSIT, fjLookAlike))
		logs.splice(1, 0, marker(RECOVERED, ATTACKER, PUBLIC.transactionId))
		const lie: DiscoveryLog = {
			...(await gift(9_000_000n, 998n, { emitter: ATTACKER })),
			transactionHash: label("lie"),
			blockNumber: ETH_BLOCK,
		}
		const d = await discover(record(), reads([sourceTx(ROUTED)], [fillTx(logs)], { lie: [lie] }))
		expect(d).toMatchObject({ verdict: "deposited", deposit: FACTS, extraDeposits: [] })
	})

	it("never reads a delivery as a deposit of a record whose secret hash it did not deposit to", async () => {
		const tampered = { ...record(), secretHashHex: label("tampered") } as CrossChainDepositRecord
		const d = await discover(tampered, reads([sourceTx(ROUTED)], [fillTx(ROUTED.destination.logs)]))
		expect(verdictOf(d)).toBe("incomplete: the router's Deposited is not this record's intent")
	})

	it("a recovered fill is delivered to the wallet: provisional until its Ethereum block is finalized, then final", async () => {
		const tx = fillTx(ROUTED_RECOVERED.destination.logs, { block: ETH_BLOCK + 3n })
		const early = await discover(record(FLOOR_UNMET), reads([sourceTx(ROUTED_RECOVERED)], [tx]))
		const provisional = { ...record(FLOOR_UNMET), ...discoveryPatch(record(FLOOR_UNMET), early, 7) } as CrossChainDepositRecord
		expect(provisional.route).toMatchObject({ outcome: "delivered-to-wallet", outcomeTxHash: FILL_TX, outcomeAmount: DELIVERED })
		expect(outcomeFinality(provisional)).toBe("provisional")

		const late = await discover(provisional, reads([sourceTx(ROUTED_RECOVERED)], [tx], { finalized: ETH_BLOCK + 3n }))
		expect(outcomeFinality({ ...provisional, ...discoveryPatch(provisional, late, 9) } as CrossChainDepositRecord)).toBe("final")
	})

	it("expires on source only when unfilled and past the deadline at the same finalized block", async () => {
		const deadline = BigInt(RAIL.inputs.fillDeadline)
		const past = reads([sourceTx(ROUTED)], [], { timestamp: () => deadline + 1n })
		const d = await discover(record(), past)
		const at = { chainId: ETH, blockNumber: ETH_BLOCK }
		expect(d).toMatchObject({ verdict: "expired-on-source", observation: { decidedAt: at, finalized: at } })
		const relayHash = d.verdict === "expired-on-source" && d.transport?.kind === "across" ? d.transport.relayHash : undefined
		expect(past.ethereum.fillReads).toEqual([expect.objectContaining({ args: [relayHash], blockNumber: ETH_BLOCK })])
		expect(discoveryPatch(record(), d, 7)).toMatchObject({ completedAt: 7 })

		expect((await discover(record(), reads([sourceTx(ROUTED)], [], { timestamp: () => deadline }))).verdict).toBe("pending")
		const filled = reads([sourceTx(ROUTED)], [], { timestamp: () => deadline + 1n, fillStatus: 2n })
		expect(verdictOf(await discover(record(), filled))).toBe("incomplete: filled by the finalized block, yet no fill was found")
	})

	it("a chain switch, a reorg during the scan or a node behind the record is incomplete, never a verdict", async () => {
		const txs = () => [fillTx(ROUTED.destination.logs)]
		let epoch = 0
		const flapping = reads([sourceTx(ROUTED)], txs(), { epoch: () => epoch })
		const getLogs = flapping.ethereum.getLogs
		flapping.ethereum.getLogs = async (args) => {
			epoch++
			return getLogs(args)
		}
		expect(verdictOf(await discover(record(), flapping))).toBe("incomplete: chain changed")

		const switched = reads([sourceTx(ROUTED)], txs(), { chainIdOf: (call) => (call === 0 ? ETH : 1) })
		expect(verdictOf(await discover(record(), switched))).toBe("incomplete: chain")

		const head = ETH_BLOCK + 10n
		const tipMoved = (n: bigint, readNo: number) => (n === head && readNo > 1 ? label("other tip") : pad(toHex(n)))
		expect(verdictOf(await discover(record(), reads([sourceTx(ROUTED)], txs(), { blockHash: tipMoved })))).toBe("incomplete: reorg")

		// A head below the height the record was planned at: a stale node, not an empty window.
		const stale = reads([sourceTx(ROUTED)], [], { finalized: ETH_BLOCK - 40n })
		expect(verdictOf(await discover(record(), stale))).toBe("incomplete: the chain's head is below the record's scan start")
	})

	it("a reorg after discovery returned is re-derived: the provisional outcome is replaced by the deposit", async () => {
		// The same relay recovered on a fork the chain later left, then deposited on the canonical one.
		const forked = await discover(record(), reads([sourceTx(ROUTED)], [fillTx(ROUTED_RECOVERY, { block: ETH_BLOCK + 2n })]))
		const provisional = { ...record(), ...discoveryPatch(record(), forked, 7) } as CrossChainDepositRecord
		expect(provisional.route.outcome).toBe("delivered-to-wallet")

		const canonical = await discover(
			provisional,
			reads([sourceTx(ROUTED)], [fillTx(ROUTED.destination.logs, { hash: label("refill") })]),
		)
		const settled = { ...provisional, ...discoveryPatch(provisional, canonical, 9) } as CrossChainDepositRecord
		expect(outcomeFinality(settled)).toBe("none")
		expect(settled.route.outcomeTxHash).toBeUndefined()
		expect(settled).toMatchObject({
			amount: FACTS.token.amount,
			leafIndex: FACTS.token.leafIndex,
			messageHash: FACTS.token.messageHash,
			depositTxHash: label("refill"),
			fuel: { received: FACTS.fuel.received, leafIndex: FACTS.fuel.leafIndex, messageHash: FACTS.fuel.messageHash },
		})
	})

	it("a deposit the canonical chain no longer carries leaves no claim facts behind, unless it or the record is final", async () => {
		const above = fillTx(ROUTED.destination.logs, { block: ETH_BLOCK + 2n })
		const deposited = await discover(record(), reads([sourceTx(ROUTED)], [above]))
		const claimable = { ...record(), ...discoveryPatch(record(), deposited, 7) } as CrossChainDepositRecord
		expect(deriveCrossChainDepositStage(claimable)).toBe("syncing")
		expect(claimable.route.depositFinal, "its block is above the finalized head").toBeUndefined()
		const rerun = async (ethTxs: Tx[], rec = claimable) =>
			({ ...rec, ...discoveryPatch(rec, await discover(rec, reads([sourceTx(ROUTED)], ethTxs)), 9) }) as CrossChainDepositRecord
		const gone = {
			leafIndex: undefined,
			messageHash: undefined,
			depositTxHash: undefined,
			fuel: { received: undefined, leafIndex: undefined, messageHash: undefined },
		}

		const reorgedOut = await rerun([])
		expect(reorgedOut).toMatchObject(gone)
		expect(deriveCrossChainDepositStage(reorgedOut)).toBe("bridging")

		const recovered = await rerun([fillTx(ROUTED_RECOVERY, { hash: label("recovery") })])
		expect(recovered).toMatchObject({ ...gone, route: { outcome: "delivered-to-wallet" } })

		const final = await rerun([fillTx(ROUTED.destination.logs)])
		expect(final.route.depositFinal).toBe(true)
		const kept = { leafIndex: FACTS.token.leafIndex, depositTxHash: FILL_TX, fuel: { leafIndex: FACTS.fuel.leafIndex } }
		expect(await rerun([], final)).toMatchObject({ ...kept, route: { depositFinal: true } })
		expect(await rerun([], { ...claimable, completedAt: 8 })).toMatchObject(kept)
	})

	it("finds a lost source hash through the Transfer scan, skipping the sender's other LI.FI transfers", async () => {
		const other: Tx = { hash: label("other send"), block: SRC_BLOCK - 3n, logs: PLAIN.source.logs }
		const ours: Tx = { hash: label("lost"), block: SRC_BLOCK, logs: ROUTED.source.logs }
		const lost = record(PUBLIC, { srcTxHash: undefined })
		const d = await discover(lost, reads([other, ours], [fillTx(ROUTED.destination.logs)]))
		expect(d).toMatchObject({ verdict: "deposited", srcTxHash: ours.hash })
		expect(discoveryPatch(lost, d, 7)).toMatchObject({ route: { srcTxHash: ours.hash } })
	})

	it("a forged Across fill reusing our (originChainId, depositId) is not our delivery, and its deposit is only an extra", async () => {
		const [fill, ...callback] = ROUTED.destination.logs
		// Same origin chain and deposit id, another depositor: another relay hash, filled with no deposit behind it.
		const forgedFill = {
			...fill,
			data: fill.data.toLowerCase().replace(RAIL.inputs.user.slice(2).toLowerCase(), ATTACKER.slice(2)) as Hex,
		}
		const forged = fillTx([forgedFill, ...callback, await gift(4_000_000n, 950n, { payer: RAIL.destination.executor })])
		const d = await discover(record(), reads([sourceTx(ROUTED)], [forged]))
		expect(d).toMatchObject({
			verdict: "pending",
			extraDeposits: [{ txHash: FILL_TX, leafIndex: FACTS.token.leafIndex, amount: FACTS.token.amount }, { leafIndex: "950" }],
		})
	})

	it.each([
		["Across", "succeeds"],
		["Across", "recovers"],
		["Stargate", "succeeds"],
		["Stargate", "recovers"],
	] as const)(
		"%s: a gift and forged markers bundled before and after a real delivery that %s change nothing but the extras",
		async (rail, outcome) => {
			const [r, variant] = outcome === "succeeds" ? [ROUTED, PUBLIC] : [ROUTED_RECOVERED, FLOOR_UNMET]
			const stargate = rail === "Stargate"
			const ctx = stargate ? STARGATE_CTX : ACROSS_CTX
			const rec = stargate ? stargateRecord() : record(variant)
			const id = rec.route.lifiTxId
			const forgeries = [marker(COMPLETED, RAIL.destination.executor, id), marker(RECOVERED, ctx.rail.receiver, id)]
			const real = stargate ? composed(r, variant) : r.destination.logs
			const logs = [await gift(5_000_000n, 900n), ...forgeries, ...real, ...forgeries, await gift(5_000_000n, 901n)]
			const d = await discover(rec, stargate ? baseReads([fillTx(logs)]) : reads([sourceTx(r)], [fillTx(logs)]), ctx)
			const extraDeposits = [
				{ txHash: FILL_TX, leafIndex: "900", amount: "5000000" },
				{ txHash: FILL_TX, leafIndex: "901", amount: "5000000" },
			]
			if (outcome === "succeeds") expect(d).toMatchObject({ verdict: "deposited", deposit: FACTS, extraDeposits })
			else expect(d).toMatchObject({ verdict: "delivered-to-wallet", observation: { amount: DELIVERED }, extraDeposits })
		},
	)

	it("Stargate: Executor-paid dust deposits and replays of our LI.FI id, each in its own transaction, never crowd out the delivery", async () => {
		const rec = stargateRecord()
		const replayed = marker(RECOVERED, STARGATE_CTX.rail.receiver, rec.route.lifiTxId)
		const noise = await Promise.all(
			Array.from(
				{ length: 9 },
				async (_, i): Promise<Tx> => ({
					hash: pad(toHex(0xdead00 + i)),
					block: ETH_BLOCK,
					logs: [await gift(1n, 700n + BigInt(i), { payer: STARGATE_CTX.ethereum.executor }), replayed],
				}),
			),
		)
		const d = await discover(rec, baseReads([...noise, fillTx(composed(ROUTED, PUBLIC))]), STARGATE_CTX)
		expect(d).toMatchObject({ verdict: "deposited", deposit: FACTS })
	})

	it("matches the Inbox's deployed MessageSent shape per network", async () => {
		const artifactShape = ROUTED.destination.logs.find((l) => eq(l.address, INBOX))?.topics[0]
		// The older line indexes the checkpoint and the hash; the leaf index moves into the data.
		const checkpointed = ROUTED.destination.logs.map((l) =>
			eq(l.address, INBOX) && eq(l.topics[0], artifactShape)
				? log(INBOX, MESSAGE_SENT_CHECKPOINT, {
						checkpointNumber: 1n,
						index: BigInt(`0x${l.data.slice(2 + 64 * 8, 2 + 64 * 9)}`),
						hash: l.topics[1],
						rollingHash: "0x00000000000000000000000000000000",
					})
				: l,
		)
		const inbox = { ...ACROSS_CTX.ethereum.inbox, shape: "checkpoint" as const }
		const checkpointCtx = { ...ACROSS_CTX, ethereum: { ...ACROSS_CTX.ethereum, inbox } }
		const r = () => reads([sourceTx(ROUTED)], [fillTx(checkpointed)])
		expect(await discover(record(), r(), checkpointCtx)).toMatchObject({ verdict: "deposited", deposit: FACTS })
		expect(verdictOf(await discover(record(), r()))).toBe("incomplete: the Inbox inserted no token leaf")
	})
})

describe("readRouterDeposit", () => {
	const intent = PUBLIC.intent
	const expected = {
		l1ChainId: ETH,
		isPrivate: false,
		recipient: intent.aztecRecipient as Hex,
		token: { erc20: RAIL.destination.usdc as Address, secretHash: intent.tokenSecretHash as Hex },
		fuel: { secretHash: intent.fuelSecretHash as Hex },
	}
	const logs = ROUTED.destination.logs
	const eth = ACROSS_CTX.ethereum

	it("authenticates a transaction's own router deposit exactly as discovery does, and nothing else", async () => {
		expect(await readRouterDeposit(logs, FILL_TX, eth, expected)).toEqual(FACTS)
		const other = { ...expected, token: { ...expected.token, secretHash: label("other") } }
		await expect(readRouterDeposit(logs, FILL_TX, eth, other)).rejects.toThrow("carries 0 router Deposited events")
		const twice = [...logs, ...logs.filter((l) => eq(l.address, eth.router))]
		await expect(readRouterDeposit(twice, FILL_TX, eth, expected)).rejects.toThrow("carries 2 router Deposited events")
		const otherRollup = { ...eth, inbox: { ...eth.inbox, rollupVersion: 1n } }
		await expect(readRouterDeposit(logs, FILL_TX, otherRollup, expected)).rejects.toThrow("leaf does not recompute")
	})
})
