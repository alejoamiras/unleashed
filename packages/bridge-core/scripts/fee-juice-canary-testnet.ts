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
 *      (a keyed run on testnet-l1.env.example: PRIVATE_KEY, SEPOLIA_RPC_URL, DRPC_API_KEY)
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { FeeAssetHandlerAbi } from "@aztec-foundation/l1-artifacts"
import { privateKeyToAccount } from "viem/accounts"
import { FeeJuicePortalAbi, planPublicFuelDeposit, walletChainIdOf } from "@unleashed/sdk/protocol"
import { ERC20_MIN_ABI } from "./script-l1"
import { claimAndDeployAccount, claimFeeJuiceSelfPaid, depositFeeJuicePublic, feeJuiceFor } from "./fee-juice-l2"
import { waitForL1ToL2Message } from "./generation"
import { deployAccountIfAbsent, freshSchnorrAccount, sponsoredFpcFee } from "./script-l2"
import { createL1Clients, createL2Wallet, createNode, loadManifestV2FromConfigArg, sepoliaChain, stopwatch } from "./script-bootstrap"
import { keyedNodeUrl, runKeyed } from "./keyed-run"

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"
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

/** A reset keeps the fee asset and its handler, so only the portal and the chain id tell a retired
 *  generation's manifest from the network the node serves; depositing on a stale one funds a dead rollup. */
async function assertManifestIsLive(d: CanaryL1, node: ReturnType<typeof createNode>): Promise<void> {
	const info = await node.getNodeInfo()
	const livePortal = info.l1ContractAddresses.feeJuicePortalAddress.toString().toLowerCase()
	const liveChainId = walletChainIdOf(info.l1ChainId, info.rollupVersion)
	if (d.portal.toLowerCase() !== livePortal || CONFIG.walletChainId !== liveChainId) {
		throw new Error(
			`${CONFIG_PATH} names portal ${d.portal} on chain ${CONFIG.walletChainId}; the node serves ${livePortal} on ${liveChainId} — STOP`,
		)
	}
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

async function main() {
	const mins = stopwatch()
	const nodeUrl = keyedNodeUrl("testnet")
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

	const node = createNode(nodeUrl)
	await assertManifestIsLive(l1, node)
	await assertLaneCoherence(l1)
	await ensureFeeAssetFunded(l1)

	// L2 fresh account first (the deposit binds to its address), sponsored-FPC deploy.
	const ewallet = await createL2Wallet({ nodeUrl, proverEnabled: true })
	// Bound and checked against the node before depositing: the claim secret lives only in this run.
	const feeJuice = await feeJuiceFor(ewallet as never, node)
	const { manager, from } = await freshSchnorrAccount(ewallet as never)
	console.log(`L2 recipient ${from.toString()}`)
	const { fee: sponsoredFee } = await sponsoredFpcFee(ewallet)
	// --fresh-selfpay: SKIP the sponsored account deploy so the self-pay claim is the account's FIRST
	// tx and carries the account's initialization - the mainnet persona (no sponsor
	// exists there). Measures the gas shape the steady-state calibration excludes.
	const freshSelfPay = process.argv.includes("--fresh-selfpay")
	if (freshSelfPay) {
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
	const deposit = await depositFeeJuicePublic({ pub, wallet, account }, { asset: l1.asset, portal: l1.portal, plan })
	console.log(`deposited: ${deposit.amount} FJ-wei, leaf ${deposit.leafIndex} (${mins()})`)

	const fjBalance = async (): Promise<bigint> => {
		const r = (await feeJuice.methods.balance_of_public(from).simulate({ from })) as { result?: bigint } | bigint
		return typeof r === "bigint" ? r : (r.result ?? 0n)
	}
	// An undeployed account cannot simulate; a fresh one holds nothing.
	const fjBefore = freshSelfPay ? 0n : await fjBalance()
	await waitForL1ToL2Message(node, deposit.key, { timeoutMs: 30 * 60_000 })
	const claim = { claimAmount: deposit.amount, claimSecret: plan.secret, messageLeafIndex: deposit.leafIndex }
	if (freshSelfPay) await claimAndDeployAccount({ node, manager: manager as never, from, claim })
	else await claimFeeJuiceSelfPaid({ wallet: ewallet as never, node, from, claim })

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

runKeyed(main)
