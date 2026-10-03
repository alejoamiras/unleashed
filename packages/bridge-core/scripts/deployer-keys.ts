/**
 * STABLE, network-keyed L2 deployer identity. The account secret and salt are derived
 * deterministically from a network-separated env secret, never drawn at random: a random account
 * funded by a run that then crashed would hold its fee juice at an unrecoverable address. The same
 * secret always yields the same L2 account, so the deployer is pre-fundable and a crashed run
 * resumes control by re-running with the same env.
 *
 * Network separation is double-walled: separate env vars (`BRIDGE_DEPLOYER_SECRET_TESTNET` /
 * `BRIDGE_DEPLOYER_SECRET_MAINNET`) AND a network-tagged derivation domain — so even an identical
 * raw secret yields DIFFERENT accounts per network (keys never cross networks).
 *
 * The domain's prefix is part of the identity: a different prefix is a different account. Mainnet
 * takes it from `BRIDGE_DEPLOYER_PREFIX_MAINNET` and has NO default, so a missing setting throws
 * instead of silently selecting an unfunded account. Testnet may override it the same way.
 *
 * The secret stays in the operator's env, never journaled or printed; the derived ADDRESS is what the
 * journal records. The wallet store holding the derived keys is removed when the run exits.
 */
import { createHash } from "node:crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"

export type DeployerNetwork = "testnet" | "mainnet"

const ENV_NAMES: Record<DeployerNetwork, string> = {
	testnet: "BRIDGE_DEPLOYER_SECRET_TESTNET",
	mainnet: "BRIDGE_DEPLOYER_SECRET_MAINNET",
}

const PREFIX_ENV_NAMES: Record<DeployerNetwork, string> = {
	testnet: "BRIDGE_DEPLOYER_PREFIX_TESTNET",
	mainnet: "BRIDGE_DEPLOYER_PREFIX_MAINNET",
}

const DEFAULT_PREFIX: Partial<Record<DeployerNetwork, string>> = { testnet: "unleashed-bridge-deployer" }

/** The derivation prefix: printable, colon-free, so it can never forge the `:secret:` / `:salt:` fields. */
const PREFIX_SHAPE = /^[a-z0-9][a-z0-9-]{2,62}$/

function resolvePrefix(network: DeployerNetwork, env: Record<string, string | undefined>): string {
	const name = PREFIX_ENV_NAMES[network]
	const prefix = env[name] || DEFAULT_PREFIX[network]
	if (!prefix) {
		throw new Error(
			`${name} is required — the derivation prefix of the ${network} L2 deployer. A wrong or missing ` +
				"prefix derives a different, unfunded account, so there is no default. STOP.",
		)
	}
	if (!PREFIX_SHAPE.test(prefix)) throw new Error(`${name} must match ${PREFIX_SHAPE}`)
	return prefix
}

/** sha256(domain) truncated to 31 bytes — always < the BN254 field modulus, so Fr parsing never wraps. */
function deriveField(domain: string): Fr {
	const digest = createHash("sha256").update(domain).digest("hex")
	return Fr.fromHexString(`0x${digest.slice(0, 62)}`)
}

/** Fail-closed: throws when the network's deployer secret is missing or too short, or when mainnet's prefix is unset. */
export function resolveDeployerKeys(
	network: DeployerNetwork,
	env: Record<string, string | undefined> = process.env,
): { secret: Fr; salt: Fr } {
	const name = ENV_NAMES[network]
	const raw = env[name]
	if (!raw || raw.length < 16) {
		throw new Error(
			`${name} is required (>= 16 chars) — the STABLE ${network} L2 deployer secret. Losing it after ` +
				"funding orphans the deployer's fee juice; store it like a key, never commit it. STOP.",
		)
	}
	const prefix = resolvePrefix(network, env)
	return {
		secret: deriveField(`${prefix}:secret:${network}:${raw}`),
		salt: deriveField(`${prefix}:salt:${network}:${raw}`),
	}
}
