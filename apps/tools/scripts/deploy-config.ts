import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { GrumpkinScalar } from "@aztec-labs/foundation/curves/grumpkin"
import { poseidon2Hash } from "@aztec-labs/foundation/crypto/poseidon"
import { overwriteLoggingStream } from "@aztec-labs/foundation/log"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import { FAUCET_DRIPPER_SALT, type FaucetSymbol, FAUCET_TOKENS, requireDrpcNodeUrl } from "@unleashed/bridge-core"
import { parseFj } from "@unleashed/bridge-core/drip-deploy"

/**
 * Drip-specific deploy configuration, in the shape of aztec-standards/scripts/deploy-config.ts so
 * the vendored deploy.ts keeps the upstream pattern. Tokens and every salt come from the faucet
 * catalog.
 */

export type Network = "testnet" | "mainnet" | "local-network"

export type DripTokenConfig = (typeof FAUCET_TOKENS)[number]

export interface DeploymentConfig {
	readonly network: { readonly name: Network }
	readonly contracts: {
		readonly tokens: readonly DripTokenConfig[]
		readonly dripper: { readonly salt: number }
	}
}

export function getDeploymentConfig(network: Network): DeploymentConfig {
	return {
		network: { name: network },
		contracts: {
			tokens: FAUCET_TOKENS,
			dripper: { salt: FAUCET_DRIPPER_SALT },
		},
	}
}

/**
 * The node a live deploy talks to, resolved only then, so a dry run needs no key. Testnet and
 * mainnet take the keyed dRPC node from `DRPC_API_KEY`; universal deploys (deployer ZERO, fixed
 * salts) land the same addresses on both, so one deployments.json serves both. `AZTEC_NODE_URL`
 * overrides only the local network's loopback default.
 */
export function nodeUrlFor(network: Network): string {
	if (network === "local-network") return process.env.AZTEC_NODE_URL || "http://localhost:8080"
	return requireDrpcNodeUrl(network, process.env)
}

/** What a mainnet run may spend: `--cap` bounds every funding from the funding key to this deployer, together,
 *  and has no default. */
export interface Funding {
	readonly fund?: bigint
	readonly cap?: bigint
}

/**
 * `--fund` and `--cap`, in AZTEC. Only mainnet deposits, and a live mainnet run refuses without `--cap`, the
 * owner's spending ceiling, so no amount in code can stand in for it.
 */
export function fundingOf(network: Network, flag: (name: string) => string | undefined, dryRun: boolean): Funding {
	const fund = flag("--fund")
	const cap = flag("--cap")
	if (network !== "mainnet") {
		if (fund !== undefined || cap !== undefined) throw new Error("--fund and --cap apply to mainnet only")
		return {}
	}
	if (cap === undefined && !dryRun) {
		throw new Error("a mainnet run needs --cap <AZTEC>, the most every funding to this deployer may reach together")
	}
	return {
		...(fund === undefined ? {} : { fund: parseFj(fund, "--fund") }),
		...(cap === undefined ? {} : { cap: parseFj(cap, "--cap") }),
	}
}

/** The deployer's seed and the account keys derived from it (NULO-ACCOUNT-KDF v1). */
export interface DeployerKeys {
	readonly seed: Fr
	readonly secretKey: Fr
	readonly salt: Fr
	readonly signingKey: GrumpkinScalar
}

/** `Buffer.from(_, "hex")` stops at the first non-hex character, so a malformed value would quietly reduce to a
 *  short or zero field and derive an account anyone can rebuild: the shape is checked first, and errors never
 *  echo the value. */
function hexField(name: string, value: string, digits: { min: number; max: number }): Fr {
	if (!new RegExp(`^(0x)?[0-9a-fA-F]{${digits.min},${digits.max}}$`).test(value)) {
		throw new Error(`${name} must be ${digits.min === digits.max ? digits.max : `1–${digits.max}`} hex digits`)
	}
	return Fr.fromBufferReduce(Buffer.from(value.replace(/^0x/, "").padStart(64, "0"), "hex"))
}

/**
 * The hex pair `DEPLOYER_SECRET_KEY` + `DEPLOYER_SALT` reproduces an existing account. Off mainnet, a free-form
 * `DEPLOYER_SECRET` derives one with salt zero instead; mainnet refuses it, since the seed also derives every
 * funding secret and a passphrase is a weaker seed than a key.
 */
export async function resolveDeployerKeys(network: Network, env: Record<string, string | undefined> = process.env): Promise<DeployerKeys> {
	const hexSecret = env.DEPLOYER_SECRET_KEY
	const hexSalt = env.DEPLOYER_SALT
	if (hexSecret && hexSalt) {
		// An Ethereum secp256k1 key can exceed the BN254 field modulus - reduce instead of
		// throwing (deterministic: the same input always derives the same account).
		const seed = hexField("DEPLOYER_SECRET_KEY", hexSecret, { min: network === "mainnet" ? 64 : 1, max: 64 })
		if (seed.isZero()) throw new Error("DEPLOYER_SECRET_KEY reduces to zero")
		return { seed, salt: hexField("DEPLOYER_SALT", hexSalt, { min: 1, max: 64 }), ...(await deriveNuloAccountKeys(seed)) }
	}
	if (network === "mainnet") throw new Error("mainnet takes DEPLOYER_SECRET_KEY + DEPLOYER_SALT only")
	const utf8 = env.DEPLOYER_SECRET
	if (utf8 && utf8.trim().length >= 32) {
		const seed = await poseidon2Hash([Fr.fromBufferReduce(Buffer.from(utf8, "utf8"))])
		return { seed, salt: Fr.ZERO, ...(await deriveNuloAccountKeys(seed)) }
	}
	throw new Error(
		"Provide either DEPLOYER_SECRET_KEY+DEPLOYER_SALT (hex Frs, reuses an existing account) " +
			"or DEPLOYER_SECRET (≥32-char utf8 string, derives a fresh account).",
	)
}

/** The keyed run's values: the node and L1 URLs embed provider keys, and the transports put the URL in their
 *  error text. */
const SECRET_ENV = ["DRPC_API_KEY", "ETH_RPC_URL", "FUNDING_PRIVATE_KEY", "DEPLOYER_SECRET_KEY", "DEPLOYER_SECRET"] as const

/** `text` with every keyed-run value replaced by its name, so a failure can be printed whole. */
export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env): string {
	return SECRET_ENV.reduce((out, name) => {
		const value = env[name]
		return value ? out.replaceAll(value, `<${name}>`) : out
	}, text)
}

const LEVELS: Readonly<Record<number, string>> = {
	10: "TRACE",
	20: "DEBUG",
	25: "VERBOSE",
	30: "INFO",
	40: "WARN",
	50: "ERROR",
	60: "FATAL",
}
const ENVELOPE = new Set(["level", "time", "pid", "hostname", "module", "msg"])

function readable(line: string): string {
	try {
		const entry = JSON.parse(line) as Record<string, unknown>
		const data = Object.fromEntries(Object.entries(entry).filter(([k]) => !ENVELOPE.has(k)))
		const extra = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : ""
		return `${LEVELS[entry.level as number] ?? entry.level} ${entry.module ?? ""}: ${entry.msg ?? ""}${extra}\n`
	} catch {
		return line
	}
}

/**
 * Routes every SDK log line through {@link redactSecrets} before `write`. The node client logs each failed attempt
 * with its URL before it retries, so a keyed run installs this before it creates any client.
 */
export function installRedactedLogging(
	write: (text: string) => void = (text) => process.stderr.write(text),
	env: Record<string, string | undefined> = process.env,
): void {
	// Typed as a Writable, but pino needs only `write` from a destination.
	overwriteLoggingStream({
		write: (line: string) => {
			write(redactSecrets(readable(line), env))
			return true
		},
	} as Parameters<typeof overwriteLoggingStream>[0])
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
		/** constructor_with_minter's 5th parameter: ZERO means no authorization contract. The rebuild needs it
		 *  to derive the address. */
		readonly authContract: string
	}
}

interface DripperDeploymentRecord {
	readonly address: string
	readonly salt: number
	readonly deployer: string
	readonly constructorArtifact: "constructor"
}

export interface DeploymentsJson {
	readonly tokens: readonly TokenDeploymentRecord[]
	readonly dripper: DripperDeploymentRecord
}

export function buildDeploymentJson(
	dripperAddress: AztecAddress,
	tokenAddresses: Record<string, AztecAddress>,
	config: DeploymentConfig,
): DeploymentsJson {
	const tokens: TokenDeploymentRecord[] = config.contracts.tokens
		.filter((t) => t.symbol in tokenAddresses)
		.map((t) => ({
			address: (tokenAddresses[t.symbol] as AztecAddress).toString(),
			salt: t.salt,
			deployer: AztecAddress.ZERO.toString(),
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
			deployer: AztecAddress.ZERO.toString(),
			constructorArtifact: "constructor",
		},
	}
}
