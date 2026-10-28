#!/usr/bin/env bun
/**
 * The owner's keyed commands for the relayer key, run through `env-exec` with `testnet-relayer.env.example`:
 *
 *   bun scripts/relayer.ts address   prints the address RELAYER_PRIVATE_KEY derives, never the key
 *   bun scripts/relayer.ts once      runs the Worker's run once from this machine, logging as the Worker does
 */
import { relayerAccount } from "../src/key"
import { scheduledRun } from "../src/worker"

const command = process.argv[2]
if (command === "address") {
	console.log(relayerAccount(process.env).address)
} else if (command === "once") {
	const { outcome } = await scheduledRun(process.env)
	process.exit(outcome === "refused" || outcome === "failed" ? 1 : 0)
} else {
	console.error(`usage: bun scripts/relayer.ts address|once, got '${command ?? ""}'`)
	process.exit(2)
}
