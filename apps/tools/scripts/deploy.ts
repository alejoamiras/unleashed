/**
 * Drip contract deployer: the faucet catalog (`FAUCET_TOKENS`), vendored from
 * `aztec-standards/scripts/deploy.ts` and adapted.
 *
 *   testnet, local-network: DEPLOYER_SECRET_KEY + DEPLOYER_SALT (or DEPLOYER_SECRET); fees from the
 *     sponsored FPC. Live testnet is a keyed run on testnet-faucet.env.example.
 *   mainnet: DEPLOYER_SECRET_KEY + DEPLOYER_SALT only. No sponsor exists, so the deployer pays every fee
 *     from Fee Juice the pinned funding key deposits on L1 (`--fund <AZTEC>`) within `--cap <AZTEC>`, the most every
 *     funding to this deployer may reach together, which every live mainnet run requires. A keyed run on mainnet-faucet.env.example; re-run the same command
 *     until it reports the catalog initialized.
 *
 * Flags:
 *   --dry-run     compute + print addresses; no node, no key
 *   --network     `testnet` (default) | `mainnet` | `local-network`
 *   --output      override the output path (default: src/contracts/deployments.candidate.json —
 *                 candidate-first; `promote` owns the live deployments.json)
 *   --fund, --cap mainnet only, in AZTEC
 *
 * Every run reads the chain first: an initialized contract is never sent again, a published one
 * that is not initialized gets its constructor, and a finished catalog sends nothing.
 *
 * The output JSON shape MATCHES what the frontend (`src/contracts/
 * deployments.ts`) consumes — token records keyed by symbol via lookup,
 * not array order.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inspect } from "node:util"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { getContractInstanceFromInstantiationParams, type InteractionFeeOptions } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { SPONSORED_FPC_SALT } from "@aztec-labs/constants"
import { createLogger } from "@aztec-labs/foundation/log"
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC"
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { parseManifestV2 } from "@unleashed/bridge-core"
import { type CatalogEntry, deployDripCatalogOnMainnet, deploySponsoredCatalog, dripCatalog } from "@unleashed/bridge-core/drip-deploy"
import { ownedWalletStore } from "@unleashed/bridge-core/wallet-store"
import { MAINNET_ROLLUP_VERSION } from "../src/lib/chain-constants"
import {
	buildDeploymentJson,
	type DeploymentConfig,
	type Funding,
	fundingOf,
	getDeploymentConfig,
	installRedactedLogging,
	type Network,
	nodeUrlFor,
	redactSecrets,
	resolveDeployerKeys,
} from "./deploy-config.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const logger = createLogger("tools:deploy")

interface CLIOptions {
	readonly network: Network
	readonly dryRun: boolean
	readonly output: string
	readonly funding: Funding
}

function parseArgs(argv: string[]): CLIOptions {
	const args = argv.slice(2)
	const flag = (name: string): string | undefined => {
		const idx = args.indexOf(name)
		return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
	}
	const networkArg = flag("--network") ?? "testnet"
	if (networkArg !== "testnet" && networkArg !== "mainnet" && networkArg !== "local-network") {
		throw new Error(`unknown --network: ${networkArg}`)
	}
	// Candidate-first: a live deploy writes the CANDIDATE; only the receipted
	// `promote` step may touch the committed live deployments.json.
	const defaultOutput = join(__dirname, "..", "src", "contracts", "deployments.candidate.json")
	const output = flag("--output") ?? defaultOutput
	// Candidate-first guard: writing the LIVE deployments.json directly bypasses the
	// receipted promote step. Allowed only with an explicit acknowledgement flag.
	const livePath = resolve(join(__dirname, "..", "src", "contracts", "deployments.json"))
	if (resolve(output) === livePath && !args.includes("--allow-live-output")) {
		throw new Error(
			"refusing to write the live deployments.json directly — use the candidate + promote flow, or pass --allow-live-output",
		)
	}
	const dryRun = args.includes("--dry-run")
	return { network: networkArg, dryRun, output, funding: fundingOf(networkArg, flag, dryRun) }
}

function deploymentJsonOf(catalog: readonly CatalogEntry[], config: DeploymentConfig) {
	const [dripper, ...tokens] = catalog
	if (!dripper) throw new Error("the Drip catalog is empty")
	const tokenAddresses = Object.fromEntries(tokens.map((t) => [String(t.args[1]), t.instance.address])) as Record<string, AztecAddress>
	return buildDeploymentJson(dripper.instance.address, tokenAddresses, config)
}

async function buildSponsoredFeeOptions(wallet: Wallet): Promise<InteractionFeeOptions> {
	const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(SPONSORED_FPC_SALT) })
	try {
		await wallet.registerContract(instance, SponsoredFPCContract.artifact)
		logger.info(`Registered SponsoredFPC at: ${instance.address.toString()}`)
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		if (!msg.includes("already")) throw err
	}
	return { paymentMethod: new SponsoredFeePaymentMethod(instance.address) }
}

/** The committed mainnet manifest: where the fundings go, as the repository records it. */
function mainnetManifest() {
	return parseManifestV2(JSON.parse(readFileSync(join(__dirname, "..", "public", "mainnet-bridge.json"), "utf8")))
}

function requireEnv(name: string, why: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is required (${why}): run this through mainnet-faucet.env.example`)
	return value
}

async function run(): Promise<void> {
	const opts = parseArgs(process.argv)
	const config = getDeploymentConfig(opts.network)
	const catalog = await dripCatalog()
	const json = deploymentJsonOf(catalog, config)

	logger.info(`Network: ${config.network.name}`)

	if (opts.dryRun) {
		logger.info("[DRY RUN] Computed addresses:")
		logger.info(JSON.stringify(json, null, 4))
		return
	}

	const keys = await resolveDeployerKeys(opts.network)
	const nodeUrl = nodeUrlFor(config.network.name)
	const wallet = await EmbeddedWallet.create(nodeUrl, {
		pxeConfig: {
			proverEnabled: config.network.name !== "local-network",
			// No disk fallback even on local-network: the keys are the operator's DEPLOYER_SECRET*.
			dataDirectory: ownedWalletStore(`tools-deploy-${config.network.name}`),
			dataStoreMapSizeKb: 1e6,
		},
	})

	try {
		logger.info(`Connected to node ${(await createAztecNodeClient(nodeUrl).getNodeInfo()).nodeVersion}`)
		// Signing-key-root model (NULO-ACCOUNT-KDF v1): the env-derived value is the SEED; the
		// signing key roots the account and the privacy secret derives one-way from it.
		const manager = await wallet.createSchnorrAccount(keys.secretKey, keys.salt, keys.signingKey)
		const address = (await manager.getAccount()).getAddress()
		logger.info(`Deployer account: ${address.toString()}`)
		const log = (line: string) => logger.info(line)

		if (opts.network === "mainnet") {
			const { fund, cap } = opts.funding
			if (cap === undefined) throw new Error("a mainnet run needs --cap <AZTEC>")
			await deployDripCatalogOnMainnet({
				nodeUrl,
				l1RpcUrl: requireEnv("ETH_RPC_URL", "the funding's L1 RPC"),
				funderKey: requireEnv("FUNDING_PRIVATE_KEY", "the pinned funding key") as `0x${string}`,
				manifest: mainnetManifest(),
				rollupVersion: MAINNET_ROLLUP_VERSION,
				wallet,
				deployer: { address, seed: keys.seed, manager },
				catalog,
				...(fund === undefined ? {} : { fund }),
				cap,
				log,
			})
		} else {
			await deploySponsoredCatalog({
				wallet,
				node: createAztecNodeClient(nodeUrl),
				deployer: { address, manager },
				catalog,
				fee: await buildSponsoredFeeOptions(wallet),
				log,
			})
		}

		mkdirSync(dirname(opts.output), { recursive: true })
		writeFileSync(opts.output, `${JSON.stringify(json, null, "\t")}\n`)
		logger.info(`Wrote ${opts.output}`)
		logger.info("Deployment summary:")
		logger.info(`  dripper: ${json.dripper.address}`)
		for (const t of json.tokens) logger.info(`  ${t.constructorArgs.symbol}: ${t.address}`)
	} finally {
		await wallet.stop()
	}
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`
if (isDirectInvocation) {
	installRedactedLogging()
	run().catch((err: unknown) => {
		logger.error(`Deploy failed: ${redactSecrets(inspect(err, { depth: 8 }))}`)
		process.exit(1)
	})
}

export { parseArgs }
