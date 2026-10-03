/**
 * The testnet generation conductor: one L1 PortalFactory + SwapBridgeRouter and one L2 hub, then
 * the manifest's tokens pre-created and pools seeded, written as a CANDIDATE — never the live file.
 *
 *   bun scripts/deploy-generation.ts deploy   [--dry-run]
 *   bun scripts/deploy-generation.ts pre-create --config <candidate> --token <erc20> [--no-register]
 *   bun scripts/deploy-generation.ts calibrate  --config <candidate> --samples <fees.json>
 *
 * `deploy` needs PRIVATE_KEY (the pinned testnet signer) + SEPOLIA_RPC_URL; AZTEC_NODE_URL defaults
 * to the public testnet RPC. Every step is journalled, so a crashed run resumes with the recorded
 * identities. Real proofs: budget ~15 minutes.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { Address } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { L1Ctx } from "../src/flows"
import { type BridgeBlock, type ManifestToken, type ManifestV2, manifestToken, parseManifestV2 } from "../src/manifest-v2"
import { PRIVATE_FPC_ADDRESS } from "../src/private-fuel"
import { walletChainIdOf } from "../src/wallet-chain-id"
import { type CalibrationSample, calibrateFuelBudgets } from "./calibration"
import { openDeployJournal, readCandidate, writeCandidateAtomically } from "./deploy-manifest"
import { deployGeneration, type GenerationRecord, type L2Ctx, preCreateToken } from "./generation"
import { authenticatedNode, PLAN_PINNED_L1_SIGNERS } from "./live-intent"
import { run } from "./run"
import { evmArtifact } from "./script-artifacts"
import {
	createL1Clients,
	createL2Wallet,
	createNode,
	loadManifestV2FromConfigArg,
	requireBridge,
	sepoliaChain,
	stopwatch,
} from "./script-bootstrap"
import { deployAccountIfAbsent, deployerSchnorrAccount, sponsoredFpcFee } from "./script-l2"
import { TESTNET_NODE_URL } from "../src/testnet-node"

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(here, "..", "..", "..", "apps", "tools", "public")
const CANDIDATE_PATH = join(PUBLIC_DIR, "testnet-bridge.candidate.json")
const LIVE_PATH = join(PUBLIC_DIR, "testnet-bridge.json")
const JOURNAL_PATH = join(here, "..", "deploy-journal", "testnet-generation.jsonl")
const EVM_ROOT = join(here, "..", "..", "..", "contracts", "bridge", "evm")

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"
const NODE_URL = process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined

/** Sepolia's Uniswap V4 + Permit2 + Multicall3 singletons. */
const SEPOLIA = {
	permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
	multicall3: "0xca11bde05977b3631167028862be2a173976ca11",
	poolManager: "0xe03a1074c86cfedd5c142c4f04f1a1536e203543",
	quoter: "0x61b3f2011a92d183c7dbadbda940a7555ccf9227",
	weth: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14",
} as const
const TOKEN_WETH_TIERS = [{ fee: 3000, tickSpacing: 60 }]
const ETH_FJ = { fee: 987, tickSpacing: 10 }
const SLIPPAGE_BPS = 300
// 4× the worst PrivateFPC ceiling the validator measured over three live private claims on the
// testnet fee schedule (7.44 FJ); a one-sample run may only ever raise it.
const MIN_FUEL_FJ = "29773418555864000000"
const MIN_FJ = "16000000000000000000"

const lc = (v: string) => v.toLowerCase() as Address

function requireSigner(): ReturnType<typeof privateKeyToAccount> {
	if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY is required (packages/bridge-core/.env) — STOP")
	const account = privateKeyToAccount(PRIVATE_KEY)
	const pinned = PLAN_PINNED_L1_SIGNERS.testnet
	if (!pinned || account.address.toLowerCase() !== pinned.toLowerCase()) {
		throw new Error(`L1 deployer ${account.address} != pinned testnet signer ${pinned} — wrong key; STOP`)
	}
	return account
}

/** `deployAccount: false` keeps a read-only run read-only — deploying the L2 account is a real,
 *  sponsored-fee-spending transaction, and nothing but an actual generation needs it on chain. */
async function connect(mins: () => string, opts: { deployAccount: boolean }): Promise<{ l1: L1Ctx; l2: L2Ctx; addrs: NodeL1 }> {
	const account = requireSigner()
	// Before any account exists: the registry and portal read here become the generation's immutables.
	const info = await authenticatedNode(NODE_URL)
	const chain = sepoliaChain(SEPOLIA_RPC)
	const l1: L1Ctx = { ...createL1Clients({ chain, rpcUrl: SEPOLIA_RPC, account }), account }
	const node = createNode(NODE_URL)
	const wallet = await createL2Wallet({ nodeUrl: NODE_URL, proverEnabled: true })
	const { manager, from } = await deployerSchnorrAccount(wallet as never, "testnet")
	const { fee } = await sponsoredFpcFee(wallet)
	if (opts.deployAccount) {
		await deployAccountIfAbsent({
			node,
			manager: manager as never,
			from,
			fee,
			log: (stage) =>
				console.log(stage === "deploying" ? `deploying L2 account (real proof)… (${mins()})` : `L2 account ready (${mins()})`),
		})
	}
	const a = info.l1ContractAddresses
	const addrs: NodeL1 = {
		registry: lc(a.registryAddress),
		feeJuice: lc(a.feeJuiceAddress),
		feeJuicePortal: lc(a.feeJuicePortalAddress),
		feeAssetHandler: a.feeAssetHandlerAddress ? lc(a.feeAssetHandlerAddress) : undefined,
		rollupVersion: info.rollupVersion,
		l1ChainId: info.l1ChainId,
	}
	console.log(`L1 deployer ${account.address} · L2 deployer ${from.toString()} · chain ${addrs.l1ChainId}/${addrs.rollupVersion}`)
	return {
		l1,
		l2: {
			wallet: wallet as unknown as Wallet,
			node,
			from,
			deployOpts: { from, fee, wait: { waitForStatus: TxStatus.CHECKPOINTED } },
			sendOpts: { from, fee, wait: { waitForStatus: TxStatus.PROPOSED } },
		},
		addrs,
	}
}

interface NodeL1 {
	registry: Address
	feeJuice: Address
	feeJuicePortal: Address
	feeAssetHandler?: Address
	rollupVersion: number
	l1ChainId: number
}

/** What the journal is stamped with: the chain, rollup and deployer its recorded addresses exist on. */
const identityOf = (l1: L1Ctx, addrs: NodeL1) => ({
	l1ChainId: addrs.l1ChainId,
	rollupVersion: addrs.rollupVersion,
	deployer: lc(l1.account.address),
	registry: addrs.registry,
	feeJuicePortal: addrs.feeJuicePortal,
})

/** The swap target is the one generation piece with no cross-binding, so it deploys first and plain. */
async function deploySwapTarget(l1: L1Ctx, feeJuice: Address, journal: ReturnType<typeof openDeployJournal>): Promise<Address> {
	const prior = journal.steps.find((s) => s.kind === "swap-target-deployed")
	if (prior && prior.kind === "swap-target-deployed") return prior.address as Address
	const art = evmArtifact("UniswapFuelSwap")
	const hash = await l1.wallet.deployContract({
		abi: art.abi,
		bytecode: art.bytecode,
		args: [SEPOLIA.poolManager, feeJuice, SEPOLIA.weth],
		account: l1.account,
		chain: l1.wallet.chain,
	} as never)
	const receipt = await l1.pub.waitForTransactionReceipt({ hash })
	if (!receipt.contractAddress) throw new Error("UniswapFuelSwap: no contractAddress in the receipt — STOP")
	journal.append({ kind: "swap-target-deployed", address: lc(receipt.contractAddress), txHash: hash })
	console.log(`UniswapFuelSwap: ${receipt.contractAddress}`)
	return lc(receipt.contractAddress)
}

function priorSwapBudgets(): { fjPerTx: string; fjRegister: string } {
	if (!existsSync(LIVE_PATH)) return { fjPerTx: "0", fjRegister: "0" }
	try {
		const live = parseManifestV2(JSON.parse(readFileSync(LIVE_PATH, "utf8")))
		const swap = live.bridge?.l1.swap
		return swap ? { fjPerTx: swap.fjPerTx, fjRegister: swap.fjRegister } : { fjPerTx: "0", fjRegister: "0" }
	} catch {
		// A live file on the previous schema carries no budgets worth carrying.
		return { fjPerTx: "0", fjRegister: "0" }
	}
}

/** The canonical PrivateFPC the manifest advertises: the pinned address with the descriptor's
 *  version + artifact digest, so a reader can tell which FPC generation the fuel lane pays through. */
function privateFpcBlock(): NonNullable<ManifestV2["privateFpc"]> {
	const descriptor = JSON.parse(readFileSync(join(here, "..", "src", "private-fpc-canonical.json"), "utf8")) as {
		aztecVersion: string
		artifactSha256: string
	}
	return { address: PRIVATE_FPC_ADDRESS, version: descriptor.aztecVersion, artifactDigest: descriptor.artifactSha256 }
}

function buildCandidate(gen: GenerationRecord, addrs: NodeL1, tokens: ManifestToken[]): ManifestV2 {
	const budgets = priorSwapBudgets()
	const bridge: BridgeBlock = {
		l1: {
			...gen.l1,
			swap: {
				poolManager: SEPOLIA.poolManager,
				quoter: SEPOLIA.quoter,
				multicall3: SEPOLIA.multicall3,
				weth: SEPOLIA.weth,
				feeJuice: addrs.feeJuice,
				tiers: TOKEN_WETH_TIERS,
				ethFj: ETH_FJ,
				slippageBps: SLIPPAGE_BPS,
				minFuelFj: MIN_FUEL_FJ,
				...budgets,
			},
		},
		l2: gen.l2,
		tokens,
	}
	return {
		schema: 2,
		network: "testnet",
		l1ChainId: addrs.l1ChainId,
		walletChainId: walletChainIdOf(addrs.l1ChainId, addrs.rollupVersion),
		bridge,
		feeJuice: {
			portal: addrs.feeJuicePortal,
			asset: addrs.feeJuice,
			...(addrs.feeAssetHandler ? { feeAssetHandler: addrs.feeAssetHandler } : {}),
			minFj: MIN_FJ,
		},
		privateFpc: privateFpcBlock(),
		privateClaimMode: "salt-v2",
	}
}

/** `SeedTokenPool.s.sol` gives a fresh mintable token its TOKEN/WETH leg; the ETH/FJ leg carries over. */
function seedPool(erc20: Address, journal: ReturnType<typeof openDeployJournal>): void {
	if (journal.has("pool-seeded", erc20)) return
	if (process.env.SKIP_POOL_SEED === "1") {
		console.log(`  pool seed skipped for ${erc20} (SKIP_POOL_SEED=1)`)
		return
	}
	const result = run("forge", ["script", "script/SeedTokenPool.s.sol:SeedTokenPool", "--rpc-url", SEPOLIA_RPC, "--broadcast", "-vv"], {
		cwd: EVM_ROOT,
		env: { ...process.env, TOKEN: erc20 },
		// stdout is piped so the journal can carry the seeding tx; an inherited one reaches the operator
		// but never this process. `-vv` outruns spawnSync's 1 MiB default, and ENOBUFS would fail a
		// pool that actually landed.
		stdio: ["inherit", "pipe", "inherit"],
		maxBuffer: 32 * 1024 * 1024,
	})
	if (result.stdout) console.log(result.stdout)
	const txHash = result.stdout.match(/0x[0-9a-f]{64}/gi)?.at(-1)
	journal.append({ kind: "pool-seeded", erc20: lc(erc20), ...(txHash ? { txHash } : {}) })
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag)
	return i === -1 ? undefined : process.argv[i + 1]
}

/** The mintable test tokens a testnet generation ships with; each gets a portal, a hub registration and a pool. */
function seedTokens(): Address[] {
	const raw = process.env.SEED_TOKENS
	if (!raw) throw new Error("SEED_TOKENS=<erc20>[,<erc20>…] is required for `deploy` (the fake USDC/USDT to pre-create) — STOP")
	return raw.split(",").map((t) => lc(t.trim()))
}

async function commandDeploy(): Promise<void> {
	const mins = stopwatch()
	const dryRun = process.argv.includes("--dry-run")
	const tokens = seedTokens()
	const { l1, l2, addrs } = await connect(mins, { deployAccount: !dryRun })
	if (dryRun) {
		console.log(`dry run: would deploy a generation on ${addrs.l1ChainId}/${addrs.rollupVersion} with tokens ${tokens.join(", ")}`)
		return
	}
	const journal = openDeployJournal(JOURNAL_PATH, identityOf(l1, addrs))
	const swapTarget = await deploySwapTarget(l1, addrs.feeJuice, journal)
	console.log(`\n=== generation (${mins()}) ===`)
	const gen = await deployGeneration(
		l1,
		l2,
		{
			registry: addrs.registry,
			permit2: SEPOLIA.permit2,
			feeJuicePortal: addrs.feeJuicePortal,
			feeJuice: addrs.feeJuice,
			guardianL1: l1.account.address,
			guardianL2: l2.from.toString(),
			swapTarget,
		},
		journal,
	)
	console.log(`\n=== tokens (${mins()}) ===`)
	const manifestTokens: ManifestToken[] = []
	for (const erc20 of tokens) {
		manifestTokens.push(await preCreateToken(l1, l2, gen, erc20, journal, { maxWholePerTx: 1_000_000 }))
		seedPool(erc20, journal)
	}
	const candidate = buildCandidate(gen, addrs, manifestTokens)
	writeCandidateAtomically(CANDIDATE_PATH, candidate)
	// Repo-relative: the journal is the generation's record and must not carry a machine's layout.
	journal.append({ kind: "candidate-written", path: "apps/tools/public/testnet-bridge.candidate.json" })
	console.log(`\n✅ candidate written to apps/tools/public/testnet-bridge.candidate.json (${mins()})`)
	console.log("   next: bun scripts/smoke-existing-testnet.ts --config <candidate>, then calibrate, then live-intent promote.")
}

/** Adds one token to an existing generation's candidate: portal clone, hub registration, pool. */
async function commandPreCreate(): Promise<void> {
	const mins = stopwatch()
	const configPath = argValue("--config") ?? CANDIDATE_PATH
	const erc20 = argValue("--token")
	if (!erc20) throw new Error("pre-create needs --token <erc20>")
	const manifest = readCandidate(configPath)
	if (!manifest) throw new Error(`no candidate at ${configPath} — run \`deploy\` first`)
	const bridge = requireBridge(manifest)
	if (manifestToken(manifest, erc20)) throw new Error(`${erc20} is already in the candidate — nothing to pre-create`)
	const { l1, l2, addrs } = await connect(mins, { deployAccount: true })
	const journal = openDeployJournal(JOURNAL_PATH, identityOf(l1, addrs))
	const gen: GenerationRecord = {
		l1: { ...bridge.l1, swap: undefined } as GenerationRecord["l1"],
		l2: bridge.l2 as GenerationRecord["l2"],
	}
	const token = await preCreateToken(l1, l2, gen, lc(erc20), journal, {
		register: !process.argv.includes("--no-register"),
		maxWholePerTx: 1_000_000,
	})
	if (process.argv.includes("--seed-pool")) seedPool(lc(erc20), journal)
	const next: ManifestV2 = { ...manifest, bridge: { ...bridge, tokens: [...bridge.tokens, token] } }
	writeCandidateAtomically(configPath, next)
	console.log(`✅ ${token.displaySymbol} added to ${configPath} (${mins()})`)
}

/** Writes measured `fjPerTx`/`fjRegister` into the candidate from a samples file the smoke printed. */
function commandCalibrate(): void {
	const configPath = argValue("--config") ?? CANDIDATE_PATH
	const samplesPath = argValue("--samples")
	if (!samplesPath) throw new Error("calibrate needs --samples <fees.json> (an array of {shape, feeMode, transactionFee})")
	const manifest = loadManifestV2FromConfigArg(["", "", "--config", configPath], { mode: "required" })
	const bridge = requireBridge(manifest)
	if (!bridge.l1.swap) throw new Error("the candidate has no swap block to calibrate — STOP")
	const raw = JSON.parse(readFileSync(samplesPath, "utf8")) as Array<
		Omit<CalibrationSample, "transactionFee"> & { transactionFee: string }
	>
	const budgets = calibrateFuelBudgets(raw.map((s) => ({ ...s, transactionFee: BigInt(s.transactionFee) })))
	const swap = { ...bridge.l1.swap, fjPerTx: budgets.fjPerTx.toString(), fjRegister: budgets.fjRegister.toString() }
	const next: ManifestV2 = { ...manifest, bridge: { ...bridge, l1: { ...bridge.l1, swap } } }
	writeCandidateAtomically(configPath, next)
	console.log(`✅ fjPerTx=${swap.fjPerTx} fjRegister=${swap.fjRegister} written to ${configPath}`)
}

async function main(): Promise<void> {
	const command = process.argv[2]
	if (command === "deploy") return commandDeploy()
	if (command === "pre-create") return commandPreCreate()
	if (command === "calibrate") return commandCalibrate()
	throw new Error("usage: deploy-generation.ts <deploy|pre-create|calibrate> [flags] — see the header")
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
