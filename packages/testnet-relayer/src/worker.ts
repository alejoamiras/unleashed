/**
 * The Worker: each cron run makes up to four passes (`schedule.ts`), each signing with the secret RELAYER_PRIVATE_KEY
 * as `TESTNET_FILLER`, the relayer every testnet send names, on the route of the testnet manifest bundled at build
 * time. A key that is not the filler's refuses. With the optional secret CIRCLE_API_KEY, a run may also request a
 * faucet drip (`restock.ts`).
 */
import { BASE_SEPOLIA_RPC_DEFAULT, SEPOLIA_RPC_DEFAULT, TESTNET_FILLER } from "@unleashed/bridge-core/across-fill"
import { erc20Abi } from "viem"
import manifest from "../../../apps/tools/public/testnet-bridge.json"
import { withinDeadline } from "./deadline"
import { relayerAccount } from "./key"
import { consoleLog, errorLine, type RelayLog } from "./log"
import { DRIP_TIMEOUT_MS, restock, restockDue } from "./restock"
import { testnetRoute } from "./route"
import { connectRelay, type RelayConfig, type RunOutcome, type RunSummary, relayOnce, relayPass } from "./run"
import { relayRun } from "./schedule"

export interface RelayerEnv {
	RELAYER_PRIVATE_KEY?: string
	BASE_SEPOLIA_RPC_URL?: string
	SEPOLIA_RPC_URL?: string
	CIRCLE_API_KEY?: string
}

/** Outcomes a pass reaches only once its chain and signer checks passed; `failed` may come from inside those checks. */
const CHECKED: ReadonlySet<RunOutcome> = new Set(["idle", "busy", "gas-price", "late", "filled", "already-filled", "skipped"])
/** A restock starts only with this long left in the run: the float read, then Circle's own timeout. */
const RESTOCK_MS = DRIP_TIMEOUT_MS + 2_000

/**
 * Reads the float and hands it to {@link restock}, ending by `runEnd`; too little time or a failed read is a refusal
 * line, never a throw.
 */
async function restockAfter(c: RelayConfig, key: string, scheduledTime: number, runEnd: number): Promise<void> {
	const { route } = c
	if (runEnd - Date.now() < RESTOCK_MS) {
		c.log({ event: "restock-refused", reason: "too little of the run is left" })
		return
	}
	let balance: bigint
	try {
		balance = await withinDeadline(runEnd - DRIP_TIMEOUT_MS - Date.now(), (read) =>
			read(() =>
				c.destination.public.readContract({
					address: route.destination.token,
					abi: erc20Abi,
					functionName: "balanceOf",
					args: [route.filler],
				}),
			),
		)
	} catch (e) {
		c.log({ event: "restock-refused", reason: errorLine(e) })
		return
	}
	// workerd's fetch throws when called with a foreign `this`, as a property of the request object would be.
	await restock({ key, filler: route.filler, balance, scheduledTime, fetch: (url, init) => fetch(url, init), log: c.log })
}

/**
 * One run from `env`; refusals before any client exists are log lines too. `scheduledTime` is the cron trigger's: the
 * run makes its passes and restocks after the first checked one. A manual run passes none, makes one pass and never
 * restocks. Returns the last pass's summary.
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
	if (scheduledTime === undefined) return relayOnce(clients)
	const key = env.CIRCLE_API_KEY
	let restocked = !restockDue(key, scheduledTime)
	const summaries = await relayRun(async (bounds) => {
		const summary = await relayPass(clients, bounds)
		if (!restocked && CHECKED.has(summary.outcome) && key) {
			restocked = true
			await restockAfter(clients, key, scheduledTime, bounds.runEnd)
		}
		return summary
	}, scheduledTime)
	return summaries.at(-1) ?? { outcome: "idle" }
}

export default {
	async scheduled(controller: { scheduledTime: number }, env: RelayerEnv): Promise<void> {
		await scheduledRun(env, consoleLog, controller.scheduledTime)
	},
}
