/**
 * The Across relay leg: a source `FundsDeposited` turned into the destination `fillRelay` call (`fill-testnet.ts`
 * sends the same call to the live pools), the sandbox's relay loop over its two anvils, and a loopback
 * `/suggested-fees` that answers in the Across API's shape. Nothing here holds a key: callers hand in a connected
 * wallet client.
 */
import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import {
	type Account,
	type Address,
	type Chain,
	decodeEventLog,
	erc20Abi,
	getAbiItem,
	getAddress,
	type Hex,
	isAddressEqual,
	pad,
	type PublicClient,
	slice,
	type Transport,
	type WalletClient,
} from "viem"
import z from "zod"
import { type AcrossRelayData, acrossRelayHash } from "../../src/crosschain-discovery"

/** `V3SpokePoolInterface.V3RelayData`, field for field. */
const RELAY_DATA = {
	name: "relayData",
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

/** The deployed SpokePool surface a filler uses: Across's own shapes, which `TestSpokePool` reproduces. */
export const SPOKE_POOL_ABI = [
	{
		type: "event",
		name: "FundsDeposited",
		anonymous: false,
		inputs: [
			{ name: "inputToken", type: "bytes32", indexed: false },
			{ name: "outputToken", type: "bytes32", indexed: false },
			{ name: "inputAmount", type: "uint256", indexed: false },
			{ name: "outputAmount", type: "uint256", indexed: false },
			{ name: "destinationChainId", type: "uint256", indexed: true },
			{ name: "depositId", type: "uint256", indexed: true },
			{ name: "quoteTimestamp", type: "uint32", indexed: false },
			{ name: "fillDeadline", type: "uint32", indexed: false },
			{ name: "exclusivityDeadline", type: "uint32", indexed: false },
			{ name: "depositor", type: "bytes32", indexed: true },
			{ name: "recipient", type: "bytes32", indexed: false },
			{ name: "exclusiveRelayer", type: "bytes32", indexed: false },
			{ name: "message", type: "bytes", indexed: false },
		],
	},
	{
		type: "function",
		name: "fillRelay",
		stateMutability: "nonpayable",
		inputs: [RELAY_DATA, { name: "repaymentChainId", type: "uint256" }, { name: "repaymentAddress", type: "bytes32" }],
		outputs: [],
	},
	{
		type: "function",
		name: "getV3RelayHash",
		stateMutability: "view",
		inputs: [RELAY_DATA],
		outputs: [{ name: "", type: "bytes32" }],
	},
	{
		type: "function",
		name: "fillStatuses",
		stateMutability: "view",
		inputs: [{ name: "", type: "bytes32" }],
		outputs: [{ name: "", type: "uint256" }],
	},
] as const

const FUNDS_DEPOSITED = getAbiItem({ abi: SPOKE_POOL_ABI, name: "FundsDeposited" })

/** `SpokePool.FillStatus`. */
export const FILL_STATUS = { unfilled: 0n, requestedSlowFill: 1n, filled: 2n } as const

/** A deposit as its filler must reproduce it on the destination chain. */
export interface SourceDeposit {
	relay: AcrossRelayData
	destinationChainId: bigint
	quoteTimestamp: number
}

export interface RawLog {
	address: Address
	topics: readonly Hex[]
	data: Hex
}

/** The address a relay word names; dirty upper bytes are no address at all. */
export function wordAddress(word: Hex): Address {
	if (BigInt(word) >> 160n !== 0n) throw new Error(`relay word ${word} is not an address`)
	return getAddress(slice(word, 12))
}

/**
 * Every `FundsDeposited` that `spokePool` itself logged in `logs`, read from the chain `originChainId`: a look-alike
 * from any other emitter, or a log that does not decode strictly, is skipped.
 */
export function depositsIn(logs: readonly RawLog[], spokePool: Address, originChainId: bigint): SourceDeposit[] {
	return logs.flatMap((log) => {
		if (!isAddressEqual(log.address, spokePool)) return []
		let a: ReturnType<typeof decodeDeposit>
		try {
			a = decodeDeposit(log)
		} catch {
			return []
		}
		const relay: AcrossRelayData = {
			depositor: a.depositor,
			recipient: a.recipient,
			exclusiveRelayer: a.exclusiveRelayer,
			inputToken: a.inputToken,
			outputToken: a.outputToken,
			inputAmount: a.inputAmount,
			outputAmount: a.outputAmount,
			originChainId,
			depositId: a.depositId,
			fillDeadline: a.fillDeadline,
			exclusivityDeadline: a.exclusivityDeadline,
			message: a.message,
		}
		return [{ relay, destinationChainId: a.destinationChainId, quoteTimestamp: a.quoteTimestamp }]
	})
}

function decodeDeposit(log: RawLog) {
	return decodeEventLog({ abi: [FUNDS_DEPOSITED], data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }).args
}

/** The relay hash the destination pool `getV3RelayHash` returns on `destinationChainId`. */
export const relayHashOf = (d: SourceDeposit): Hex => acrossRelayHash(d.relay, Number(d.destinationChainId))

export type FillWallet = WalletClient<Transport, Chain, Account>

export interface Destination {
	public: PublicClient
	wallet: FillWallet
}

export interface FillCall {
	/** Where Across would repay the relayer; the fork suites and the canary name the origin chain. */
	repaymentChainId: bigint
	/** Explicit gas, which skips the pre-send simulation: a fill that cannot run its message lands as a revert. */
	gas?: bigint
}

interface Approval {
	token: Address
	spender: Address
	amount: bigint
}

const submitApproval = (dest: Destination, a: Approval): Promise<Hex> =>
	dest.wallet.writeContract({
		address: a.token,
		abi: erc20Abi,
		functionName: "approve",
		args: [a.spender, a.amount],
		account: dest.wallet.account,
		chain: dest.wallet.chain,
	})

async function confirmApproval(dest: Destination, a: Approval, hash: Hex): Promise<void> {
	const receipt = await dest.public.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`approve(${a.spender}, ${a.amount}) on ${a.token} reverted`)
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const firstLine = (e: unknown) => errorText(e).split("\n")[0]

/** An approval a failed fill could not clear: the pool still holds it. `cause` is the fill's own failure. */
export class AllowanceStillLive extends Error {
	constructor(spender: Address, token: Address, clearing: unknown, fill: unknown) {
		super(
			`the fill failed (${firstLine(fill)}) and clearing its approval failed (${firstLine(clearing)}): ${spender} still holds a live allowance over ${token}`,
			{ cause: fill },
		)
		this.name = "AllowanceStillLive"
	}
}

/** Clears the approval of a fill that did not land. @throws AllowanceStillLive when the clear fails too. */
async function clearApproval(dest: Destination, a: Approval, fill: unknown): Promise<void> {
	const revoke = { ...a, amount: 0n }
	try {
		await confirmApproval(dest, revoke, await submitApproval(dest, revoke))
	} catch (e) {
		throw new AllowanceStillLive(a.spender, a.token, e, fill)
	}
}

async function fillOnce(dest: Destination, spokePool: Address, relay: AcrossRelayData, call: FillCall) {
	const account = dest.wallet.account
	// viem's inference collapses this tuple argument to `never`; `AcrossRelayData` is `RELAY_DATA` field for field.
	const args = [relay as never, call.repaymentChainId, pad(account.address, { size: 32 })] as const
	if (call.gas === undefined) {
		await dest.public.simulateContract({ account, address: spokePool, abi: SPOKE_POOL_ABI, functionName: "fillRelay", args })
	}
	const hash = await dest.wallet.writeContract({
		address: spokePool,
		abi: SPOKE_POOL_ABI,
		functionName: "fillRelay",
		args,
		account,
		chain: dest.wallet.chain,
		...(call.gas === undefined ? {} : { gas: call.gas }),
	})
	const { status } = await dest.public.waitForTransactionReceipt({ hash })
	return { hash, status }
}

/**
 * Approves `spokePool` for exactly `relay.outputAmount` of its output token and sends `fillRelay` from the wallet's
 * account, which is also the logged relayer. Without explicit gas the fill is simulated first, so a fill that would
 * revert throws before anything is sent. Once the approval is submitted, any failure short of a landed fill, its own
 * confirmation included, clears the approval again.
 *
 * @throws the approval's submit error with nothing sent; otherwise the first failure once the approval is cleared,
 * or {@link AllowanceStillLive} when the clear fails too.
 */
export async function sendFill(
	dest: Destination,
	spokePool: Address,
	relay: AcrossRelayData,
	call: FillCall,
): Promise<{ hash: Hex; status: "success" | "reverted" }> {
	const approval: Approval = { token: wordAddress(relay.outputToken), spender: spokePool, amount: relay.outputAmount }
	const approved = await submitApproval(dest, approval)
	let sent: Awaited<ReturnType<typeof fillOnce>>
	try {
		await confirmApproval(dest, approval, approved)
		sent = await fillOnce(dest, spokePool, relay, call)
	} catch (e) {
		await clearApproval(dest, approval, e)
		throw e
	}
	if (sent.status !== "success") await clearApproval(dest, approval, new Error(`the fill ${sent.hash} reverted`))
	return sent
}

// ─── The sandbox relay loop ──────────────────────────────────────────────────

/** How the loop treats each deposit it sees, fixed at the moment it sees it. */
export type RelayMode = { kind: "now" } | { kind: "delay"; ms: number } | { kind: "never" } | { kind: "starve-gas" }

/** A `starve-gas` fill's gas: the pool's own bookkeeping fits, LI.FI's receiver → Executor → router path does not, and
 *  the receiver keeps no recovery gas, so the whole fill reverts and the deposit stays unfilled. */
export const STARVED_FILL_GAS = 250_000n

export type RelayOutcome =
	| { state: "pending" }
	| { state: "skipped" }
	| { state: "filled"; fillTxHash: Hex }
	| { state: "reverted"; fillTxHash: Hex }
	| { state: "failed"; error: string }

export interface RelayerOptions {
	source: PublicClient
	destination: Destination
	sourceSpokePool: Address
	destinationSpokePool: Address
	mode?: RelayMode
	pollMs?: number
	/** Gives the filler `amount` of `token` before each fill; the sandbox mints. */
	fund?: (token: Address, amount: bigint) => Promise<void>
}

export interface Relayer {
	mode(): RelayMode
	setMode(mode: RelayMode): void
	/** What became of the deposit with this relay hash; `undefined` until the loop has seen it. */
	outcome(relayHash: Hex): RelayOutcome | undefined
	/** Resolves once the deposit is filled, reverted or skipped; rejects on a fill that failed to send, or after `timeoutMs`. */
	waitFor(relayHash: Hex, timeoutMs?: number): Promise<RelayOutcome>
	/** Stops polling, cancels delayed fills and waits for a fill in flight. */
	stop(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class RelayLoop implements Relayer {
	private current: RelayMode
	private readonly outcomes = new Map<Hex, RelayOutcome>()
	private readonly timers = new Set<ReturnType<typeof setTimeout>>()
	private queue: Promise<void> = Promise.resolve()
	private stopped = false
	private running: Promise<void> = Promise.resolve()

	constructor(
		private readonly o: RelayerOptions,
		private readonly chains: { origin: bigint; destination: bigint },
		private cursor: bigint,
	) {
		this.current = o.mode ?? { kind: "now" }
	}

	start(): void {
		this.running = (async () => {
			while (!this.stopped) {
				// A failed poll is retried from the same cursor: nothing is skipped on a transient RPC error.
				await this.tick().catch((e) => console.warn(`[relayer] poll failed: ${errorText(e)}`))
				await sleep(this.o.pollMs ?? 500)
			}
		})()
	}

	mode = () => this.current
	setMode = (mode: RelayMode) => {
		this.current = mode
	}
	outcome = (relayHash: Hex) => this.outcomes.get(relayHash.toLowerCase() as Hex)

	async waitFor(relayHash: Hex, timeoutMs = 120_000): Promise<RelayOutcome> {
		const until = Date.now() + timeoutMs
		for (;;) {
			const o = this.outcome(relayHash)
			if (o?.state === "failed") throw new Error(`the relay ${relayHash} failed: ${o.error}`)
			if (o && o.state !== "pending") return o
			if (Date.now() > until) throw new Error(`the relayer saw no outcome for ${relayHash} within ${timeoutMs} ms`)
			await sleep(250)
		}
	}

	async stop(): Promise<void> {
		this.stopped = true
		for (const t of this.timers) clearTimeout(t)
		this.timers.clear()
		await this.running
		await this.queue
	}

	private async tick(): Promise<void> {
		const head = await this.o.source.getBlockNumber()
		if (head < this.cursor) return
		const logs = await this.o.source.getLogs({
			address: this.o.sourceSpokePool,
			event: FUNDS_DEPOSITED,
			args: { destinationChainId: this.chains.destination },
			fromBlock: this.cursor,
			toBlock: head,
		})
		this.cursor = head + 1n
		for (const d of depositsIn(logs, this.o.sourceSpokePool, this.chains.origin)) this.schedule(d)
	}

	private schedule(d: SourceDeposit): void {
		const key = relayHashOf(d).toLowerCase() as Hex
		if (this.outcomes.has(key)) return
		const mode = this.current
		if (mode.kind === "never") {
			this.outcomes.set(key, { state: "skipped" })
			return
		}
		this.outcomes.set(key, { state: "pending" })
		const enqueue = () => {
			this.queue = this.queue.then(() => this.fill(d, key, mode))
		}
		if (mode.kind !== "delay") {
			enqueue()
			return
		}
		const timer = setTimeout(() => {
			this.timers.delete(timer)
			enqueue()
		}, mode.ms)
		this.timers.add(timer)
	}

	private async fill(d: SourceDeposit, key: Hex, mode: RelayMode): Promise<void> {
		try {
			await this.o.fund?.(wordAddress(d.relay.outputToken), d.relay.outputAmount)
			const gas = mode.kind === "starve-gas" ? STARVED_FILL_GAS : undefined
			const r = await sendFill(this.o.destination, this.o.destinationSpokePool, d.relay, {
				repaymentChainId: this.chains.origin,
				gas,
			})
			this.outcomes.set(key, { state: r.status === "success" ? "filled" : "reverted", fillTxHash: r.hash })
		} catch (e) {
			this.outcomes.set(key, { state: "failed", error: errorText(e) })
		}
	}
}

/**
 * Watches `sourceSpokePool` from the source's current head and fills every deposit bound for the destination chain
 * on `destinationSpokePool`, one at a time from one key, each as the mode in force when the loop first saw it.
 */
export async function startRelayer(o: RelayerOptions): Promise<Relayer> {
	const [origin, destination, head] = await Promise.all([
		o.source.getChainId(),
		o.destination.public.getChainId(),
		o.source.getBlockNumber(),
	])
	const loop = new RelayLoop(o, { origin: BigInt(origin), destination: BigInt(destination) }, head)
	loop.start()
	return loop
}

// ─── Loopback Across API ─────────────────────────────────────────────────────

export interface RelayApiOptions {
	source: PublicClient
	destination: PublicClient
	sourceSpokePool: Address
	destinationSpokePool: Address
	/** The relay fee, in basis points of the input. */
	feeBps?: bigint
	limits?: { minDeposit: bigint; maxDeposit: bigint }
	/** How far past the destination's head the quoted `fillDeadline` falls; Across's testnet API quotes about 2 h. */
	fillWindowS?: number
	/** Enables `POST /relayer/mode`, so a browser fixture can steer the loop it shares a sandbox with. */
	relayer?: Relayer
}

export interface RelayApi {
	url: string
	close(): Promise<void>
}

const uint = z.string().regex(/^\d+$/)
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const feesQuery = z.object({
	inputToken: evmAddress,
	outputToken: evmAddress,
	originChainId: uint,
	destinationChainId: uint,
	amount: uint,
})
const modeBody = z.union([
	z.object({ kind: z.enum(["now", "never", "starve-gas"]) }).strict(),
	z.object({ kind: z.literal("delay"), ms: z.number().int().nonnegative() }).strict(),
])

class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message)
	}
}

const PCT_SCALE = 10n ** 18n

async function tokenInfo(client: PublicClient, address: Address, chainId: number) {
	const [symbol, decimals] = await Promise.all([
		client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
		client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
	])
	return { address: getAddress(address), symbol, decimals, chainId }
}

function feeQuote(q: z.infer<typeof feesQuery>, o: RelayApiOptions, chains: { origin: number; destination: number }) {
	if (Number(q.originChainId) !== chains.origin || Number(q.destinationChainId) !== chains.destination) {
		throw new ApiError(400, "ROUTE_NOT_ENABLED", `no route ${q.originChainId} → ${q.destinationChainId}`)
	}
	const amount = BigInt(q.amount)
	const limits = o.limits ?? { minDeposit: 1n, maxDeposit: 10n ** 30n }
	if (amount < limits.minDeposit) throw new ApiError(400, "AMOUNT_TOO_LOW", "Sent amount is too low relative to fees")
	if (amount > limits.maxDeposit) throw new ApiError(400, "AMOUNT_TOO_HIGH", "Amount is higher than available liquidity.")
	const fee = (amount * (o.feeBps ?? 50n)) / 10_000n
	return { amount, fee, limits }
}

/** The fields Across's `/suggested-fees` answers with, the fee booked as relayer gas and nothing as LP or capital. */
async function suggestedFees(q: z.infer<typeof feesQuery>, o: RelayApiOptions, chains: { origin: number; destination: number }) {
	const { amount, fee, limits } = feeQuote(q, o, chains)
	const [src, dst, inputToken, outputToken] = await Promise.all([
		o.source.getBlock(),
		o.destination.getBlock(),
		tokenInfo(o.source, q.inputToken as Address, chains.origin),
		tokenInfo(o.destination, q.outputToken as Address, chains.destination),
	])
	const part = (total: bigint) => ({ pct: ((total * PCT_SCALE) / amount).toString(), total: total.toString() })
	const zero = part(0n)
	return {
		estimatedFillTimeSec: 2,
		capitalFeePct: zero.pct,
		capitalFeeTotal: zero.total,
		relayGasFeePct: part(fee).pct,
		relayGasFeeTotal: part(fee).total,
		relayFeePct: part(fee).pct,
		relayFeeTotal: part(fee).total,
		lpFeePct: "0",
		timestamp: src.timestamp.toString(),
		isAmountTooLow: false,
		quoteBlock: src.number.toString(),
		exclusiveRelayer: "0x0000000000000000000000000000000000000000",
		exclusivityDeadline: 0,
		spokePoolAddress: getAddress(o.sourceSpokePool),
		destinationSpokePoolAddress: getAddress(o.destinationSpokePool),
		totalRelayFee: part(fee),
		relayerCapitalFee: zero,
		relayerGasFee: part(fee),
		lpFee: zero,
		internalizedSwapFee: zero,
		limits: {
			minDeposit: limits.minDeposit.toString(),
			maxDeposit: limits.maxDeposit.toString(),
			maxDepositInstant: limits.maxDeposit.toString(),
			maxDepositShortDelay: limits.maxDeposit.toString(),
			recommendedDepositInstant: limits.maxDeposit.toString(),
		},
		fillDeadline: (dst.timestamp + BigInt(o.fillWindowS ?? 7_200)).toString(),
		outputAmount: (amount - fee).toString(),
		inputToken,
		outputToken,
		id: randomUUID(),
	}
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	let raw = ""
	for await (const chunk of req) {
		raw += chunk
		if (raw.length > 4_096) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "the body is too large")
	}
	try {
		return JSON.parse(raw)
	} catch {
		throw new ApiError(400, "INVALID_PARAM", "the body is not JSON")
	}
}

function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
	const r = schema.safeParse(value)
	if (!r.success) throw new ApiError(400, "INVALID_PARAM", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
	return r.data
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	res.writeHead(status, body === undefined ? {} : { "content-type": "application/json", "access-control-allow-origin": "*" })
	res.end(body === undefined ? undefined : JSON.stringify(body))
}

/**
 * Serves `GET /suggested-fees` (the Across API's response shape for one route, priced from `feeBps` and timed from
 * the two chains' heads) and, with a relayer, `POST /relayer/mode`. Bound to 127.0.0.1 on an ephemeral port; errors
 * answer in Across's error shape.
 */
export async function serveRelayApi(o: RelayApiOptions): Promise<RelayApi> {
	const [origin, destination] = await Promise.all([o.source.getChainId(), o.destination.getChainId()])
	const chains = { origin, destination }
	const route = async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (req.method === "GET" && url.pathname === "/suggested-fees") {
			return send(res, 200, await suggestedFees(parseOr400(feesQuery, Object.fromEntries(url.searchParams)), o, chains))
		}
		if (req.method === "POST" && url.pathname === "/relayer/mode" && o.relayer) {
			o.relayer.setMode(parseOr400(modeBody, await readBody(req)))
			return send(res, 204)
		}
		throw new ApiError(404, "NOT_FOUND", `${req.method} ${url.pathname}`)
	}
	const server = createServer((req, res) => {
		route(req, res).catch((e) => {
			const err = e instanceof ApiError ? e : new ApiError(500, "INTERNAL", errorText(e))
			send(res, err.status, { type: "AcrossApiError", code: err.code, status: err.status, message: err.message, id: randomUUID() })
		})
	})
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => resolve())
	})
	const { port } = server.address() as AddressInfo
	return {
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}
