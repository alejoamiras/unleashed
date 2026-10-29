import { inspect } from "node:util"
import { overwriteLoggingStream } from "@aztec-labs/foundation/log"
import { requireDrpcNodeUrl } from "../src/drpc-node"
import { redactSecrets } from "./keyed-env"

const LEVELS: Readonly<Record<number, string>> = {
	10: "TRACE",
	20: "DEBUG",
	25: "VERBOSE",
	30: "INFO",
	40: "WARN",
	50: "ERROR",
	60: "FATAL",
}
const ENVELOPE = new Set(["level", "time", "pid", "hostname", "module", "msg"])

function readable(line: string): string {
	try {
		const entry = JSON.parse(line) as Record<string, unknown>
		const data = Object.fromEntries(Object.entries(entry).filter(([k]) => !ENVELOPE.has(k)))
		const extra = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : ""
		return `${LEVELS[entry.level as number] ?? entry.level} ${entry.module ?? ""}: ${entry.msg ?? ""}${extra}\n`
	} catch {
		return line
	}
}

/** The SDK's node client logs each failed attempt with its URL before it retries. */
function installRedactedLogging(): void {
	// Typed as a Writable, but pino needs only `write` from a destination.
	overwriteLoggingStream({
		write: (line: string) => {
			process.stderr.write(redactSecrets(readable(line)))
			return true
		},
	} as Parameters<typeof overwriteLoggingStream>[0])
}

let keyed = false

/**
 * The entry of every keyed script. Routes the SDK's log lines through {@link redactSecrets}, then lets
 * {@link keyedNodeUrl} compose, then runs `main`; a rejection prints `redactSecrets(describe(err))` and exits 1.
 * Build the run's work inside `main`, so nothing logs or composes before the redaction is in place. The default
 * `describe` lifts `inspect`'s 10 000-character string cut, which could leave a key prefix redaction cannot match.
 */
export async function runKeyed(
	main: () => Promise<unknown>,
	describe: (err: unknown) => string = (err) => inspect(err, { depth: 8, maxStringLength: null }),
): Promise<void> {
	installRedactedLogging()
	keyed = true
	try {
		await main()
	} catch (err) {
		console.error(redactSecrets(describe(err)))
		process.exit(1)
	}
}

/** The dRPC node URL for `network`. Throws, naming no value, until {@link runKeyed} has started in this process. */
export function keyedNodeUrl(network: "testnet" | "mainnet"): string {
	if (!keyed) throw new Error("the keyed node URL is composed only inside runKeyed, which redacts what the run prints")
	return requireDrpcNodeUrl(network, process.env)
}
