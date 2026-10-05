/**
 * MAINNET PrivateFPC dust canary — the descriptor's authoritative on-net proof (run AFTER
 * deploy-private-fpc-mainnet.ts + check-fpc-version --mode require-deployed, BEFORE any real
 * private-fuel funding or promotion). Proves the full private lane live with dust:
 *
 *   1. sizes the dust from the LIVE fee ceiling — 2 × getFeeLimit(PRIVATE_CLAIM_GAS × worst fees),
 *      the same formula as testnet's MIN_FUEL_FJ calibration, so the printed value IS the
 *      calibrated `minFuelFj` for the mainnet manifest;
 *   2. L1: approves + deposits that dust of $AZTEC to the FeeJuicePortal, claimer-bound to the
 *      PrivateFPC (planPrivateFuelDeposit — derived secret, never random);
 *   3. L2: the carrier-less claim — BatchCall([]) paid by privateMintAndPayFee (FeeJuice.claim +
 *      PrivateFPC.mint_and_pay_fee in setup), fees re-priced per attempt while the message syncs;
 *   4. asserts the claimer's PRIVATE FPC balance grew (dust − fee).
 *
 *   bun scripts/fpc-dust-canary-mainnet.ts   (MAINNET_PRIVATE_KEY + BRIDGE_DEPLOYER_SECRET_MAINNET + BRIDGE_DEPLOYER_PREFIX_MAINNET)
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { BatchCall, Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { Gas } from "@aztec-labs/stdlib/gas"
import { deriveNuloAccountKeys } from "@alejoamiras/nulo-wallet-crypto"
import { privateKeyToAccount } from "viem/accounts"
import { predictedWorstMinFees } from "../src/fee-juice"
import { FeeJuicePortalAbi, feeJuiceDepositArgs, parseFeeJuiceDeposit, planPrivateFuelDeposit } from "../src/fuel"
import { PRIVATE_FPC_ADDRESS, deriveBridgeSecret, privateMintAndPayFee } from "../src/private-fuel"
import { resolveDeployerKeys } from "./deployer-keys"
import { requirePinnedSigner } from "./live-intent"
import { createL1Clients, createL2Wallet, createNode, mainnetChain, stopwatch } from "./script-bootstrap"

const ETH_RPC = process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com"
const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://lb.drpc.live/aztec-mainnet/Ak_eT5HA2kbyqamqGTF702cdsdWqLTIR8YdadmahlY6k"
const PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY as `0x${string}` | undefined
if (!PRIVATE_KEY) throw new Error("MAINNET_PRIVATE_KEY required")

// The app's private-claim gas limits (fuelClaim.ts PRIVATE_CLAIM_GAS) — the ceiling the dust must clear.
const PRIVATE_CLAIM_GAS = { daGas: 100_000, l2Gas: 4_000_000 } as const
const RELIABILITY_PAD = 1.2

const ERC20_MIN = [
	{
		type: "function",
		name: "allowance",
		stateMutability: "view",
		inputs: [{ type: "address" }, { type: "address" }],
		outputs: [{ type: "uint256" }],
	},
	{
		type: "function",
		name: "approve",
		stateMutability: "nonpayable",
		inputs: [{ type: "address" }, { type: "uint256" }],
		outputs: [{ type: "bool" }],
	},
	{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const

const mainnet = mainnetChain(ETH_RPC)

async function nodeL1(): Promise<{ portal: `0x${string}`; asset: `0x${string}` }> {
	const res = await fetch(NODE_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_getNodeInfo", params: [] }),
	})
	const a = (await res.json()).result.l1ContractAddresses as Record<string, { value?: string } | string>
	const pick = (v: unknown) => (typeof v === "object" && v ? (v as { value: string }).value : (v as string)) as `0x${string}`
	return { portal: pick(a.feeJuicePortalAddress), asset: pick(a.feeJuiceAddress) }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: accepted at score 23 — the live canary binds fee sizing, deposit evidence, repriced retries and balance-delta acceptance
async function main() {
	const mins = stopwatch()

	const node = createNode(NODE_URL)
	const fpc = AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS)
	if (!(await node.getContract(fpc))) throw new Error("PrivateFPC not deployed — run deploy-private-fpc-mainnet.ts first; STOP")

	// 1. Size the dust from the LIVE ceiling (this IS the minFuelFj calibration formula).
	const worst = await predictedWorstMinFees(node)
	const ceiling = BigInt(PRIVATE_CLAIM_GAS.l2Gas) * worst.feePerL2Gas + BigInt(PRIVATE_CLAIM_GAS.daGas) * worst.feePerDaGas
	const dust = ceiling * 2n
	console.log(`live worst fees: l2 ${worst.feePerL2Gas} da ${worst.feePerDaGas} → ceiling ${ceiling} FJ-wei; dust = ${dust}`)

	// 2. L1 deposit, claimer-bound to the FPC.
	const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`)
	if (account.address.toLowerCase() !== requirePinnedSigner("mainnet").toLowerCase()) throw new Error("wrong L1 key; STOP")
	const { wallet, pub } = createL1Clients({ chain: mainnet, rpcUrl: ETH_RPC, account })
	const { portal, asset } = await nodeL1()

	const ewallet = await createL2Wallet({ nodeUrl: NODE_URL, proverEnabled: true })
	const { secret, salt } = resolveDeployerKeys("mainnet")
	const { signingKey, secretKey } = await deriveNuloAccountKeys(secret)
	const manager = await ewallet.createSchnorrAccount(secretKey, salt, signingKey)
	const from = (await manager.getAccount()).getAddress()
	// Account instances are NOT served by node.getContract (observed live: the FPC deployed AFTER
	// the account became visible while the account never did) — the serveable existence proof is the
	// PUBLIC fee-juice balance (public state reads at checkpoint level; a positive balance proves the
	// account-deploy tx landed, since the claim and the deploy were one tx).
	{
		const { feeJuiceFor } = await import("./fee-juice-l2")
		const fj = await feeJuiceFor(ewallet as never)
		const r = (await fj.methods.balance_of_public(from).simulate({ from })) as { result?: bigint } | bigint
		const bal = typeof r === "bigint" ? r : (r.result ?? 0n)
		if (bal <= 0n) throw new Error(`L2 deployer ${from} has no public FJ — run the conductor's L2 group first; STOP`)
		console.log(`L2 deployer landed (public FJ ${bal})`)
	}

	const bridgeSalt = Fr.random()
	const plan = await planPrivateFuelDeposit(from, dust, bridgeSalt)
	const allowance = (await pub.readContract({
		address: asset,
		abi: ERC20_MIN,
		functionName: "allowance",
		args: [account.address, portal],
	})) as bigint
	if (allowance < dust) {
		const h = await wallet.writeContract({ address: asset, abi: ERC20_MIN, functionName: "approve", args: [portal, dust] })
		const r = await pub.waitForTransactionReceipt({ hash: h })
		if (r.status !== "success") throw new Error("approve reverted")
	}
	const depHash = await wallet.writeContract({
		address: portal,
		abi: FeeJuicePortalAbi,
		functionName: "depositToAztecPublic",
		args: feeJuiceDepositArgs(plan) as never,
	})
	const depReceipt = await pub.waitForTransactionReceipt({ hash: depHash })
	if (depReceipt.status !== "success") throw new Error("depositToAztecPublic reverted")
	const dep = parseFeeJuiceDeposit(depReceipt.logs as never, portal)
	console.log(`deposited ${dep.amount} FJ-wei to the FPC lane, leaf ${dep.leafIndex} (${mins()})`)

	// 3. The carrier-less claim, fees re-priced per attempt (the stranded-static-cap lesson).
	const { PrivateFPCContractArtifact } = await import("../src/private-fpc-artifact")
	const fpcC = await Contract.at(fpc, PrivateFPCContractArtifact as never, ewallet as never)
	const fpcBalance = async (): Promise<bigint> => {
		const r = (await fpcC.methods.balance_of(from).simulate({ from })) as { result?: bigint } | bigint
		return typeof r === "bigint" ? r : (r.result ?? 0n)
	}
	const before = await fpcBalance()
	let settled = false
	for (let i = 0; i < 300 && !settled; i++) {
		try {
			const maxFees = (await predictedWorstMinFees(node)).mul(RELIABILITY_PAD)
			await new BatchCall(ewallet as never, []).send({
				from,
				fee: {
					paymentMethod: privateMintAndPayFee(
						fpc,
						dep.amount,
						deriveBridgeSecret(bridgeSalt, from),
						bridgeSalt,
						new Fr(dep.leafIndex),
					),
					gasSettings: {
						gasLimits: Gas.from(PRIVATE_CLAIM_GAS),
						teardownGasLimits: Gas.from({ daGas: 0, l2Gas: 0 }),
						maxFeesPerGas: maxFees,
					},
				},
				wait: { waitForStatus: TxStatus.PROPOSED },
			} as never)
			settled = true
		} catch (e) {
			if (i % 10 === 0) console.log(`claim retry (${mins()}): ${e instanceof Error ? e.message.slice(0, 160) : e}`)
			await new Promise((r) => setTimeout(r, 6000))
		}
	}
	if (!settled) throw new Error("private dust claim never settled within budget")

	// 4. The private balance must have grown by (dust − fee) — strictly positive, strictly < dust.
	const after = await fpcBalance()
	const gained = after - before
	if (gained <= 0n || gained >= dust) throw new Error(`FPC private balance delta ${gained} out of (0, ${dust}) — canary FAILED`)
	console.log(`\n✅ FPC DUST CANARY PASSED — private balance +${gained} FJ-wei (fee ${dust - gained}) in ${mins()}.`)
	console.log(`   Calibrated minFuelFj (2× live ceiling): ${dust} — set bridge.l1.swap.minFuelFj in the candidate.`)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
