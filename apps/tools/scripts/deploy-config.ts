import { FAUCET_DRIPPER_SALT, FAUCET_TOKENS, TESTNET_NODE_URL } from "@unleashed/bridge-core"

/**
 * Drip-specific deploy configuration, in the shape of aztec-standards/scripts/deploy-config.ts so
 * the vendored deploy.ts keeps the upstream pattern. Tokens and every salt come from the faucet
 * catalog.
 */

export type Network = "testnet" | "mainnet" | "local-network"

export const NETWORK_URLS: Record<Network, string> = {
	testnet: TESTNET_NODE_URL,
	// The Alpha node — same dRPC host the tools app + extension pin. Universal deploys (deployer
	// ZERO, fixed salts) land the SAME addresses as testnet, so deployments.json serves both.
	mainnet: "https://lb.drpc.live/aztec-mainnet/Ak_eT5HA2kbyqamqGTF702cdsdWqLTIR8YdadmahlY6k",
	"local-network": "http://localhost:8080",
}

export type DripTokenConfig = (typeof FAUCET_TOKENS)[number]

export interface DeploymentConfig {
	readonly network: { readonly name: Network; readonly nodeUrl: string }
	readonly contracts: {
		readonly tokens: readonly DripTokenConfig[]
		readonly dripper: { readonly salt: number }
	}
}

export function getDeploymentConfig(network: Network): DeploymentConfig {
	// AZTEC_NODE_URL overrides the per-network default. The frontend reads
	// its own VITE_AZTEC_NODE_URL — deliberately separate so the bundled
	// build never embeds DEPLOYER_SECRET-adjacent config.
	const nodeUrl = process.env.AZTEC_NODE_URL || NETWORK_URLS[network]
	return {
		network: { name: network, nodeUrl },
		contracts: {
			tokens: FAUCET_TOKENS,
			dripper: { salt: FAUCET_DRIPPER_SALT },
		},
	}
}
