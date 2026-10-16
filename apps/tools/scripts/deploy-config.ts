import { FAUCET_DRIPPER_SALT, FAUCET_TOKENS, requireDrpcNodeUrl } from "@unleashed/bridge-core"

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
