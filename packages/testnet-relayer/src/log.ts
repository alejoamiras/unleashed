/** One JSON line per event, for Workers Logs. A line never carries a key, nor a URL that could hold one. */
import type { Hex } from "viem"

export type RelayEvent =
	| "filled"
	| "already-filled"
	| "skipped"
	| "failed"
	| "ignored"
	| "low-gas"
	| "low-inventory"
	| "busy"
	| "gas-price"
	| "refused"

export interface RelayLine {
	event: RelayEvent
	reason?: string
	relayHash?: Hex
	srcTx?: Hex
	fillTx?: Hex | null
	input?: bigint
	output?: bigint
	fillDeadline?: number
	balance?: bigint
}

export type RelayLog = (line: RelayLine) => void

/** An error's first line with any URL masked: a provider's URL can embed its key, and viem's messages quote it. */
export function errorLine(e: unknown): string {
	const text = e instanceof Error ? e.message : String(e)
	return (text.split("\n")[0] ?? "").replace(/\b\w+:\/\/\S+/g, "<url>")
}

export const consoleLog: RelayLog = (line) =>
	console.log(JSON.stringify(line, (_key, value) => (typeof value === "bigint" ? value.toString() : value)))
