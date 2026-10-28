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
import { type Hex, getAddress, type PublicClient } from "viem"
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts"
import {
	BASE_SEPOLIA_RPC_DEFAULT,
	FILL_ROUTE,
	type FillDeps,
	FillRefused,
	type FillWallet,
	fillSourceDeposit,
	SEPOLIA_RPC_DEFAULT,
} from "../src/across-fill"
import { lifiBook } from "@unleashed/sdk/protocol"
import { PLAN_PINNED_CANARY_SIGNERS } from "./live-intent"
import { createL1Clients, createL1PublicClient } from "./script-bootstrap"
import { manifestL1Chain } from "./script-l1"

export {
	BASE_SEPOLIA_RPC_DEFAULT,
	FILL_ROUTE,
	type FillDeps,
	type FillOptions,
	type FillRefusalReason,
	FillRefused,
	type FillResult,
	fillSourceDeposit,
	SEPOLIA_RPC_DEFAULT,
} from "../src/across-fill"
/** The bound a caller passes as {@link FillDeps.gasTerms}: refuse a send before it exists when its worst fee is too high. */
export { boundedGasTerms } from "../src/gas-terms"

const isTxHash = (v: string): v is Hex => /^0x[0-9a-fA-F]{64}$/.test(v)
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ─── CLI ─────────────────────────────────────────────────────────────────────

export interface FillEndpoints {
	sourceRpcUrl: string
	destinationRpcUrl: string
}

export interface FillConfig extends FillEndpoints {
	srcTxHash: Hex
	/** The canary key, already an account: the key itself is kept nowhere else. */
	account: PrivateKeyAccount
}

/** `BASE_SEPOLIA_RPC_URL` and `SEPOLIA_RPC_URL`, else the PublicNode endpoints. */
export function fillEndpointsFromEnv(env: Readonly<Record<string, string | undefined>>): FillEndpoints {
	return {
		sourceRpcUrl: env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA_RPC_DEFAULT,
		destinationRpcUrl: env.SEPOLIA_RPC_URL || SEPOLIA_RPC_DEFAULT,
	}
}

/**
 * The key in `CANARY_PRIVATE_KEY` as an account, which must sign as `pinned`; an error never carries the key.
 *
 * @throws when no address is `pinned`, or the key is missing, malformed or another address's.
 */
export function canaryAccountFromEnv(env: Readonly<Record<string, string | undefined>>, pinned: string | null): PrivateKeyAccount {
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
	return account
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
	return { srcTxHash, account: canaryAccountFromEnv(env, pinned), ...fillEndpointsFromEnv(env) }
}

/** An endpoint on the wrong chain would fill somewhere else with the same key: both are checked before any read. */
async function assertRoute(source: PublicClient, destination: PublicClient): Promise<void> {
	const [s, d] = await Promise.all([source.getChainId(), destination.getChainId()])
	if (s !== FILL_ROUTE.source) throw new Error(`BASE_SEPOLIA_RPC_URL answers chain ${s}, not ${FILL_ROUTE.source}`)
	if (d !== FILL_ROUTE.destination) throw new Error(`SEPOLIA_RPC_URL answers chain ${d}, not ${FILL_ROUTE.destination}`)
}

/**
 * The fill dependencies for {@link FILL_ROUTE}'s pinned pools, signing as `account` on the destination.
 *
 * @throws before any other read when either endpoint answers a chain other than its end of the route.
 */
export async function connectFillRoute(account: PrivateKeyAccount, endpoints: FillEndpoints): Promise<FillDeps> {
	const sourceChain = manifestL1Chain({ network: "base-sepolia", l1ChainId: FILL_ROUTE.source }, endpoints.sourceRpcUrl)
	const destinationChain = manifestL1Chain({ network: "sepolia", l1ChainId: FILL_ROUTE.destination }, endpoints.destinationRpcUrl)
	const source = createL1PublicClient({ chain: sourceChain, rpcUrl: endpoints.sourceRpcUrl })
	const dest = createL1Clients({ chain: destinationChain, rpcUrl: endpoints.destinationRpcUrl, account })
	await assertRoute(source, dest.pub as PublicClient)
	return {
		source,
		destination: { public: dest.pub as PublicClient, wallet: dest.wallet as FillWallet },
		sourceSpokePool: lifiBook(FILL_ROUTE.source).acrossSpokePool,
		destinationSpokePool: lifiBook(FILL_ROUTE.destination).acrossSpokePool,
	}
}

/** The CLI: every refusal of {@link fillConfigFromEnv} fires before a client exists. */
export async function fillCli(
	env: Readonly<Record<string, string | undefined>>,
	argv: readonly string[],
	pinned: string | null = PLAN_PINNED_CANARY_SIGNERS.testnet,
): Promise<void> {
	const cfg = fillConfigFromEnv(env, argv, pinned)
	const deps = await connectFillRoute(cfg.account, cfg)
	console.log(`filler ${cfg.account.address}; source deposit ${cfg.srcTxHash}`)
	const r = await fillSourceDeposit(deps, cfg.srcTxHash)
	console.log(
		r.alreadyFilled
			? `relay ${r.relayHash} is filled; this run confirmed no fill of its own`
			: `filled in ${r.fillTxHash} (relay ${r.relayHash})`,
	)
}

if (import.meta.main) {
	fillCli(process.env, process.argv).catch((e) => {
		console.error(e instanceof FillRefused ? `refused (${e.reason}): ${e.message}` : errorText(e))
		process.exit(1)
	})
}
