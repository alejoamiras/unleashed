/**
 * Four loopback ports for one browser run — the tools preview and one test-wallet origin per
 * profile (the SDK's discovery probe tells wallet frames apart by origin alone) — bind-tested
 * from the static window below the kernel's ephemeral range, so the resolve → build → serve gap
 * cannot lose them to an outgoing connection's source port, and claimed in the host registry under
 * the run's id so every other run on the host (the sandbox this run boots next included) picks
 * around them. The sandbox reserves its own the same way.
 *
 *   bun scripts/e2e/resolve-ports.ts <state-dir> <run-id> <pid>   → writes <state-dir>/ports.json
 *   bun scripts/e2e/resolve-ports.ts --release <state-dir>         → drops the rows ports.json says it owns
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { PortClaimConflict, registerHostPorts, registeredPorts, releaseHostPorts } from "@unleashed/bridge-core/sandbox"

const STATIC_LO = 10_000
const FLOOR_GUARD = 512
const TRIES = 256

function ephemeralFloor(): number {
	try {
		const lo = Number.parseInt(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0] ?? "", 10)
		return Number.isFinite(lo) && lo > STATIC_LO + 256 ? lo : 32_768
	} catch {
		return 32_768
	}
}

function free(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = createServer()
		srv.unref()
		srv.once("error", () => resolve(false))
		srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)))
	})
}

async function reserve(taken: Set<number>): Promise<number> {
	const span = ephemeralFloor() - FLOOR_GUARD - STATIC_LO
	for (let i = 0; i < TRIES; i++) {
		const port = STATIC_LO + Math.floor(Math.random() * span)
		if (!taken.has(port) && (await free(port))) {
			taken.add(port)
			return port
		}
	}
	throw new Error("resolve-ports: no free port in the static window")
}

/** The file names its owner: a state directory chosen by hand is not the run id its rows carry. */
type RunPorts = { tools: number; walletPlain: number; walletSelfpay: number; walletFull: number }
type PortsFile = RunPorts & { owner: string; resolvedAt: string }

if (process.argv[2] === "--release") {
	const stateDir = process.argv[3]
	if (!stateDir) throw new Error("resolve-ports: --release <state-dir>")
	const stored = JSON.parse(readFileSync(join(stateDir, "ports.json"), "utf8")) as PortsFile
	const { owner, resolvedAt: _at, ...owned } = stored
	if (owner) await releaseHostPorts(owner, owned)
} else {
	const [stateDir, runId, pid] = process.argv.slice(2)
	if (!stateDir || !runId) throw new Error("resolve-ports: <state-dir> <run-id> [pid] required")
	const ports = await claim(runId, Number(pid) || process.pid)
	const file: PortsFile = { ...ports, owner: runId, resolvedAt: new Date().toISOString() }
	mkdirSync(stateDir, { recursive: true })
	writeFileSync(join(stateDir, "ports.json"), `${JSON.stringify(file, null, 2)}\n`)
	console.log(`[e2e:tools] tools=:${ports.tools} test-wallet=:${ports.walletPlain}/:${ports.walletSelfpay}/:${ports.walletFull}`)
}

/** Bind-test around every port the registry lists, then claim under its lock; a claim another run
 *  beat this one to is picked again. */
async function claim(runId: string, pid: number): Promise<RunPorts> {
	for (let attempt = 0; ; attempt++) {
		const taken = registeredPorts()
		const ports: RunPorts = {
			tools: await reserve(taken),
			walletPlain: await reserve(taken),
			walletSelfpay: await reserve(taken),
			walletFull: await reserve(taken),
		}
		try {
			await registerHostPorts(runId, "tools-e2e", ports, pid)
			return ports
		} catch (e) {
			if (!(e instanceof PortClaimConflict) || attempt >= 4) throw e
		}
	}
}
