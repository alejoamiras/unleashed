/**
 * Receipt reads for deposits a retired `SwapBridgeRouter` made. No send goes through it any more; a
 * record that was in flight when the app moved to the deposit router still recovers its leaves here,
 * through the router's frozen ABI.
 */
import { type Address, type Hex, parseEventLogs } from "viem"
import { SWAP_BRIDGE_ROUTER_ABI } from "./router-abi"

type Logs = Parameters<typeof parseEventLogs>[0]["logs"]

/** The leaves a legacy deposit produced; the same fields `SendResult` carries. */
export interface LegacySendLeaves {
	tokenLeafIndex?: bigint
	tokenMessageHashHex?: Hex
	fuelLeafIndex?: bigint
	fuelMessageHashHex?: Hex
	fuelReceived?: bigint
}

/**
 * The router's one event of the given name. Only logs the ROUTER emitted count: the token being
 * bridged runs arbitrary code inside the Permit2 pull, before the router emits, and a hostile one
 * can emit a same-signature event carrying a leaf index nothing will ever prove.
 */
function routerEvent<T>(router: Address, eventName: "Bridge" | "BridgeWithFuel", txHash: Hex, logs: Logs): T {
	const own = logs.filter((l) => l.address.toLowerCase() === router.toLowerCase())
	const events = parseEventLogs({ abi: SWAP_BRIDGE_ROUTER_ABI, eventName, logs: own })
	if (events.length !== 1) throw new Error(`the router emitted ${events.length} ${eventName} events in ${txHash}, expected exactly one`)
	return events[0] as T
}

/** Whether `router` emitted anything in `logs`: the receipt names which router a deposit went through. */
export function emittedBy(router: Address, logs: readonly { address: string }[]): boolean {
	return logs.some((l) => l.address.toLowerCase() === router.toLowerCase())
}

/**
 * The leaves a legacy send produced, from its receipt alone. A first-time deposit's receipt also
 * carries the factory's register leaf, so the Inbox events are never read directly: only the router's
 * own event names the deposit's leaf. The fee asset's public gas-only went through the plain
 * `bridge()`, whose message is the gas leg.
 */
export function readLegacySendLeaves(router: Address, intent: "token" | "token+gas" | "gas", txHash: Hex, logs: Logs): LegacySendLeaves {
	const own = logs.filter((l) => l.address.toLowerCase() === router.toLowerCase())
	if (parseEventLogs({ abi: SWAP_BRIDGE_ROUTER_ABI, eventName: "BridgeWithFuel", logs: own }).length === 0) {
		const ev = routerEvent<{ args: { index: bigint; key: Hex; amount: bigint } }>(router, "Bridge", txHash, logs)
		if (intent !== "gas") return { tokenLeafIndex: ev.args.index, tokenMessageHashHex: ev.args.key }
		return { fuelLeafIndex: ev.args.index, fuelMessageHashHex: ev.args.key, fuelReceived: ev.args.amount }
	}
	const ev = routerEvent<{ args: { tokenKey: Hex; tokenIndex: bigint; fuelKey: Hex; fuelIndex: bigint; fuelAmount: bigint } }>(
		router,
		"BridgeWithFuel",
		txHash,
		logs,
	)
	const fuel = { fuelLeafIndex: ev.args.fuelIndex, fuelMessageHashHex: ev.args.fuelKey, fuelReceived: ev.args.fuelAmount }
	return intent === "gas" ? fuel : { ...fuel, tokenLeafIndex: ev.args.tokenIndex, tokenMessageHashHex: ev.args.tokenKey }
}
