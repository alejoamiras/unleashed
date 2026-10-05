/**
 * Records the LI.FI fork fixtures under `contracts/bridge/evm/test/fixtures/lifi/`. Public RPCs prune old
 * state, so a fixture pins blocks that only stay forkable for minutes: `--run` records and immediately runs the
 * fork suite at those blocks with `LIFI_RECORD=1`, which also writes the receipts the TS discovery tests read.
 *
 *   bun scripts/lifi-fixtures.ts testnet-rail [--run]
 *
 * RPCs: `BASE_SEPOLIA_RPC_URL` and `SEPOLIA_RPC_URL`, defaulting to PublicNode (no key; complete
 * `eth_getLogs` and CORS, unlike gateways that truncate silently).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
	type Address,
	createPublicClient,
	encodeFunctionData,
	getAddress,
	type Hex,
	http,
	keccak256,
	type PublicClient,
	slice,
	toHex,
} from "viem"
import { buildAcrossV4Deposit, encodeLifiReceiverMessage } from "../src/across-v4"
import type { LifiSwapData } from "../src/lifi-abi"
import { resolveBin, run } from "./run"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..")
const EVM_ROOT = join(repoRoot, "contracts", "bridge", "evm")
const FIXTURE_DIR = join(EVM_ROOT, "test", "fixtures", "lifi")
const RECORDER = "lifi-fixtures.ts testnet-rail v1"

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL || "https://base-sepolia-rpc.publicnode.com"
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"

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

function testnetFactory(): Address {
	const manifest = JSON.parse(readFileSync(join(repoRoot, "apps", "tools", "public", "testnet-bridge.json"), "utf8"))
	return getAddress(manifest.bridge.l1.factory)
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
	const factory = testnetFactory()
	const [srcBlock, dstBlock] = await Promise.all([pinnedBlock(base), pinnedBlock(sepolia)])
	const portal = await sepolia.readContract({
		address: factory,
		abi: FACTORY_ABI,
		functionName: "predictPortal",
		args: [TESTNET_RAIL.destination.usdc],
		blockNumber: dstBlock.number,
	})

	const user = label("user")
	const transactionId = keccak256(toHex("unleashed:lifi-testnet-rail:tx"))
	const step: LifiSwapData = {
		callTo: portal,
		approveTo: portal,
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
	const quoteTimestamp = srcBlock.timestamp
	const fillDeadline = quoteTimestamp + FILL_WINDOW_S
	const tx = buildAcrossV4Deposit({
		diamond: TESTNET_RAIL.source.diamond,
		transactionId,
		integrator: "unleashed",
		user,
		inputToken: TESTNET_RAIL.source.usdc,
		inputAmount: INPUT_AMOUNT,
		destinationChainId: BigInt(TESTNET_RAIL.destination.chainId),
		destinationReceiver: TESTNET_RAIL.destination.receiverAcrossV4,
		outputToken: TESTNET_RAIL.destination.usdc,
		outputAmount: OUTPUT_AMOUNT,
		quoteTimestamp,
		fillDeadline,
		steps: [step],
	})

	const fixture = {
		recorder: RECORDER,
		source: { ...TESTNET_RAIL.source, block: Number(srcBlock.number), timestamp: srcBlock.timestamp },
		destination: { ...TESTNET_RAIL.destination, block: Number(dstBlock.number), factory, portal },
		inputs: {
			transactionId,
			integrator: "unleashed",
			user,
			inputAmount: INPUT_AMOUNT.toString(),
			outputAmount: OUTPUT_AMOUNT.toString(),
			quoteTimestamp,
			fillDeadline,
			aztecRecipient: AZTEC_RECIPIENT,
			secretHash: SECRET_HASH,
			step: { ...step, fromAmount: step.fromAmount.toString() },
		},
		message: encodeLifiReceiverMessage(transactionId, [step], user),
		calldata: tx.data,
	}
	mkdirSync(FIXTURE_DIR, { recursive: true })
	const path = join(FIXTURE_DIR, "testnet-rail.json")
	writeFileSync(path, `${JSON.stringify(fixture, null, "\t")}\n`)
	return path
}

function runRailFork(): void {
	const forge = resolveBin("forge", { envVar: "FORGE_BIN", candidates: [], prefer: "path" })
	run(forge, ["test", "--match-contract", "LifiTestnetRailFork", "-vv"], {
		cwd: EVM_ROOT,
		stdio: "inherit",
		env: { ...process.env, BASE_SEPOLIA_RPC_URL: BASE_SEPOLIA_RPC, SEPOLIA_RPC_URL: SEPOLIA_RPC, LIFI_RECORD: "1" },
	})
}

async function main(): Promise<void> {
	const command = process.argv[2]
	if (command !== "testnet-rail") throw new Error("usage: bun scripts/lifi-fixtures.ts testnet-rail [--run]")
	const path = await recordTestnetRail()
	console.log(`wrote ${path}`)
	if (process.argv.includes("--run")) runRailFork()
}

if (import.meta.main) await main()
