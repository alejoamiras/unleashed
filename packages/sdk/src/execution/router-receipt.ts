/**
 * The router's own `Deposited`, read from a mined transaction: each leg authenticated by its portal's event and the
 * Inbox leaf recomputed from the intent's facts, so a look-alike event from another emitter cannot supply a leaf.
 */
import { InboxAbi } from "@aztec-foundation/l1-artifacts"
import {
	type AbiEvent,
	type Address,
	decodeEventLog,
	getAbiItem,
	type Hex,
	type Log,
	parseAbiItem,
	toEventSelector,
	toFunctionSelector,
	toHex,
	zeroHash,
} from "viem"
import { bytesFromHex, mintToPrivateContentHash, mintToPublicContentHash, sha256ToField, word } from "../protocol/content-hash.ts"
import { DEPOSIT_ROUTER_ABI } from "../protocol/deposit-router-abi.ts"
import { TOKEN_PORTAL_ABI } from "../protocol/factory-abi.ts"
import { parseFeeJuiceDeposit } from "../protocol/fuel.ts"
import { PRIVATE_FPC_ADDRESS } from "../protocol/private-fuel.ts"
import type { DepositRecord } from "../records.ts"
import { hexEq, ScanIncomplete } from "./chain-scan.ts"

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

/** The record facts a deposit's expectation is built from; every deposit record has them, cross-chain ones included. */
export type DepositRecordFacts = Pick<DepositRecord, "chainId" | "isPrivate" | "recipient" | "secretHashHex" | "fuel"> &
	({ intent: "gas" } | { intent: "token" | "token+gas"; token: { erc20: string } })

/** What the router's `Deposited` must carry for a deposit record, whichever chain the send started on. */
export function depositExpectationOf(rec: DepositRecordFacts): DepositExpectation {
	return {
		l1ChainId: rec.chainId,
		isPrivate: rec.isPrivate,
		recipient: rec.recipient as Hex,
		...(rec.intent === "gas" ? {} : { token: { erc20: rec.token.erc20 as Address, secretHash: rec.secretHashHex as Hex } }),
		...(rec.fuel ? { fuel: { secretHash: rec.fuel.secretHashHex as Hex, fpc: rec.fuel.fpc as Hex | undefined } } : {}),
	}
}

/** The Ethereum addresses that authenticate a deposit's logs. */
export interface DepositLogContext {
	router: Address
	feeJuicePortal: Address
	/** The deposit token's portal clone; required unless the send is gas only. */
	tokenPortal?: Address
	inbox: InboxContext
}

const MESSAGE_SENT: Record<InboxEventShape, AbiEvent> = {
	artifact: getAbiItem({ abi: InboxAbi, name: "MessageSent" }) as AbiEvent,
	checkpoint: parseAbiItem(
		"event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)",
	),
}
export const DEPOSITED = getAbiItem({ abi: DEPOSIT_ROUTER_ABI, name: "Deposited" }) as AbiEvent
const PORTAL_PUBLIC = getAbiItem({ abi: TOKEN_PORTAL_ABI, name: "DepositToAztecPublic" }) as AbiEvent
const PORTAL_PRIVATE = getAbiItem({ abi: TOKEN_PORTAL_ABI, name: "DepositToAztecPrivate" }) as AbiEvent
const CLAIM_SELECTOR = toFunctionSelector("claim(bytes32,uint256)")

export type Args = Record<string, unknown>
export type RawLog = { address: Address; topics: readonly Hex[]; data: Hex }

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
export function eventFrom(emitter: Address, event: AbiEvent, log: RawLog): Args | undefined {
	if (!hexEq(log.address, emitter) || !hexEq(log.topics[0], selectorOf(event))) return undefined
	try {
		return decodeEventLog({ abi: [event], data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }).args as Args
	} catch {
		return undefined
	}
}

export interface DepositedArgs {
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
export async function tokenLeaf(d: DepositedArgs, x: DepositExpectation, eth: DepositLogContext): Promise<string> {
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
export async function fuelLeaf(d: DepositedArgs, x: DepositExpectation, eth: DepositLogContext): Promise<string> {
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

export function isIntent(d: DepositedArgs, x: DepositExpectation): boolean {
	return (
		hexEq(d.tokenSecretHash, x.token?.secretHash ?? zeroHash) &&
		hexEq(d.fuelSecretHash, x.fuel?.secretHash ?? zeroHash) &&
		d.isPrivate === x.isPrivate &&
		(!x.token || hexEq(d.token, x.token.erc20))
	)
}

export async function depositFacts(
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
