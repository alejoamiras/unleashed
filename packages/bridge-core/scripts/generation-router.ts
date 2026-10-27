/**
 * The router-only arc: a DepositRouter and its testnet fuel swapper deployed beside the current generation's router
 * on an unchanged network, then a candidate manifest naming them in its additive fields (`router` stays the old
 * one). The generation's identity, factory and hub are inputs, never outputs: promotion locks exactly those, so this
 * arc moves the router and nothing else.
 *
 * The core takes its L1 context, journal path and network constants from the caller, so the sandbox rehearsal and
 * the live run drive the same steps. Each deploy is journalled and each other write is idempotent, so a crashed run
 * resumes and an identical re-run sends nothing.
 */
import { readDeployJournal, openDeployJournal, type DeployJournal, writeCandidateAtomically } from "./deploy-manifest"
import type { Address } from "viem"
import z from "zod"
import { PORTAL_FACTORY_ABI } from "../src/factory-abi"
import type { L1Ctx } from "../src/flows"
import { type BridgeBlock, evmAddressV2, type ManifestV2, routingSchema } from "../src/manifest-v2"
import {
	type AdoptableDeploy,
	assertBindings,
	type DepositRouterArgs,
	deployDepositRouter,
	deployFuelSwapper,
	depositRouterArgs,
	findAdoptable,
	type FuelSwapperArgs,
	fuelSwapperArgs,
	readFuelSwapperBindings,
	readRouterBindings,
} from "./generation"
import { ERC20_MIN_ABI, FEE_ASSET_HANDLER_ABI, FUEL_SWAPPER_ABI, sendL1, swapperInventoryFloor } from "./script-l1"

type FuelBudgets = NonNullable<BridgeBlock["l1"]["fuel"]>
export type Routing = z.infer<typeof routingSchema>

/** The cross-chain floor's slippage until calibration measures its own. */
export const DEFAULT_CROSS_CHAIN_SLIPPAGE_BPS = 300
/** More faucet calls than this for one top-up means the floor is out of proportion with the faucet. */
const MAX_INVENTORY_MINTS = 10n

/** The network the arc runs on, as the caller authenticated it; the base manifest must agree with every field. */
export interface RouterOnlyNetwork {
	l1ChainId: number
	rollupVersion: number
	registry: Address
	feeJuicePortal: Address
	/** The fee asset, `FeeJuicePortal.UNDERLYING()`. */
	feeJuice: Address
	permit2: Address
	/** The faucet the network reports; compared with the manifest's when both name one. */
	feeAssetHandler?: Address
}

export interface RouterOnlyOptions {
	/** Signs every write; must be the generation's guardian, which owns both contracts and sets the rates. */
	l1: L1Ctx
	network: RouterOnlyNetwork
	journalPath: string
	/** The current generation's manifest: the live one, or a candidate of the same generation. */
	base: ManifestV2
	/** Fee-asset base units per whole token. Must cover every base token; extra tokens (ones to pre-create) are set too. */
	rates: Readonly<Record<string, bigint>>
	/** Replaces the base's `routing`; omitted keeps it. Every destination token must already be a manifest token. */
	routing?: Routing | null
	candidatePath: string
}

export interface RouterOnlyResult {
	candidate: ManifestV2
	fuelSwapper: AdoptableDeploy
	depositRouter: AdoptableDeploy
}

const lc = (v: string) => v.toLowerCase() as Address
const eq = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase()

/** The rates file: `{ "<erc20>": "<fee-asset base units per whole token>" }`, every rate positive. */
export function parseRates(raw: unknown): Record<string, bigint> {
	const parsed = z.record(evmAddressV2, z.string().regex(/^[1-9]\d*$/, "expected a positive base-10 integer string")).safeParse(raw)
	if (!parsed.success) {
		throw new Error(`rates: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)
	}
	return Object.fromEntries(Object.entries(parsed.data).map(([token, rate]) => [lc(token), BigInt(rate)]))
}

export function parseRouting(raw: unknown): Routing {
	return routingSchema.parse(raw)
}

/** The base's fuel budgets: its `fuel` block, else the legacy `swap` block's budgets, which measure the same L2 fees. */
export function fuelBudgetsOf(base: ManifestV2): FuelBudgets {
	const l1 = base.bridge?.l1
	if (l1?.fuel) return l1.fuel
	if (!l1?.swap) throw new Error("the base manifest carries neither fuel budgets nor a swap block to take them from — STOP")
	const { slippageBps, minFuelFj, fjPerTx, fjRegister } = l1.swap
	return { slippageBps, crossChainSlippageBps: DEFAULT_CROSS_CHAIN_SLIPPAGE_BPS, minFuelFj, fjPerTx, fjRegister }
}

/** The base with the arc's additive fields; every other field, `router` included, is the base's own. */
export function routerOnlyCandidate(
	base: ManifestV2,
	f: { depositRouter: Address; fuelSwapper: Address; fuel: FuelBudgets; routing?: Routing | null },
): ManifestV2 {
	const b = base.bridge
	if (!b) throw new Error(`manifest for ${base.network} carries no bridge — there is no generation to add a router to; STOP`)
	const routing = f.routing === undefined ? b.routing : f.routing
	return {
		...base,
		bridge: {
			...b,
			l1: { ...b.l1, depositRouter: lc(f.depositRouter), fuelSwapper: lc(f.fuelSwapper), fuel: f.fuel },
			...(routing === undefined ? {} : { routing }),
		},
	}
}

/** Every base field the arc's contracts bind must be the network's own, and the signer must own what it deploys. */
function assertBaseOnNetwork(o: RouterOnlyOptions): BridgeBlock {
	const { base, network: n } = o
	const b = base.bridge
	if (!b) throw new Error(`manifest for ${base.network} carries no bridge — STOP`)
	if (n.l1ChainId === 1) {
		throw new Error(
			"the router-only arc deploys TestnetFuelSwapper, which Ethereum mainnet refuses; a mainnet router targets the Diamond",
		)
	}
	const pairs: Array<[string, string | number | undefined, string | number | undefined]> = [
		["l1ChainId", base.l1ChainId, n.l1ChainId],
		["registry", b.l1.registry, n.registry],
		["feeJuicePortal", b.l1.feeJuicePortal, n.feeJuicePortal],
		["feeJuice.asset", base.feeJuice.asset, n.feeJuice],
		["permit2", b.l1.permit2, n.permit2],
		["guardian (the owner of both contracts) vs the signer", b.l1.guardian, o.l1.account.address],
	]
	if (base.feeJuice.feeAssetHandler && n.feeAssetHandler)
		pairs.push(["feeAssetHandler", base.feeJuice.feeAssetHandler, n.feeAssetHandler])
	for (const [label, inBase, onNetwork] of pairs) {
		if (!eq(String(inBase), String(onNetwork))) throw new Error(`base manifest ${label} ${inBase} != network ${onNetwork} — STOP`)
	}
	const missing = b.tokens.filter((t) => !o.rates[lc(t.erc20)]).map((t) => `${t.displaySymbol} ${t.erc20}`)
	if (missing.length > 0) throw new Error(`no swapper rate for ${missing.join(", ")} — every manifest token needs one; STOP`)
	return b
}

/** The factory the router will bind is the base's, on this chain, bound to the base's hub; and a journal that
 *  recorded this generation's deploy recorded the same factory and hub. */
async function assertGeneration(l1: L1Ctx, b: BridgeBlock, journal: Pick<DeployJournal, "steps">): Promise<void> {
	const factory = b.l1.factory as Address
	const code = await l1.pub.getCode({ address: factory })
	if (!code || code === "0x") throw new Error(`base factory ${factory} has no code on this chain — STOP`)
	const read = async (functionName: "L2_HUB" | "IMPLEMENTATION") =>
		String(await l1.pub.readContract({ address: factory, abi: PORTAL_FACTORY_ABI, functionName, args: [] }))
	assertBindings(
		"factory",
		{ L2_HUB: await read("L2_HUB"), IMPLEMENTATION: await read("IMPLEMENTATION") },
		{
			L2_HUB: b.l2.hub.address,
			IMPLEMENTATION: b.l1.implementation,
		},
	)
	for (const s of journal.steps) {
		if (s.kind === "factory-deployed" && !eq(s.factory, factory))
			throw new Error(`journal factory ${s.factory} != base ${factory} — STOP`)
		if (s.kind === "hub-deployed" && !eq(s.hub, b.l2.hub.address))
			throw new Error(`journal hub ${s.hub} != base ${b.l2.hub.address} — STOP`)
	}
}

const swapperArgsOf = (o: RouterOnlyOptions, b: BridgeBlock): FuelSwapperArgs => ({
	feeAsset: lc(o.network.feeJuice),
	...(o.base.feeJuice.feeAssetHandler ? { feeAssetHandler: lc(o.base.feeJuice.feeAssetHandler) } : {}),
	owner: lc(b.l1.guardian),
})

const routerArgsOf = (o: RouterOnlyOptions, b: BridgeBlock, swapTarget: Address): DepositRouterArgs => ({
	permit2: lc(o.network.permit2),
	feeJuicePortal: lc(o.network.feeJuicePortal),
	factory: lc(b.l1.factory),
	swapTarget,
	owner: lc(b.l1.guardian),
})

async function rateOf(l1: L1Ctx, swapper: Address, token: string): Promise<bigint> {
	return (await l1.pub.readContract({
		address: swapper,
		abi: FUEL_SWAPPER_ABI,
		functionName: "rate",
		args: [token as Address],
	})) as bigint
}

/** Sets each rate the swapper does not already hold; returns how many it sent. */
async function setRates(l1: L1Ctx, swapper: Address, rates: Readonly<Record<string, bigint>>): Promise<number> {
	let sent = 0
	for (const [token, rate] of Object.entries(rates).sort(([a], [b]) => a.localeCompare(b))) {
		if ((await rateOf(l1, swapper, token)) === rate) continue
		await sendL1(l1, { address: swapper, abi: FUEL_SWAPPER_ABI, functionName: "setRate", args: [token, rate] })
		console.log(`  rate ${token} = ${rate} fee-asset units per whole token`)
		sent++
	}
	return sent
}

async function feeAssetBalance(l1: L1Ctx, feeAsset: Address, holder: Address): Promise<bigint> {
	return (await l1.pub.readContract({ address: feeAsset, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: [holder] })) as bigint
}

/** Faucet calls that lift `balance` to `floor`, refused when the faucet pays nothing or the floor is out of
 *  proportion with it. */
export function inventoryMints(balance: bigint, floor: bigint, mintAmount: bigint): bigint {
	if (balance >= floor) return 0n
	if (mintAmount === 0n) throw new Error("the fee-asset faucet mints nothing per call — STOP")
	const calls = (floor - balance + mintAmount - 1n) / mintAmount
	if (calls > MAX_INVENTORY_MINTS)
		throw new Error(`an inventory floor of ${floor} needs ${calls} faucet calls (max ${MAX_INVENTORY_MINTS}) — STOP`)
	return calls
}

/** Mints the swapper's inventory up to `floor` from the permissionless faucet; with no faucet the swapper is
 *  inventory-only and is funded by transfer instead. */
async function topUpInventory(
	l1: L1Ctx,
	swapper: Address,
	feeAsset: Address,
	handler: Address | undefined,
	floor: bigint,
): Promise<bigint> {
	if (!handler) {
		console.log("  inventory: no fee-asset faucet on this network — fund the swapper by transfer")
		return 0n
	}
	const mintAmount = (await l1.pub.readContract({ address: handler, abi: FEE_ASSET_HANDLER_ABI, functionName: "mintAmount" })) as bigint
	const calls = inventoryMints(await feeAssetBalance(l1, feeAsset, swapper), floor, mintAmount)
	for (let i = 0n; i < calls; i++)
		await sendL1(l1, { address: handler, abi: FEE_ASSET_HANDLER_ABI, functionName: "mint", args: [swapper] })
	const balance = await feeAssetBalance(l1, feeAsset, swapper)
	if (balance < floor) throw new Error(`swapper inventory ${balance} is below the floor ${floor} after ${calls} faucet call(s) — STOP`)
	console.log(`  inventory: ${balance} fee-asset units (floor ${floor}, ${calls} faucet call(s))`)
	return calls
}

/**
 * Deploys (or adopts) the swapper, sets its rates and inventory, deploys (or adopts) the router bound to it and the
 * base's factory, reads both back, and writes the candidate. Throws before any write when the base disagrees with
 * the network or the chain, or a base token has no rate.
 */
export async function deployRouterOnly(o: RouterOnlyOptions): Promise<RouterOnlyResult> {
	const b = assertBaseOnNetwork(o)
	const fuel = fuelBudgetsOf(o.base)
	const journal = openDeployJournal(o.journalPath, {
		l1ChainId: o.network.l1ChainId,
		rollupVersion: o.network.rollupVersion,
		deployer: lc(o.l1.account.address),
		registry: lc(o.network.registry),
		feeJuicePortal: lc(o.network.feeJuicePortal),
	})
	await assertGeneration(o.l1, b, journal)

	const swapperArgs = swapperArgsOf(o, b)
	const fuelSwapper = await deployFuelSwapper(o.l1, journal, swapperArgs)
	assertBindings("swapper", await readFuelSwapperBindings(o.l1, fuelSwapper.address), {
		...swapperArgs,
		feeAssetHandler: fuelSwapperArgs(swapperArgs)[1],
	})
	await setRates(o.l1, fuelSwapper.address, o.rates)
	await topUpInventory(
		o.l1,
		fuelSwapper.address,
		swapperArgs.feeAsset,
		swapperArgs.feeAssetHandler,
		swapperInventoryFloor(fuel.minFuelFj),
	)

	const routerArgs = routerArgsOf(o, b, fuelSwapper.address)
	const depositRouter = await deployDepositRouter(o.l1, journal, routerArgs)
	assertBindings("router", await readRouterBindings(o.l1, depositRouter.address), { ...routerArgs, feeAsset: lc(o.network.feeJuice) })

	const candidate = routerOnlyCandidate(o.base, {
		depositRouter: depositRouter.address,
		fuelSwapper: fuelSwapper.address,
		fuel,
		routing: o.routing,
	})
	writeCandidateAtomically(o.candidatePath, candidate)
	return { candidate, fuelSwapper, depositRouter }
}

/** What `deployRouterOnly` would do, read-only: no transaction, no journal or candidate write. */
export async function planRouterOnly(o: RouterOnlyOptions): Promise<string[]> {
	const b = assertBaseOnNetwork(o)
	const fuel = fuelBudgetsOf(o.base)
	const journal = { steps: readDeployJournal(o.journalPath) }
	await assertGeneration(o.l1, b, journal)
	const swapperArgs = fuelSwapperArgs(swapperArgsOf(o, b))
	const swapper = await findAdoptable(o.l1, journal, "fuel-swapper-deployed", swapperArgs)
	const lines = [
		`signer ${o.l1.account.address} · chain ${o.network.l1ChainId}/${o.network.rollupVersion} · journal ${journal.steps.length} step(s)`,
		swapper ? `swapper: adopt ${swapper}` : `swapper: deploy TestnetFuelSwapper(${swapperArgs.join(", ")})`,
	]
	if (!swapper) {
		lines.push(`router: deploy DepositRouter bound to the new swapper; ${Object.keys(o.rates).length} rate(s) to set`)
	} else {
		const routerArgs = depositRouterArgs(routerArgsOf(o, b, swapper))
		const router = await findAdoptable(o.l1, journal, "deposit-router-deployed", routerArgs)
		lines.push(router ? `router: adopt ${router}` : `router: deploy DepositRouter(${routerArgs.join(", ")})`)
		let unset = 0
		for (const [token, rate] of Object.entries(o.rates)) if ((await rateOf(o.l1, swapper, token)) !== rate) unset++
		lines.push(`rates: ${unset} of ${Object.keys(o.rates).length} to set`)
	}
	lines.push(`inventory floor ${swapperInventoryFloor(fuel.minFuelFj)} fee-asset units; candidate → ${o.candidatePath}`)
	return lines
}
