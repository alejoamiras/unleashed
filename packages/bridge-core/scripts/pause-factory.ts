/**
 * Set a generation's L1 deposit pause, the guardian's switch on its PortalFactory. Used to retire a
 * generation: with deposits paused, a page still open on the old manifest cannot start a token
 * deposit the current app will never show. The withdraw pause is left exactly as it is.
 *
 *   bun packages/bridge-core/scripts/pause-factory.ts --config <manifest> --factory <address> --deposits paused|open [--dry-run]
 *
 * `--factory` must repeat the manifest's own `bridge.l1.factory`: the manifest says which generation,
 * the flag proves the operator meant that one. The signer (PRIVATE_KEY) must be the pinned testnet
 * signer AND the factory's owner, with no transaction newer than the finalized block (about 15
 * minutes on Sepolia). Needs SEPOLIA_RPC_URL. Testnet only.
 *
 * A pause stops `depositToAztecPublic`/`depositToAztecPrivate` on every portal of the factory, and
 * every DepositRouter send bound to it, gas-only included: a cross-chain delivery that reaches the
 * router while paused recovers to the sender's wallet on Ethereum.
 */
import {
	type Abi,
	type Address,
	decodeFunctionResult,
	encodeFunctionData,
	getAddress,
	type Hash,
	hexToNumber,
	isAddress,
	parseAbi,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { PORTAL_FACTORY_ABI } from "../src/factory-abi"
import type { ManifestV2 } from "../src/manifest-v2"
import { requirePinnedSigner } from "./live-intent"
import { createL1Clients, loadManifestV2FromConfigArg, requireBridge, sepoliaChain } from "./script-bootstrap"
import { FACTORY_CONSTANTS_ABI } from "./script-l1"

const SET_PAUSED_ABI = parseAbi(["function setPaused(bool deposits, bool withdraws)"])
const SEPOLIA_CHAIN_ID = 11155111

export interface PauseState {
	deposits: boolean
	withdraws: boolean
}

export interface PausePlan {
	factory: Address
	/** `setPaused` writes both bits: the withdraw bit is carried over, never chosen here. */
	next: PauseState
	/** False when the chain already holds `next`: nothing is sent. */
	needed: boolean
	/** The nonce the call is sent with: the signer's at the block `current` was read from. */
	nonce: number
}

function flag(argv: readonly string[], name: string): string | undefined {
	const i = argv.indexOf(name)
	return i === -1 ? undefined : argv[i + 1]
}

/**
 * The single `setPaused` call a request amounts to, or a refusal.
 *
 * `setPaused` writes both bits and only the owner can call it, so the withdraw bit carried over is
 * only safe if no other call of the signer can sit between the state read and this call. `owner`,
 * `current` and `nonces.finalized` must come from ONE finalized block, read by its hash: with nothing
 * sent since and the send pinned to that nonce, every earlier call is already in the state read, a
 * later one takes the nonce so this call fails, and a reorg cannot put one back in between.
 *
 * @throws when the manifest is not a Sepolia testnet generation, `--factory` is absent, malformed or
 *   not the manifest's factory, `--deposits` is not `paused` or `open`, the signer is not both the
 *   pinned signer and the factory's owner, or the signer has sent a transaction since the finalized block.
 */
export function planPause(input: {
	manifest: ManifestV2
	argv: readonly string[]
	signer: string
	pinnedSigner: string
	owner: string
	nonces: { finalized: number; pending: number }
	current: PauseState
}): PausePlan {
	const { manifest, argv, current } = input
	if (manifest.network !== "testnet" || manifest.l1ChainId !== SEPOLIA_CHAIN_ID) {
		throw new Error(`testnet only: the manifest is ${manifest.network} on L1 chain ${manifest.l1ChainId} — STOP`)
	}
	const claimed = flag(argv, "--factory")
	if (!claimed || !isAddress(claimed)) throw new Error("--factory <address> is required — STOP")
	const factory = getAddress(requireBridge(manifest).l1.factory)
	if (getAddress(claimed) !== factory) throw new Error(`--factory ${claimed} is not the manifest's factory ${factory} — STOP`)
	const want = flag(argv, "--deposits")
	if (want !== "paused" && want !== "open") throw new Error("--deposits paused|open is required — STOP")
	const signer = getAddress(input.signer)
	if (signer !== getAddress(input.pinnedSigner)) throw new Error(`signer ${signer} is not the pinned testnet signer — STOP`)
	if (signer !== getAddress(input.owner)) throw new Error(`signer ${signer} is not the factory's owner ${input.owner} — STOP`)
	const { finalized, pending } = input.nonces
	if (pending !== finalized)
		throw new Error(`signer ${signer} has ${pending - finalized} transaction(s) not yet finalized: wait, then re-run — STOP`)
	const next = { deposits: want === "paused", withdraws: current.withdraws }
	return { factory, next, needed: next.deposits !== current.deposits, nonce: finalized }
}

async function main(): Promise<void> {
	const rpcUrl = process.env.SEPOLIA_RPC_URL
	const key = process.env.PRIVATE_KEY as `0x${string}` | undefined
	if (!rpcUrl || !key) throw new Error("SEPOLIA_RPC_URL and PRIVATE_KEY are required — STOP")
	const manifest = loadManifestV2FromConfigArg(process.argv, { mode: "required", requiredHint: "the generation's manifest" })
	const account = privateKeyToAccount(key)
	const { wallet, pub } = createL1Clients({ chain: sepoliaChain(rpcUrl), rpcUrl, account })
	if ((await pub.getChainId()) !== SEPOLIA_CHAIN_ID) throw new Error("SEPOLIA_RPC_URL does not answer chain 11155111 — STOP")

	const address = requireBridge(manifest).l1.factory as Address
	// One finalized block for the owner, the pause bits and the nonce (see `planPause`), bound by
	// hash: a height alone lets an RPC backend on another fork answer for a different block, and
	// viem's block-pinned reads send the height. With `requireCanonical` such a backend must fail.
	const finalized = await pub.getBlock({ blockTag: "finalized" })
	const at = { blockHash: finalized.hash as Hash, requireCanonical: true }
	const callAt = async (abi: Abi, functionName: string): Promise<unknown> => {
		const data = await pub.request({
			method: "eth_call",
			params: [{ to: address, data: encodeFunctionData({ abi, functionName }) }, at],
		})
		return decodeFunctionResult({ abi, functionName, data })
	}
	const nonces = {
		finalized: hexToNumber(await pub.request({ method: "eth_getTransactionCount", params: [account.address, at] })),
		pending: await pub.getTransactionCount({ address: account.address, blockTag: "pending" }),
	}
	const plan = planPause({
		manifest,
		argv: process.argv,
		signer: account.address,
		pinnedSigner: requirePinnedSigner("testnet"),
		owner: (await callAt(FACTORY_CONSTANTS_ABI, "owner")) as Address,
		nonces,
		current: {
			deposits: (await callAt(PORTAL_FACTORY_ABI, "depositsPaused")) as boolean,
			withdraws: (await callAt(PORTAL_FACTORY_ABI, "withdrawsPaused")) as boolean,
		},
	})
	const describe = (s: PauseState) => `deposits ${s.deposits ? "paused" : "open"}, withdraws ${s.withdraws ? "paused" : "open"}`
	if (!plan.needed) {
		console.log(`✓ factory ${plan.factory} already has ${describe(plan.next)} — nothing sent`)
		return
	}
	if (process.argv.includes("--dry-run")) {
		console.log(`dry run: would call setPaused(${plan.next.deposits}, ${plan.next.withdraws}) on ${plan.factory}`)
		return
	}
	const hash = await wallet.writeContract({
		address: plan.factory,
		abi: SET_PAUSED_ABI,
		functionName: "setPaused",
		args: [plan.next.deposits, plan.next.withdraws],
		nonce: plan.nonce,
	})
	const receipt = await pub.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`setPaused reverted in ${hash} — STOP`)
	const after = {
		deposits: await pub.readContract({ address, abi: PORTAL_FACTORY_ABI, functionName: "depositsPaused" }),
		withdraws: await pub.readContract({ address, abi: PORTAL_FACTORY_ABI, functionName: "withdrawsPaused" }),
	}
	if (after.deposits !== plan.next.deposits || after.withdraws !== plan.next.withdraws) {
		throw new Error(`setPaused landed in ${hash} but the factory reads ${describe(after)} — STOP`)
	}
	console.log(`✓ factory ${plan.factory}: ${describe(after)} (tx ${hash})`)
}

if (import.meta.main) {
	try {
		await main()
	} catch (e) {
		console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
		process.exit(1)
	}
}
