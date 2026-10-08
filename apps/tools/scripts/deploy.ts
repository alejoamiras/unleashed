/**
 * Drip contract deployer — vendored from
 * `aztec-standards/scripts/deploy.ts` (560 lines) and adapted to the
 * faucet catalog (`FAUCET_TOKENS`).
 *
 * Run once per environment:
 *   DEPLOYER_SECRET="<32+ chars>" bun run deploy:testnet
 *
 * Optional flags:
 *   --dry-run     compute + print addresses without sending txs
 *   --network     `testnet` (default) | `local-network`
 *   --output      override the output path (default: src/contracts/deployments.candidate.json —
 *                 candidate-first; `promote` owns the live deployments.json)
 *
 * Idempotency: each contract deploy checks `node.getContract(addr)` first;
 * skips with `[EXISTING]` if found. Re-running is a no-op when everything
 * is on-chain.
 *
 * The output JSON shape MATCHES what the frontend (`src/contracts/
 * deployments.ts`) consumes — token records keyed by symbol via lookup,
 * not array order.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import {
	Contract,
	type DeployOptions,
	getContractInstanceFromInstantiationParams,
	type InteractionFeeOptions,
} from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { type FaucetSymbol, preexistingFeeJuicePayment } from "@unleashed/bridge-core"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import { type AztecNode, createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { AccountManager, Wallet } from "@aztec-labs/aztec.js/wallet"
import { SPONSORED_FPC_SALT } from "@aztec-labs/constants"
import { poseidon2Hash } from "@aztec-labs/foundation/crypto/poseidon"
import { createLogger } from "@aztec-labs/foundation/log"
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import type { GrumpkinScalar } from "@aztec-labs/foundation/curves/grumpkin"
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { ownedWalletStore } from "@unleashed/bridge-core/wallet-store"
import { DripperContract, DripperContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js"
import { TokenContract, TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import { type DeploymentConfig, getDeploymentConfig, type Network } from "./deploy-config.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const logger = createLogger("tools:deploy")

const UNIVERSAL_DEPLOYER = AztecAddress.ZERO

interface CLIOptions {
	readonly network: Network
	readonly dryRun: boolean
	readonly output: string
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
	return {
		network: networkArg,
		dryRun: args.includes("--dry-run"),
		output,
	}
}

// ── Schemas matching src/contracts/deployments.ts ──────────────────────────

interface TokenDeploymentRecord {
	readonly address: string
	readonly salt: number
	readonly deployer: string
	readonly constructorArtifact: "constructor_with_minter"
	readonly constructorArgs: {
		readonly name: string
		readonly symbol: FaucetSymbol
		readonly decimals: number
		readonly minter: string
		/** 5.0.1 standards Token: constructor_with_minter's 5th parameter. ZERO = no
		 *  authorization contract; REQUIRED for the rebuild to derive the address. */
		readonly authContract: string
	}
}

interface DripperDeploymentRecord {
	readonly address: string
	readonly salt: number
	readonly deployer: string
	readonly constructorArtifact: "constructor"
}

interface DeploymentsJson {
	readonly tokens: readonly TokenDeploymentRecord[]
	readonly dripper: DripperDeploymentRecord
}

function buildDeploymentJson(
	dripperAddress: AztecAddress,
	tokenAddresses: Record<string, AztecAddress>,
	config: DeploymentConfig,
): DeploymentsJson {
	const tokens: TokenDeploymentRecord[] = config.contracts.tokens
		.filter((t) => t.symbol in tokenAddresses)
		.map((t) => ({
			address: tokenAddresses[t.symbol].toString(),
			salt: t.salt,
			deployer: UNIVERSAL_DEPLOYER.toString(),
			constructorArtifact: "constructor_with_minter",
			constructorArgs: {
				name: t.name,
				symbol: t.symbol,
				decimals: t.decimals,
				minter: dripperAddress.toString(),
				authContract: AztecAddress.ZERO.toString(),
			},
		}))
	return {
		tokens,
		dripper: {
			address: dripperAddress.toString(),
			salt: config.contracts.dripper.salt,
			deployer: UNIVERSAL_DEPLOYER.toString(),
			constructorArtifact: "constructor",
		},
	}
}

// ── Sponsored fee helper ────────────────────────────────────────────────────

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

// ── Account deploy (idempotent) ─────────────────────────────────────────────

// `NO_FROM` is the SDK's sentinel for "deploy without routing through any
// account contract entrypoint" — required for the very first account
// deploy because the account doesn't exist yet (chicken/egg). The SDK
// exports it from `dest/contract/interaction_options.js` but no public
// subpath re-exports the constant in 4.2.0; inlining the literal is
// equivalent because the SDK does a string comparison internally.
const NO_FROM = "NO_FROM" as const

async function ensureAccountDeployed(manager: AccountManager, node: AztecNode, feeOptions: InteractionFeeOptions): Promise<void> {
	const address = manager.getInstance().address
	const existing = await node.getContract(address)
	if (existing) {
		logger.info(`Account already deployed at ${address.toString()}`)
		return
	}
	logger.info(`Deploying account at ${address.toString()}…`)
	try {
		const deployMethod = await manager.getDeployMethod()
		// biome-ignore lint/suspicious/noExplicitAny: NO_FROM sentinel not re-exported through a public subpath in 4.2.0
		await deployMethod.send({ fee: feeOptions, from: NO_FROM as any })
		logger.info(`Account deployed at ${address.toString()}`)
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		const cause = err instanceof Error && "cause" in err && err.cause instanceof Error ? err.cause.message : ""
		if (msg.includes("Existing nullifier") || cause.includes("Existing nullifier")) {
			logger.info(`Account already deployed at ${address.toString()} (existing nullifier)`)
			return
		}
		throw err
	}
}

// ── Generic deploy with idempotency ─────────────────────────────────────────

/** The root failure text: prefer the wrapped cause (Aztec send errors nest it there). */
function errorCauseMessage(err: unknown): string {
	if (err instanceof Error && "cause" in err && err.cause instanceof Error) return err.cause.message
	return err instanceof Error ? err.message : String(err)
}

/** Known instance: register it with THIS deployer's PXE so later calls resolve (an
 *  already-registered contract is fine). */
async function registerExisting(
	deployer: Wallet,
	instance: Awaited<ReturnType<typeof getContractInstanceFromInstantiationParams>>,
	artifact: typeof TokenContractArtifact,
): Promise<void> {
	try {
		await deployer.registerContract(instance, artifact)
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err)
		if (!msg.includes("already")) throw err
	}
}

async function deployIfMissing(
	deployer: Wallet,
	node: AztecNode,
	label: string,
	artifact: typeof TokenContractArtifact,
	constructorArgs: unknown[],
	constructorArtifact: string,
	salt: Fr,
	options: DeployOptions,
): Promise<{ address: AztecAddress; status: "deployed" | "existing" }> {
	const instance = await getContractInstanceFromInstantiationParams(artifact, {
		constructorArgs,
		salt,
		publicKeys: PublicKeys.default(),
		deployer: AztecAddress.ZERO,
		constructorArtifact,
	})
	const existing = await node.getContract(instance.address)
	if (existing) {
		await registerExisting(deployer, instance, artifact)
		logger.info(`${label} already at ${instance.address.toString()} [EXISTING]`)
		return { address: instance.address, status: "existing" }
	}
	logger.info(`Deploying ${label}…`)
	try {
		// 5.0: salt + universalDeploy move to construction-time DeployInstantiationOptions
		// (removed from send options; the deployer is locked at construction).
		const method = Contract.deploy(deployer, artifact, constructorArgs, constructorArtifact, {
			salt,
			universalDeploy: true,
		})
		await method.send({
			...options,
			wait: { waitForStatus: TxStatus.PROPOSED },
		})
	} catch (err: unknown) {
		if (errorCauseMessage(err).includes("Existing nullifier")) {
			logger.info(`${label} at ${instance.address.toString()} (existing nullifier)`)
			return { address: instance.address, status: "existing" }
		}
		throw err
	}
	logger.info(`${label} deployed at ${instance.address.toString()}`)
	return { address: instance.address, status: "deployed" }
}

// ── Address pre-computation (used by --dry-run) ────────────────────────────

async function computeAddresses(config: DeploymentConfig): Promise<{
	dripper: AztecAddress
	tokens: Record<string, AztecAddress>
}> {
	const dripperInstance = await getContractInstanceFromInstantiationParams(DripperContractArtifact, {
		constructorArgs: [],
		salt: new Fr(config.contracts.dripper.salt),
		publicKeys: PublicKeys.default(),
		deployer: AztecAddress.ZERO,
	})
	const tokens: Record<string, AztecAddress> = {}
	for (const t of config.contracts.tokens) {
		const inst = await getContractInstanceFromInstantiationParams(TokenContractArtifact, {
			// 5.0.1 standards Token: 5th constructor param auth_contract (ZERO), matching the
			// live-deploy path — a 4-arg dry-run would derive a DIFFERENT address than the deploy.
			constructorArgs: [t.name, t.symbol, t.decimals, dripperInstance.address, AztecAddress.ZERO],
			salt: new Fr(t.salt),
			publicKeys: PublicKeys.default(),
			deployer: AztecAddress.ZERO,
			constructorArtifact: "constructor_with_minter",
		})
		tokens[t.symbol] = inst.address
	}
	return { dripper: dripperInstance.address, tokens }
}

// ── Main deploy ─────────────────────────────────────────────────────────────

async function run(): Promise<void> {
	const opts = parseArgs(process.argv)
	const config = getDeploymentConfig(opts.network)

	logger.info(`Network: ${config.network.name} (${config.network.nodeUrl})`)

	if (opts.dryRun) {
		const computed = await computeAddresses(config)
		const json = buildDeploymentJson(computed.dripper, computed.tokens, config)
		logger.info("[DRY RUN] Computed addresses:")
		logger.info(JSON.stringify(json, null, 4))
		return
	}

	const account = await resolveDeployerKeys()

	const node = createAztecNodeClient(config.network.nodeUrl)
	const wallet = await EmbeddedWallet.create(config.network.nodeUrl, {
		pxeConfig: {
			proverEnabled: config.network.name !== "local-network",
			// No disk fallback even on local-network: the keys are the operator's DEPLOYER_SECRET*.
			dataDirectory: ownedWalletStore(`tools-deploy-${config.network.name}`),
			dataStoreMapSizeKb: 1e6,
		},
	})

	try {
		const nodeInfo = await node.getNodeInfo()
		logger.info(`Connected to node ${nodeInfo.nodeVersion}`)

		// Signing-key-root model (NULO-ACCOUNT-KDF v1): the env-derived value is the SEED; the
		// signing key roots the account and the privacy secret derives one-way from it.
		const accountManager = await wallet.createSchnorrAccount(account.secretKey, account.salt, account.signingKey)
		const accountInstance = await accountManager.getAccount()
		logger.info(`Deployer account: ${accountInstance.getAddress().toString()}`)

		// MAINNET has no SponsoredFPC — the (already-deployed, fee-juiced) deployer pays from its own
		// public Fee Juice balance via the zero-call payload the account entrypoint routes as
		// PREEXISTING_FEE_JUICE. Testnet/local keep the sponsored path.
		const fee =
			config.network.name === "mainnet"
				? { paymentMethod: preexistingFeeJuicePayment(accountInstance.getAddress()) }
				: await buildSponsoredFeeOptions(wallet)
		await ensureAccountDeployed(accountManager, node, fee)

		const deployOptions: DeployOptions = { from: accountInstance.getAddress(), fee }

		const dripperResult = await deployIfMissing(
			wallet,
			node,
			"Dripper",
			DripperContractArtifact,
			[],
			"constructor",
			new Fr(config.contracts.dripper.salt),
			deployOptions,
		)
		const dripperContract = await DripperContract.at(dripperResult.address, wallet)

		const tokenAddresses: Record<string, AztecAddress> = {}
		for (const t of config.contracts.tokens) {
			const result = await deployIfMissing(
				wallet,
				node,
				`Token ${t.symbol}`,
				TokenContractArtifact,
				[t.name, t.symbol, t.decimals, dripperContract.address, AztecAddress.ZERO],
				"constructor_with_minter",
				new Fr(t.salt),
				deployOptions,
			)
			tokenAddresses[t.symbol] = result.address
			// Wrap to a TokenContract just to surface a clean failure if the
			// artifact + address are mismatched (cheap sanity check).
			await TokenContract.at(result.address, wallet)
		}

		const json = buildDeploymentJson(dripperContract.address, tokenAddresses, config)

		mkdirSync(dirname(opts.output), { recursive: true })
		writeFileSync(opts.output, `${JSON.stringify(json, null, "\t")}\n`)
		logger.info(`Wrote ${opts.output}`)

		// Final readback for the operator's terminal.
		logger.info("Deployment summary:")
		logger.info(`  dripper: ${dripperContract.address.toString()}`)
		for (const [symbol, addr] of Object.entries(tokenAddresses)) {
			logger.info(`  ${symbol}: ${addr.toString()}`)
		}
	} finally {
		await wallet.stop()
	}
}

// Allow `bun run scripts/deploy.ts` direct invocation. Also exports the
// helpers above so tests (if added later) can import them.
type DeployerKeys = { secretKey: Fr; salt: Fr; signingKey: GrumpkinScalar }

function frFromHexReduce(hex: string): Fr {
	return Fr.fromBufferReduce(Buffer.from(hex.replace(/^0x/, "").padStart(64, "0"), "hex"))
}

async function resolveDeployerKeys(): Promise<DeployerKeys> {
	// Prefer the holonym-style hex+salt pair: if a project already has a
	// funded testnet account under (secretKey, salt, derivedSigningKey),
	// supplying those same values reproduces the same account address —
	// which is what lets the tools app share an existing fee-juiced deployer.
	const hexSecret = process.env.DEPLOYER_SECRET_KEY
	const hexSalt = process.env.DEPLOYER_SALT
	if (hexSecret && hexSalt) {
		// An Ethereum secp256k1 key can exceed the BN254 field modulus - reduce instead of
		// throwing (deterministic: the same input always derives the same account).
		const seed = frFromHexReduce(hexSecret)
		const salt = frFromHexReduce(hexSalt)
		const { signingKey, secretKey } = await deriveNuloAccountKeys(seed)
		return { secretKey, salt, signingKey }
	}
	// Fallback: a free-form string that gets poseidon-hashed. Original
	// upstream pattern; convenient for one-off testnet experiments.
	const utf8 = process.env.DEPLOYER_SECRET
	if (utf8 && utf8.trim().length >= 32) {
		const seed = await poseidon2Hash([Fr.fromBufferReduce(Buffer.from(utf8, "utf8"))])
		const { signingKey, secretKey } = await deriveNuloAccountKeys(seed)
		return { secretKey, salt: Fr.ZERO, signingKey }
	}
	throw new Error(
		"Provide either DEPLOYER_SECRET_KEY+DEPLOYER_SALT (hex Frs, reuses an existing account) " +
			"or DEPLOYER_SECRET (≥32-char utf8 string, derives a fresh account).",
	)
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`
if (isDirectInvocation) {
	run().catch((err: unknown) => {
		logger.error("Deploy failed:", err)
		process.exit(1)
	})
}

// Reference `readFileSync` so dead-code elimination keeps the import in the
// generated bundle — the helper is here for future test or CLI extension.
export { buildDeploymentJson, computeAddresses, parseArgs, readFileSync }
