/**
 * The Worker: each cron run signs with the secret RELAYER_PRIVATE_KEY as `TESTNET_FILLER`, the relayer every testnet
 * send names, on the route of the testnet manifest bundled at build time. A key that is not the filler's refuses.
 */
import { BASE_SEPOLIA_RPC_DEFAULT, SEPOLIA_RPC_DEFAULT, TESTNET_FILLER } from "@unleashed/bridge-core/across-fill"
import manifest from "../../../apps/tools/public/testnet-bridge.json"
import { relayerAccount } from "./key"
import { consoleLog, errorLine, type RelayLog } from "./log"
import { testnetRoute } from "./route"
import { connectRelay, type RunSummary, relayOnce } from "./run"

export interface RelayerEnv {
	RELAYER_PRIVATE_KEY?: string
	BASE_SEPOLIA_RPC_URL?: string
	SEPOLIA_RPC_URL?: string
}

/** One run from `env`; refusals before any client exists are log lines too. */
export async function scheduledRun(env: RelayerEnv, log: RelayLog = consoleLog): Promise<RunSummary> {
	let clients: Parameters<typeof relayOnce>[0]
	try {
		const route = testnetRoute(manifest, TESTNET_FILLER)
		const endpoints = {
			sourceRpcUrl: env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA_RPC_DEFAULT,
			destinationRpcUrl: env.SEPOLIA_RPC_URL || SEPOLIA_RPC_DEFAULT,
		}
		clients = { ...connectRelay(relayerAccount({ ...env }), route, endpoints), route, log }
	} catch (e) {
		log({ event: "refused", reason: errorLine(e) })
		return { outcome: "refused" }
	}
	return relayOnce(clients)
}

export default {
	async scheduled(_controller: unknown, env: RelayerEnv): Promise<void> {
		await scheduledRun(env)
	},
}
