/**
 * Pre-promotion smoke for a freshly-deployed CANDIDATE generation manifest. It registers the
 * recorded hub and the first two tokens (NO deploy) and bridges each of them publicly and privately
 * through the app's own send path, so a pass proves two things at once: the manifest is
 * self-consistent — every recorded address recomputes, and the factory's frozen registration agrees
 * with the words it carries — AND the deployed generation actually bridges more than one token.
 *
 * The L2 recipient is a throwaway account; the deposits are funded by PRIVATE_KEY. Real proofs make
 * each claim take minutes. Run:
 *   bun run scripts/smoke-existing-testnet.ts --config <path/to/testnet-bridge.candidate.json>
 * (needs PRIVATE_KEY + SEPOLIA_RPC_URL in packages/bridge-core/.env; AZTEC_NODE_URL defaults to the
 * public testnet RPC).
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Address } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { ERC20_ABI } from "../src/erc20"
import type { L1Ctx } from "../src/flows"
import { hubExitsPaused, hubTokenFor } from "../src/hub-l2"
import type { SendOpts } from "../src/hub-l2"
import type { ManifestToken } from "../src/manifest-v2"
import { runSend, type SendGeneration } from "../src/send-flow"
import { sendGenerationOf } from "./script-send"
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

const MANIFEST = loadManifestV2FromConfigArg(process.argv, {
	mode: "required",
	requiredHint: "apps/tools/public/testnet-bridge.candidate.json",
})
const BRIDGE = requireBridge(MANIFEST)

interface Lane {
	l1: L1Ctx
	generation: SendGeneration
	hub: ContractBase
	l2Token: ContractBase
	token: ManifestToken
	from: AztecAddress
	sendOpts: SendOpts
	/** One whole unit — enough to move a balance, small enough for a token with no faucet. */
	amount: bigint
	mins: () => string
}

/** The L1 balance a lane spends: a permissionless-mint test token mints on demand, anything else
 *  must already be held (a canonical token has no faucet and the smoke must not pretend otherwise). */
async function fundL1(lane: Lane): Promise<void> {
	const erc20 = lane.token.erc20 as Address
	if (lane.token.source !== "permissionless-mint") {
		const held = await lane.l1.pub.readContract({
			address: erc20,
			abi: ERC20_ABI,
			functionName: "balanceOf",
			args: [lane.l1.account.address],
		})
		if (held < lane.amount)
			throw new Error(`${lane.token.displaySymbol}: funder holds ${held} < ${lane.amount} and the token has no mint`)
		return
	}
	const hash = await lane.l1.wallet.writeContract({
		address: erc20,
		abi: evmAbi(lane.token.sourceContract ?? "MintableERC20"),
		functionName: "mint",
		args: [lane.l1.account.address, lane.amount],
		account: lane.l1.account,
		chain: lane.l1.wallet.chain,
	} as never)
	await lane.l1.pub.waitForTransactionReceipt({ hash })
}

/** Before the first claim the L2 token is not published yet, so its balance read reverts — that is
 *  a zero balance, not a failure. */
async function l2Balance(lane: Lane, isPrivate: boolean): Promise<bigint> {
	try {
		const call = isPrivate ? lane.l2Token.methods.balance_of_private(lane.from) : lane.l2Token.methods.balance_of_public(lane.from)
		return ((await call.simulate({ from: lane.from } as never)) as { result: bigint }).result
	} catch {
		return 0n
	}
}

/** The factory's frozen registration is what the hub derives the L2 token from, so a manifest whose
 *  words or portal disagree with it names an address the hub would never mint to. */
function assertRegistrationMatches(
	lane: Lane,
	registered: { portal: string; nameWord: string; symbolWord: string; decimals: number },
): void {
	const mismatches = [
		["portal", registered.portal, lane.token.portal],
		["nameWord", registered.nameWord, lane.token.nameWord],
		["symbolWord", registered.symbolWord, lane.token.symbolWord],
		["decimals", String(registered.decimals), String(lane.token.decimals)],
	].filter(([, onChain, recorded]) => onChain.toLowerCase() !== recorded.toLowerCase())
	if (mismatches.length > 0) {
		throw new Error(
			`${lane.token.displaySymbol}: the factory's registration disagrees with the manifest — ${mismatches.map(([f, a, b]) => `${f} ${a} != ${b}`).join("; ")}`,
		)
	}
}

/** One deposit → claim, end to end on the app's path, asserting the L2 balance actually moved. */
async function bridgeOnce(lane: Lane, isPrivate: boolean): Promise<void> {
	const label = `${lane.token.displaySymbol} ${isPrivate ? "private" : "public"}`
	await fundL1(lane)
	await ensureRouterPermit2(lane.l1, {
		usdc: lane.token.erc20 as Address,
		usdcAbi: ERC20_ABI,
		permit2: lane.generation.permit2,
		needed: lane.amount,
		mins: lane.mins,
	})
	const sent = await runSend(
		lane.l1,
		lane.generation,
		{
			intent: "token",
			erc20: lane.token.erc20 as Address,
			amount: lane.amount,
			aztecRecipient: lane.from.toString() as `0x${string}`,
			isPrivate,
			claimSalt: isPrivate ? Fr.random() : undefined,
			nonce: BigInt(`0x${crypto.randomUUID().replaceAll("-", "")}`),
			deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
		},
		(stage) => console.log(`${label} l1: ${stage} (${lane.mins()})`),
	)
	if (!sent.token || sent.tokenLeafIndex === undefined || !sent.tokenClaimValueHex) {
		throw new Error(`${label}: the send returned no token leg (${sent.txHash})`)
	}
	assertRegistrationMatches(lane, sent.token)
	console.log(`${label}: deposited ${lane.amount} at leaf ${sent.tokenLeafIndex} (${lane.mins()})`)

	const before = await l2Balance(lane, isPrivate)
	const outcome = await claimTokensUntilSynced({
		hub: lane.hub,
		// The factory record carries no L2 address; the manifest's is the one the registration derives.
		claim: {
			token: { ...sent.token, l2Token: lane.token.l2Token },
			recipient: lane.from.toString(),
			amount: lane.amount,
			claimValue: Fr.fromHexString(sent.tokenClaimValueHex),
			leafIndex: sent.tokenLeafIndex,
			isPrivate,
			from: lane.from.toString(),
		},
		sendOpts: lane.sendOpts,
	})
	const moved = (await l2Balance(lane, isPrivate)) - before
	if (moved < lane.amount) throw new Error(`${label}: balance moved ${moved} < deposited ${lane.amount}`)
	console.log(`${label}: claimed via ${outcome.path} — balance +${moved} (${lane.mins()})`)
}

/** After the first claim the hub must name exactly the L2 token the manifest recorded. */
async function assertHubBinding(lane: Lane): Promise<void> {
	const bound = await hubTokenFor(lane.hub, lane.token.erc20, lane.from.toString())
	if (bound?.toLowerCase() !== lane.token.l2Token.toLowerCase()) {
		throw new Error(`hub token_for(${lane.token.erc20}) is ${bound ?? "unregistered"} but the manifest records ${lane.token.l2Token}`)
	}
}

/** The hub has no paused view, so the check is the assert itself: on a paused hub an exit simulation
 *  fails with the contract's own string before reaching the authwit it would fail on anyway. */
async function assertExitsOpen(lane: Lane): Promise<void> {
	if (await hubExitsPaused(lane.hub, lane.from.toString()))
		throw new Error("the candidate hub has exits PAUSED — refusing to call the smoke a pass")
}

async function main(): Promise<void> {
	const mins = stopwatch()
	const tokens = BRIDGE.tokens.slice(0, 2)
	if (tokens.length < 2) throw new Error("the candidate carries fewer than two tokens — the smoke exists to prove the hub serves several")

	const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`)
	console.log("L1 funder", account.address)
	const { wallet, pub } = createL1Clients({ chain: sepoliaChain(SEPOLIA_RPC), rpcUrl: SEPOLIA_RPC, account })
	const l1: L1Ctx = { wallet, pub, account }

	const node = createNode(NODE_URL)
	const ewallet = await createL2Wallet({ nodeUrl: NODE_URL, proverEnabled: true })
	const { manager, from } = await freshSchnorrAccount(ewallet as never)
	console.log("L2 smoke account", from.toString())
	const { fee } = await sponsoredFpcFee(ewallet)
	const sendOpts: SendOpts = { from, fee, wait: { waitForStatus: TxStatus.PROPOSED } }
	await deployAccountIfAbsent({
		node,
		manager: manager as never,
		from,
		fee,
		log: (stage) => {
			if (stage === "deploying") console.log(`deploying L2 smoke account (real proof, ~minutes)… (${mins()})`)
		},
	})

	const hub = await registerHub(ewallet, BRIDGE.l2.hub)
	console.log(`registered hub ${hub.address.toString()} (${mins()})`)
	const generation = sendGenerationOf(MANIFEST, BRIDGE)
	const lanes: Lane[] = []
	for (const token of tokens) {
		const l2Token = await registerHubToken(ewallet, hub.address, token, BRIDGE.l2.tokenClassId)
		lanes.push({ l1, generation, hub, l2Token, token, from, sendOpts, amount: 10n ** BigInt(token.decimals), mins })
	}
	for (const lane of lanes) {
		await bridgeOnce(lane, false)
		await assertHubBinding(lane)
		await bridgeOnce(lane, true)
	}
	// The exit preflight reads the hub's portal binding, which only exists once a token has registered.
	await assertExitsOpen(lanes[0])

	console.log(`\n✅ CANDIDATE smoke PASSED — ${tokens.length} tokens bridged public + private on the recorded generation in ${mins()}.`)
	console.log("   Safe to promote the candidate manifest.")
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
