/**
 * The factory's frozen registration record and the hub's registration view, read together: the
 * three-way state a token can be in decides which L1 call and which L2 claim a send needs.
 */
import type { Address, Hex } from "viem"
import { PORTAL_FACTORY_ABI } from "./factory-abi"

export interface Registration {
	portal: Address
	decimals: number
	registerIndex: bigint
	nameWord: Hex
	symbolWord: Hex
	registerKey: Hex
}

/** The viem surface this module needs — a PublicClient satisfies it. */
export interface RegistryClient {
	readContract(args: {
		address: Address
		abi: typeof PORTAL_FACTORY_ABI
		functionName: "registrationOf"
		args: readonly [Address]
	}): Promise<{
		portal: Address
		decimals: number
		registerIndex: bigint
		nameWord: Hex
		symbolWord: Hex
		registerKey: Hex
	}>
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/** `undefined` when the factory has no portal for the token yet (a zero record). */
export async function readRegistration(client: RegistryClient, factory: Address, erc20: Address): Promise<Registration | undefined> {
	const r = await client.readContract({ address: factory, abi: PORTAL_FACTORY_ABI, functionName: "registrationOf", args: [erc20] })
	if (r.portal.toLowerCase() === ZERO_ADDRESS) return undefined
	return {
		portal: r.portal,
		decimals: r.decimals,
		registerIndex: r.registerIndex,
		nameWord: r.nameWord,
		symbolWord: r.symbolWord,
		registerKey: r.registerKey,
	}
}

/**
 * - `first-time`: no portal on L1 (the router creates it inline; the first L2 claim registers).
 * - `portal-only`: the portal exists but the hub has not consumed its register message yet (the
 *   first L2 claim still registers — the message is waiting).
 * - `registered`: both sides bound; every claim is a plain claim.
 */
export type TokenState =
	| { kind: "first-time" }
	| { kind: "portal-only"; registration: Registration }
	| { kind: "registered"; registration: Registration; l2Token: Hex }

const ZERO_FIELD = `0x${"0".repeat(64)}`

export function tokenStateOf(registration: Registration | undefined, l2TokenFor: Hex): TokenState {
	if (!registration) return { kind: "first-time" }
	if (l2TokenFor.toLowerCase() === ZERO_FIELD) return { kind: "portal-only", registration }
	return { kind: "registered", registration, l2Token: l2TokenFor }
}
