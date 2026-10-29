/**
 * Every env var a keyed run may carry a secret in: provider keys, RPC URLs that embed one, signing keys and
 * deployer secrets. `scripts/ci-cd/keyed-runs.test.ts` holds it to every such name the code reads and every
 * `op://` field of the keyed-run templates.
 */
export const KEYED_ENV = [
	"ARBITRUM_RPC_URL",
	"BASE_RPC_URL",
	"BASE_SEPOLIA_RPC_URL",
	"BRIDGE_DEPLOYER_SECRET_MAINNET",
	"BRIDGE_DEPLOYER_SECRET_TESTNET",
	"CANARY_PRIVATE_KEY",
	"CIRCLE_API_KEY",
	"CLOUDFLARE_API_TOKEN",
	"DEPLOYER_SECRET",
	"DEPLOYER_SECRET_KEY",
	"DRPC_API_KEY",
	"ETH_RPC_URL",
	"FUNDING_PRIVATE_KEY",
	"INTENT_SECOND_AZTEC_RPC",
	"MAINNET_PRIVATE_KEY",
	"OPTIMISM_RPC_URL",
	"PRIVATE_KEY",
	"RELAYER_L2_SECRET_KEY",
	"RELAYER_PRIVATE_KEY",
	"SEPOLIA_RPC_URL",
] as const

/**
 * `text` with every set keyed value replaced by `<NAME>`, longest value first so a value that contains another is
 * still matched whole. Matches literal values only; redact before truncating, or a cut through a value leaves a
 * fragment no longer matched.
 */
export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env): string {
	return KEYED_ENV.flatMap((name) => {
		const value = env[name]
		return value ? [[name, value] as const] : []
	})
		.sort(([, a], [, b]) => b.length - a.length)
		.reduce((out, [name, value]) => out.replaceAll(value, `<${name}>`), text)
}
