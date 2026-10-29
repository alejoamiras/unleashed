import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Address, Hex } from "viem"
import { BridgeError, refusal } from "../errors.ts"
import { type Registration, readRegistration } from "../execution/factory-registry.ts"
import { hubBindingAt } from "../execution/hub-l2.ts"
import { assertNetwork, type Network, type Reads, type TokenRoute } from "../network.ts"
import { readErc20Metadata } from "../protocol/erc20.ts"
import { deriveHubTokenInstance } from "../protocol/hub-token.ts"
import { predictPortal } from "../protocol/portal-address.ts"
import { fromWord, toWord } from "../protocol/register-hash.ts"
import type { JournalTokenBlock } from "../records.ts"

/** Where a token stands: no portal yet, a portal the hub has not registered, or bound on both sides. */
export type BridgeTokenState = "first-time" | "portal-only" | "registered"

/** An ERC-20 as the bridge will move it: its portal, the words and decimals the hub derives its L2 token from, and
 *  that L2 token. Listed or not, every token resolves the same way. */
export interface BridgeToken {
	readonly network: Network
	readonly erc20: Address
	readonly portal: Address
	readonly nameWord: Hex
	readonly symbolWord: Hex
	readonly decimals: number
	/** Decoded from the symbol word: the bytes the hub binds, not a list's claim. */
	readonly symbol: string
	readonly l2Token: Hex
	readonly state: BridgeTokenState
	/** The factory's frozen record, once the portal exists. */
	readonly registration?: Registration
}

function bridgeOf(net: Network): TokenRoute {
	if (!net.bridge) throw refusal("invalid-request", `${net.name} has no token bridge`)
	return net.bridge
}

const readFailed = (what: string, e: unknown) =>
	new BridgeError("read-failed", `could not read ${what}: ${e instanceof Error ? e.message : String(e)}`, "none", "after-wait", {
		cause: e,
	})

/** The words and decimals the hub will derive from: the factory's frozen ones, else the contract's own raw bytes. */
async function wordsOf(r: Reads, erc20: Address, registration: Registration | undefined) {
	if (registration) return { nameWord: registration.nameWord, symbolWord: registration.symbolWord, decimals: registration.decimals }
	let meta: Awaited<ReturnType<typeof readErc20Metadata>>
	try {
		meta = await readErc20Metadata(r.l1 as never, erc20)
	} catch (e) {
		throw refusal("invalid-request", `${erc20} does not answer as an ERC-20`, "never", e)
	}
	// The raw returndata is the sanitizer's only valid input: a decoded string that lost a byte derives an address the
	// hub never mints to.
	return { nameWord: toWord(meta.nameRaw), symbolWord: toWord(meta.symbolRaw), decimals: meta.decimals }
}

/**
 * Resolves any ERC-20 against the network's factory and hub. A registered token's L2 address is the hub's binding and
 * must equal the derivation from the frozen words; a first-time token's is the address the hub will derive.
 */
export async function resolveToken(net: Network, r: Reads, erc20: Address): Promise<BridgeToken> {
	assertNetwork(net)
	const b = bridgeOf(net)
	let registration: Registration | undefined
	try {
		registration = await readRegistration(r.l1 as never, b.factory, erc20)
	} catch (e) {
		throw readFailed("the factory's registration", e)
	}
	const words = await wordsOf(r, erc20, registration)
	let bound: string | undefined
	try {
		bound = registration ? await hubBindingAt(r.aztecNode, b.hub, erc20) : undefined
	} catch (e) {
		throw readFailed("the hub's binding from the Aztec node", e)
	}
	const derived = (await deriveHubTokenInstance(AztecAddress.fromStringUnsafe(b.hub), erc20, words, b.tokenClassId)).address.toString()
	if (bound && bound.toLowerCase() !== derived.toLowerCase()) {
		throw refusal("invalid-network", `the hub binds ${erc20} to ${bound}, not the derivation ${derived}`)
	}
	const state: BridgeTokenState = !registration ? "first-time" : bound ? "registered" : "portal-only"
	return Object.freeze({
		network: net,
		erc20,
		portal: (registration?.portal ?? predictPortal(b.factory, b.implementation, erc20)) as Address,
		...words,
		symbol: fromWord(words.symbolWord),
		l2Token: derived as Hex,
		state,
		...(registration ? { registration } : {}),
	})
}

/** The token block a deposit's record carries until the receipt's frozen registration replaces it. */
export function tokenBlockOf(t: BridgeToken): JournalTokenBlock {
	return {
		erc20: t.erc20.toLowerCase(),
		portal: t.portal.toLowerCase(),
		l2Token: t.l2Token,
		nameWord: t.nameWord,
		symbolWord: t.symbolWord,
		decimals: t.decimals,
		displaySymbol: t.symbol,
		...(t.registration ? { registerKey: t.registration.registerKey, registerIndex: t.registration.registerIndex.toString() } : {}),
	}
}
