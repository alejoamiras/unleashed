/**
 * The testnet LI.FI canary: Base Sepolia → Sepolia over Across, and Sepolia-origin Permit2 deposits, against
 * the manifest's `DepositRouter` and `TestnetFuelSwapper`, signed by the disposable canary key.
 *
 *   bun scripts/lifi-canary-testnet.ts --config apps/tools/public/testnet-bridge.json [--dry-run] [--canary 0x…]
 *
 * Env: CANARY_PRIVATE_KEY (live; a dry run uses only its address, or `--canary`, or the pin),
 * SEPOLIA_RPC_URL, BASE_SEPOLIA_RPC_URL, AZTEC_NODE_URL. A live run replays the whole matrix as a dry run
 * first, so every refusal fires before its first send (the Aztec account deploy included). Prints the record.
 */
import { FEE_JUICE_ADDRESS } from "@aztec-labs/constants"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type Address, getAddress, type Hex, type LocalAccount, type PublicClient, pad, parseEther, toHex, type WalletClient } from "viem"
import { privateKeyToAccount, privateKeyToAddress } from "viem/accounts"
import type { DiscoveryChainReads } from "../src/crosschain-discovery"
import type { L1Ctx } from "../src/flows"
import { lifiBook } from "../src/lifi-addresses"
import type { ManifestV2 } from "../src/manifest-v2"
import { TESTNET_NODE_URL } from "../src/testnet-node"
import { runFpcGate } from "./check-fpc-version"
import { type FillDeps, fillSourceDeposit } from "./fill-testnet"
import { ACROSS_TESTNET_API } from "./lifi-canary-across"
import { openCanaryL2 } from "./lifi-canary-l2"
import { type CanaryAmounts, type CanaryCaps, CanaryRefusal, canaryBindings, formatCanaryRecord, type GasPerRow } from "./lifi-canary-plan"
import { type CanaryConfig, type CanaryDeps, type CanaryLive, type ChainReads, runCanary } from "./lifi-canary-run"
import { CANARY_CAPS, PLAN_PINNED_CANARY_SIGNERS } from "./live-intent"
import { createL1Clients, createL1PublicClient, loadManifestV2FromConfigArg, stopwatch } from "./script-bootstrap"
import { manifestL1Chain, sourceRpcUrl } from "./script-l1"

export const SOURCE_CHAIN_ID = 84532
export const SEPOLIA_RPC_DEFAULT = "https://ethereum-sepolia-rpc.publicnode.com"
export const BASE_SEPOLIA_RPC_DEFAULT = "https://base-sepolia-rpc.publicnode.com"

/** In the rail asset's base units (6-decimal USDC): inside Across's observed testnet limits of ~4.9–8 USDC. */
export const TESTNET_AMOUNTS: CanaryAmounts = { crossChain: 6_000_000n, ethereumPlain: 2_000_000n, ethereumFueled: 3_000_000n }
export const TESTNET_TOKEN_CAPS = { sourcePerRow: 8_000_000n, sourceTotal: 24_000_000n, ethereumTotal: 30_000_000n }
/** Sized so the matrix's worst case fits `CANARY_CAPS`: three source rows and five Sepolia signings. */
export const TESTNET_GAS_PER_ROW: GasPerRow = { source: parseEther("0.005"), ethereum: parseEther("0.03") }
export const TESTNET_WINDOWS: CanaryConfig["windows"] = { organicFillMs: 5 * 60_000, settleMs: 10 * 60_000, pollMs: 15_000 }

export interface CanaryArgs {
	dryRun: boolean
	/** A dry run's canary address when no key is set. */
	canary?: Address
}

export function parseCanaryArgs(argv: readonly string[]): CanaryArgs {
	const at = argv.indexOf("--canary")
	const canary = at === -1 ? undefined : argv[at + 1]
	if (at !== -1 && !canary?.match(/^0x[0-9a-fA-F]{40}$/)) throw new CanaryRefusal("--canary takes an address")
	return { dryRun: argv.includes("--dry-run"), ...(canary ? { canary: getAddress(canary) } : {}) }
}

/** Every binding a run uses. The key is never held: a live edge carries its signer, a dry one only an address. */
export interface CanaryEdge {
	cfg: CanaryConfig
	rpc: { source: string; ethereum: string }
	nodeUrl: string
	acrossBase: string
	signer?: LocalAccount
}

type Env = Readonly<Record<string, string | undefined>>

function canaryKey(env: Env): Hex | undefined {
	const key = env.CANARY_PRIVATE_KEY
	if (key === undefined || key === "") return undefined
	if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new CanaryRefusal("CANARY_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key")
	return key as Hex
}

/** The signer of a live run, or the address a dry run reads balances for. */
function canaryIdentity(args: CanaryArgs, env: Env, pinned: Address | null): { canary: Address; signer?: LocalAccount } {
	const key = canaryKey(env)
	if (args.dryRun) {
		const canary = key ? privateKeyToAddress(key) : (args.canary ?? pinned)
		if (!canary) throw new CanaryRefusal("a dry run needs CANARY_PRIVATE_KEY, --canary or a pinned canary to read balances for")
		return { canary }
	}
	if (!key) throw new CanaryRefusal("a live run signs with CANARY_PRIVATE_KEY, which is not set")
	const signer = privateKeyToAccount(key)
	if (pinned === null) throw new CanaryRefusal("no canary address is pinned yet; a live run waits for the pin")
	if (signer.address !== getAddress(pinned))
		throw new CanaryRefusal(`the canary key signs as ${signer.address}, not the pinned ${pinned}`)
	return { canary: signer.address, signer }
}

const gasCap = (chainId: number): bigint => {
	const cap = CANARY_CAPS[String(chainId)]
	if (!cap) throw new CanaryRefusal(`the intent caps no canary spend on chain ${chainId}`)
	return parseEther(cap.maxEthSpend)
}

/**
 * Resolves the run's bindings from the manifest, the LI.FI book, the intent's pins and caps, and `env`.
 *
 * @throws CanaryRefusal on a malformed key, a live run without the key or the pin, or a key that is not the pin.
 */
export function canaryEdge(
	manifest: ManifestV2,
	args: CanaryArgs,
	env: Env,
	pinned = PLAN_PINNED_CANARY_SIGNERS.testnet as Address | null,
): CanaryEdge {
	const { canary, signer } = canaryIdentity(args, env, pinned)
	const source = lifiBook(SOURCE_CHAIN_ID)
	const destination = lifiBook(manifest.l1ChainId)
	// The Inbox records the FeeJuicePortal's messages as sent by, and to, the Fee Juice address.
	const feeJuice = toHex(FEE_JUICE_ADDRESS)
	const caps: CanaryCaps = {
		sourceChainId: SOURCE_CHAIN_ID,
		...TESTNET_TOKEN_CAPS,
		gasWei: { source: gasCap(SOURCE_CHAIN_ID), ethereum: gasCap(manifest.l1ChainId) },
	}
	const cfg: CanaryConfig = {
		manifest,
		sourceChainId: SOURCE_CHAIN_ID,
		lifi: {
			diamond: source.diamond,
			sourceSpokePool: source.acrossSpokePool,
			destinationSpokePool: destination.acrossSpokePool,
			receiverAcrossV4: destination.receiverAcrossV4,
			executor: destination.executor,
		},
		inbox: { shape: "artifact", feeJuice: { l2: pad(feeJuice, { size: 32 }), l1Sender: pad(feeJuice, { size: 20 }) as Address } },
		canary,
		pinned,
		caps,
		amounts: TESTNET_AMOUNTS,
		gasPerRow: TESTNET_GAS_PER_ROW,
		windows: TESTNET_WINDOWS,
	}
	return {
		cfg,
		rpc: {
			source: sourceRpcUrl(SOURCE_CHAIN_ID, env) ?? BASE_SEPOLIA_RPC_DEFAULT,
			ethereum: env.SEPOLIA_RPC_URL || SEPOLIA_RPC_DEFAULT,
		},
		nodeUrl: env.AZTEC_NODE_URL || TESTNET_NODE_URL,
		acrossBase: ACROSS_TESTNET_API,
		...(signer ? { signer } : {}),
	}
}

const chainOf = (chainId: number, rpcUrl: string) => manifestL1Chain({ network: `chain-${chainId}`, l1ChainId: chainId }, rpcUrl)

/** Read-only clients: all a dry run ever constructs. */
export function canaryReads(edge: CanaryEdge): { source: PublicClient; ethereum: PublicClient } {
	return {
		source: createL1PublicClient({ chain: chainOf(SOURCE_CHAIN_ID, edge.rpc.source), rpcUrl: edge.rpc.source }),
		ethereum: createL1PublicClient({ chain: chainOf(edge.cfg.manifest.l1ChainId, edge.rpc.ethereum), rpcUrl: edge.rpc.ethereum }),
	}
}

/** Signers on both chains, the Aztec account and the filler. Sends the Aztec account deploy. */
async function liveMode(edge: CanaryEdge, signer: LocalAccount): Promise<CanaryLive> {
	const { cfg } = edge
	await runFpcGate("require-deployed")
	const src = createL1Clients({ chain: chainOf(SOURCE_CHAIN_ID, edge.rpc.source), rpcUrl: edge.rpc.source, account: signer })
	const eth = createL1Clients({ chain: chainOf(cfg.manifest.l1ChainId, edge.rpc.ethereum), rpcUrl: edge.rpc.ethereum, account: signer })
	const source: L1Ctx = { pub: src.pub as PublicClient, wallet: src.wallet as WalletClient, account: signer }
	const ethereum: L1Ctx = { pub: eth.pub as PublicClient, wallet: eth.wallet as WalletClient, account: signer }
	const destToken = canaryBindings(cfg.manifest, cfg.sourceChainId).destToken
	const l2 = await openCanaryL2({
		nodeUrl: edge.nodeUrl,
		manifest: cfg.manifest,
		tokens: [destToken],
		registrations: ethereum.pub as never,
		mins: stopwatch(),
	})
	const fillDeps: FillDeps = {
		source: source.pub,
		destination: { public: ethereum.pub, wallet: ethereum.wallet as FillDeps["destination"]["wallet"] },
		sourceSpokePool: cfg.lifi.sourceSpokePool,
		destinationSpokePool: cfg.lifi.destinationSpokePool,
	}
	return {
		kind: "live",
		source,
		ethereum,
		discovery: { source: source.pub as unknown as DiscoveryChainReads, ethereum: ethereum.pub as unknown as DiscoveryChainReads },
		l2,
		selfFill: (srcTxHash) => fillSourceDeposit(fillDeps, srcTxHash),
	}
}

async function main(): Promise<void> {
	const manifest = loadManifestV2FromConfigArg(process.argv, { mode: "required", requiredHint: "apps/tools/public/testnet-bridge.json" })
	const args = parseCanaryArgs(process.argv)
	const edge = canaryEdge(manifest, args, process.env)
	const reads = canaryReads(edge)
	const base: Omit<CanaryDeps, "recipient" | "mode"> = {
		reads: { source: reads.source as unknown as ChainReads, ethereum: reads.ethereum as unknown as ChainReads },
		across: { fetch: globalThis.fetch, base: edge.acrossBase },
		random: () => Fr.random(),
		now: () => Date.now(),
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		log: (line) => console.log(line),
	}
	const preflight = await runCanary(edge.cfg, { ...base, recipient: await AztecAddress.random(), mode: { kind: "dry-run" } })
	if (args.dryRun || !edge.signer) {
		console.log(formatCanaryRecord(preflight))
		return
	}
	if (preflight.funding.length > 0) throw new CanaryRefusal(`the canary is not funded for the matrix (${preflight.funding.join("; ")})`)
	const live = await liveMode(edge, edge.signer)
	console.log(formatCanaryRecord(await runCanary(edge.cfg, { ...base, recipient: live.l2.recipient, mode: live })))
}

if (import.meta.main) {
	main().then(
		() => process.exit(0),
		(e: unknown) => {
			console.error(e instanceof Error ? e.message : e)
			process.exit(1)
		},
	)
}
