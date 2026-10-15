/** A bare dRPC key: anything else could rewrite the URL's path, query or host. */
const URL_SAFE_KEY = /^[A-Za-z0-9_-]+$/

/**
 * The dRPC node URL for `network`, composed from `env.DRPC_API_KEY`, the owner's shared CLI key.
 * Never defaulted: the key reaches a run only from 1Password through a keyed-run template, so a
 * script run outside one fails here instead of falling back to another node. Throws, naming the
 * variable but never its value, when the key is unset or not URL-safe (`[A-Za-z0-9_-]+`).
 *
 * The URL carries the key: callers never print it, write it to a file or put it in an error.
 * Callers pass `process.env` at operation entry, so the browser bundle never references `process`.
 */
export function requireDrpcNodeUrl(network: "testnet" | "mainnet", env: Record<string, string | undefined>): string {
	const key = env.DRPC_API_KEY
	if (!key) throw new Error("DRPC_API_KEY is unset: run this through its keyed-run template (*.env.example)")
	if (!URL_SAFE_KEY.test(key)) throw new Error("DRPC_API_KEY is not a bare URL-safe key ([A-Za-z0-9_-]+)")
	return `https://lb.drpc.live/aztec-${network}/${key}`
}
