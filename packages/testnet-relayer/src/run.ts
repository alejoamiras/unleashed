/**
 * One relayer pass: find the app's deposits for our filler in the fill window, drop what is filled, late or
 * unaffordable, and fill at most one, the largest first. Stateless: the chain is the only record, so a redeploy, a
 * crash or a skipped pass loses nothing a later pass cannot redo while the deposit is fillable.
 */
import {
	boundedGasTerms,
	type Destination,
	depositsIn,
	FILLED_RELAY,
	FillRefused,
	type FillWallet,
	FUNDS_DEPOSITED,
	fillSourceDeposit,
	fillsRelay,
	relayHashOf,
	retried,
	type SourceDeposit,
	selfBuiltTerms,
	TX_GAS_CAP,
} from "@unleashed/bridge-core/across-fill"
import {
	type Chain,
	createPublicClient,
	createWalletClient,
	defineChain,
	erc20Abi,
	type Hex,
	http,
	isAddressEqual,
	type PublicClient,
} from "viem"
import type { PrivateKeyAccount } from "viem/accounts"
import { PastDeadline, type Read, withinDeadline } from "./deadline"
import { errorLine, type RelayLog } from "./log"
import type { RelayerRoute } from "./route"
import { classify } from "./select"
import { SCAN_WINDOW_S, scanWindow } from "./window"

/** Destination blocks searched for fills: Sepolia's 12 s slots make 800 blocks span at least 9,600 s, past `SCAN_WINDOW_S`. */
export const FILL_LOG_BLOCKS = 800n
/** `getLogs` range per call, which PublicNode serves on both chains (50,000 on Base Sepolia); Base's own endpoint serves 200. */
export const CHUNK_BLOCKS = 2_000n
/** Source blocks left unread at the head, which a load-balanced RPC's backends may not all have. */
const SOURCE_LAG = 2n
const DEADLINE_MARGIN_S = 120n
/** The longest a pass's reads may take: a slow provider fails the pass, never the next cron's run. */
export const SURVEY_DEADLINE_MS = 45_000
/**
 * A try starts only this long before the run's end: two Sepolia slots and a second of receipt polling each, a
 * heuristic for a send at normal pace, which nothing here can cut short.
 */
export const FILL_BUDGET_MS = 25_000
/** Candidates one pass may try: write-free refusals pass to the next, so fewer poisoned deposits cannot hold the queue. */
export const MAX_TRIES = 8
/** The worst fee one send may cost, checked at the gas cap before any write and on every send. */
export const FEE_CEILING_WEI = 5_000_000_000_000_000n
const LOW_GAS_WEI = 10_000_000_000_000_000n

export interface RelayConfig {
	source: PublicClient
	destination: Destination
	route: RelayerRoute
	log: RelayLog
}

export type RunOutcome = "refused" | "idle" | "busy" | "gas-price" | "late" | "filled" | "already-filled" | "skipped" | "failed"

export interface PassBounds {
	/** When the pass's reads must be done and no later try may start (ms since the epoch): before the next cron fires. */
	runEnd: number
}

export interface RunSummary {
	outcome: RunOutcome
	fillTx?: Hex | null
}

/** A deposit the run may fill, with what it needs to name it again. */
interface Candidate {
	deposit: SourceDeposit
	txHash: Hex
	blockNumber: bigint
	logIndex: number
	relayHash: Hex
}

class RunRefused extends Error {}
const chainOf = (id: number, rpcUrl: string): Chain =>
	defineChain({
		id,
		name: `chain-${id}`,
		nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
		rpcUrls: { default: { http: [rpcUrl] } },
	})

/** The route's clients over HTTP, signing on the destination as `account`. */
export function connectRelay(
	account: PrivateKeyAccount,
	route: RelayerRoute,
	endpoints: { sourceRpcUrl: string; destinationRpcUrl: string },
): Pick<RelayConfig, "source" | "destination"> {
	const destinationChain = chainOf(route.destination.chainId, endpoints.destinationRpcUrl)
	const transport = http(endpoints.destinationRpcUrl)
	return {
		source: createPublicClient({
			chain: chainOf(route.source.chainId, endpoints.sourceRpcUrl),
			transport: http(endpoints.sourceRpcUrl),
		}),
		destination: {
			// Receipt waits poll at 1 s, so a send lasts about its inclusion time, as `FILL_BUDGET_MS` assumes.
			public: createPublicClient({ chain: destinationChain, transport, pollingInterval: 1_000 }),
			wallet: createWalletClient({ account, chain: destinationChain, transport }) as FillWallet,
		},
	}
}

/** Both endpoints on their end of the route and the signer is the filler, before any other read or any signature. */
async function assertRoute(c: RelayConfig, read: Read): Promise<void> {
	const [s, d] = await Promise.all([read(() => c.source.getChainId()), read(() => c.destination.public.getChainId())])
	if (s !== c.route.source.chainId) throw new RunRefused(`the source endpoint answers chain ${s}, not ${c.route.source.chainId}`)
	if (d !== c.route.destination.chainId) {
		throw new RunRefused(`the destination endpoint answers chain ${d}, not ${c.route.destination.chainId}`)
	}
	const signer = c.destination.wallet.account.address
	if (!isAddressEqual(signer, c.route.filler)) throw new RunRefused(`the key signs as ${signer}, not the filler ${c.route.filler}`)
}

/** The filler's output-token balance; either balance is logged when too low for one more full send. */
async function readFloat(c: RelayConfig, read: Read): Promise<bigint> {
	const { public: client } = c.destination
	const filler = c.route.filler
	const [gas, token] = await Promise.all([
		read(() => client.getBalance({ address: filler })),
		read(() => client.readContract({ address: c.route.destination.token, abi: erc20Abi, functionName: "balanceOf", args: [filler] })),
	])
	if (gas < LOW_GAS_WEI) c.log({ event: "low-gas", balance: gas })
	const fullSend = selfBuiltTerms(c.route.destination.chainId, c.route.maxInput, 0, filler).outputAmount
	if (token < fullSend) c.log({ event: "low-inventory", balance: token })
	return token
}

function chunks(from: bigint, to: bigint): [bigint, bigint][] {
	const out: [bigint, bigint][] = []
	for (let start = from; start <= to; start += CHUNK_BLOCKS)
		out.push([start, start + CHUNK_BLOCKS - 1n < to ? start + CHUNK_BLOCKS - 1n : to])
	return out
}

/** The source pool's deposits bound for the destination since `since`, one per log so each keeps its transaction. */
async function sourceDeposits(c: RelayConfig, since: bigint, read: Read) {
	const { source, route } = c
	const latest = await read(() => source.getBlockNumber({ cacheTime: 0 }))
	const head = latest > SOURCE_LAG ? latest - SOURCE_LAG : 0n
	const stamp = async (blockNumber: bigint) => (await retried(() => read(() => source.getBlock({ blockNumber })))).timestamp
	const window = await scanWindow(stamp, head, since)
	const found: Omit<Candidate, "relayHash">[] = []
	for (const [fromBlock, toBlock] of chunks(window.from, head)) {
		const logs = await retried(() =>
			read(() =>
				source.getLogs({
					address: route.source.spokePool,
					event: FUNDS_DEPOSITED,
					args: { destinationChainId: BigInt(route.destination.chainId) },
					fromBlock,
					toBlock,
				}),
			),
		)
		for (const log of logs) {
			const [deposit] = depositsIn([log], route.source.spokePool, BigInt(route.source.chainId))
			if (deposit && log.transactionHash && log.blockNumber !== null && log.logIndex !== null) {
				found.push({ deposit, txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex })
			}
		}
	}
	return { recentFrom: window.recentFrom, found }
}

/** Admitted deposits; a transaction holding two is ignored whole, since the fill path names a deposit by its transaction. */
async function admitted(c: RelayConfig, since: bigint, read: Read): Promise<Candidate[]> {
	const { recentFrom, found } = await sourceDeposits(c, since, read)
	const perTx = new Map<string, number>()
	for (const f of found) perTx.set(f.txHash, (perTx.get(f.txHash) ?? 0) + 1)
	const out: Candidate[] = []
	for (const f of found) {
		const reason = (perTx.get(f.txHash) ?? 0) > 1 ? "ambiguous" : classify(f.deposit, c.route)
		if (reason === null) out.push({ ...f, relayHash: relayHashOf(f.deposit) })
		else if (f.blockNumber >= recentFrom) c.log({ event: "ignored", reason, srcTx: f.txHash })
	}
	return out
}

/** Fills the destination pool logged from our origin, by deposit id, over the fill window. */
async function recentFills(c: RelayConfig, destinationHead: bigint, read: Read) {
	const { public: client } = c.destination
	const from = destinationHead > FILL_LOG_BLOCKS ? destinationHead - FILL_LOG_BLOCKS : 0n
	const byId = new Map<bigint, Parameters<typeof fillsRelay>[0][]>()
	for (const [fromBlock, toBlock] of chunks(from, destinationHead)) {
		const logs = await retried(() =>
			read(() =>
				client.getLogs({
					address: c.route.destination.spokePool,
					event: FILLED_RELAY,
					args: { originChainId: BigInt(c.route.source.chainId) },
					fromBlock,
					toBlock,
					strict: true,
				}),
			),
		)
		// Anyone can log fills under one deposit id, so a bucket can be long: append, never copy.
		for (const { args } of logs) {
			const bucket = byId.get(args.depositId)
			if (bucket) bucket.push(args)
			else byId.set(args.depositId, [args])
		}
	}
	return byId
}

/** Why a run passes over an unfilled candidate before trying it, if it does. */
function skipReason(k: Candidate, headTimestamp: bigint, float: bigint): "deadline" | "balance" | null {
	if (BigInt(k.deposit.relay.fillDeadline) < headTimestamp + DEADLINE_MARGIN_S) return "deadline"
	return k.deposit.relay.outputAmount > float ? "balance" : null
}

/** The largest output first, then the earliest deposit. */
function before(a: Candidate, b: Candidate): number {
	const [x, y] = [a.deposit.relay.outputAmount, b.deposit.relay.outputAmount]
	if (x !== y) return x > y ? -1 : 1
	if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1
	return a.logIndex - b.logIndex
}

/** Candidates still worth a try, in order: unfilled by full identity, not late, affordable. */
async function fillable(
	c: RelayConfig,
	candidates: Candidate[],
	float: bigint,
	head: { number: bigint; timestamp: bigint },
	read: Read,
): Promise<Candidate[]> {
	const fills = await recentFills(c, head.number, read)
	const destinationId = c.route.destination.chainId
	const isFilled = (k: Candidate) =>
		(fills.get(k.deposit.relay.depositId) ?? []).some((f) => fillsRelay(f, k.deposit.relay.message, k.relayHash, destinationId))
	const open: Candidate[] = []
	for (const k of candidates.filter((k) => !isFilled(k))) {
		const reason = skipReason(k, head.timestamp, float)
		if (reason === null) open.push(k)
		else
			c.log({
				event: "skipped",
				reason,
				relayHash: k.relayHash,
				srcTx: k.txHash,
				output: k.deposit.relay.outputAmount,
				balance: float,
			})
	}
	return open.sort(before)
}

/** `busy` while the filler has a transaction out, `gas-price` while a fill at the gas cap would pass the ceiling. */
async function pause(c: RelayConfig, read: Read): Promise<"busy" | "gas-price" | null> {
	const { public: client } = c.destination
	const address = c.route.filler
	const [pending, latest] = await Promise.all([
		read(() => client.getTransactionCount({ address, blockTag: "pending" })),
		read(() => client.getTransactionCount({ address, blockTag: "latest" })),
	])
	if (pending > latest) return "busy"
	const { maxFeePerGas } = await read(() => client.estimateFeesPerGas())
	return TX_GAS_CAP * maxFeePerGas > FEE_CEILING_WEI ? "gas-price" : null
}

/** Why a try may not start: past the send cutoff, or per {@link pause}, whose reads are raced to that cutoff. */
async function holdBeforeTry(c: RelayConfig, bounds: PassBounds): Promise<"late" | "busy" | "gas-price" | null> {
	const left = bounds.runEnd - FILL_BUDGET_MS - Date.now()
	if (left <= 0) return "late"
	try {
		return await withinDeadline(left, (read) => pause(c, read))
	} catch (e) {
		if (e instanceof PastDeadline) return "late"
		throw e
	}
}

/** Tries candidates in order until one reaches a write or a result; write-free refusals pass to the next. */
async function fillOne(c: RelayConfig, candidates: Candidate[], bounds: PassBounds): Promise<RunSummary> {
	const charge = (worst: bigint) => {
		if (worst > FEE_CEILING_WEI) throw new Error(`a send's worst fee ${worst} wei passes the ${FEE_CEILING_WEI} wei ceiling`)
	}
	const deps = {
		source: c.source,
		destination: c.destination,
		sourceSpokePool: c.route.source.spokePool,
		destinationSpokePool: c.route.destination.spokePool,
		gasTerms: boundedGasTerms(c.destination.public, charge),
	}
	let outcome: RunSummary = { outcome: "idle" }
	for (const k of candidates.slice(0, MAX_TRIES)) {
		const held = await holdBeforeTry(c, bounds)
		if (held) {
			c.log({ event: held })
			return { outcome: held }
		}
		const line = { relayHash: k.relayHash, srcTx: k.txHash, input: k.deposit.relay.inputAmount, output: k.deposit.relay.outputAmount }
		try {
			const r = await fillSourceDeposit(deps, k.txHash, { relayHash: k.relayHash })
			const event = r.alreadyFilled ? "already-filled" : "filled"
			c.log({ event, fillTx: r.fillTxHash, ...line })
			return { outcome: event, fillTx: r.fillTxHash }
		} catch (e) {
			if (!(e instanceof FillRefused) || e.reason === "fill-reverted") {
				c.log({ event: "failed", reason: errorLine(e), ...line })
				return { outcome: "failed" }
			}
			c.log({ event: "skipped", reason: e.reason, ...line })
			outcome = { outcome: "skipped" }
		}
	}
	return outcome
}

async function survey(c: RelayConfig, read: Read): Promise<Candidate[]> {
	await assertRoute(c, read)
	const float = await readFloat(c, read)
	// One destination head serves the window and the deadline skip: both are Sepolia-clock facts.
	const head = await read(() => c.destination.public.getBlock({ blockTag: "latest" }))
	return fillable(c, await admitted(c, head.timestamp - SCAN_WINDOW_S, read), float, head, read)
}

/**
 * One pass, never throwing: every error is a log line, and the next pass is the retry. Its reads end by
 * `bounds.runEnd` or fail the pass before any send. No try starts within `FILL_BUDGET_MS` of it, and a started try is
 * awaited past it.
 */
export async function relayPass(c: RelayConfig, bounds: PassBounds = { runEnd: Number.POSITIVE_INFINITY }): Promise<RunSummary> {
	try {
		const candidates = await withinDeadline(Math.min(SURVEY_DEADLINE_MS, bounds.runEnd - Date.now()), (read) => survey(c, read))
		if (candidates.length === 0) return { outcome: "idle" }
		return await fillOne(c, candidates, bounds)
	} catch (e) {
		c.log({ event: e instanceof RunRefused ? "refused" : "failed", reason: errorLine(e) })
		return { outcome: e instanceof RunRefused ? "refused" : "failed" }
	}
}

/** One pass with no run around it: the manual run and the tests. */
export const relayOnce = (c: RelayConfig): Promise<RunSummary> => relayPass(c)
