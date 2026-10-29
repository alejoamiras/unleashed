/**
 * The testnet generation conductor: one L1 PortalFactory and one L2 hub, the manifest's tokens
 * pre-created, then the DepositRouter and its TestnetFuelSwapper, written as a CANDIDATE — never the
 * live file.
 *
 *   bun scripts/deploy-generation.ts deploy --rates <rates.json> [--routing <routing.json>] [--dry-run]
 *   bun scripts/deploy-generation.ts deploy --router-only --rates <rates.json> [--config <base>] [--routing <routing.json>] [--dry-run]
 *   bun scripts/deploy-generation.ts deploy --fuel-route --fuel <fuel.json> [--config <base>] [--dry-run]
 *   bun scripts/deploy-generation.ts pre-create --config <candidate> --token <erc20> [--no-register]
 *   bun scripts/deploy-generation.ts calibrate  --config <candidate> --samples <fees.json>
 *
 * `deploy` and `pre-create` run as a keyed run on testnet-generation.env.example: PRIVATE_KEY (the
 * pinned testnet signer), SEPOLIA_RPC_URL, BRIDGE_DEPLOYER_SECRET_TESTNET and DRPC_API_KEY, the node's
 * key. Every step is journalled, so a crashed run resumes with the recorded identities. Real proofs:
 * budget ~15 minutes. `--rates` names the swapper's rate for every token
 * (`{ "<erc20>": "<fee-asset units per whole token>" }`). `--router-only` is L1-only (no L2 account,
 * no proofs): a new DepositRouter and TestnetFuelSwapper for the current generation, `--config`
 * (default: the live manifest) as the base of the candidate it writes.
 *
 * `--fuel-route` is Ethereum mainnet's: a FuelOnlyGate and a DepositRouter swapping through LI.FI's Diamond, L1 only,
 * as a keyed run on mainnet-l1.env.example (PRIVATE_KEY, the pinned mainnet signer; ETH_RPC_URL; DRPC_API_KEY).
 * `--fuel` names the route's `{ slippageBps, minFuelFj, fjPerTx }`; `--config` (default: the live mainnet manifest)
 * is the placeholder the candidate extends.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { Address } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
	manifestPrivateFpc,
	type BridgeBlock,
	fuelRouteSchema,
	type ManifestToken,
	type ManifestV2,
	manifestToken,
	parseManifestV2,
	walletChainIdOf,
} from "@unleashed/sdk/protocol"
import type { L1Ctx } from "@unleashed/sdk/internal"
import { applyFuelBudgets, type CalibrationSample, calibrateFuelBudgets } from "./calibration"
import { openDeployJournal, readCandidate, writeCandidateAtomically } from "./deploy-manifest"
import { deployFuelRoute, type FuelRouteOptions, planFuelRoute } from "./fuel-route"
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
import {
	authenticatedMainnetNode,
	authenticatedNode,
	MAINNET_JOURNAL,
	MAINNET_REGISTRY,
	type NodeIdentity,
	PLAN_PINNED_L1_SIGNERS,
} from "./live-intent"
import {
	createL1Clients,
	createL2Wallet,
	createNode,
	loadManifestV2FromConfigArg,
	mainnetChain,
	requireBridge,
	sepoliaChain,
	stopwatch,
} from "./script-bootstrap"
import { CANONICAL_PERMIT2 } from "@unleashed/sdk/protocol"
import { deployAccountIfAbsent, deployerSchnorrAccount, sponsoredFpcFee } from "./script-l2"
import { requireDrpcNodeUrl } from "../src/drpc-node"

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(here, "..", "..", "..", "apps", "tools", "public")
const CANDIDATE_PATH = join(PUBLIC_DIR, "testnet-bridge.candidate.json")
const LIVE_PATH = join(PUBLIC_DIR, "testnet-bridge.json")
const JOURNAL_PATH = join(here, "..", "deploy-journal", "testnet-generation.jsonl")
const REPO_ROOT = join(here, "..", "..", "..")
const MAINNET_LIVE_PATH = join(PUBLIC_DIR, "mainnet-bridge.json")
const MAINNET_CANDIDATE = "apps/tools/public/mainnet-bridge.candidate.json"

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined

/** Sepolia's canonical Permit2. */
const SEPOLIA_PERMIT2 = CANONICAL_PERMIT2
const SLIPPAGE_BPS = 300
// 4× the worst PrivateFPC ceiling the validator measured over three live private claims on the
// testnet fee schedule (7.44 FJ); a one-sample run may only ever raise it.
const MIN_FUEL_FJ = "29773418555864000000"
const MIN_FJ = "16000000000000000000"

const lc = (v: string) => v.toLowerCase() as Address

/** The env's signer, refused unless it is `network`'s pinned one, before any node or L1 read. */
function requireSigner(network: "testnet" | "mainnet" = "testnet"): ReturnType<typeof privateKeyToAccount> {
	if (!PRIVATE_KEY) throw new Error(`PRIVATE_KEY is required: run this through its ${network} keyed-run template — STOP`)
	const account = privateKeyToAccount(PRIVATE_KEY)
	const pinned = PLAN_PINNED_L1_SIGNERS[network]
	if (!pinned || account.address.toLowerCase() !== pinned.toLowerCase()) {
		throw new Error(`L1 deployer ${account.address} != pinned ${network} signer ${pinned} — wrong key; STOP`)
	}
	return account
}

/** `deployAccount: false` keeps a read-only run read-only — deploying the L2 account is a real,
 *  sponsored-fee-spending transaction, and nothing but an actual generation needs it on chain. */
async function connect(mins: () => string, opts: { deployAccount: boolean }): Promise<{ l1: L1Ctx; l2: L2Ctx; addrs: NodeL1 }> {
	const account = requireSigner()
	const nodeUrl = requireDrpcNodeUrl("testnet", process.env)
	// Before any account exists: the registry and portal read here become the generation's immutables.
	const info = await authenticatedNode(nodeUrl)
	const chain = sepoliaChain(SEPOLIA_RPC)
	const l1: L1Ctx = { ...createL1Clients({ chain, rpcUrl: SEPOLIA_RPC, account }), account }
	const node = createNode(nodeUrl)
	const wallet = await createL2Wallet({ nodeUrl, proverEnabled: true })
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
		privateFpc: manifestPrivateFpc(addrs.l1ChainId),
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
	const routing = routingArg()
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
		...routing,
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
	const info = await authenticatedNode(requireDrpcNodeUrl("testnet", process.env))
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

/** Ethereum mainnet's fuel-only route: a gate and a router beside the live placeholder. L1 only. */
async function commandFuelRoute(): Promise<void> {
	const mins = stopwatch()
	const fuelPath = argValue("--fuel")
	if (!fuelPath) throw new Error('deploy --fuel-route needs --fuel <fuel.json> ({ "slippageBps", "minFuelFj", "fjPerTx" })')
	const fuel = fuelRouteSchema.shape.fuel.parse(readJson(fuelPath))
	const rpcUrl = process.env.ETH_RPC_URL
	if (!rpcUrl) throw new Error("ETH_RPC_URL is required: run this through mainnet-l1.env.example — STOP")
	const account = requireSigner("mainnet")
	const base = loadManifestV2FromConfigArg(process.argv, { mode: "fallback", fallbackPath: MAINNET_LIVE_PATH })
	const info = await authenticatedMainnetNode(requireDrpcNodeUrl("mainnet", process.env), base)
	const l1: L1Ctx = { ...createL1Clients({ chain: mainnetChain(rpcUrl), rpcUrl, account }), account }
	const options: FuelRouteOptions = {
		l1,
		network: {
			l1ChainId: info.l1ChainId,
			rollupVersion: info.rollupVersion,
			registry: lc(MAINNET_REGISTRY),
			feeJuicePortal: lc(base.feeJuice.portal),
			feeJuice: lc(base.feeJuice.asset),
			permit2: lc(CANONICAL_PERMIT2),
		},
		journalPath: join(REPO_ROOT, MAINNET_JOURNAL),
		base,
		fuel,
		candidatePath: join(REPO_ROOT, MAINNET_CANDIDATE),
	}
	if (process.argv.includes("--dry-run")) {
		for (const line of await planFuelRoute(options)) console.log(`dry run: ${line}`)
		return
	}
	const { gate, depositRouter } = await deployFuelRoute(options)
	// Repo-relative: the journal is the route's record and must not carry a machine's layout.
	openDeployJournal(options.journalPath).append({ kind: "candidate-written", path: MAINNET_CANDIDATE })
	const how = (d: { adopted: boolean }) => (d.adopted ? "adopted" : "deployed")
	console.log(`\n✅ gate ${gate.address} (${how(gate)}), router ${depositRouter.address} (${how(depositRouter)}) (${mins()})`)
	console.log(`   candidate written to ${MAINNET_CANDIDATE}; next: verify:l1 --strict, the canary, calibrate, live-intent verify.`)
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
	if (command === "deploy" && process.argv.includes("--fuel-route")) return commandFuelRoute()
	if (command === "deploy") return commandDeploy()
	if (command === "pre-create") return commandPreCreate()
	if (command === "calibrate") return commandCalibrate()
	throw new Error("usage: deploy-generation.ts <deploy|pre-create|calibrate> [flags] — see the header")
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
