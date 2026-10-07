/**
 * The testnet generation conductor: one L1 PortalFactory and one L2 hub, the manifest's tokens
 * pre-created, then the DepositRouter and its TestnetFuelSwapper, written as a CANDIDATE — never the
 * live file.
 *
 *   bun scripts/deploy-generation.ts deploy --rates <rates.json> [--routing <routing.json>] [--dry-run]
 *   bun scripts/deploy-generation.ts deploy --router-only --rates <rates.json> [--config <base>] [--routing <routing.json>] [--dry-run]
 *   bun scripts/deploy-generation.ts pre-create --config <candidate> --token <erc20> [--no-register]
 *   bun scripts/deploy-generation.ts calibrate  --config <candidate> --samples <fees.json>
 *
 * `deploy` needs PRIVATE_KEY (the pinned testnet signer) + SEPOLIA_RPC_URL; AZTEC_NODE_URL defaults
 * to the public testnet RPC. Every step is journalled, so a crashed run resumes with the recorded
 * identities. Real proofs: budget ~15 minutes. `--rates` names the swapper's rate for every token
 * (`{ "<erc20>": "<fee-asset units per whole token>" }`). `--router-only` is L1-only (no L2 account,
 * no proofs): a new DepositRouter and TestnetFuelSwapper for the current generation, `--config`
 * (default: the live manifest) as the base of the candidate it writes.
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
import { applyFuelBudgets, type CalibrationSample, calibrateFuelBudgets } from "./calibration"
import { openDeployJournal, readCandidate, writeCandidateAtomically } from "./deploy-manifest"
import { deployGeneration, type GenerationRecord, type L2Ctx, preCreateToken } from "./generation"
import {
	DEFAULT_CROSS_CHAIN_SLIPPAGE_BPS,
	deployRouterOnly,
	parseRates,
	parseRouting,
	planRouterOnly,
	type RouterOnlyNetwork,
	type RouterOnlyOptions,
} from "./generation-router"
import { authenticatedNode, type NodeIdentity, PLAN_PINNED_L1_SIGNERS } from "./live-intent"
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

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"
const NODE_URL = process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined

/** Sepolia's canonical Permit2. */
const SEPOLIA_PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3"
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
	const addrs = nodeL1Of(info)
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

/** The node's L1 bindings, as `authenticatedNode` pinned them against the committed baseline. */
function nodeL1Of(info: NodeIdentity): NodeL1 {
	const a = info.l1ContractAddresses
	const handler = a.feeAssetHandlerAddress
	return {
		registry: lc(String(a.registryAddress)),
		feeJuice: lc(String(a.feeJuiceAddress)),
		feeJuicePortal: lc(String(a.feeJuicePortalAddress)),
		...(handler ? { feeAssetHandler: lc(String(handler)) } : {}),
		rollupVersion: info.rollupVersion,
		l1ChainId: info.l1ChainId,
	}
}

/** What the router binds: the node's L1 bindings and Sepolia's canonical Permit2. */
const routerNetworkOf = (addrs: NodeL1): RouterOnlyNetwork => ({ ...addrs, permit2: SEPOLIA_PERMIT2 })

/** What the journal is stamped with: the chain, rollup and deployer its recorded addresses exist on. */
const identityOf = (l1: L1Ctx, addrs: NodeL1) => ({
	l1ChainId: addrs.l1ChainId,
	rollupVersion: addrs.rollupVersion,
	deployer: lc(l1.account.address),
	registry: addrs.registry,
	feeJuicePortal: addrs.feeJuicePortal,
})

type FuelBudgets = NonNullable<BridgeBlock["l1"]["fuel"]>

/** The live manifest's measured `fjPerTx`/`fjRegister`, which price the same network's L2 claims; a first
 *  generation starts unmeasured until `calibrate`. */
function priorFuelBudgets(): FuelBudgets {
	const unmeasured: FuelBudgets = {
		slippageBps: SLIPPAGE_BPS,
		crossChainSlippageBps: DEFAULT_CROSS_CHAIN_SLIPPAGE_BPS,
		minFuelFj: MIN_FUEL_FJ,
		fjPerTx: "0",
		fjRegister: "0",
	}
	if (!existsSync(LIVE_PATH)) return unmeasured
	try {
		const fuel = parseManifestV2(JSON.parse(readFileSync(LIVE_PATH, "utf8"))).bridge?.l1.fuel
		return fuel ? { ...unmeasured, fjPerTx: fuel.fjPerTx, fjRegister: fuel.fjRegister } : unmeasured
	} catch {
		// A live file on a previous schema carries no budgets worth carrying.
		return unmeasured
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

/** The generation and its tokens with the fuel budgets the router deploy carries into the candidate. */
function generationBase(gen: GenerationRecord, addrs: NodeL1, tokens: ManifestToken[]): ManifestV2 {
	const bridge: BridgeBlock = { l1: { ...gen.l1, fuel: priorFuelBudgets() }, l2: gen.l2, tokens }
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

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag)
	return i === -1 ? undefined : process.argv[i + 1]
}

/** The mintable test tokens a testnet generation ships with; each gets a portal and a hub registration. */
function seedTokens(): Address[] {
	const raw = process.env.SEED_TOKENS
	if (!raw) throw new Error("SEED_TOKENS=<erc20>[,<erc20>…] is required for `deploy` (the fake USDC/USDT to pre-create) — STOP")
	return raw.split(",").map((t) => lc(t.trim()))
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"))

/** The swapper rates, refused before anything is sent when a token the run deploys has none. */
function ratesArg(tokens: readonly string[] = []): Record<string, bigint> {
	const path = argValue("--rates")
	if (!path) throw new Error('deploy needs --rates <rates.json> ({ "<erc20>": "<fee-asset units per whole token>" })')
	const rates = parseRates(readJson(path))
	const unrated = tokens.filter((t) => !rates[lc(t)])
	if (unrated.length > 0) throw new Error(`--rates names no swapper rate for ${unrated.join(", ")} — STOP`)
	return rates
}

function routingArg(): Pick<RouterOnlyOptions, "routing"> {
	const path = argValue("--routing")
	return path ? { routing: parseRouting(readJson(path)) } : {}
}

async function commandDeploy(): Promise<void> {
	const mins = stopwatch()
	const dryRun = process.argv.includes("--dry-run")
	const tokens = seedTokens()
	const rates = ratesArg(tokens)
	const { l1, l2, addrs } = await connect(mins, { deployAccount: !dryRun })
	if (dryRun) {
		console.log(`dry run: would deploy a generation on ${addrs.l1ChainId}/${addrs.rollupVersion} with tokens ${tokens.join(", ")}`)
		return
	}
	const journal = openDeployJournal(JOURNAL_PATH, identityOf(l1, addrs))
	console.log(`\n=== generation (${mins()}) ===`)
	const gen = await deployGeneration(
		l1,
		l2,
		{
			registry: addrs.registry,
			permit2: SEPOLIA_PERMIT2,
			feeJuicePortal: addrs.feeJuicePortal,
			guardianL1: l1.account.address,
			guardianL2: l2.from.toString(),
		},
		journal,
	)
	console.log(`\n=== tokens (${mins()}) ===`)
	const manifestTokens: ManifestToken[] = []
	for (const erc20 of tokens) manifestTokens.push(await preCreateToken(l1, l2, gen, erc20, journal, { maxWholePerTx: 1_000_000 }))
	console.log(`\n=== router (${mins()}) ===`)
	await deployRouterOnly({
		l1,
		network: routerNetworkOf(addrs),
		journalPath: JOURNAL_PATH,
		base: generationBase(gen, addrs, manifestTokens),
		rates,
		...routingArg(),
		candidatePath: CANDIDATE_PATH,
	})
	// Repo-relative: the journal is the generation's record and must not carry a machine's layout.
	journal.append({ kind: "candidate-written", path: "apps/tools/public/testnet-bridge.candidate.json" })
	console.log(`\n✅ candidate written to apps/tools/public/testnet-bridge.candidate.json (${mins()})`)
	console.log("   next: verify:l1 --strict, bun scripts/smoke-existing-testnet.ts --config <candidate>, calibrate, live-intent promote.")
}

/** A new DepositRouter + TestnetFuelSwapper for the current generation. L1 only: no L2 account, no proofs. */
async function commandRouterOnly(): Promise<void> {
	const mins = stopwatch()
	const rates = ratesArg()
	const account = requireSigner()
	const info = await authenticatedNode(NODE_URL)
	const l1: L1Ctx = { ...createL1Clients({ chain: sepoliaChain(SEPOLIA_RPC), rpcUrl: SEPOLIA_RPC, account }), account }
	const options: RouterOnlyOptions = {
		l1,
		network: routerNetworkOf(nodeL1Of(info)),
		journalPath: JOURNAL_PATH,
		base: loadManifestV2FromConfigArg(process.argv, { mode: "fallback", fallbackPath: LIVE_PATH }),
		rates,
		...routingArg(),
		candidatePath: CANDIDATE_PATH,
	}
	if (process.argv.includes("--dry-run")) {
		for (const line of await planRouterOnly(options)) console.log(`dry run: ${line}`)
		return
	}
	const { fuelSwapper, depositRouter } = await deployRouterOnly(options)
	const how = (d: { adopted: boolean }) => (d.adopted ? "adopted" : "deployed")
	console.log(
		`\n✅ swapper ${fuelSwapper.address} (${how(fuelSwapper)}), router ${depositRouter.address} (${how(depositRouter)}) (${mins()})`,
	)
	console.log(
		"   candidate written to apps/tools/public/testnet-bridge.candidate.json; next: pre-create, verify:l1 --strict, the smokes.",
	)
}

/** Adds one token to an existing generation's candidate: portal clone and hub registration. */
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
	const gen: GenerationRecord = { l1: bridge.l1 as GenerationRecord["l1"], l2: bridge.l2 as GenerationRecord["l2"] }
	const token = await preCreateToken(l1, l2, gen, lc(erc20), journal, {
		register: !process.argv.includes("--no-register"),
		// A real token has no public mint, so the app must not offer one.
		...(process.argv.includes("--canonical") ? { source: "canonical" as const } : { maxWholePerTx: 1_000_000 }),
	})
	const next: ManifestV2 = { ...manifest, bridge: { ...bridge, tokens: [...bridge.tokens, token] } }
	writeCandidateAtomically(configPath, next)
	console.log(`✅ ${token.displaySymbol} added to ${configPath} (${mins()})`)
}

/** Writes measured `fjPerTx`/`fjRegister` into the candidate's `fuel` block from a samples file the smoke printed. */
function commandCalibrate(): void {
	const configPath = argValue("--config") ?? CANDIDATE_PATH
	const samplesPath = argValue("--samples")
	if (!samplesPath) throw new Error("calibrate needs --samples <fees.json> (an array of {shape, feeMode, transactionFee})")
	const manifest = loadManifestV2FromConfigArg(["", "", "--config", configPath], { mode: "required" })
	const raw = readJson(samplesPath) as Array<Omit<CalibrationSample, "transactionFee"> & { transactionFee: string }>
	const budgets = calibrateFuelBudgets(raw.map((s) => ({ ...s, transactionFee: BigInt(s.transactionFee) })))
	writeCandidateAtomically(configPath, applyFuelBudgets(manifest, budgets))
	console.log(`✅ fjPerTx=${budgets.fjPerTx} fjRegister=${budgets.fjRegister} written to ${configPath}`)
}

async function main(): Promise<void> {
	const command = process.argv[2]
	if (command === "deploy" && process.argv.includes("--router-only")) return commandRouterOnly()
	if (command === "deploy") return commandDeploy()
	if (command === "pre-create") return commandPreCreate()
	if (command === "calibrate") return commandCalibrate()
	throw new Error("usage: deploy-generation.ts <deploy|pre-create|calibrate> [flags] — see the header")
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
