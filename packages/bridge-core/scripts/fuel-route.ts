/**
 * The fuel-only route: a DepositRouter whose factory slot holds a FuelOnlyGate, for a network with no token portals,
 * written as a candidate manifest whose `fuelRoute` names both. On Ethereum mainnet the router swaps through LI.FI's
 * Diamond and only the pinned mainnet signer may deploy it; on the sandbox, the one other chain it runs on, it swaps
 * through a TestnetFuelSwapper deployed beside it. The signer owns everything it deploys and is the route's guardian.
 *
 * The router freezes its Fee Juice portal for life, so the portal is proven to be the registry's canonical rollup's
 * before anything is sent. Each deploy is journalled and adopted on an identical re-run, so a crashed run resumes and
 * a finished one sends nothing.
 */
import { FeeJuicePortalAbi, RegistryAbi, RollupAbi } from "@aztec-foundation/l1-artifacts"
import type { Address } from "viem"
import type { L1Ctx } from "../src/flows"
import { lifiBook } from "../src/lifi-addresses"
import type { FuelRouteBlock, ManifestV2 } from "../src/manifest-v2"
import { type DeployJournal, openDeployJournal, readDeployJournal, writeCandidateAtomically } from "./deploy-manifest"
import {
	type AdoptableDeploy,
	assertBindings,
	type DepositRouterArgs,
	deployDepositRouter,
	deployFuelOnlyGate,
	depositRouterArgs,
	findAdoptable,
	type FuelSwapperArgs,
	fuelSwapperArgs,
	readRouterBindings,
} from "./generation"
import { provisionFuelSwapper } from "./generation-router"
import { requirePinnedSigner } from "./live-intent"
import { FUEL_GATE_ABI } from "./script-l1"

const ETHEREUM_MAINNET = 1
/** The sandbox's L1 (`sandbox/constants.ts`): the only chain the route is rehearsed on. */
const SANDBOX_L1 = 31337
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/** The network the route binds, as the caller authenticated it; the base manifest must agree with it. */
export interface FuelRouteNetwork {
	l1ChainId: number
	rollupVersion: number
	registry: Address
	feeJuicePortal: Address
	/** The fee asset, `FeeJuicePortal.UNDERLYING()`. */
	feeJuice: Address
	permit2: Address
}

export interface FuelRouteOptions {
	/** Signs every write and owns the gate, the router and any swapper. */
	l1: L1Ctx
	network: FuelRouteNetwork
	journalPath: string
	/** The network's manifest without a bridge: the live placeholder, or a candidate of it. */
	base: ManifestV2
	fuel: FuelRouteBlock["fuel"]
	/** The sandbox swapper's rates; mainnet swaps through LI.FI's Diamond and takes none. */
	rates?: Readonly<Record<string, bigint>>
	candidatePath: string
}

export interface FuelRouteResult {
	candidate: ManifestV2
	gate: AdoptableDeploy
	depositRouter: AdoptableDeploy
	/** The sandbox's swap target; absent on mainnet. */
	fuelSwapper?: AdoptableDeploy
}

const lc = (v: string) => v.toLowerCase() as Address
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const signerOf = (l1: L1Ctx) => lc(l1.account.address)

/** Refuses before anything is read: a chain the route is not for, a signer other than mainnet's pinned one, a base
 *  that names a bridge or another network's Fee Juice. */
export function assertFuelRouteOptions(o: FuelRouteOptions): void {
	const { base, network: n } = o
	if (n.l1ChainId !== ETHEREUM_MAINNET && n.l1ChainId !== SANDBOX_L1) {
		throw new Error(`a fuel-only route runs on Ethereum mainnet or the sandbox, not chain ${n.l1ChainId} — STOP`)
	}
	if (n.l1ChainId === ETHEREUM_MAINNET) {
		const pinned = requirePinnedSigner("mainnet")
		if (!eq(o.l1.account.address, pinned)) throw new Error(`signer ${o.l1.account.address} != pinned mainnet signer ${pinned} — STOP`)
		if (o.rates) throw new Error("mainnet swaps through LI.FI's Diamond and takes no swapper rates — STOP")
	}
	if (base.bridge) throw new Error(`manifest for ${base.network} carries a bridge, whose own router carries the fuel leg — STOP`)
	const pairs: Array<[string, string | number, string | number]> = [
		["l1ChainId", base.l1ChainId, n.l1ChainId],
		["feeJuice.portal", base.feeJuice.portal, n.feeJuicePortal],
		["feeJuice.asset", base.feeJuice.asset, n.feeJuice],
	]
	for (const [label, inBase, onNetwork] of pairs) {
		if (!eq(String(inBase), String(onNetwork))) throw new Error(`base manifest ${label} ${inBase} != network ${onNetwork} — STOP`)
	}
}

/** The router freezes its portal for life, and a registry keeps older rollups whose portals still take deposits: the
 *  registry's canonical rollup must name the portal, and the portal must name that rollup, pay the network's fee asset
 *  and carry its version. Any contract can answer the portal's own reads, so the rollup's is the authority. */
async function assertCanonicalPortal(l1: L1Ctx, n: FuelRouteNetwork): Promise<void> {
	const portal = (functionName: "UNDERLYING" | "ROLLUP" | "VERSION") =>
		l1.pub.readContract({ address: n.feeJuicePortal, abi: FeeJuicePortalAbi, functionName })
	const [underlying, rollup, version, canonical] = await Promise.all([
		portal("UNDERLYING"),
		portal("ROLLUP"),
		portal("VERSION"),
		l1.pub.readContract({ address: n.registry, abi: RegistryAbi, functionName: "getCanonicalRollup" }),
	])
	assertBindings(
		"feeJuicePortal",
		{ underlying, rollup, version },
		{ underlying: n.feeJuice, rollup: canonical, version: n.rollupVersion },
	)
	const named = await l1.pub.readContract({ address: canonical, abi: RollupAbi, functionName: "getFeeAssetPortal" })
	assertBindings("canonical rollup", { getFeeAssetPortal: named }, { getFeeAssetPortal: n.feeJuicePortal })
}

/** An adopted gate may since have been paused or handed over: a candidate names only an open gate its signer owns. */
async function assertGateOpen(l1: L1Ctx, gate: Address): Promise<void> {
	const read = (functionName: "owner" | "pendingOwner" | "depositsPaused") =>
		l1.pub.readContract({ address: gate, abi: FUEL_GATE_ABI, functionName })
	const [owner, pendingOwner, depositsPaused] = await Promise.all([read("owner"), read("pendingOwner"), read("depositsPaused")])
	assertBindings(
		"gate",
		{ owner, pendingOwner, depositsPaused },
		{ owner: signerOf(l1), pendingOwner: ZERO_ADDRESS, depositsPaused: false },
	)
}

const swapperArgsOf = (o: FuelRouteOptions): FuelSwapperArgs => ({
	feeAsset: lc(o.network.feeJuice),
	...(o.base.feeJuice.feeAssetHandler ? { feeAssetHandler: lc(o.base.feeJuice.feeAssetHandler) } : {}),
	owner: signerOf(o.l1),
})

const routerArgsOf = (o: FuelRouteOptions, gate: Address, swapTarget: Address): DepositRouterArgs => ({
	permit2: lc(o.network.permit2),
	feeJuicePortal: lc(o.network.feeJuicePortal),
	factory: gate,
	swapTarget,
	owner: signerOf(o.l1),
})

/** LI.FI's Diamond on mainnet; on the sandbox, the swapper, provisioned with its rates and inventory. */
async function swapTargetOf(o: FuelRouteOptions, journal: DeployJournal): Promise<{ swapTarget: Address; fuelSwapper?: AdoptableDeploy }> {
	if (o.network.l1ChainId === ETHEREUM_MAINNET) return { swapTarget: lc(lifiBook(ETHEREUM_MAINNET).diamond) }
	const fuelSwapper = await provisionFuelSwapper(o.l1, journal, swapperArgsOf(o), o.rates ?? {}, o.fuel.minFuelFj)
	return { swapTarget: fuelSwapper.address, fuelSwapper }
}

/** The base with the route; the base must name no bridge. */
export function fuelRouteCandidate(base: ManifestV2, route: FuelRouteBlock): ManifestV2 {
	if (base.bridge) throw new Error(`manifest for ${base.network} carries a bridge; a fuel route is legal only without one — STOP`)
	return { ...base, fuelRoute: route }
}

/**
 * Deploys (or adopts) the gate, the sandbox's swapper and the router bound to both, reads each back, and writes the
 * candidate. Throws before any write on a refused chain or signer, a base that disagrees with the network, or a
 * portal that is not the canonical rollup's.
 */
export async function deployFuelRoute(o: FuelRouteOptions): Promise<FuelRouteResult> {
	assertFuelRouteOptions(o)
	await assertCanonicalPortal(o.l1, o.network)
	const owner = signerOf(o.l1)
	const journal = openDeployJournal(o.journalPath, {
		l1ChainId: o.network.l1ChainId,
		rollupVersion: o.network.rollupVersion,
		deployer: owner,
		registry: lc(o.network.registry),
		feeJuicePortal: lc(o.network.feeJuicePortal),
	})
	const gate = await deployFuelOnlyGate(o.l1, journal, owner)
	await assertGateOpen(o.l1, gate.address)
	const { swapTarget, fuelSwapper } = await swapTargetOf(o, journal)
	const routerArgs = routerArgsOf(o, gate.address, swapTarget)
	const depositRouter = await deployDepositRouter(o.l1, journal, routerArgs)
	assertBindings("router", await readRouterBindings(o.l1, depositRouter.address), { ...routerArgs, feeAsset: lc(o.network.feeJuice) })

	const candidate = fuelRouteCandidate(o.base, {
		depositRouter: depositRouter.address,
		gate: gate.address,
		guardian: owner,
		registry: lc(o.network.registry),
		permit2: lc(o.network.permit2),
		...(fuelSwapper ? { fuelSwapper: fuelSwapper.address } : {}),
		fuel: o.fuel,
	})
	writeCandidateAtomically(o.candidatePath, candidate)
	return { candidate, gate, depositRouter, ...(fuelSwapper ? { fuelSwapper } : {}) }
}

/** What `deployFuelRoute` would do, read-only: no transaction, no journal or candidate write. */
export async function planFuelRoute(o: FuelRouteOptions): Promise<string[]> {
	assertFuelRouteOptions(o)
	await assertCanonicalPortal(o.l1, o.network)
	const journal = { steps: readDeployJournal(o.journalPath) }
	const owner = signerOf(o.l1)
	const gate = await findAdoptable(o.l1, journal, "fuel-gate-deployed", [owner])
	const lines = [
		`signer ${owner} · chain ${o.network.l1ChainId}/${o.network.rollupVersion} · journal ${journal.steps.length} step(s)`,
		`portal ${o.network.feeJuicePortal}: the registry's canonical rollup, paying ${o.network.feeJuice}`,
		gate ? `gate: adopt ${gate}` : `gate: deploy FuelOnlyGate(${owner})`,
	]
	const swap = await plannedSwapTarget(o, journal, lines)
	if (!gate || !swap) {
		lines.push("router: deploy DepositRouter bound to the new contracts")
	} else {
		const args = depositRouterArgs(routerArgsOf(o, gate, swap))
		const router = await findAdoptable(o.l1, journal, "deposit-router-deployed", args)
		lines.push(router ? `router: adopt ${router}` : `router: deploy DepositRouter(${args.join(", ")})`)
	}
	lines.push(`candidate → ${o.candidatePath}`)
	return lines
}

/** The swap target a run would bind, when it already exists; reports the sandbox swapper's fate in `lines`. */
async function plannedSwapTarget(
	o: FuelRouteOptions,
	journal: Pick<DeployJournal, "steps">,
	lines: string[],
): Promise<Address | undefined> {
	if (o.network.l1ChainId === ETHEREUM_MAINNET) {
		const diamond = lc(lifiBook(ETHEREUM_MAINNET).diamond)
		lines.push(`swap target: LI.FI's Diamond ${diamond}`)
		return diamond
	}
	const args = fuelSwapperArgs(swapperArgsOf(o))
	const swapper = await findAdoptable(o.l1, journal, "fuel-swapper-deployed", args)
	lines.push(swapper ? `swapper: adopt ${swapper}` : `swapper: deploy TestnetFuelSwapper(${args.join(", ")})`)
	return swapper
}
