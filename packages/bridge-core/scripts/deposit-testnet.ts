/**
 * Live-testnet BIDIRECTIONAL smoke against a deployed manifest: send → hub claim → hub exit → L1
 * withdraw. Nothing is deployed — the portal is the factory's clone for the token and the L2 side is
 * the manifest's hub plus the token it derives, so this proves the exit half no other gate covers.
 *
 * Real proofs plus a proven-epoch wait make this slow — expect ~30-60 min end to end.
 * Run: bun run scripts/deposit-testnet.ts --config <manifest> [--token <erc20>]
 *      (PRIVATE_KEY + SEPOLIA_RPC_URL in packages/bridge-core/.env; AZTEC_NODE_URL defaults to the
 *      public testnet RPC). `--token` defaults to the manifest's first token.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Abi, Address } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { ERC20_ABI } from "../src/erc20"
import { TOKEN_PORTAL_ABI } from "../src/factory-abi"
import { consumeWithdrawal, type L1Ctx } from "../src/flows"
import { exitViaHub, preflightHubExit } from "../src/hub-l2"
import { runSend } from "../src/send-flow"
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
import { claimTokenBlock, selectToken, sendGenerationOf } from "./script-send"
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
	requiredHint: "apps/tools/public/testnet-bridge.json",
})
const BRIDGE = requireBridge(CONFIG)
const TOKEN = selectToken(BRIDGE, process.argv)
const GENERATION = sendGenerationOf(CONFIG, BRIDGE)

const sepolia = sepoliaChain(SEPOLIA_RPC)

const UNIT = 10n ** BigInt(TOKEN.decimals)
const DEPOSIT = 100n * UNIT
const WITHDRAW = 40n * UNIT
// The burn's epoch has to prove before the Outbox will accept the consume; testnet epochs are slow.
const PROVEN_TIMEOUT_SEC = 1800

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
	const hash = await l1.wallet.writeContract({
		address: TOKEN.erc20 as Address,
		abi: evmAbi(TOKEN.sourceContract ?? "MintableERC20"),
		functionName: "mint",
		args: [l1.account.address, amount],
		account: l1.account,
		chain: l1.wallet.chain,
	} as never)
	await l1.pub.waitForTransactionReceipt({ hash })
	console.log(`minted ${amount} ${TOKEN.displaySymbol} base units (${mins()})`)
}

/** L1 send → hub claim, asserting the L2 public balance the exit then spends. */
async function runDepositLeg(
	l1: L1Ctx,
	l2: { hub: ContractBase; token: ContractBase; from: AztecAddress; sendOpts: Record<string, unknown> },
	mins: () => string,
): Promise<void> {
	await mintIfPermissionless(l1, DEPOSIT, mins)
	await ensureRouterPermit2(l1, {
		usdc: TOKEN.erc20 as `0x${string}`,
		usdcAbi: evmAbi(TOKEN.sourceContract ?? "MintableERC20"),
		permit2: GENERATION.permit2,
		needed: DEPOSIT,
		mins,
	})
	const result = await runSend(
		l1,
		GENERATION,
		{
			intent: "token",
			erc20: TOKEN.erc20 as Address,
			amount: DEPOSIT,
			aztecRecipient: l2.from.toString() as `0x${string}`,
			isPrivate: false,
			nonce: rndNonce(),
			deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
		},
		(s) => console.log(`l1: ${s} (${mins()})`),
	)
	console.log(`sent ${DEPOSIT} ${TOKEN.displaySymbol}-units → L2, leaf ${result.tokenLeafIndex} (${mins()})`)

	const outcome = await claimTokensUntilSynced({
		hub: l2.hub,
		claim: {
			token: claimTokenBlock(TOKEN, result.token as NonNullable<typeof result.token>),
			recipient: l2.from.toString(),
			amount: DEPOSIT,
			claimValue: Fr.fromHexString(result.tokenClaimValueHex as string),
			leafIndex: result.tokenLeafIndex as bigint,
			isPrivate: false,
			from: l2.from.toString(),
		},
		sendOpts: l2.sendOpts,
	})
	const bal = await balanceOf(l2.token, l2.from)
	if (bal < DEPOSIT) throw new Error(`L2 balance ${bal} < deposited ${DEPOSIT}`)
	console.log(`\n✅ deposit PASSED — ${DEPOSIT} bridged via ${outcome.path}, L2 balance ${bal} (${mins()})`)
}

/** L2 burn through the hub → proven epoch → Outbox consume on the token's portal clone. */
async function runWithdrawLeg(
	l1: L1Ctx,
	l2: { ewallet: unknown; hub: ContractBase; token: ContractBase; from: AztecAddress; sendOpts: Record<string, unknown> },
	node: ReturnType<typeof createNode>,
	mins: () => string,
): Promise<void> {
	console.log("\n=== withdraw smoke (L2 burn → L1 release) ===")
	const authwitNonce = Fr.random()
	const exit = {
		l2Token: TOKEN.l2Token,
		recipientL1: l1.account.address,
		amount: WITHDRAW,
		callerOnL1: "0x0000000000000000000000000000000000000000",
		authwitNonce,
		isPrivate: false,
	}
	// The hub burns as the caller, so the burn needs the account's public authwit before the exit —
	// and the preflight runs the pause assert + portal read before that authwit is spent.
	const authwit = await SetPublicAuthwitContractInteraction.create(
		l2.ewallet as never,
		l2.from,
		{ caller: l2.hub.address, action: l2.token.methods.burn_public(l2.from, WITHDRAW, authwitNonce) } as never,
		true,
	)
	await authwit.send(l2.sendOpts as never)
	await preflightHubExit(l2.hub, exit, l2.from.toString())

	const { receipt } = (await exitViaHub(l2.hub, exit, l2.sendOpts)) as unknown as { receipt: { txHash: unknown } }
	console.log(`exit sent (${mins()}); waiting for the proven epoch (slow on testnet)…`)

	const balanceL1 = async (): Promise<bigint> =>
		(await l1.pub.readContract({
			address: TOKEN.erc20 as Address,
			abi: ERC20_ABI,
			functionName: "balanceOf",
			args: [l1.account.address],
		})) as bigint
	const before = await balanceL1()
	await consumeWithdrawal(
		l1,
		node as never,
		receipt,
		{
			recipientL1: l1.account.address,
			amount: WITHDRAW,
			portal: TOKEN.portal as Address,
			portalAbi: TOKEN_PORTAL_ABI as unknown as Abi,
			provenTimeoutSec: PROVEN_TIMEOUT_SEC,
		},
		(s) => console.log(`withdraw: ${s} (${mins()})`),
	)
	const withdrawn = (await balanceL1()) - before
	if (withdrawn < WITHDRAW) throw new Error(`withdrew ${withdrawn} < ${WITHDRAW}`)
	console.log(`✅ withdraw PASSED — ${withdrawn} ${TOKEN.displaySymbol}-units L2 → Sepolia in ${mins()}`)
}

async function main() {
	const mins = stopwatch()

	const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`)
	const { wallet, pub } = createL1Clients({ chain: sepolia, rpcUrl: SEPOLIA_RPC, account })
	const l1: L1Ctx = { pub, wallet, account }
	console.log(`bidirectional smoke: ${TOKEN.displaySymbol} ${TOKEN.erc20} → portal ${TOKEN.portal}, hub ${BRIDGE.l2.hub.address}`)

	const node = createNode(NODE_URL)
	const ewallet = await createL2Wallet({ nodeUrl: NODE_URL, proverEnabled: true })
	const { manager, from } = await freshSchnorrAccount(ewallet as never)
	console.log("L2 smoke account", from.toString())

	const { fee } = await sponsoredFpcFee(ewallet)
	const sendOpts = { from, fee, wait: { waitForStatus: TxStatus.PROPOSED } }
	await deployAccountIfAbsent({
		node,
		manager: manager as never,
		from,
		fee,
		log: (stage) => {
			if (stage === "deploying") console.log(`deploying L2 smoke account (real proof, ~minutes)… (${mins()})`)
		},
	})

	const hub = await registerHub(ewallet as never, BRIDGE.l2.hub)
	const token = await registerHubToken(
		ewallet as never,
		AztecAddress.fromStringUnsafe(BRIDGE.l2.hub.address),
		TOKEN,
		BRIDGE.l2.tokenClassId,
	)
	console.log(`hub + ${TOKEN.displaySymbol} registered (${mins()})`)

	await runDepositLeg(l1, { hub, token, from, sendOpts }, mins)
	await runWithdrawLeg(l1, { ewallet, hub, token, from, sendOpts }, node, mins)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
