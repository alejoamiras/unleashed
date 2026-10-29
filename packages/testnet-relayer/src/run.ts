/**
 * One relayer run: find the app's deposits for our filler in the fill window, drop what is filled, late or
 * unaffordable, and fill at most one, the largest first. Stateless: the chain is the only record, so a redeploy, a
 * crash or a skipped minute loses nothing a later run cannot redo while the deposit is fillable.
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
import { errorLine, type RelayLog } from "./log"
import type { RelayerRoute } from "./route"
import { classify } from "./select"

/** Source blocks a run scans: Base Sepolia's 2 s blocks over the 7,200 s fill window and 600 s more. */
export const SCAN_BLOCKS = 4_000n
/** Destination blocks searched for fills: the fill window and margin at Sepolia's 12 s. */
export const FILL_LOG_BLOCKS = 800n
/** The widest `getLogs` range Base's own endpoint serves. */
const CHUNK_BLOCKS = 500n
/** Source blocks left unread at the head, which a load-balanced RPC's backends may not all have. */
const SOURCE_LAG = 2n
/** An ignored deposit is logged by the runs that see it this close to the head, not by every run for two hours. */
const IGNORED_LOG_BLOCKS = 30n
const DEADLINE_MARGIN_S = 120n
/** Candidates one run may try: write-free refusals pass to the next, so fewer poisoned deposits cannot hold the queue. */
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

export type RunOutcome = "refused" | "idle" | "busy" | "gas-price" | "filled" | "already-filled" | "skipped" | "failed"

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
			public: createPublicClient({ chain: destinationChain, transport }),
			wallet: createWalletClient({ account, chain: destinationChain, transport }) as FillWallet,
		},
	}
}

/** Both endpoints on their end of the route and the signer is the filler, before any other read or any signature. */
async function assertRoute(c: RelayConfig): Promise<void> {
	const [s, d] = await Promise.all([c.source.getChainId(), c.destination.public.getChainId()])
	if (s !== c.route.source.chainId) throw new RunRefused(`the source endpoint answers chain ${s}, not ${c.route.source.chainId}`)
	if (d !== c.route.destination.chainId) {
		throw new RunRefused(`the destination endpoint answers chain ${d}, not ${c.route.destination.chainId}`)
	}
	const signer = c.destination.wallet.account.address
	if (!isAddressEqual(signer, c.route.filler)) throw new RunRefused(`the key signs as ${signer}, not the filler ${c.route.filler}`)
}

/** The filler's output-token balance; either balance is logged when too low for one more full send. */
async function readFloat(c: RelayConfig): Promise<bigint> {
	const { public: client } = c.destination
	const filler = c.route.filler
	const [gas, token] = await Promise.all([
		client.getBalance({ address: filler }),
		client.readContract({ address: c.route.destination.token, abi: erc20Abi, functionName: "balanceOf", args: [filler] }),
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

/** The source pool's deposits bound for the destination over the window, one per log so each keeps its transaction. */
async function sourceDeposits(c: RelayConfig): Promise<{ head: bigint; found: Omit<Candidate, "relayHash">[] }> {
	const { source, route } = c
	const head = (await source.getBlockNumber({ cacheTime: 0 })) - SOURCE_LAG
	const from = head > SCAN_BLOCKS ? head - SCAN_BLOCKS : 0n
	const found: Omit<Candidate, "relayHash">[] = []
	for (const [fromBlock, toBlock] of chunks(from, head)) {
		const logs = await retried(() =>
			source.getLogs({
				address: route.source.spokePool,
				event: FUNDS_DEPOSITED,
				args: { destinationChainId: BigInt(route.destination.chainId) },
				fromBlock,
				toBlock,
			}),
		)
		for (const log of logs) {
			const [deposit] = depositsIn([log], route.source.spokePool, BigInt(route.source.chainId))
			if (deposit && log.transactionHash && log.blockNumber !== null && log.logIndex !== null) {
				found.push({ deposit, txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex })
			}
		}
	}
	return { head, found }
}

/** Admitted deposits; a transaction holding two is ignored whole, since the fill path names a deposit by its transaction. */
async function admitted(c: RelayConfig): Promise<Candidate[]> {
	const { head, found } = await sourceDeposits(c)
	const perTx = new Map<string, number>()
	for (const f of found) perTx.set(f.txHash, (perTx.get(f.txHash) ?? 0) + 1)
	const out: Candidate[] = []
	for (const f of found) {
		const reason = (perTx.get(f.txHash) ?? 0) > 1 ? "ambiguous" : classify(f.deposit, c.route)
		if (reason === null) out.push({ ...f, relayHash: relayHashOf(f.deposit) })
		else if (f.blockNumber + IGNORED_LOG_BLOCKS >= head) c.log({ event: "ignored", reason, srcTx: f.txHash })
	}
	return out
}

/** Fills the destination pool logged from our origin, by deposit id, over the fill window. */
async function recentFills(c: RelayConfig, destinationHead: bigint) {
	const { public: client } = c.destination
	const from = destinationHead > FILL_LOG_BLOCKS ? destinationHead - FILL_LOG_BLOCKS : 0n
	const byId = new Map<bigint, Parameters<typeof fillsRelay>[0][]>()
	for (const [fromBlock, toBlock] of chunks(from, destinationHead)) {
		const logs = await retried(() =>
			client.getLogs({
				address: c.route.destination.spokePool,
				event: FILLED_RELAY,
				args: { originChainId: BigInt(c.route.source.chainId) },
				fromBlock,
				toBlock,
				strict: true,
			}),
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
async function fillable(c: RelayConfig, candidates: Candidate[], float: bigint): Promise<Candidate[]> {
	const head = await c.destination.public.getBlock({ blockTag: "latest" })
	const fills = await recentFills(c, head.number)
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
async function pause(c: RelayConfig): Promise<"busy" | "gas-price" | null> {
	const { public: client } = c.destination
	const address = c.route.filler
	const [pending, latest] = await Promise.all([
		client.getTransactionCount({ address, blockTag: "pending" }),
		client.getTransactionCount({ address, blockTag: "latest" }),
	])
	if (pending > latest) return "busy"
	const { maxFeePerGas } = await client.estimateFeesPerGas()
	return TX_GAS_CAP * maxFeePerGas > FEE_CEILING_WEI ? "gas-price" : null
}

/** Tries candidates in order until one reaches a write or a result; write-free refusals pass to the next. */
async function fillOne(c: RelayConfig, candidates: Candidate[]): Promise<RunSummary> {
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

/** One run, never throwing: every error is a log line, and the next minute is the retry. */
export async function relayOnce(c: RelayConfig): Promise<RunSummary> {
	try {
		await assertRoute(c)
		const float = await readFloat(c)
		const candidates = await fillable(c, await admitted(c), float)
		if (candidates.length === 0) return { outcome: "idle" }
		const paused = await pause(c)
		if (paused) {
			c.log({ event: paused })
			return { outcome: paused }
		}
		return await fillOne(c, candidates)
	} catch (e) {
		c.log({ event: e instanceof RunRefused ? "refused" : "failed", reason: errorLine(e) })
		return { outcome: e instanceof RunRefused ? "refused" : "failed" }
	}
}
