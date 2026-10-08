/**
 * LIVE-testnet DIRECT Fee-Juice canary: proves the manifest's top-level `feeJuice` lane end to end —
 * the one lane `fuel-testnet.ts` does NOT exercise (that one acquires FJ via the swap router).
 * Mirrors the faucet's PUBLIC direct-Fuel flow exactly (useL1FeeAsset + useFuel + fuelClaim):
 *
 *   1. fail-closed coherence: handler.FEE_ASSET() == asset, portal.UNDERLYING() == asset
 *   2. FeeAssetHandler.mint(owner)            — the wallet's mint button
 *   3. approve + FeeJuicePortal.depositToAztecPublic(to, minFj, secretHash)  — deposits EXACTLY
 *      the manifest's minFj, so the floor the manifest promises the wallet is what gets proven
 *   4. fresh L2 account (sponsored-FPC deploy), then a SELF-PAY claim (fuelClaim.ts): a carrier-less
 *      zero-app-call BatchCall([]) + FeeJuicePaymentMethodWithClaim (claim_and_end_setup in setup) — the
 *      mainnet-shaped public claim lane (NO Sponsored FPC). Net balance = deposit − self-paid gas.
 *
 * Run: bun scripts/fee-juice-canary-testnet.ts --config <candidate.json>
 *      (PRIVATE_KEY + SEPOLIA_RPC_URL in packages/bridge-core/.env)
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { BatchCall } from "@aztec-labs/aztec.js/contracts"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { FeeAssetHandlerAbi } from "@aztec-foundation/l1-artifacts"
import { Gas } from "@aztec-labs/stdlib/gas"
import { privateKeyToAccount } from "viem/accounts"
import { predictedWorstMinFees, publicFeeJuicePayment } from "../src/fee-juice"
import { FeeJuicePortalAbi, feeJuiceDepositArgs, parseFeeJuiceDeposit, planPublicFuelDeposit } from "../src/fuel"
import { ERC20_MIN_ABI } from "./script-l1"
import { feeJuiceFor } from "./fee-juice-l2"
import { deployAccountIfAbsent, freshSchnorrAccount, sponsoredFpcFee } from "./script-l2"
import { createL1Clients, createL2Wallet, createNode, loadManifestV2FromConfigArg, sepoliaChain, stopwatch } from "./script-bootstrap"
import { TESTNET_NODE_URL } from "../src/testnet-node"

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"
const NODE_URL = process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY required (packages/bridge-core/.env)")

const here = dirname(fileURLToPath(import.meta.url))
const configArg = process.argv.indexOf("--config")
// Recomputed (not just derived from the loader) so the error below names the ACTUAL resolved path,
// matching whichever of --config / the fallback was used.
const CONFIG_PATH =
	configArg !== -1
		? (process.argv[configArg + 1] as string)
		: join(here, "..", "..", "..", "apps", "tools", "public", "testnet-bridge.json")
const CONFIG = loadManifestV2FromConfigArg(process.argv, { mode: "fallback", fallbackPath: CONFIG_PATH })
const direct = CONFIG.feeJuice
const FEE_ASSET_HANDLER = direct.feeAssetHandler
// The mint leg IS the wallet's mint button; without a handler there is no permissionless source.
if (!FEE_ASSET_HANDLER) throw new Error(`${CONFIG_PATH} carries no feeJuice.feeAssetHandler — nothing to mint from`)

const sepolia = sepoliaChain(SEPOLIA_RPC)

interface CanaryL1 {
	wallet: ReturnType<typeof createL1Clients>["wallet"]
	pub: ReturnType<typeof createL1Clients>["pub"]
	owner: `0x${string}`
	asset: `0x${string}`
	portal: `0x${string}`
	handler: `0x${string}`
	minFj: bigint
	mins: () => string
}

/** The wallet's fail-closed coherence checks (useL1FeeAsset.verifyPortalAsset/verifyHandlerAsset). */
async function assertLaneCoherence(d: CanaryL1): Promise<void> {
	const underlying = (await d.pub.readContract({ address: d.portal, abi: FeeJuicePortalAbi, functionName: "UNDERLYING" })) as string
	if (underlying.toLowerCase() !== d.asset.toLowerCase()) throw new Error(`portal UNDERLYING ${underlying} != asset ${d.asset}`)
	const feeAsset = (await d.pub.readContract({ address: d.handler, abi: FeeAssetHandlerAbi, functionName: "FEE_ASSET" })) as string
	if (feeAsset.toLowerCase() !== d.asset.toLowerCase()) throw new Error(`handler FEE_ASSET ${feeAsset} != asset ${d.asset}`)
	console.log(`coherence OK: UNDERLYING + FEE_ASSET match the manifest asset (${d.mins()})`)
}

/** Mint via the handler — the wallet's mint path. The handler's fixed mintAmount must cover
 *  the floor the manifest promises, or the wallet's own mint button couldn't fund a deposit. */
async function ensureFeeAssetFunded(d: CanaryL1): Promise<void> {
	const readBalance = async () =>
		(await d.pub.readContract({ address: d.asset, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: [d.owner] })) as bigint
	const mintAmount = (await d.pub.readContract({ address: d.handler, abi: FeeAssetHandlerAbi, functionName: "mintAmount" })) as bigint
	const balBefore = await readBalance()
	if (balBefore >= d.minFj) {
		console.log(`existing fee-asset balance ${balBefore} covers minFj — skipping mint (mintAmount ${mintAmount})`)
		return
	}
	const mintTx = await d.wallet.writeContract({ address: d.handler, abi: FeeAssetHandlerAbi, functionName: "mint", args: [d.owner] })
	const mintReceipt = await d.pub.waitForTransactionReceipt({ hash: mintTx })
	if (mintReceipt.status !== "success") throw new Error("handler mint reverted on-chain")
	const balAfter = await readBalance()
	console.log(`minted ${balAfter - balBefore} fee asset via handler (mintAmount ${mintAmount}) (${d.mins()})`)
	if (balAfter < d.minFj) throw new Error(`post-mint balance ${balAfter} < minFj ${d.minFj} — one mint can't fund the floor`)
}

/** Direct deposit of EXACTLY minFj — approve (allowance-skip, like the wallet) then deposit. */
async function depositDirectFj(d: CanaryL1, plan: Awaited<ReturnType<typeof planPublicFuelDeposit>>) {
	const allowance = (await d.pub.readContract({
		address: d.asset,
		abi: ERC20_MIN_ABI,
		functionName: "allowance",
		args: [d.owner, d.portal],
	})) as bigint
	if (allowance < d.minFj) {
		const approveTx = await d.wallet.writeContract({
			address: d.asset,
			abi: ERC20_MIN_ABI,
			functionName: "approve",
			args: [d.portal, d.minFj],
		})
		const approveReceipt = await d.pub.waitForTransactionReceipt({ hash: approveTx })
		if (approveReceipt.status !== "success") throw new Error("approve reverted on-chain")
	}
	const depositTx = await d.wallet.writeContract({
		address: d.portal,
		abi: FeeJuicePortalAbi,
		functionName: "depositToAztecPublic",
		args: feeJuiceDepositArgs(plan) as never,
	})
	const depositReceipt = await d.pub.waitForTransactionReceipt({ hash: depositTx })
	if (depositReceipt.status !== "success") throw new Error("depositToAztecPublic reverted on-chain")
	const deposit = parseFeeJuiceDeposit(depositReceipt.logs as never, d.portal)
	console.log(`deposited: ${deposit.amount} FJ-wei, leaf ${deposit.leafIndex} (${d.mins()})`)
	if (deposit.amount !== d.minFj) throw new Error(`deposit event amount ${deposit.amount} != minFj ${d.minFj}`)
	return deposit
}

/**
 * The faucet's PUBLIC claim lane — SELF-PAY (fuelClaim.ts): claim the bridged
 * FJ and pay THIS tx's fee FROM it in one carrier-less zero-app-call tx (BatchCall([]) +
 * FeeJuicePaymentMethodWithClaim → claim_and_end_setup in the SETUP phase). No Sponsored FPC — the
 * mainnet shape. Setup is the CORRECT home for claim_and_end_setup: the 5.0.0 "149 failed simulates"
 * bug was that variant in the APP phase under a sponsored fee; as a fee payload it is valid. This
 * canary is what PROVES the zero-app-call + claim_and_end_setup combination live before we ship it.
 * Retries until the L1→L2 message syncs (same cadence as fuel-testnet's claim loop).
 */
async function runSelfPayClaim(p: {
	ewallet: unknown
	node: ReturnType<typeof createNode>
	from: AztecAddress
	deposit: { amount: bigint; leafIndex: number | bigint }
	claimSecret: Fr
	mins: () => string
}): Promise<void> {
	// predicted-worst maxFeesPerGas (NO padding): a self-pay claim spends the bridged amount as its whole
	// budget, so any padding inflates max_gas_cost past it and claim_and_end_setup reverts "Amount too low".
	const worst = await predictedWorstMinFees(p.node)
	const selfPayFee = {
		paymentMethod: publicFeeJuicePayment(p.from, {
			claimAmount: p.deposit.amount,
			claimSecret: p.claimSecret,
			messageLeafIndex: BigInt(p.deposit.leafIndex),
		}),
		gasSettings: {
			// EXPLICIT gasLimits — the empty BatchCall([]) gives the estimator nothing, so it would default to
			// the per-tx MAX and max_gas_cost would blow past the bridged amount. CALIBRATED (1.5M/3k, a ~2.3x
			// margin over a landed claim's 659_123/224) and mirrored in fuelClaim.ts. Deliberately far below
			// the private 4M so the limit-based balance check keeps fee-spike headroom under the floor.
			gasLimits: Gas.from({ daGas: 3_000, l2Gas: 1_500_000 }),
			teardownGasLimits: Gas.from({ daGas: 0, l2Gas: 0 }),
			maxFeesPerGas: { feePerDaGas: worst.feePerDaGas, feePerL2Gas: worst.feePerL2Gas },
		},
	}
	let settled = false
	for (let i = 0; i < 300 && !settled; i++) {
		try {
			await new BatchCall(p.ewallet as never, []).send({
				from: p.from,
				fee: selfPayFee,
				wait: { waitForStatus: TxStatus.PROPOSED },
			} as never)
			settled = true
		} catch (e) {
			// Surface the real error on the retry cadence — a swallowed persistent assert looks identical to a
			// slow message sync from the outside (the claim_and_end_setup bug hid behind this in 5.0.0).
			if (i % 10 === 0) console.log(`self-pay claim retry (${p.mins()}): ${e instanceof Error ? e.message.slice(0, 200) : e}`)
			await new Promise((r) => setTimeout(r, 6000))
		}
	}
	if (!settled) throw new Error("direct-FJ SELF-PAY claim never SETTLED within budget")
}

async function main() {
	const mins = stopwatch()
	const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`)
	const { wallet, pub } = createL1Clients({ chain: sepolia, rpcUrl: SEPOLIA_RPC, account })
	const l1: CanaryL1 = {
		wallet,
		pub,
		owner: account.address,
		asset: direct.asset as `0x${string}`,
		portal: direct.portal as `0x${string}`,
		handler: FEE_ASSET_HANDLER as `0x${string}`,
		minFj: BigInt(direct.minFj),
		mins,
	}
	console.log(`direct-FJ lane: asset ${l1.asset} | portal ${l1.portal} | handler ${l1.handler} | minFj ${l1.minFj}`)

	await assertLaneCoherence(l1)
	await ensureFeeAssetFunded(l1)

	// L2 fresh account first (the deposit binds to its address), sponsored-FPC deploy.
	const node = createNode(NODE_URL)
	const ewallet = await createL2Wallet({ nodeUrl: NODE_URL, proverEnabled: true })
	// Bound and checked against the node before depositing: the claim secret lives only in this run.
	const feeJuice = await feeJuiceFor(ewallet as never, node)
	const { manager, from } = await freshSchnorrAccount(ewallet as never)
	console.log(`L2 recipient ${from.toString()}`)
	const { fee: sponsoredFee } = await sponsoredFpcFee(ewallet)
	// --fresh-selfpay: SKIP the sponsored account deploy so the self-pay claim is the account's FIRST
	// tx and carries initialization (ctor + instance publication) - the mainnet persona (no sponsor
	// exists there). Measures the gas shape the steady-state calibration excludes.
	if (process.argv.includes("--fresh-selfpay")) {
		console.log("FRESH-SELFPAY mode: skipping the sponsored account deploy - the claim must carry init")
	} else {
		await deployAccountIfAbsent({
			node,
			manager: manager as never,
			from,
			fee: sponsoredFee,
			log: (stage) =>
				console.log(
					stage === "deploying"
						? `deploying L2 account via sponsored FPC (real proof)… (${mins()})`
						: `L2 account deployed (${mins()})`,
				),
		})
	}

	const plan = await planPublicFuelDeposit(from, l1.minFj)
	const deposit = await depositDirectFj(l1, plan)

	const fjBalance = async (): Promise<bigint> => {
		const r = (await feeJuice.methods.balance_of_public(from).simulate({ from })) as { result?: bigint } | bigint
		return typeof r === "bigint" ? r : (r.result ?? 0n)
	}
	const fjBefore = await fjBalance()
	await runSelfPayClaim({ ewallet, node, from, deposit, claimSecret: plan.secret, mins })

	// SELF-PAY: the claim paid this tx's fee FROM the deposit, so the NET gain is deposit − max_gas_cost
	// (NOT the full deposit). Assert a positive balance landed strictly below the deposit — the mainnet shape.
	const fjAfter = await fjBalance()
	const gained = fjAfter - fjBefore
	const feePaid = deposit.amount - gained
	if (gained <= 0n) throw new Error(`self-pay claim gained ${gained} (<=0) — nothing landed`)
	if (gained >= deposit.amount) throw new Error(`self-pay claim gained ${gained} >= deposited ${deposit.amount} — fee not deducted?`)
	console.log(
		`\n✅ DIRECT Fee-Juice SELF-PAY canary PASSED — mint→deposit(minFj)→self-pay-claim landed ${gained} FJ-wei (fee ${feePaid}) in ${mins()}.`,
	)
	console.log("   The feeJuice lane (handler mint + direct portal deposit + zero-app-call self-pay claim) is live.")
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
