/**
 * A network the SDK will move funds on: a strictly parsed manifest whose every derivable address is re-derived, whose
 * Aztec line this release runs, and whose deployed contracts are this release's builds bound to the rollup the Aztec
 * node runs. Nothing else is a `Network`: every call that signs takes one and refuses an object not built here.
 */
import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { Address, PublicClient } from "viem"
import { BridgeError, refusal } from "./errors.ts"
import { bundledManifest } from "./networks.ts"
import { mismatches, networkBindings } from "./execution/trust-roots.ts"
import { fuelRouteOf, type ManifestFuelRoute, sendGenerationOf } from "./execution/send-generation.ts"
import type { SendGeneration } from "./execution/send-flow.ts"
import { deepFreeze } from "./protocol/freeze.ts"
import { codeOf, type GenerationCode } from "./protocol/generation-record.ts"
import { aztecLineOf } from "./protocol/aztec-line.ts"
import { CANONICAL_PERMIT2, MAINNET_L1, MAX_FUEL_SLIPPAGE_BPS } from "./protocol/l1-pins.ts"
import { SANDBOX_LIFI_CHAIN_IDS } from "./protocol/lifi-addresses.ts"
import { assertManifestTokensDerive, type ManifestToken, type ManifestV2, parseManifestV2 } from "./protocol/manifest-v2.ts"
import { walletChainIdOf } from "./protocol/wallet-chain-id.ts"

/** The reads every call makes. Nothing here signs. `fetch` reaches li.quest, which needs no key; the global one is
 *  used when absent. */
export interface Reads {
	l1: PublicClient
	aztecNode: AztecNode
	fetch?: typeof fetch
}

export type Privacy = "public" | "private"

/** Where gas-only deposits go: the router, its Permit2, the Fee Juice portal, and the budgets quotes floor against. */
export interface FuelRoute extends ManifestFuelRoute {
	registry: Address
}

/** Where token deposits go: the factory whose clones are the portals, and the hub the L2 tokens derive from. */
export interface TokenRoute extends SendGeneration {
	registry: Address
	/** The tokens the manifest lists; any other ERC-20 still bridges, through `resolveToken`. */
	tokens: readonly ManifestToken[]
}

export interface Network {
	readonly name: string
	readonly l1ChainId: number
	readonly walletChainId: number
	readonly rollupVersion: number
	/** The canonical PrivateFPC of this network's Aztec line: private Fee Juice lands there and nowhere else. */
	readonly privateFpc: string
	readonly fuel: FuelRoute
	/** Absent on a network that only sells gas. */
	readonly bridge?: TokenRoute
	readonly manifest: ManifestV2
}

const verified = new WeakSet<Network>()
/** The hub artifact each token route's hub was derived from: the one its generation deployed. */
const hubArtifacts = new WeakMap<Network, ContractArtifact>()

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function parsed(manifest: unknown): ManifestV2 {
	try {
		return parseManifestV2(manifest)
	} catch (e) {
		throw refusal("invalid-network", e instanceof Error ? e.message : String(e), "never", e)
	}
}

function registryOf(m: ManifestV2): Address {
	return (m.bridge?.l1.registry ?? m.fuelRoute?.registry) as Address
}

/** The checks that need no chain: the line, a route, the canonical Permit2, the slippage cap, mainnet's pins. */
function assertStaticRoots(m: ManifestV2, fuel: ManifestFuelRoute | undefined): asserts fuel is ManifestFuelRoute {
	const line = aztecLineOf(m.l1ChainId)
	if (!line.supported)
		throw refusal("unsupported-line", `L1 chain ${m.l1ChainId} runs Aztec ${line.version}, which this release does not`)
	if (!fuel) throw refusal("invalid-network", `the ${m.network} manifest has no deposit route`)
	if (!same(fuel.permit2, CANONICAL_PERMIT2)) throw refusal("invalid-network", `permit2 ${fuel.permit2} is not the canonical Permit2`)
	if (fuel.slippageBps > MAX_FUEL_SLIPPAGE_BPS)
		throw refusal("invalid-network", `slippage ${fuel.slippageBps} bps is above the ${MAX_FUEL_SLIPPAGE_BPS} bps this release allows`)
	// A deposit lands at least the route's floor; under the claim's own floor it would land gas no claim can spend.
	if (fuel.minFuelFj < BigInt(m.feeJuice.minFj))
		throw refusal("invalid-network", `the route's fuel floor ${fuel.minFuelFj} is under the claim floor ${m.feeJuice.minFj}`)
	if (m.l1ChainId !== 1) return
	const pinned = [
		["registry", registryOf(m), MAINNET_L1.registry],
		["feeJuice.portal", m.feeJuice.portal, MAINNET_L1.feeJuicePortal],
		["feeJuice.asset", m.feeJuice.asset, MAINNET_L1.feeAsset],
	] as const
	for (const [label, got, want] of pinned)
		if (!same(got, want)) throw refusal("invalid-network", `${label} ${got} is not mainnet's ${want}`)
}

const HEX = /^0x[0-9a-f]*$/i
const keysOf = (o: object) => Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined)

/** One parsed manifest tree: object keys in any order, an `undefined` key as absent, `0x` hex in any case, else exact. */
function sameTree(a: unknown, b: unknown): boolean {
	if (typeof a === "string" && typeof b === "string") return HEX.test(a) && HEX.test(b) ? same(a, b) : a === b
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b
	if (Array.isArray(a) !== Array.isArray(b)) return false
	const [ka, kb] = [keysOf(a), keysOf(b)]
	const at = (o: object, k: string) => (o as Record<string, unknown>)[k]
	return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameTree(at(a, k), at(b, k)))
}

/** On a chain this release bundles a network for, that network only; off them, a sandbox's chain alone. Reads nothing. */
function assertBundled(m: ManifestV2): void {
	const bundled = bundledManifest(m.l1ChainId)
	if (bundled === undefined) {
		if (SANDBOX_LIFI_CHAIN_IDS.includes(m.l1ChainId)) return
		throw refusal("invalid-network", `this release bundles no network for chain ${m.l1ChainId}`)
	}
	if (!sameTree(m, parsed(bundled)))
		throw refusal("invalid-network", `the manifest is not the network this release bundles for chain ${m.l1ChainId}`)
}

/** The Aztec node names the rollup: its chain, version, registry and Fee Juice contracts must be the manifest's. */
async function assertNodeRoots(m: ManifestV2, r: Reads): Promise<number> {
	const [l1ChainId, info] = await Promise.all([r.l1.getChainId(), r.aztecNode.getNodeInfo()])
	if (l1ChainId !== m.l1ChainId) throw refusal("wrong-chain", `the Ethereum reads are on chain ${l1ChainId}, not ${m.l1ChainId}`, "safe")
	if (info.l1ChainId !== m.l1ChainId || walletChainIdOf(m.l1ChainId, info.rollupVersion) !== m.walletChainId) {
		throw refusal(
			"wrong-aztec-network",
			`the Aztec node runs rollup ${info.rollupVersion} on chain ${info.l1ChainId}, not ${m.network}`,
			"safe",
		)
	}
	const a = info.l1ContractAddresses
	const anchored = [
		["registry", registryOf(m), a.registryAddress.toString()],
		["feeJuice.portal", m.feeJuice.portal, a.feeJuicePortalAddress.toString()],
		["feeJuice.asset", m.feeJuice.asset, a.feeJuiceAddress.toString()],
	] as const
	for (const [label, got, want] of anchored) {
		if (!same(got, want)) throw refusal("invalid-network", `${label} ${got} is not the Aztec node's ${want}`)
	}
	return info.rollupVersion
}

/** The code the manifest's generation runs: a live chain's committed record, which must name the manifest's
 *  contracts, or a sandbox chain's own build. */
function generationCode(m: ManifestV2): GenerationCode {
	try {
		return codeOf(m)
	} catch (e) {
		throw refusal("invalid-network", e instanceof Error ? e.message : String(e), "never", e)
	}
}

/** Derives the hub and every token from the generation's hub artifact, whose class must be the one its record
 *  names, and returns that artifact. */
async function assertDerivations(m: ManifestV2, code: GenerationCode): Promise<ContractArtifact | undefined> {
	if (!m.bridge) return undefined
	try {
		const artifact = await code.hubArtifact()
		const hub = await assertManifestTokensDerive(m, artifact)
		const recorded = code.record?.aztec?.TokenBridgeHub.classId
		const derived = hub?.currentContractClassId.toString().toLowerCase()
		if (recorded && derived !== recorded) throw new Error(`the hub artifact's class ${derived} is not the recorded ${recorded}`)
		return artifact
	} catch (e) {
		throw refusal("invalid-network", e instanceof Error ? e.message : String(e), "never", e)
	}
}

async function assertChainRoots(m: ManifestV2, r: Reads, code: GenerationCode): Promise<void> {
	const bad = mismatches(await networkBindings(r.l1, m, code))
	if (bad.length === 0) return
	const why = bad.map((b) => `${b.label} is ${b.actual}, ${b.source} says ${b.expected}`).join("; ")
	throw refusal("invalid-network", `the deployed contracts are not this release's network: ${why}`)
}

/**
 * Parses a manifest and checks it against the chain. On a chain this release bundles a network for (`bundledManifest`)
 * only that network is accepted, before any read; off them only a sandbox chain's. Refuses (`BridgeError`, nothing
 * sent) a manifest that fails strict validation, has no deposit route, runs an Aztec line this release does not, names
 * a non-canonical Permit2 or a slippage above `MAX_FUEL_SLIPPAGE_BPS`, is not the bundled network, names contracts
 * its chain's committed generation record does not (`codeOf`), disagrees with the Aztec node on its chain, rollup,
 * registry or Fee Juice contracts (or with mainnet's pins), or whose deployed router, factory or gate, implementation
 * and swapper do not run the code that record pins (a sandbox chain's: this release's builds), bound to the registry's
 * canonical rollup. The guarantee is the returned `Network`'s: a raw `/protocol` primitive given a manifest of its own
 * inherits none of it.
 */
export async function parseNetwork(manifest: unknown, r: Reads): Promise<Network> {
	const m = deepFreeze(parsed(manifest))
	const route = fuelRouteOf(m)
	assertStaticRoots(m, route)
	assertBundled(m)
	const code = generationCode(m)
	const rollupVersion = await assertNodeRoots(m, r)
	const hubArtifact = await assertDerivations(m, code)
	await assertChainRoots(m, r, code)
	const registry = registryOf(m)
	const net: Network = Object.freeze({
		name: m.network,
		l1ChainId: m.l1ChainId,
		walletChainId: m.walletChainId,
		rollupVersion,
		privateFpc: m.privateFpc?.address ?? aztecLineOf(m.l1ChainId).privateFpc.address,
		fuel: Object.freeze({ ...route, registry }),
		...(m.bridge ? { bridge: Object.freeze({ ...sendGenerationOf(m, m.bridge), registry, tokens: m.bridge.tokens }) } : {}),
		manifest: m,
	})
	verified.add(net)
	if (hubArtifact) hubArtifacts.set(net, hubArtifact)
	return net
}

/** Refuses a `Network` that `parseNetwork` did not build. */
export function assertNetwork(net: Network): void {
	if (!verified.has(net)) throw new BridgeError("invalid-network", "this network was not built by parseNetwork", "none", "never")
}

/** The hub artifact `parseNetwork` derived `net`'s hub from. Refuses a network it did not build, or one with no token
 *  route. */
export function hubArtifactOf(net: Network): ContractArtifact {
	assertNetwork(net)
	const artifact = hubArtifacts.get(net)
	if (!artifact) throw refusal("invalid-network", `the ${net.name} network has no token route`)
	return artifact
}
