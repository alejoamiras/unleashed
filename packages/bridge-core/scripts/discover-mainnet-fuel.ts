/**
 * Mainnet swap-fuel discovery (READ-ONLY — eth_call only, no key, no spend). Mainnet does not SEED
 * pools the way testnet does; it DISCOVERS the canonical Uniswap V4 liquidity the fuel route rides.
 * Run it before a mainnet deploy and re-run it to fail closed on drift:
 *
 *   1. verifies the doc-pinned V4 addresses answer on-chain (code + a live quote through them),
 *   2. verifies the token identities (Circle USDC, WETH9, the fee asset) and the
 *      portal.UNDERLYING() == fee-asset binding,
 *   3. sweeps the standard fee tiers for BOTH route legs — USDC/WETH and, critically,
 *      NATIVE-ETH/feeAsset: the router's route shape is fixed (token → WETH, unwrap, ETH → FJ), so a
 *      world with only WETH-paired fee-asset liquidity CANNOT serve it. That outcome is reported
 *      explicitly, never papered over.
 *   4. batch-quotes every surviving combination through the app's own quoter path and prints the
 *      manifest's `bridge.l1.swap` pool half.
 *
 *   bun scripts/discover-mainnet-fuel.ts            # ETH_RPC_URL overrides the default RPC
 */
import { http, type Address, createPublicClient, defineChain, encodeAbiParameters, keccak256, parseAbiParameters } from "viem"
import { quoteFuelPathsBatched } from "../src/quote"
import { buildFuelRoute, type FuelPoolParams } from "../src/route"

// ── Doc-pinned canonical addresses (docs.uniswap.org/contracts/v4/deployments).
// Pins are the starting claim; the on-chain checks below are the authority.
const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90" as const
const V4_QUOTER = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203" as const
// Multicall3's deterministic deployment — the same address on every chain it is deployed to.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const
const CIRCLE_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const
// The live Aztec pair (same defaults as DeployBridgeMainnet.s.sol; env-overridable there).
const FEE_JUICE_PORTAL = "0xaf73Dd51D1eb8a079BB097f39c832cDD00ac691c" as const
const FEE_JUICE_ASSET = "0xA27EC0006e59f245217Ff08CD52A7E8b169E62D2" as const

const NATIVE = "0x0000000000000000000000000000000000000000" as const
const FEE_TIERS: FuelPoolParams[] = [
	{ fee: 100, tickSpacing: 1 },
	{ fee: 500, tickSpacing: 10 },
	{ fee: 3000, tickSpacing: 60 },
	{ fee: 10000, tickSpacing: 200 },
]

const RPC = process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com"
const mainnet = defineChain({
	id: 1,
	name: "ethereum",
	nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
	rpcUrls: { default: { http: [RPC] } },
})
const pub = createPublicClient({ chain: mainnet, transport: http(RPC) })

const ERC20_META_ABI = [
	{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
	{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const
const PORTAL_ABI = [{ type: "function", name: "UNDERLYING", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const
const EXTSLOAD_ABI = [
	{ type: "function", name: "extsload", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
] as const

const DUST = 10_000n // 0.01 USDC
const ONE = 1_000_000n
const TWENTY_FIVE = 25_000_000n

function poolId(c0: Address, c1: Address, fee: number, tickSpacing: number): `0x${string}` {
	return keccak256(
		encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [c0, c1, fee, tickSpacing, NATIVE]),
	)
}

/** slot0 sqrtPriceX96 via PoolManager.extsload of the pool's state slot (StateLibrary layout). */
async function sqrtPriceOf(id: `0x${string}`): Promise<bigint> {
	const stateSlot = keccak256(`0x${id.slice(2)}${"0".repeat(63)}6` as `0x${string}`)
	const raw = await pub.readContract({ address: POOL_MANAGER, abi: EXTSLOAD_ABI, functionName: "extsload", args: [stateSlot] })
	return BigInt(raw) & ((1n << 160n) - 1n)
}

async function requireCode(name: string, addr: Address): Promise<void> {
	const code = await pub.getCode({ address: addr })
	if (!code || code === "0x") throw new Error(`${name} has NO CODE at ${addr} — doc pin wrong or wrong chain; STOP`)
	console.log(`✓ ${name} has code (${addr})`)
}

async function assertPins(): Promise<void> {
	const chainId = await pub.getChainId()
	if (chainId !== 1) throw new Error(`connected chain id ${chainId} != 1 (Ethereum mainnet); STOP`)
	for (const [name, addr] of [
		["PoolManager", POOL_MANAGER],
		["V4Quoter", V4_QUOTER],
		["Multicall3", MULTICALL3],
		["WETH9", WETH],
		["Circle USDC", CIRCLE_USDC],
		["FeeJuicePortal", FEE_JUICE_PORTAL],
		["FeeJuiceAsset", FEE_JUICE_ASSET],
	] as const) {
		await requireCode(name, addr)
	}
}

/** Token identities plus the portal↔fee-asset binding; returns the fee asset's symbol for display. */
async function assertIdentities(): Promise<string> {
	const [usdcSym, usdcDec, wethSym, fjSym, fjDec, underlying] = await Promise.all([
		pub.readContract({ address: CIRCLE_USDC, abi: ERC20_META_ABI, functionName: "symbol" }),
		pub.readContract({ address: CIRCLE_USDC, abi: ERC20_META_ABI, functionName: "decimals" }),
		pub.readContract({ address: WETH, abi: ERC20_META_ABI, functionName: "symbol" }),
		pub.readContract({ address: FEE_JUICE_ASSET, abi: ERC20_META_ABI, functionName: "symbol" }),
		pub.readContract({ address: FEE_JUICE_ASSET, abi: ERC20_META_ABI, functionName: "decimals" }),
		pub.readContract({ address: FEE_JUICE_PORTAL, abi: PORTAL_ABI, functionName: "UNDERLYING" }),
	])
	if (usdcSym !== "USDC" || usdcDec !== 6) throw new Error(`USDC identity mismatch: ${usdcSym}/${usdcDec}; STOP`)
	if (wethSym !== "WETH") throw new Error(`WETH identity mismatch: ${wethSym}; STOP`)
	if (fjDec !== 18) throw new Error(`fee asset decimals ${fjDec} != 18; STOP`)
	if (underlying.toLowerCase() !== FEE_JUICE_ASSET.toLowerCase()) {
		throw new Error(`portal UNDERLYING ${underlying} != fee asset ${FEE_JUICE_ASSET}; STOP`)
	}
	console.log(`✓ identities — USDC/6, WETH, fee asset ${fjSym}/18, portal UNDERLYING matches`)
	return fjSym
}

/** The tiers whose pool is initialized on chain. Initialized is not liquid — the quotes below decide. */
async function initializedTiers(label: string, c0: Address, c1: Address): Promise<FuelPoolParams[]> {
	const live: FuelPoolParams[] = []
	for (const t of FEE_TIERS) {
		const price = await sqrtPriceOf(poolId(c0, c1, t.fee, t.tickSpacing))
		if (price > 0n) {
			live.push(t)
			console.log(`  ${label} fee ${t.fee}/${t.tickSpacing}: INITIALIZED (sqrtPriceX96 ${price})`)
		}
	}
	if (live.length === 0) console.log(`  ${label}: no initialized pool on the standard tiers`)
	return live
}

/** Quote `amountIn` USDC through every tokenWeth tier at one fixed ETH/FJ leg, in one batch. */
async function quoteTiers(tiers: FuelPoolParams[], ethFj: FuelPoolParams, amountIn: bigint): Promise<(bigint | undefined)[]> {
	const routes = tiers.map((tokenWeth) => buildFuelRoute({ token: CIRCLE_USDC, weth: WETH, feeJuice: FEE_JUICE_ASSET, tokenWeth, ethFj }))
	const quotes = await quoteFuelPathsBatched(pub, V4_QUOTER, MULTICALL3, routes, amountIn)
	return quotes.map((q) => ("out" in q ? q.out : undefined))
}

interface Winner {
	ethFj: FuelPoolParams
	/** Every viable USDC/WETH tier under that leg, best output first — the manifest's `tiers`. */
	tiers: FuelPoolParams[]
	out1: bigint
}

/** The best ETH/FJ leg and the token tiers that are viable under it, at 1 USDC in. */
async function pickWinner(usdcWeth: FuelPoolParams[], ethFjTiers: FuelPoolParams[], fjSym: string): Promise<Winner> {
	let winner: Winner | undefined
	for (const ethFj of ethFjTiers) {
		const outs = await quoteTiers(usdcWeth, ethFj, ONE)
		const viable = usdcWeth
			.map((tokenWeth, i) => ({ tokenWeth, out: outs[i] }))
			.filter((r): r is { tokenWeth: FuelPoolParams; out: bigint } => r.out !== undefined && r.out > 0n)
			.sort((a, b) => (b.out > a.out ? 1 : -1))
		for (const r of viable) {
			console.log(
				`  USDC/WETH ${r.tokenWeth.fee} → ETH/${fjSym} ${ethFj.fee}: 1 USDC → ${(Number(r.out) / 1e18).toFixed(4)} ${fjSym}`,
			)
		}
		const best = viable[0]
		if (best && (!winner || best.out > winner.out1)) {
			winner = { ethFj, tiers: viable.map((r) => r.tokenWeth), out1: best.out }
		}
	}
	if (!winner) throw new Error("no viable quoted route across the initialized tiers; STOP")
	return winner
}

/** Dust must quote (a route that dies on dust is unusable) and 25 USDC gives the depth signal. */
async function reportDepth(winner: Winner, fjSym: string): Promise<void> {
	const [dust] = await quoteTiers([winner.tiers[0]], winner.ethFj, DUST)
	const [out25] = await quoteTiers([winner.tiers[0]], winner.ethFj, TWENTY_FIVE)
	if (dust === undefined || dust <= 0n) throw new Error("the winning route does not quote a dust probe — unusable; STOP")
	const impact = out25 === undefined ? undefined : (1 - Number(out25) / 25 / Number(winner.out1)) * 100
	console.log(
		`✓ winner depth — dust ${dust} wei, 25 USDC impact vs 1: ${impact === undefined ? "n/a" : `${impact.toFixed(2)}%`} ` +
			`(1 USDC → ${(Number(winner.out1) / 1e18).toFixed(4)} ${fjSym})`,
	)
}

async function main(): Promise<void> {
	await assertPins()
	const fjSym = await assertIdentities()

	const usdcWeth = await initializedTiers("USDC/WETH", CIRCLE_USDC, WETH)
	const ethFjTiers = await initializedTiers("ETH(native)/feeAsset", NATIVE, FEE_JUICE_ASSET)
	// Diagnostic only: the fixed route unwraps to native before the fee-asset hop, so WETH-paired
	// fee-asset liquidity cannot serve it.
	await initializedTiers("WETH/feeAsset (diagnostic — the fixed route CANNOT use it)", FEE_JUICE_ASSET, WETH)
	if (usdcWeth.length === 0) throw new Error("no USDC/WETH V4 pool on the standard fee tiers; STOP")
	if (ethFjTiers.length === 0) {
		throw new Error(
			"no NATIVE-ETH/feeAsset V4 pool on the standard fee tiers — the fixed route (unwrap → native hop) cannot run; " +
				"if only WETH-paired fee-asset liquidity exists this needs a swap-target change, not a pin change; STOP",
		)
	}

	const winner = await pickWinner(usdcWeth, ethFjTiers, fjSym)
	await reportDepth(winner, fjSym)

	console.log("\n── bridge.l1.swap (pool half) ──")
	console.log(
		JSON.stringify(
			{
				poolManager: POOL_MANAGER,
				quoter: V4_QUOTER,
				multicall3: MULTICALL3,
				weth: WETH,
				feeJuice: FEE_JUICE_ASSET,
				tiers: winner.tiers,
				ethFj: winner.ethFj,
			},
			null,
			2,
		),
	)
	console.log("slippageBps, minFuelFj, fjPerTx and fjRegister are calibrated live — see fuel-testnet.ts.")
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e)
	process.exit(1)
})
