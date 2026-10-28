/**
 * The Worker: each cron run signs with the secret RELAYER_PRIVATE_KEY as `TESTNET_FILLER`, the relayer every testnet
 * send names, on the route of the testnet manifest bundled at build time. A key that is not the filler's refuses.
 * With the optional secret CIRCLE_API_KEY, a run may also request a faucet drip (`restock.ts`).
 */
import { BASE_SEPOLIA_RPC_DEFAULT, SEPOLIA_RPC_DEFAULT, TESTNET_FILLER } from "@unleashed/bridge-core/across-fill"
import { erc20Abi } from "viem"
import manifest from "../../../apps/tools/public/testnet-bridge.json"
import { relayerAccount } from "./key"
import { consoleLog, errorLine, type RelayLog } from "./log"
import { restock, restockDue } from "./restock"
import { testnetRoute } from "./route"
import { connectRelay, type RelayConfig, type RunOutcome, type RunSummary, relayOnce } from "./run"

export interface RelayerEnv {
	RELAYER_PRIVATE_KEY?: string
	BASE_SEPOLIA_RPC_URL?: string
	SEPOLIA_RPC_URL?: string
	CIRCLE_API_KEY?: string
}

/** Outcomes a run reaches only once its chain and signer checks passed; `failed` may come from inside those checks. */
const CHECKED: ReadonlySet<RunOutcome> = new Set(["idle", "busy", "gas-price", "filled", "already-filled", "skipped"])

/** Reads the float after the run and hands it to {@link restock}; a failed read is a refusal line, never a throw. */
async function restockAfter(c: RelayConfig, key: string, scheduledTime: number): Promise<void> {
	const { route } = c
	let balance: bigint
	try {
		balance = await c.destination.public.readContract({
			address: route.destination.token,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [route.filler],
		})
	} catch (e) {
		c.log({ event: "restock-refused", reason: errorLine(e) })
		return
	}
	// workerd's fetch throws when called with a foreign `this`, as a property of the request object would be.
	await restock({ key, filler: route.filler, balance, scheduledTime, fetch: (url, init) => fetch(url, init), log: c.log })
}

/**
 * One run from `env`; refusals before any client exists are log lines too. `scheduledTime` is the cron trigger's;
 * a manual run passes none and never restocks.
 */
export async function scheduledRun(env: RelayerEnv, log: RelayLog = consoleLog, scheduledTime?: number): Promise<RunSummary> {
	let clients: RelayConfig
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
	const summary = await relayOnce(clients)
	const key = env.CIRCLE_API_KEY
	if (scheduledTime !== undefined && CHECKED.has(summary.outcome) && restockDue(key, scheduledTime)) {
		await restockAfter(clients, key, scheduledTime)
	}
	return summary
}

export default {
	async scheduled(controller: { scheduledTime: number }, env: RelayerEnv): Promise<void> {
		await scheduledRun(env, consoleLog, controller.scheduledTime)
	},
}
