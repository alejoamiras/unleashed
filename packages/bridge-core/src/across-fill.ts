/**
 * Fills an Across v4 relay on its destination pool: the deposit as the source pool logged it, an approval of exactly
 * the output, a fill sent with checked gas, and {@link fillSourceDeposit}, which refuses anything it cannot fill as
 * logged before any write. Viem only, so the testnet relayer Worker and the operator scripts load the same code.
 * Nothing here holds a key: callers hand in a connected wallet client.
 */
import {
	type Account,
	type Address,
	type Chain,
	decodeEventLog,
	encodeFunctionData,
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
import { type AcrossRelayData, acrossRelayHash, FILLED_RELAY_TOPIC, RELAY_DATA } from "./across-relay"
import { type GasTermsFor, withGasTerms } from "./gas-terms"
import { retried } from "./retried"

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

export const FUNDS_DEPOSITED = getAbiItem({ abi: SPOKE_POOL_ABI, name: "FundsDeposited" })

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
	/** Explicit gas, which skips {@link fillGas} and its simulation: a fill that cannot run its message lands as a
	 *  revert, or as a recovery under Amsterdam's schedule. */
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

/** The approval's block. */
async function confirmApproval(dest: Destination, a: Approval, hash: Hex): Promise<bigint> {
	const receipt = await dest.public.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`approve(${a.spender}, ${a.amount}) on ${a.token} reverted`)
	return receipt.blockNumber
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const firstLine = (e: unknown) => errorText(e).split("\n")[0]

/** An approval a failed send could not clear: the spender still holds it. `cause` is the send's own failure. */
export class AllowanceStillLive extends Error {
	constructor(spender: Address, token: Address, clearing: unknown, failed: unknown, what = "fill") {
		super(
			`the ${what} failed (${firstLine(failed)}) and clearing its approval failed (${firstLine(clearing)}): ${spender} still holds a live allowance over ${token}`,
			{ cause: failed },
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

/** EIP-7825's per-transaction gas cap: no fill can be given more. */
export const TX_GAS_CAP = 16_777_216n

interface SimulatedCall {
	to: Address
	data: Hex
	gas?: bigint
}

/**
 * The fill's simulated outcome on the state of `blockNumber` (the head when omitted), after `before` in the same
 * block: whether the pool logged `FilledRelay`, and a key of its status and every log's emitter, topics and data.
 * Each probe names one block, which a load-balanced RPC's lagging backend refuses until it catches up.
 */
async function simulateFill(
	dest: Destination,
	spokePool: Address,
	fill: SimulatedCall,
	blockNumber?: bigint,
	before: SimulatedCall[] = [],
) {
	const account = dest.wallet.account
	const calls = [...before, fill].map((c) => ({ account, ...c }))
	const [block] = await retried(() => dest.public.simulateBlocks({ blockNumber, blocks: [{ calls }] }))
	const result = block.calls[before.length]
	if (!result) return { reason: ": the node returned no result for the fill", fills: false, key: "" }
	const { status, logs = [], ...call } = result
	return {
		reason: "error" in call && call.error ? `: ${firstLine(call.error)}` : "",
		fills: status === "success" && logs.some((l) => isAddressEqual(l.address, spokePool) && l.topics[0] === FILLED_RELAY_TOPIC),
		key: `${status}:${logs.map((l) => `${l.address.toLowerCase()}/${l.topics.join("/")}/${l.data}`).join(",")}`,
	}
}

const fillRelayArgs = (relay: AcrossRelayData, repaymentChainId: bigint, relayer: Address) =>
	// viem's inference collapses this tuple argument to `never`; `AcrossRelayData` is `RELAY_DATA` field for field.
	[relay as never, repaymentChainId, pad(relayer, { size: 32 })] as const

const fillRelayData = (args: ReturnType<typeof fillRelayArgs>): Hex =>
	encodeFunctionData({ abi: SPOKE_POOL_ABI, functionName: "fillRelay", args })

/**
 * The gas a fill is sent with. A node's estimate is not enough: under Amsterdam's schedule LI.FI's receiver catches an
 * underfunded message and recovers the delivery to the user, so the estimate settles on that recovery. On the state of
 * one block, never before `notBefore` (the approval the fill spends), the fill gets the smallest of 2×, 4×, … the
 * estimate whose simulated outcome (status, then every log's emitter, topics and data) equals the one at the cap,
 * where nothing is underfunded. It is a simulation check: the block the fill lands in can still differ.
 *
 * @throws when the fill does not log the pool's `FilledRelay` in simulation even at the cap, a node's omitted logs
 *   included.
 */
export async function fillGas(dest: Destination, spokePool: Address, data: Hex, notBefore: bigint): Promise<bigint> {
	const account = dest.wallet.account
	// viem serves the head from a cache as old as its polling interval, which can predate the approval.
	const head = await dest.public.getBlockNumber({ cacheTime: 0 })
	const blockNumber = head > notBefore ? head : notBefore
	const outcome = (gas: bigint) => simulateFill(dest, spokePool, { to: spokePool, data, gas }, blockNumber)
	const atCap = await outcome(TX_GAS_CAP)
	if (!atCap.fills)
		throw new Error(`fillRelay on ${spokePool} logs no FilledRelay in simulation even at the ${TX_GAS_CAP} gas cap${atCap.reason}`)
	const estimate = await retried(() => dest.public.estimateGas({ account, to: spokePool, data, blockNumber }))
	for (let gas = estimate * 2n; gas < TX_GAS_CAP; gas *= 2n) if ((await outcome(gas)).key === atCap.key) return gas
	return TX_GAS_CAP
}

async function fillOnce(dest: Destination, spokePool: Address, relay: AcrossRelayData, call: FillCall, approvedAt: bigint) {
	const account = dest.wallet.account
	const args = fillRelayArgs(relay, call.repaymentChainId, account.address)
	// fillGas's cap simulation is the pre-send check; a `latest` simulation here could run before the approval.
	const gas = call.gas ?? (await fillGas(dest, spokePool, fillRelayData(args), approvedAt))
	const hash = await dest.wallet.writeContract({
		address: spokePool,
		abi: SPOKE_POOL_ABI,
		functionName: "fillRelay",
		args,
		account,
		chain: dest.wallet.chain,
		gas,
	})
	const { status } = await dest.public.waitForTransactionReceipt({ hash })
	return { hash, status }
}

/**
 * Approves `spokePool` for exactly `relay.outputAmount` of its output token and sends `fillRelay` from the wallet's
 * account, which is also the logged relayer. Without explicit gas the fill is sent with {@link fillGas}, whose
 * simulation on a block no earlier than the approval refuses a fill that would not fill, before any fill transaction.
 * Once the approval is submitted, any failure short of a landed fill, its own confirmation included, clears the
 * approval again.
 *
 * @throws the approval's submit error as is; otherwise the first failure once the approval is cleared, or
 * {@link AllowanceStillLive} when the clear fails too.
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
		sent = await fillOnce(dest, spokePool, relay, call, await confirmApproval(dest, approval, approved))
	} catch (e) {
		await clearApproval(dest, approval, e)
		throw e
	}
	if (sent.status !== "success") await clearApproval(dest, approval, new Error(`the fill ${sent.hash} reverted`))
	return sent
}

/** The one route this filler serves. */
export const FILL_ROUTE = { source: 84532, destination: 11155111 } as const
export const BASE_SEPOLIA_RPC_DEFAULT = "https://base-sepolia-rpc.publicnode.com"
export const SEPOLIA_RPC_DEFAULT = "https://ethereum-sepolia-rpc.publicnode.com"

/** Head-room the fill deadline must still leave on the destination, so the fill cannot land past it. */
const DEFAULT_DEADLINE_MARGIN_S = 120

export interface FillDeps {
	/** Reads the origin chain. */
	source: PublicClient
	/** Reads and signs on the destination; the wallet's account pays the output and is the logged relayer. */
	destination: Destination
	/** The pinned pools: a `FundsDeposited` from any other emitter is no deposit at all. */
	sourceSpokePool: Address
	destinationSpokePool: Address
	/** Seconds the fill deadline must stay ahead of the destination's head; 120 by default. */
	deadlineMarginS?: number
	/** Explicit gas terms for the approve and the fill, refused before sending when they do not fit; without them the
	 *  wallet prices both itself. */
	gasTerms?: GasTermsFor
}

export interface FillResult {
	/** `null` when this call confirmed no fill of its own: the relay was filled by another relayer, or by ours whose
	 *  receipt wait failed. An approval and its revoke may still have been sent. */
	fillTxHash: Hex | null
	relayHash: Hex
	alreadyFilled: boolean
}

export interface FillOptions {
	/** The relay hash the caller vetted from its own read of the deposit: a receipt whose deposit hashes otherwise is
	 *  refused before any write, so what is filled is what was vetted. */
	relayHash?: Hex
}

export type FillRefusalReason =
	| "not-a-hash"
	| "no-receipt"
	| "reverted"
	| "no-deposit"
	| "ambiguous"
	| "relay-hash"
	| "deadline"
	| "exclusive"
	| "balance"
	| "unfillable"
	| "fill-reverted"

/** A fill this module would not, or could not, send; `reason` names the check. */
export class FillRefused extends Error {
	constructor(
		readonly reason: FillRefusalReason,
		message: string,
	) {
		super(message)
		this.name = "FillRefused"
	}
}

const isTxHash = (v: string): v is Hex => /^0x[0-9a-fA-F]{64}$/.test(v)

/** The one deposit bound for the destination that the pinned source pool logged in a successful `hash`. */
async function soleDeposit(deps: FillDeps, hash: Hex): Promise<SourceDeposit> {
	const [origin, destination] = await Promise.all([deps.source.getChainId(), deps.destination.public.getChainId()])
	let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>
	try {
		receipt = await deps.source.getTransactionReceipt({ hash })
	} catch (e) {
		throw new FillRefused("no-receipt", `no receipt for ${hash} on chain ${origin}: ${errorText(e).split("\n")[0]}`)
	}
	if (receipt.status !== "success") throw new FillRefused("reverted", `the source transaction ${hash} reverted`)
	const deposits = depositsIn(receipt.logs as RawLog[], deps.sourceSpokePool, BigInt(origin)).filter(
		(d) => d.destinationChainId === BigInt(destination),
	)
	if (deposits.length === 0) {
		throw new FillRefused("no-deposit", `${hash} holds no FundsDeposited from ${deps.sourceSpokePool} bound for chain ${destination}`)
	}
	if (deposits.length > 1)
		throw new FillRefused("ambiguous", `${hash} holds ${deposits.length} deposits for chain ${destination}; name one`)
	return deposits[0] as SourceDeposit
}

async function isFilled(deps: FillDeps, relayHash: Hex): Promise<boolean> {
	const status = await deps.destination.public.readContract({
		address: deps.destinationSpokePool,
		abi: SPOKE_POOL_ABI,
		functionName: "fillStatuses",
		args: [relayHash],
	})
	return status === FILL_STATUS.filled
}

/** The pool's own hash of the relay must be ours: a pool that hashes otherwise is not the deposit's destination. */
async function assertRelayHash(deps: FillDeps, d: SourceDeposit, relayHash: Hex): Promise<void> {
	const onChain = await deps.destination.public.readContract({
		address: deps.destinationSpokePool,
		abi: SPOKE_POOL_ABI,
		functionName: "getV3RelayHash",
		// viem's inference collapses this tuple argument to `never`; `AcrossRelayData` is the ABI's struct field for field.
		args: [d.relay as never],
	})
	if (onChain.toLowerCase() !== relayHash.toLowerCase()) {
		throw new FillRefused("relay-hash", `${deps.destinationSpokePool} hashes this relay to ${onChain}, not ${relayHash}`)
	}
}

/** Refuses a fill the pool would refuse at the head's time, or one this account cannot pay. */
async function assertFillable(deps: FillDeps, d: SourceDeposit): Promise<void> {
	const { public: client, wallet } = deps.destination
	const head = await client.getBlock()
	const margin = BigInt(deps.deadlineMarginS ?? DEFAULT_DEADLINE_MARGIN_S)
	if (BigInt(d.relay.fillDeadline) < head.timestamp + margin) {
		throw new FillRefused("deadline", `the fill deadline ${d.relay.fillDeadline} is within ${margin} s of the head's ${head.timestamp}`)
	}
	const filler = wallet.account.address
	const exclusive = wordAddress(d.relay.exclusiveRelayer)
	if (BigInt(d.relay.exclusivityDeadline) >= head.timestamp && !isAddressEqual(exclusive, filler)) {
		throw new FillRefused("exclusive", `${exclusive} holds this relay exclusively until ${d.relay.exclusivityDeadline}`)
	}
	const token = wordAddress(d.relay.outputToken)
	const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [filler] })
	if (balance < d.relay.outputAmount) {
		throw new FillRefused("balance", `${filler} holds ${balance} of ${token}; the relay pays out ${d.relay.outputAmount}`)
	}
}

/**
 * Refuses, before any write, a fill that logs no `FilledRelay` even at the gas cap right after its approval on the
 * head's state: a deposit that can never fill then costs reads only, however often a caller retries it.
 */
async function assertWouldFill(deps: FillDeps, d: SourceDeposit): Promise<void> {
	const { destination: dest, destinationSpokePool: pool } = deps
	const amount = d.relay.outputAmount
	const approve = {
		to: wordAddress(d.relay.outputToken),
		data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, amount] }),
	}
	const data = fillRelayData(fillRelayArgs(d.relay, d.relay.originChainId, dest.wallet.account.address))
	const outcome = await simulateFill(dest, pool, { to: pool, data, gas: TX_GAS_CAP }, undefined, [approve])
	if (!outcome.fills) {
		throw new FillRefused(
			"unfillable",
			`fillRelay on ${pool} logs no FilledRelay in simulation even at the ${TX_GAS_CAP} gas cap${outcome.reason}`,
		)
	}
}

/**
 * Fills the relay `srcTxHash` started, from the destination wallet's account, repaid (nominally) on the origin chain.
 *
 * Refuses with {@link FillRefused} before sending when: the hash is malformed; the source transaction has no receipt,
 * reverted, or holds no single `FundsDeposited` from `sourceSpokePool` bound for the destination chain; the
 * destination pool hashes the relay differently, or the relay is not `opts.relayHash`; the fill deadline is within
 * `deadlineMarginS` of the destination's head; another relayer's exclusivity window is open; the account cannot
 * pay `outputAmount`; or the fill, simulated after its approval, logs no `FilledRelay`. Approves the pool for exactly
 * `outputAmount` (cleared again if the fill does not land; a failed clear throws {@link AllowanceStillLive}).
 * A relay found filled before or during the call is otherwise success without a fill hash, whoever filled it; one
 * filled during the call may still have cost our approval and its revoke.
 */
export async function fillSourceDeposit(deps: FillDeps, srcTxHash: Hex, opts: FillOptions = {}): Promise<FillResult> {
	if (!isTxHash(srcTxHash)) throw new FillRefused("not-a-hash", `${String(srcTxHash).slice(0, 80)} is not a 32-byte transaction hash`)
	const d = await soleDeposit(deps, srcTxHash)
	const relayHash = relayHashOf(d)
	if (opts.relayHash && opts.relayHash.toLowerCase() !== relayHash.toLowerCase()) {
		throw new FillRefused("relay-hash", `${srcTxHash} now holds the relay ${relayHash}, not the vetted ${opts.relayHash}`)
	}
	await assertRelayHash(deps, d, relayHash)
	const filled: FillResult = { fillTxHash: null, relayHash, alreadyFilled: true }
	if (await isFilled(deps, relayHash)) return filled
	await assertFillable(deps, d)
	await assertWouldFill(deps, d)
	const destination = deps.gasTerms
		? { ...deps.destination, wallet: withGasTerms(deps.destination.wallet, deps.gasTerms) }
		: deps.destination
	try {
		const r = await sendFill(destination, deps.destinationSpokePool, d.relay, { repaymentChainId: d.relay.originChainId })
		if (r.status !== "success") throw new FillRefused("fill-reverted", `the fill ${r.hash} reverted`)
		return { fillTxHash: r.hash, relayHash, alreadyFilled: false }
	} catch (e) {
		// Another relayer may have filled between the status read and our send: the deposit is filled all the same,
		// unless our own approval is still live.
		if (!(e instanceof AllowanceStillLive) && (await isFilled(deps, relayHash))) return filled
		throw e
	}
}

// What a filler checks a deposit against, from modules as Worker-safe as this one.
export { SELF_BUILT_FILL_WINDOW_S, selfBuiltTerms, TESTNET_FILLER } from "./across-self-built"
export { DEPOSIT_ROUTER_ABI } from "./deposit-router-abi"
export { type GasPricing, type GasTermsFor, boundedGasTerms } from "./gas-terms"
export { lifiBook } from "./lifi-addresses"
export { type DecodedMessage, type DecodedRouterCall, decodeRouterMessage } from "./lifi-decode"
export { type AcrossRelayData, acrossRelayHash } from "./across-relay"
