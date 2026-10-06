#!/usr/bin/env bun
/**
 * Fills one named Base Sepolia source deposit on Sepolia, as an Across relayer would, for a testnet route Across's own
 * relayers leave unfilled. The relay is read from the pinned Base Sepolia SpokePool's `FundsDeposited` in that
 * transaction and filled on the pinned Sepolia SpokePool from the canary key; anything it cannot fill exactly as
 * logged is refused before a transaction exists. The key must be the pinned testnet canary
 * (`PLAN_PINNED_CANARY_SIGNERS`), checked before any client exists.
 *
 *   CANARY_PRIVATE_KEY=… bun scripts/fill-testnet.ts <base-sepolia-tx-hash>
 *
 * `BASE_SEPOLIA_RPC_URL` and `SEPOLIA_RPC_URL` override the PublicNode endpoints. Non-interactive; never prints the key.
 */
import { type Address, erc20Abi, getAddress, type Hex, isAddressEqual, type PublicClient } from "viem"
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts"
import { lifiBook } from "../src/lifi-addresses"
import { PLAN_PINNED_CANARY_SIGNERS } from "./live-intent"
import {
	type Destination,
	depositsIn,
	FILL_STATUS,
	type FillWallet,
	type RawLog,
	relayHashOf,
	SPOKE_POOL_ABI,
	type SourceDeposit,
	sendFill,
	wordAddress,
} from "./sandbox/relayer"
import { createL1Clients, createL1PublicClient } from "./script-bootstrap"
import { type GasTermsFor, manifestL1Chain, withGasTerms } from "./script-l1"

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
	/** `null` when the relay was already filled, by anyone, and nothing was sent. */
	fillTxHash: Hex | null
	relayHash: Hex
	alreadyFilled: boolean
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
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

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
 * Fills the relay `srcTxHash` started, from the destination wallet's account, repaid (nominally) on the origin chain.
 *
 * Refuses with {@link FillRefused} before sending when: the hash is malformed; the source transaction has no receipt,
 * reverted, or holds no single `FundsDeposited` from `sourceSpokePool` bound for the destination chain; the
 * destination pool hashes the relay differently; the fill deadline is within `deadlineMarginS` of the destination's
 * head; another relayer's exclusivity window is open; or the account cannot pay `outputAmount`. Approves the pool for
 * exactly `outputAmount` (cleared again if the fill does not land). A relay already filled, by anyone, before or
 * during the call, is success with nothing sent.
 */
export async function fillSourceDeposit(deps: FillDeps, srcTxHash: Hex): Promise<FillResult> {
	if (!isTxHash(srcTxHash)) throw new FillRefused("not-a-hash", `${String(srcTxHash).slice(0, 80)} is not a 32-byte transaction hash`)
	const d = await soleDeposit(deps, srcTxHash)
	const relayHash = relayHashOf(d)
	await assertRelayHash(deps, d, relayHash)
	const filled: FillResult = { fillTxHash: null, relayHash, alreadyFilled: true }
	if (await isFilled(deps, relayHash)) return filled
	await assertFillable(deps, d)
	const destination = deps.gasTerms
		? { ...deps.destination, wallet: withGasTerms(deps.destination.wallet, deps.gasTerms) }
		: deps.destination
	try {
		const r = await sendFill(destination, deps.destinationSpokePool, d.relay, { repaymentChainId: d.relay.originChainId })
		if (r.status !== "success") throw new FillRefused("fill-reverted", `the fill ${r.hash} reverted`)
		return { fillTxHash: r.hash, relayHash, alreadyFilled: false }
	} catch (e) {
		// Another relayer may have filled between the status read and our send: the deposit is filled all the same.
		if (await isFilled(deps, relayHash)) return filled
		throw e
	}
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export interface FillConfig {
	srcTxHash: Hex
	/** The canary key, already an account: the key itself is kept nowhere else. */
	account: PrivateKeyAccount
	sourceRpcUrl: string
	destinationRpcUrl: string
}

/**
 * Reads `<srcTxHash>` from `argv` and the key from `CANARY_PRIVATE_KEY` alone; an error never carries the key.
 *
 * @throws when the hash is malformed, no canary is `pinned`, or the key is missing, malformed or not the pinned canary's.
 */
export function fillConfigFromEnv(
	env: Readonly<Record<string, string | undefined>>,
	argv: readonly string[],
	pinned: string | null = PLAN_PINNED_CANARY_SIGNERS.testnet,
): FillConfig {
	const args = argv.slice(2)
	const srcTxHash = args[0]
	if (args.length !== 1 || !srcTxHash || !isTxHash(srcTxHash)) {
		throw new FillRefused("not-a-hash", "usage: bun scripts/fill-testnet.ts <base-sepolia-tx-hash> — exactly one 32-byte 0x hash")
	}
	if (!pinned) throw new Error("no testnet canary is pinned in PLAN_PINNED_CANARY_SIGNERS: this filler signs as the pinned canary only")
	const key = env.CANARY_PRIVATE_KEY
	if (!key) throw new Error("CANARY_PRIVATE_KEY is not set: this filler signs with the canary key and no other")
	let account: PrivateKeyAccount
	try {
		if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("malformed")
		account = privateKeyToAccount(key as Hex)
	} catch {
		throw new Error("CANARY_PRIVATE_KEY is not a valid 0x-prefixed 32-byte secp256k1 key")
	}
	if (account.address !== getAddress(pinned))
		throw new Error(`CANARY_PRIVATE_KEY signs as ${account.address}, not the pinned canary ${pinned}`)
	return {
		srcTxHash,
		account,
		sourceRpcUrl: env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA_RPC_DEFAULT,
		destinationRpcUrl: env.SEPOLIA_RPC_URL || SEPOLIA_RPC_DEFAULT,
	}
}

/** An endpoint on the wrong chain would fill somewhere else with the same key: both are checked before any read. */
async function assertRoute(source: PublicClient, destination: PublicClient): Promise<void> {
	const [s, d] = await Promise.all([source.getChainId(), destination.getChainId()])
	if (s !== FILL_ROUTE.source) throw new Error(`BASE_SEPOLIA_RPC_URL answers chain ${s}, not ${FILL_ROUTE.source}`)
	if (d !== FILL_ROUTE.destination) throw new Error(`SEPOLIA_RPC_URL answers chain ${d}, not ${FILL_ROUTE.destination}`)
}

/** The CLI: every refusal of {@link fillConfigFromEnv} fires before a client exists. */
export async function fillCli(
	env: Readonly<Record<string, string | undefined>>,
	argv: readonly string[],
	pinned: string | null = PLAN_PINNED_CANARY_SIGNERS.testnet,
): Promise<void> {
	const cfg = fillConfigFromEnv(env, argv, pinned)
	const sourceChain = manifestL1Chain({ network: "base-sepolia", l1ChainId: FILL_ROUTE.source }, cfg.sourceRpcUrl)
	const destinationChain = manifestL1Chain({ network: "sepolia", l1ChainId: FILL_ROUTE.destination }, cfg.destinationRpcUrl)
	const source = createL1PublicClient({ chain: sourceChain, rpcUrl: cfg.sourceRpcUrl })
	const dest = createL1Clients({ chain: destinationChain, rpcUrl: cfg.destinationRpcUrl, account: cfg.account })
	await assertRoute(source, dest.pub as PublicClient)
	console.log(`filler ${cfg.account.address}; source deposit ${cfg.srcTxHash}`)
	const r = await fillSourceDeposit(
		{
			source,
			destination: { public: dest.pub as PublicClient, wallet: dest.wallet as FillWallet },
			sourceSpokePool: lifiBook(FILL_ROUTE.source).acrossSpokePool,
			destinationSpokePool: lifiBook(FILL_ROUTE.destination).acrossSpokePool,
		},
		cfg.srcTxHash,
	)
	console.log(
		r.alreadyFilled ? `already filled (relay ${r.relayHash}); nothing sent` : `filled in ${r.fillTxHash} (relay ${r.relayHash})`,
	)
}

if (import.meta.main) {
	fillCli(process.env, process.argv).catch((e) => {
		console.error(e instanceof FillRefused ? `refused (${e.reason}): ${e.message}` : errorText(e))
		process.exit(1)
	})
}
