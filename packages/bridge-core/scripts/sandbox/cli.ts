#!/usr/bin/env bun
/**
 * The sandbox from the command line.
 *
 *   run   [--smoke] [--keep]        boot, deploy, optionally smoke, tear down (unless --keep)
 *   up    --artifacts <dir>         boot, deploy, write <dir>/{manifest,handle}.json, then hold until SIGTERM/SIGINT
 *   smoke --artifacts <dir>         attach to the network a handle names and run the battery on the base actor
 *
 * `SANDBOX_L1_RPC` + `SANDBOX_NODE_URL` (both) attach `run` to a network already up instead of booting one.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stopwatch } from "../script-bootstrap"
import { deployEverything } from "./deploy"
import { openSandbox, readHandle, readManifest } from "./handle"
import { actorAddress } from "./l2"
import { startLocalNetwork } from "./local-network"
import { durationTable, runSmoke } from "./smoke"

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ARTIFACTS = join(here, "..", "..", "sandbox-deploy")

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(name)
	return i >= 0 ? process.argv[i + 1] : undefined
}

async function commandRun(): Promise<void> {
	const mins = stopwatch()
	const runId = `bridge-sandbox-${process.pid}-${Date.now().toString(36)}`
	const net = await startLocalNetwork({ runId })
	let failure: unknown
	let table = ""
	try {
		const deployed = await deployEverything(net, { artifactsDir: flag("--artifacts") ?? DEFAULT_ARTIFACTS, mins })
		if (process.argv.includes("--smoke")) {
			const report = await runSmoke(deployed.clients, deployed.manifest, deployed.actor)
			table = durationTable(report.results)
		}
	} catch (e) {
		failure = e
	}
	if (table) console.log(`\n=== durations (${mins()}) ===\n${table}`)
	if (process.argv.includes("--keep")) {
		console.log(`\nnetwork kept — re-attach with:\n  SANDBOX_L1_RPC=${net.anvilUrl} SANDBOX_NODE_URL=${net.nodeUrl}`)
	} else {
		await net.stop()
	}
	if (failure) throw failure
	console.log(`\n✅ sandbox deploy${process.argv.includes("--smoke") ? " + smoke" : ""} OK (${mins()})`)
}

async function commandUp(): Promise<void> {
	const dir = flag("--artifacts")
	if (!dir) throw new Error("up needs --artifacts <dir>")
	const mins = stopwatch()
	const runId = `bridge-sandbox-${process.pid}-${Date.now().toString(36)}`
	const net = await startLocalNetwork({ runId })
	try {
		await deployEverything(net, { artifactsDir: dir, mins })
	} catch (e) {
		await net.stop()
		throw e
	}
	console.log(`\n✅ sandbox up (${mins()}) — artifacts in ${dir}; holding until SIGTERM/SIGINT`)
	// startLocalNetwork installed the signal handlers that tear the network down; this process just
	// has to stay alive so the handle keeps pointing at something.
	await new Promise(() => {})
}

async function commandSmoke(): Promise<void> {
	const dir = flag("--artifacts")
	if (!dir) throw new Error("smoke needs --artifacts <dir>")
	const handle = readHandle(dir)
	const manifest = readManifest(dir)
	const clients = await openSandbox(handle)
	const address = await actorAddress(clients.l2.wallet, handle.l2.actorSecret as `0x${string}`, BigInt(handle.l2.actorSalt))
	const report = await runSmoke(clients, manifest, {
		secret: handle.l2.actorSecret as `0x${string}`,
		salt: BigInt(handle.l2.actorSalt),
		address,
	})
	console.log(`\n=== durations ===\n${durationTable(report.results)}`)
	console.log(`\n✅ smoke OK (${clients.mins()})`)
}

const commands: Record<string, () => Promise<void>> = { run: commandRun, up: commandUp, smoke: commandSmoke }

/** The CLI's entry: `import.meta.main` is false for a module another script imports, so the alias calls this. */
export function main(): void {
	const name = process.argv[2] ?? "run"
	const command = commands[name]
	if (!command) {
		console.error(`unknown command "${name}" — expected run | up | smoke`)
		process.exit(2)
	}
	command().catch((e) => {
		console.error(e)
		process.exit(1)
	})
}

if (import.meta.main) main()
