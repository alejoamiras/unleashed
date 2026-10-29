/**
 * The on-chain half of a network's trust roots: the deployed router, factory or gate, implementation and swapper are
 * this release's builds, and every pointer they froze resolves through the manifest's registry to its canonical
 * rollup. A genuine factory built on a hostile registry would freeze a foreign Outbox that releases every clone's
 * reserve, so the registry itself is anchored by the caller (to the Aztec node's, or the mainnet pin).
 */
import { FeeJuicePortalAbi, RegistryAbi, RollupAbi } from "@aztec-foundation/l1-artifacts"
import { type Address, hexToBytes, type PublicClient, parseAbi } from "viem"
import { CODE_PINS, deployedHash, type PinnedContract } from "../protocol/code-hash.ts"
import { DEPOSIT_ROUTER_ABI } from "../protocol/deposit-router-abi.ts"
import { PORTAL_FACTORY_ABI, PORTAL_IMPL_CONSTANTS_ABI } from "../protocol/factory-abi.ts"
import { DEPOSIT_WITNESS_TYPE_STRING } from "../protocol/l1.ts"
import { lifiBook, SANDBOX_LIFI_CHAIN_IDS } from "../protocol/lifi-addresses.ts"
import type { ManifestV2 } from "../protocol/manifest-v2.ts"

/** One comparison, lower-cased: what the chain answered and what it must be, and where the expectation came from. */
export interface Binding {
	label: string
	actual: string
	expected: string
	source: string
}

export type ChainReader = Pick<PublicClient, "readContract" | "getCode">

const bind = (label: string, actual: unknown, expected: unknown, source = "manifest"): Binding => ({
	label,
	actual: String(actual).toLowerCase(),
	expected: String(expected).toLowerCase(),
	source,
})

export const mismatches = (bindings: readonly Binding[]): Binding[] => bindings.filter((b) => b.actual !== b.expected)

export interface RollupBinding {
	rollup: Address
	inbox: Address
	outbox: Address
	version: bigint
	feeAssetPortal: Address
}

/** What a registry's canonical rollup is right now: the only source the frozen L1 pointers may have come from. */
export async function readRollupBinding(pub: ChainReader, registry: Address): Promise<RollupBinding> {
	const rollup = (await pub.readContract({ address: registry, abi: RegistryAbi, functionName: "getCanonicalRollup" })) as Address
	const read = (functionName: "getInbox" | "getOutbox" | "getVersion" | "getFeeAssetPortal") =>
		pub.readContract({ address: rollup, abi: RollupAbi, functionName }) as Promise<unknown>
	const [inbox, outbox, version, feeAssetPortal] = await Promise.all([
		read("getInbox"),
		read("getOutbox"),
		read("getVersion"),
		read("getFeeAssetPortal"),
	])
	return {
		rollup,
		inbox: inbox as Address,
		outbox: outbox as Address,
		version: version as bigint,
		feeAssetPortal: feeAssetPortal as Address,
	}
}

const fromRollup = "registry→canonical rollup"

export interface BridgeContracts {
	factory: Address
	implementation: Address
	hub: string
}

/** The factory froze its implementation, hub, Inbox and rollup version; no registry getter exists to compare. */
export async function factoryBindings(pub: ChainReader, b: BridgeContracts, rollup: RollupBinding): Promise<Binding[]> {
	const read = (functionName: "IMPLEMENTATION" | "L2_HUB" | "INBOX" | "ROLLUP_VERSION") =>
		pub.readContract({ address: b.factory, abi: PORTAL_FACTORY_ABI, functionName }) as Promise<unknown>
	const [implementation, hub, inbox, version] = await Promise.all([
		read("IMPLEMENTATION"),
		read("L2_HUB"),
		read("INBOX"),
		read("ROLLUP_VERSION"),
	])
	return [
		bind("factory.IMPLEMENTATION", implementation, b.implementation),
		bind("factory.L2_HUB", hub, b.hub),
		bind("factory.INBOX", inbox, rollup.inbox, fromRollup),
		bind("factory.ROLLUP_VERSION", version, rollup.version, fromRollup),
	]
}

/** A clone has no storage to repoint: the implementation's frozen pointers are every token portal's. */
export async function implementationBindings(pub: ChainReader, b: BridgeContracts, rollup: RollupBinding): Promise<Binding[]> {
	const read = (functionName: "FACTORY" | "L2_HUB" | "INBOX" | "OUTBOX" | "ROLLUP_VERSION") =>
		pub.readContract({ address: b.implementation, abi: PORTAL_IMPL_CONSTANTS_ABI, functionName }) as Promise<unknown>
	const [factory, hub, inbox, outbox, version] = await Promise.all([
		read("FACTORY"),
		read("L2_HUB"),
		read("INBOX"),
		read("OUTBOX"),
		read("ROLLUP_VERSION"),
	])
	return [
		bind("implementation.FACTORY", factory, b.factory),
		bind("implementation.L2_HUB", hub, b.hub),
		bind("implementation.INBOX", inbox, rollup.inbox, fromRollup),
		bind("implementation.OUTBOX", outbox, rollup.outbox, fromRollup),
		bind("implementation.ROLLUP_VERSION", version, rollup.version, fromRollup),
	]
}

/** What a router's immutables must be: a bridge's binds its factory, a fuel route's its gate. */
export interface RouterExpectation {
	factory: string
	permit2: string
	feeJuicePortal: string
	feeAsset: string
	/** LI.FI's Diamond on Ethereum mainnet, the manifest's testnet swapper elsewhere. */
	swapTarget: string | undefined
}

/** Every router immutable is fixed for its life, and the client signs the router's witness type string verbatim. */
export async function routerBindings(pub: ChainReader, router: Address, want: RouterExpectation): Promise<Binding[]> {
	const read = (functionName: "PERMIT2" | "FEE_JUICE_PORTAL" | "FACTORY" | "FEE_ASSET" | "SWAP_TARGET" | "DEPOSIT_WITNESS_TYPE_STRING") =>
		pub.readContract({ address: router, abi: DEPOSIT_ROUTER_ABI, functionName }) as Promise<unknown>
	const [permit2, portal, factory, feeAsset, swapTarget, witness] = await Promise.all([
		read("PERMIT2"),
		read("FEE_JUICE_PORTAL"),
		read("FACTORY"),
		read("FEE_ASSET"),
		read("SWAP_TARGET"),
		read("DEPOSIT_WITNESS_TYPE_STRING"),
	])
	return [
		bind("depositRouter.SWAP_TARGET", swapTarget, want.swapTarget ?? "(no swap target for this chain)"),
		bind("depositRouter.FACTORY", factory, want.factory),
		bind("depositRouter.PERMIT2", permit2, want.permit2),
		bind("depositRouter.FEE_JUICE_PORTAL", portal, want.feeJuicePortal),
		bind("depositRouter.FEE_ASSET", feeAsset, want.feeAsset),
		// Case matters to the EIP-712 hash, so the string is compared exactly.
		{
			label: "depositRouter.DEPOSIT_WITNESS_TYPE_STRING",
			actual: String(witness),
			expected: DEPOSIT_WITNESS_TYPE_STRING,
			source: "client",
		},
	]
}

/** A registry keeps older rollups whose portals still take deposits: the canonical rollup must name this portal (any
 *  contract can answer the portal's own reads), and the portal must name that rollup and pay the fee asset. */
export async function portalBindings(pub: ChainReader, portal: Address, feeAsset: string, rollup: RollupBinding): Promise<Binding[]> {
	const read = (functionName: "UNDERLYING" | "ROLLUP") =>
		pub.readContract({ address: portal, abi: FeeJuicePortalAbi, functionName }) as Promise<unknown>
	const [underlying, portalRollup] = await Promise.all([read("UNDERLYING"), read("ROLLUP")])
	return [
		bind("canonical rollup's getFeeAssetPortal", rollup.feeAssetPortal, portal),
		bind("feeJuicePortal.UNDERLYING", underlying, feeAsset),
		bind("feeJuicePortal.ROLLUP", portalRollup, rollup.rollup, "registry.getCanonicalRollup()"),
	]
}

/** Each deployed contract's runtime under its build's mask, against this release's pin. */
export async function codeBindings(pub: ChainReader, targets: readonly (readonly [PinnedContract, Address])[]): Promise<Binding[]> {
	return Promise.all(
		targets.map(async ([contract, address]) => {
			const pin = CODE_PINS[contract]
			const onChain = hexToBytes((await pub.getCode({ address })) ?? "0x")
			const actual = deployedHash(onChain, pin) ?? `${onChain.length} bytes`
			return bind(`${contract} runtime at ${address}`, actual, pin.hash, "this release's build")
		}),
	)
}

const SWAPPER_ABI = parseAbi(["function FEE_ASSET() view returns (address)"])

/** The testnet swapper's code is pinned; what it swaps into is an immutable, read here. */
async function swapperBindings(pub: ChainReader, swapper: Address, feeAsset: string): Promise<Binding[]> {
	const asset = await pub.readContract({ address: swapper, abi: SWAPPER_ABI, functionName: "FEE_ASSET" })
	return [bind("fuelSwapper.FEE_ASSET", asset, feeAsset)]
}

/** The router's swap target: LI.FI's Diamond on mainnet and on a sandbox that lists no swapper (its registered
 *  stand-in), the listed testnet swapper elsewhere. */
export function swapTargetOf(l1ChainId: number, fuelSwapper: string | undefined): string | undefined {
	if (l1ChainId === 1) return lifiBook(1).diamond
	if (!fuelSwapper && SANDBOX_LIFI_CHAIN_IDS.includes(l1ChainId)) return lifiBook(l1ChainId).diamond
	return fuelSwapper
}

/** Every on-chain trust root of a manifest's route. The registry it reads through must already be anchored. */
export async function networkBindings(pub: ChainReader, m: ManifestV2): Promise<Binding[]> {
	const route = m.bridge?.l1 ?? m.fuelRoute
	if (!route?.depositRouter) throw new Error("the manifest has no deposit router")
	const factory = (m.bridge ? m.bridge.l1.factory : m.fuelRoute?.gate) as Address
	const rollup = await readRollupBinding(pub, route.registry as Address)
	const router = route.depositRouter as Address
	const swapTarget = swapTargetOf(m.l1ChainId, route.fuelSwapper)
	const code: [PinnedContract, Address][] = [
		["DepositRouter", router],
		[m.bridge ? "PortalFactory" : "FuelOnlyGate", factory],
		...(m.bridge ? [["TokenPortalImpl", m.bridge.l1.implementation as Address] as [PinnedContract, Address]] : []),
		...(m.l1ChainId !== 1 && route.fuelSwapper
			? [["TestnetFuelSwapper", route.fuelSwapper as Address] as [PinnedContract, Address]]
			: []),
	]
	const want = { factory, permit2: route.permit2, feeJuicePortal: m.feeJuice.portal, feeAsset: m.feeJuice.asset, swapTarget }
	const bridge = m.bridge && { factory, implementation: m.bridge.l1.implementation as Address, hub: m.bridge.l2.hub.address }
	const groups = await Promise.all([
		codeBindings(pub, code),
		routerBindings(pub, router, want),
		portalBindings(pub, m.feeJuice.portal as Address, m.feeJuice.asset, rollup),
		bridge ? factoryBindings(pub, bridge, rollup) : [],
		bridge ? implementationBindings(pub, bridge, rollup) : [],
		m.l1ChainId !== 1 && route.fuelSwapper ? swapperBindings(pub, route.fuelSwapper as Address, m.feeJuice.asset) : [],
	])
	return groups.flat()
}
