/**
 * Records the LI.FI fork fixtures under `contracts/bridge/evm/test/fixtures/lifi/`. Public RPCs prune old
 * state, so a fixture pins blocks that only stay forkable for minutes: `--run` builds first, records, and
 * immediately runs the fork suites at those blocks with `LIFI_RECORD=1`, which also writes the receipts the TS
 * discovery tests read.
 *
 *   bun scripts/lifi-fixtures.ts [testnet-rail | mainnet] [--run]     (no command: both)
 *
 * `mainnet` spends five li.quest calls and therefore requires `LIFI_LIVE=1`. RPCs: `BASE_SEPOLIA_RPC_URL`,
 * `SEPOLIA_RPC_URL`, `ETH_RPC_URL`, `BASE_RPC_URL`, `ARBITRUM_RPC_URL`, defaulting to PublicNode (no key;
 * complete `eth_getLogs` and CORS, unlike gateways that truncate silently).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
	type AbiParameterToPrimitiveType,
	type Address,
	createPublicClient,
	encodeFunctionData,
	erc20Abi,
	getAddress,
	type Hex,
	http,
	keccak256,
	type PublicClient,
	slice,
	toHex,
	zeroHash,
} from "viem"
import { buildAcrossV4Deposit, encodeLifiReceiverMessage } from "../src/across-v4"
import { type DEPOSIT_INTENT_COMPONENTS, DEPOSIT_ROUTER_ABI } from "../src/deposit-router-abi"
import { LIFI_SWAP_DATA_COMPONENTS, type LifiSwapData } from "../src/lifi-abi"
import { LIFI_INTEGRATOR } from "../src/lifi-gas"
import { MAINNET, recordMainnetQuotes } from "./lifi-fixtures-mainnet"
import { resolveBin, run } from "./run"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..")
const EVM_ROOT = join(repoRoot, "contracts", "bridge", "evm")
const FIXTURE_DIR = join(EVM_ROOT, "test", "fixtures", "lifi")
const RECORDER = "lifi-fixtures.ts testnet-rail v2"

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL || "https://base-sepolia-rpc.publicnode.com"
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"
const ETH_RPC = process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com"
const BASE_RPC = process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com"
const ARBITRUM_RPC = process.env.ARBITRUM_RPC_URL || "https://arbitrum-one-rpc.publicnode.com"

/** LI.FI's and Across's deployed testnet contracts (lifinance/contracts `deployments/*.json`, Across's docs). */
const TESTNET_RAIL = {
	source: {
		chainId: 84532,
		diamond: "0x816Fc6EeE47e3157A666827a0C06205294C81770",
		spokePool: "0x82B564983aE7274c86695917BBf8C99ECb6F0F8F",
		usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
	},
	destination: {
		chainId: 11155111,
		spokePool: "0x5ef6C01E11889d86803e0B23e3cB3F9E9d97B662",
		receiverAcrossV4: "0x51Cd54Fab6Bc72c4c313C7d2DD4E0bE1A4390f44",
		executor: "0x7b01E6A2badAB05e2afaAeFf963f60B5FCF3a533",
		usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
	},
} as const

const INPUT_AMOUNT = 5_000_000n
/** About Across's testnet relay fee on 5 USDC; the fork's relayer delivers exactly this. */
const OUTPUT_AMOUNT = 4_500_000n
const FILL_WINDOW_S = 7_200
/** Blocks behind the head, so both forks pin a block every provider has already served. */
const CONFIRMATIONS = 3n
/** Small enough to be a BN254 field element, as the portal requires. */
const AZTEC_RECIPIENT: Hex = "0x0000000000000000000000000000000000000000000000000000000000a11ce0"
const SECRET_HASH: Hex = "0x000000000000000000000000000000000000000000000000000000000005ec7e"
/** Distinct from `SECRET_HASH`, so a crossed leg shows in the forks. */
const FUEL_SECRET_HASH: Hex = "0x00000000000000000000000000000000000000000000000000000000000f5ec7"

/** The router variants' fuel slice out of the delivered 4.5 USDC (fuel-only swaps all of it). */
const FUEL_SLICE = 1_000_000n
/** The `TestnetFuelSwapper` rate the fork sets for USDC: Fee Juice base units per whole USDC. */
const FJ_PER_USDC = 100n * 10n ** 18n
/** Floors sit 1 % under the swapper's fixed-rate quote, where a client's slippage would put them. */
const FUEL_FLOOR_BPS = 9_900n

const PORTAL_ABI = [
	{
		type: "function",
		name: "depositToAztecPublic",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "_to", type: "bytes32" },
			{ name: "_amount", type: "uint256" },
			{ name: "_secretHash", type: "bytes32" },
		],
		outputs: [
			{ name: "", type: "bytes32" },
			{ name: "", type: "uint256" },
		],
	},
] as const

const FACTORY_ABI = [
	{
		type: "function",
		name: "predictPortal",
		stateMutability: "view",
		inputs: [{ name: "token", type: "address" }],
		outputs: [{ name: "", type: "address" }],
	},
] as const

const FEE_JUICE_PORTAL_ABI = [
	{
		type: "function",
		name: "UNDERLYING",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "address" }],
	},
] as const

/** `GenericSwapFacetV3.swapTokensSingleV3ERC20ToERC20`, which `TestnetFuelSwapper` answers with LI.FI's exact ABI. */
const SWAP_SINGLE_ABI = [
	{
		type: "function",
		name: "swapTokensSingleV3ERC20ToERC20",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "_transactionId", type: "bytes32" },
			{ name: "_integrator", type: "string" },
			{ name: "_referrer", type: "string" },
			{ name: "_receiver", type: "address" },
			{ name: "_minAmountOut", type: "uint256" },
			{ name: "_swapData", type: "tuple", components: LIFI_SWAP_DATA_COMPONENTS },
		],
		outputs: [],
	},
] as const

type DepositIntent = AbiParameterToPrimitiveType<{ type: "tuple"; components: typeof DEPOSIT_INTENT_COMPONENTS }>

/** The live Sepolia generation's bindings the rail deposits into, from the promoted testnet manifest. */
interface TestnetGeneration {
	factory: Address
	permit2: Address
	feeJuicePortal: Address
	feeAsset: Address
	feeAssetHandler: Address
	privateFpc: Hex
}

function testnetGeneration(): TestnetGeneration {
	const m = JSON.parse(readFileSync(join(repoRoot, "apps", "tools", "public", "testnet-bridge.json"), "utf8"))
	return {
		factory: getAddress(m.bridge.l1.factory),
		permit2: getAddress(m.bridge.l1.permit2),
		feeJuicePortal: getAddress(m.feeJuice.portal),
		feeAsset: getAddress(m.feeJuice.asset),
		feeAssetHandler: getAddress(m.feeJuice.feeAssetHandler),
		privateFpc: m.privateFpc.address,
	}
}

interface Destination {
	portal: Address
	feeAsset: Address
	usdcDecimals: number
}

async function destinationAt(sepolia: PublicClient, gen: TestnetGeneration, blockNumber: bigint): Promise<Destination> {
	const usdc = TESTNET_RAIL.destination.usdc
	const [portal, feeAsset, usdcDecimals] = await Promise.all([
		sepolia.readContract({ address: gen.factory, abi: FACTORY_ABI, functionName: "predictPortal", args: [usdc], blockNumber }),
		sepolia.readContract({ address: gen.feeJuicePortal, abi: FEE_JUICE_PORTAL_ABI, functionName: "UNDERLYING", blockNumber }),
		sepolia.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals", blockNumber }),
	])
	// The router binds `UNDERLYING()` at construction; a manifest naming another asset is stale.
	if (getAddress(feeAsset) !== gen.feeAsset) {
		throw new Error(`FeeJuicePortal.UNDERLYING() is ${feeAsset}, the manifest says ${gen.feeAsset}`)
	}
	return { portal, feeAsset: gen.feeAsset, usdcDecimals }
}

interface Rail {
	user: Address
	quoteTimestamp: number
	fillDeadline: number
}

/** The destination message and the Diamond call that carries it, for one Executor step. */
function railDeposit(rail: Rail, transactionId: Hex, step: LifiSwapData): { message: Hex; calldata: Hex } {
	const tx = buildAcrossV4Deposit({
		diamond: TESTNET_RAIL.source.diamond,
		transactionId,
		integrator: LIFI_INTEGRATOR,
		user: rail.user,
		inputToken: TESTNET_RAIL.source.usdc,
		inputAmount: INPUT_AMOUNT,
		destinationChainId: BigInt(TESTNET_RAIL.destination.chainId),
		destinationReceiver: TESTNET_RAIL.destination.receiverAcrossV4,
		outputToken: TESTNET_RAIL.destination.usdc,
		outputAmount: OUTPUT_AMOUNT,
		quoteTimestamp: rail.quoteTimestamp,
		fillDeadline: rail.fillDeadline,
		steps: [step],
	})
	return { message: encodeLifiReceiverMessage(transactionId, [step], rail.user), calldata: tx.data }
}

/** The intents the router variants carry; `quote` is the swapper's fixed-rate output for a USDC amount. */
function routerIntents(privateFpc: Hex, quote: (amount: bigint) => bigint): Record<string, DepositIntent> {
	const floor = (amount: bigint) => (quote(amount) * FUEL_FLOOR_BPS) / 10_000n
	const publicLegs: DepositIntent = {
		token: TESTNET_RAIL.destination.usdc,
		aztecRecipient: AZTEC_RECIPIENT,
		tokenSecretHash: SECRET_HASH,
		isPrivate: false,
		fuelSlice: FUEL_SLICE,
		fuelRecipient: AZTEC_RECIPIENT,
		fuelSecretHash: FUEL_SECRET_HASH,
		minFuelOutput: floor(FUEL_SLICE),
	}
	return {
		public: publicLegs,
		private: { ...publicLegs, aztecRecipient: zeroHash, isPrivate: true, fuelRecipient: privateFpc },
		fuelOnly: {
			...publicLegs,
			aztecRecipient: zeroHash,
			tokenSecretHash: zeroHash,
			fuelSlice: OUTPUT_AMOUNT,
			minFuelOutput: floor(OUTPUT_AMOUNT),
		},
		floorUnmet: { ...publicLegs, minFuelOutput: quote(FUEL_SLICE) + 1n },
	}
}

interface RouterAddresses {
	router: Address
	swapper: Address
	feeAsset: Address
}

/** The Executor's one step: `bridgeFromCaller` with the swapper's call as `swapData`, the floor as `_minAmountOut`. */
function routerStep(at: RouterAddresses, transactionId: Hex, intent: DepositIntent): LifiSwapData {
	const swapData = encodeFunctionData({
		abi: SWAP_SINGLE_ABI,
		functionName: "swapTokensSingleV3ERC20ToERC20",
		args: [
			transactionId,
			LIFI_INTEGRATOR,
			"",
			at.router,
			intent.minFuelOutput,
			{
				callTo: at.swapper,
				approveTo: at.swapper,
				sendingAssetId: intent.token,
				receivingAssetId: at.feeAsset,
				fromAmount: intent.fuelSlice,
				callData: "0x",
				requiresDeposit: true,
			},
		],
	})
	return {
		callTo: at.router,
		approveTo: at.router,
		sendingAssetId: intent.token,
		receivingAssetId: intent.token,
		fromAmount: OUTPUT_AMOUNT,
		// Across delivers exactly `outputAmount`, so it is both bounds.
		callData: encodeFunctionData({
			abi: DEPOSIT_ROUTER_ABI,
			functionName: "bridgeFromCaller",
			args: [intent, swapData, OUTPUT_AMOUNT, OUTPUT_AMOUNT],
		}),
		requiresDeposit: false,
	}
}

/**
 * Our `DepositRouter` and `TestnetFuelSwapper` at label addresses on the live generation. Each variant carries its
 * own Diamond call, so a router case's source deposit emits exactly the message its fill runs.
 */
function routerFixture(rail: Rail, gen: TestnetGeneration, dst: Destination) {
	const at: RouterAddresses = { router: label("router"), swapper: label("swapper"), feeAsset: dst.feeAsset }
	const quote = (amount: bigint) => (amount * FJ_PER_USDC) / 10n ** BigInt(dst.usdcDecimals)
	const variants = Object.entries(routerIntents(gen.privateFpc, quote)).map(([name, intent]) => {
		const transactionId = keccak256(toHex(`unleashed:lifi-testnet-rail:tx:${name}`))
		return [name, { transactionId, intent, ...railDeposit(rail, transactionId, routerStep(at, transactionId, intent)) }] as const
	})
	return {
		...at,
		permit2: gen.permit2,
		feeJuicePortal: gen.feeJuicePortal,
		feeAssetHandler: gen.feeAssetHandler,
		fjPerWholeToken: FJ_PER_USDC,
		minReceived: OUTPUT_AMOUNT,
		maxPull: OUTPUT_AMOUNT,
		variants: Object.fromEntries(variants),
	}
}

async function pinnedBlock(client: PublicClient): Promise<{ number: bigint; timestamp: number }> {
	const head = await client.getBlockNumber()
	const block = await client.getBlock({ blockNumber: head - CONFIRMATIONS })
	return { number: block.number, timestamp: Number(block.timestamp) }
}

function label(name: string): Address {
	return getAddress(slice(keccak256(toHex(`unleashed:lifi-testnet-rail:${name}`)), 12))
}

async function recordTestnetRail(): Promise<string> {
	const base = createPublicClient({ transport: http(BASE_SEPOLIA_RPC) })
	const sepolia = createPublicClient({ transport: http(SEPOLIA_RPC) })
	const [srcChain, dstChain] = await Promise.all([base.getChainId(), sepolia.getChainId()])
	if (srcChain !== TESTNET_RAIL.source.chainId || dstChain !== TESTNET_RAIL.destination.chainId) {
		throw new Error(`RPC chain ids ${srcChain}/${dstChain}, expected Base Sepolia/Sepolia`)
	}
	const gen = testnetGeneration()
	const [srcBlock, dstBlock] = await Promise.all([pinnedBlock(base), pinnedBlock(sepolia)])
	const dst = await destinationAt(sepolia, gen, dstBlock.number)

	const rail: Rail = {
		user: label("user"),
		quoteTimestamp: srcBlock.timestamp,
		fillDeadline: srcBlock.timestamp + FILL_WINDOW_S,
	}
	const transactionId = keccak256(toHex("unleashed:lifi-testnet-rail:tx"))
	// No router in between: the Executor deposits straight into the USDC clone.
	const step: LifiSwapData = {
		callTo: dst.portal,
		approveTo: dst.portal,
		sendingAssetId: TESTNET_RAIL.destination.usdc,
		receivingAssetId: TESTNET_RAIL.destination.usdc,
		fromAmount: OUTPUT_AMOUNT,
		callData: encodeFunctionData({
			abi: PORTAL_ABI,
			functionName: "depositToAztecPublic",
			args: [AZTEC_RECIPIENT, OUTPUT_AMOUNT, SECRET_HASH],
		}),
		requiresDeposit: false,
	}
	const fixture = {
		recorder: RECORDER,
		source: { ...TESTNET_RAIL.source, block: Number(srcBlock.number), timestamp: srcBlock.timestamp },
		destination: { ...TESTNET_RAIL.destination, block: Number(dstBlock.number), factory: gen.factory, portal: dst.portal },
		inputs: {
			transactionId,
			integrator: LIFI_INTEGRATOR,
			user: rail.user,
			inputAmount: INPUT_AMOUNT,
			outputAmount: OUTPUT_AMOUNT,
			quoteTimestamp: rail.quoteTimestamp,
			fillDeadline: rail.fillDeadline,
			aztecRecipient: AZTEC_RECIPIENT,
			secretHash: SECRET_HASH,
			step,
		},
		...railDeposit(rail, transactionId, step),
		router: routerFixture(rail, gen, dst),
	}
	mkdirSync(FIXTURE_DIR, { recursive: true })
	const path = join(FIXTURE_DIR, "testnet-rail.json")
	// Amounts as decimal strings, which `vm.parseJsonUint` reads and JSON cannot hold as numbers.
	const json = JSON.stringify(fixture, (_, v) => (typeof v === "bigint" ? v.toString() : v), "\t")
	writeFileSync(path, `${json}\n`)
	return path
}

async function chainHead(rpc: string, chainId: number): Promise<{ block: number; timestamp: number }> {
	const client = createPublicClient({ transport: http(rpc) })
	const actual = await client.getChainId()
	if (actual !== chainId) throw new Error(`RPC ${rpc} is chain ${actual}, expected ${chainId}`)
	const pinned = await pinnedBlock(client)
	return { block: Number(pinned.number), timestamp: pinned.timestamp }
}

async function recordMainnet(): Promise<string> {
	if (process.env.LIFI_LIVE !== "1") throw new Error("mainnet spends five li.quest calls: set LIFI_LIVE=1")
	const [ethereum, base, arbitrum] = await Promise.all([
		chainHead(ETH_RPC, MAINNET.ethereum.chainId),
		chainHead(BASE_RPC, MAINNET.base.chainId),
		chainHead(ARBITRUM_RPC, MAINNET.arbitrum.chainId),
	])
	const { fixture, raw } = await recordMainnetQuotes({ ethereum, base, arbitrum })
	mkdirSync(FIXTURE_DIR, { recursive: true })
	const path = join(FIXTURE_DIR, "mainnet.json")
	writeFileSync(path, `${JSON.stringify(fixture, null, "\t")}\n`)
	writeFileSync(join(FIXTURE_DIR, "mainnet.raw.json"), `${JSON.stringify(raw, null, "\t")}\n`)
	return path
}

const FORK_SUITES = {
	"testnet-rail": "LifiTestnetRailFork",
	mainnet: "Lifi(Destination|StargateCompose|Replay)Fork",
} as const
type Command = keyof typeof FORK_SUITES

function forge(args: string[]): void {
	const bin = resolveBin("forge", { envVar: "FORGE_BIN", candidates: [], prefer: "path" })
	run(bin, args, {
		cwd: EVM_ROOT,
		stdio: "inherit",
		env: {
			...process.env,
			BASE_SEPOLIA_RPC_URL: BASE_SEPOLIA_RPC,
			SEPOLIA_RPC_URL: SEPOLIA_RPC,
			ETH_RPC_URL: ETH_RPC,
			BASE_RPC_URL: BASE_RPC,
			ARBITRUM_RPC_URL: ARBITRUM_RPC,
			LIFI_RECORD: "1",
		},
	})
}

function commandsFrom(argv: string[]): Command[] {
	const named = argv[2]
	if (named === undefined || named === "--run") return ["testnet-rail", "mainnet"]
	if (named in FORK_SUITES) return [named as Command]
	throw new Error("usage: bun scripts/lifi-fixtures.ts [testnet-rail | mainnet] [--run]")
}

async function main(): Promise<void> {
	const commands = commandsFrom(process.argv)
	const runForks = process.argv.includes("--run")
	// Compile before recording: the pinned blocks start ageing out of the providers' state the moment they are read.
	if (runForks) forge(["build"])
	for (const command of commands) {
		const path = command === "mainnet" ? await recordMainnet() : await recordTestnetRail()
		console.log(`wrote ${path}`)
	}
	if (runForks) forge(["test", "--match-contract", `^(${commands.map((c) => FORK_SUITES[c]).join("|")})$`, "-vv"])
}

if (import.meta.main) await main()
