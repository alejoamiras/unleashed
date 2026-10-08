/**
 * Pre-promotion FUELED smoke for a candidate manifest: send + swap → self-paying hub claim.
 *
 * The fueled sibling of smoke-existing-testnet.ts (which does the plain send→claim). Registers the
 * manifest's hub and the hub-derived L2 token (NO deploy), then runs ONE public fueled send through the
 * deposit router: swap a slice of the bridged token → Fee Juice at the fuel swapper's quote, bridge the
 * rest into the token's factory portal, and claim through the hub in a single self-paying tx (the
 * claimed Fee Juice pays that tx's own gas).
 *
 * This is the lean candidate gate; fuel-testnet.ts is the heavier validator (public + private +
 * minFuelFj/fjPerTx calibration). Both compose the same flows (runSend / claimViaHub).
 *
 * Real proofs: expect ~15-40 min. Run:
 *   bun run scripts/smoke-fuel-existing-testnet.ts --config <manifest> [--token <erc20>]
 * (needs PRIVATE_KEY + SEPOLIA_RPC_URL in packages/bridge-core/.env). `--token` defaults to the
 * manifest's first token.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Address } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { publicFeeJuicePayment } from "../src/fee-juice"
import type { L1Ctx } from "../src/flows"
import { runSend } from "../src/send-flow"
import { feeJuiceFor } from "./fee-juice-l2"
import { evmAbi } from "./script-artifacts"
import { ensureRouterPermit2 } from "./script-l1"
import {
	claimTokensUntilSynced,
	deployAccountIfAbsent,
	freshSchnorrAccount,
	registerHub,
	registerHubToken,
	sponsoredFpcFee,
} from "./script-l2"
import { claimTokenBlock, planFuelLeg, requireFuel, selectToken, sendGenerationOf } from "./script-send"
import {
	createL1Clients,
	createL2Wallet,
	createNode,
	loadManifestV2FromConfigArg,
	requireBridge,
	sepoliaChain,
	stopwatch,
} from "./script-bootstrap"
import { TESTNET_NODE_URL } from "../src/testnet-node"

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"
const NODE_URL = process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY required (packages/bridge-core/.env)")

const CONFIG = loadManifestV2FromConfigArg(process.argv, {
	mode: "required",
	requiredHint: "apps/tools/public/testnet-bridge.candidate.json",
})
const BRIDGE = requireBridge(CONFIG)
requireFuel(BRIDGE)
const TOKEN = selectToken(BRIDGE, process.argv)
const GENERATION = sendGenerationOf(CONFIG, BRIDGE)

const sepolia = sepoliaChain(SEPOLIA_RPC)

// Amounts are DECIMALS-DRIVEN from the manifest token: an 18-dec assumption against a 6-dec token
// requests 10^19 base units into a 10^9 mint cap and reverts on the spot.
const TOTAL = 10n * 10n ** BigInt(TOKEN.decimals)
// Env-tunable: the slice must buy ENOUGH FJ for the self-paying claim at the swapper's CURRENT rate
// (quote >= minFuelFj) — a low rate can put the default under the floor.
const FUEL_SLICE = BigInt(process.env.FUEL_SLICE_UNITS ?? (10n ** BigInt(TOKEN.decimals)).toString())

const rndNonce = () => BigInt(`0x${crypto.randomUUID().replaceAll("-", "")}`)

const balanceOf = async (contract: ContractBase, from: AztecAddress): Promise<bigint> => {
	const r = (await contract.methods.balance_of_public(from).simulate({ from } as never)) as { result?: bigint } | bigint
	return typeof r === "bigint" ? r : (r.result ?? 0n)
}

async function mintIfPermissionless(l1: L1Ctx, amount: bigint, mins: () => string): Promise<void> {
	if (TOKEN.source !== "permissionless-mint") {
		console.log(`${TOKEN.displaySymbol} is canonical — fund the sender yourself (needs ${amount} base units)`)
		return
	}
	const abi = evmAbi(TOKEN.sourceContract ?? "MintableERC20")
	const hash = await l1.wallet.writeContract({
		address: TOKEN.erc20 as Address,
		abi,
		functionName: "mint",
		args: [l1.account.address, amount],
		account: l1.account,
		chain: l1.wallet.chain,
	} as never)
	await l1.pub.waitForTransactionReceipt({ hash })
	console.log(`minted ${amount} ${TOKEN.displaySymbol} base units (${mins()})`)
}

interface L2Leg {
	hub: ContractBase
	l2Token: ContractBase
	feeJuice: ContractBase
	from: AztecAddress
}

/** A throwaway recipient (the sponsored FPC pays ONLY its deploy) plus the hub and token it claims through. */
async function buildL2Leg(mins: () => string): Promise<L2Leg> {
	const node = createNode(NODE_URL)
	const ewallet = await createL2Wallet({ nodeUrl: NODE_URL, proverEnabled: true })
	const { manager, from } = await freshSchnorrAccount(ewallet as never)
	console.log("L2 smoke account", from.toString())

	const { fee: sponsoredFee } = await sponsoredFpcFee(ewallet)
	await deployAccountIfAbsent({
		node,
		manager: manager as never,
		from,
		fee: sponsoredFee,
		log: (stage) => {
			if (stage === "deploying") console.log(`deploying L2 smoke account (real proof)… (${mins()})`)
		},
	})

	const hub = await registerHub(ewallet as never, BRIDGE.l2.hub)
	const hubAddress = AztecAddress.fromStringUnsafe(BRIDGE.l2.hub.address)
	const l2Token = await registerHubToken(ewallet as never, hubAddress, TOKEN, BRIDGE.l2.tokenClassId)
	const feeJuice = await feeJuiceFor(ewallet as never, node)
	console.log(`hub + ${TOKEN.displaySymbol} registered (${mins()})`)
	return { hub, l2Token, feeJuice, from }
}

async function main() {
	const mins = stopwatch()

	const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`)
	const { wallet, pub } = createL1Clients({ chain: sepolia, rpcUrl: SEPOLIA_RPC, account })
	const l1: L1Ctx = { pub, wallet, account }
	console.log(`fuel smoke: ${TOKEN.displaySymbol} ${TOKEN.erc20} → portal ${TOKEN.portal}, router ${GENERATION.router}`)

	await mintIfPermissionless(l1, TOTAL, mins)
	const fuel = await planFuelLeg(pub, CONFIG, TOKEN.erc20 as Address, FUEL_SLICE)
	console.log(`quote: ${FUEL_SLICE} ${TOKEN.displaySymbol}-units → ${fuel.quote} FJ-wei (floor ${fuel.minFuelOutput}) (${mins()})`)

	const { hub, l2Token, feeJuice, from } = await buildL2Leg(mins)

	await ensureRouterPermit2(l1, {
		usdc: TOKEN.erc20 as `0x${string}`,
		usdcAbi: evmAbi(TOKEN.sourceContract ?? "MintableERC20"),
		permit2: GENERATION.permit2,
		needed: TOTAL,
		mins,
	})

	const result = await runSend(
		l1,
		GENERATION,
		{
			intent: "token+gas",
			erc20: TOKEN.erc20 as Address,
			amount: TOTAL,
			aztecRecipient: from.toString() as `0x${string}`,
			isPrivate: false,
			gas: {
				fuelAmount: FUEL_SLICE,
				fuelRecipient: from.toString() as `0x${string}`,
				minFuelOutput: fuel.minFuelOutput,
				swapData: fuel.swapData,
			},
			nonce: rndNonce(),
			deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
		},
		(s) => console.log(`l1: ${s} (${mins()})`),
		{ onSecrets: () => console.log("secrets persisted (in-memory for the smoke)") },
	)
	console.log(
		`bridged: tokenLeaf ${result.tokenLeafIndex}, fuelLeaf ${result.fuelLeafIndex}, fuelReceived ${result.fuelReceived} (${mins()})`,
	)

	// The claim pays its own gas from the Fee Juice it claims in the same tx.
	const bridgedAmount = TOTAL - FUEL_SLICE
	const fjBefore = await balanceOf(feeJuice, from)
	const outcome = await claimTokensUntilSynced({
		hub,
		claim: {
			token: claimTokenBlock(TOKEN, result.token as NonNullable<typeof result.token>),
			recipient: from.toString(),
			amount: bridgedAmount,
			claimValue: Fr.fromHexString(result.tokenClaimValueHex as string),
			leafIndex: result.tokenLeafIndex as bigint,
			isPrivate: false,
			from: from.toString(),
		},
		sendOpts: {
			from,
			fee: {
				paymentMethod: publicFeeJuicePayment(from, {
					claimAmount: result.fuelReceived as bigint,
					claimSecret: Fr.fromHexString(result.fuelSecretHex as string),
					messageLeafIndex: result.fuelLeafIndex as bigint,
				}),
			},
			wait: { waitForStatus: TxStatus.PROPOSED },
		},
	})

	const tokenBal = await balanceOf(l2Token, from)
	const fjAfter = await balanceOf(feeJuice, from)
	if (tokenBal < bridgedAmount) throw new Error(`token balance ${tokenBal} < bridged ${bridgedAmount}`)
	if (fjAfter <= fjBefore) throw new Error("no Fee Juice landed as balance (fee ate everything?)")
	console.log(`\n✅ FUELED smoke PASSED — send+swap→self-paying ${outcome.path} in ${mins()}.`)
	console.log(`   ${TOKEN.displaySymbol} balance ${tokenBal}, FJ gained ${fjAfter - fjBefore}. Safe to promote.`)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
