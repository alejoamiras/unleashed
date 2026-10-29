/**
 * Two anvils at Base Sepolia's and Sepolia's chain ids, owned by this run alone: the ports are claimed in the
 * host's port registry, each anvil leads its own process group, and teardown signals those groups and nothing else.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PortClaimConflict, registerHostPorts, releaseHostPorts, reserveSandboxPorts } from "@unleashed/bridge-core/sandbox"
import { type Abi, type Hex, isHex } from "viem"

export interface AnvilPair {
	sourceUrl: string
	destinationUrl: string
	stop(): Promise<void>
}

const EVM_OUT = join(import.meta.dirname, "..", "..", "..", "..", "contracts", "bridge", "evm", "out")

/** A default-profile forge artifact: `forge build` in contracts/bridge/evm writes them. */
export function artifact(name: string): { abi: Abi; bytecode: Hex } {
	const json = JSON.parse(readFileSync(join(EVM_OUT, `${name}.sol`, `${name}.json`), "utf8"))
	return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex }
}

function spawnAnvil(port: number, chainId: number): ChildProcess {
	// The 7 wei base fee is Sepolia's order of magnitude; anvil's 1 gwei default would trip the relayer's gas pause.
	const args = ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--block-base-fee-per-gas", "7", "--silent"]
	return spawn(process.env.ANVIL_BIN || "anvil", args, { stdio: "ignore", detached: true })
}

async function signalGroup(child: ChildProcess): Promise<void> {
	const pid = child.pid
	if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
	process.kill(-pid, "SIGTERM")
	const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000))
	if ((await Promise.race([exited, timer])) === "timeout") process.kill(-pid, "SIGKILL")
}

async function answers(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
		})
		return isHex(((await res.json()) as { result?: unknown }).result)
	} catch {
		return false
	}
}

/** Ports reserved and claimed: a pick another run claims in between is picked again. */
async function claimPorts(runId: string): Promise<{ source: number; destination: number }> {
	for (let attempt = 0; ; attempt++) {
		const reserved = await reserveSandboxPorts()
		const ports = { source: reserved.anvil, destination: reserved.sourceAnvil }
		try {
			await registerHostPorts(runId, "testnet-relayer", ports, process.pid)
			return ports
		} catch (e) {
			if (!(e instanceof PortClaimConflict) || attempt >= 4) throw e
		}
	}
}

export async function startAnvilPair(): Promise<AnvilPair> {
	const runId = `testnet-relayer-${randomUUID().slice(0, 8)}`
	const ports = await claimPorts(runId)
	const children = [spawnAnvil(ports.source, 84532), spawnAnvil(ports.destination, 11155111)]
	let stopping: Promise<void> | undefined
	const stop = () => {
		stopping ??= Promise.all(children.map(signalGroup)).then(() => releaseHostPorts(runId, ports))
		return stopping
	}
	const onSignal = () => void stop().finally(() => process.exit(1))
	process.once("SIGINT", onSignal)
	process.once("SIGTERM", onSignal)
	const urls = { sourceUrl: `http://127.0.0.1:${ports.source}`, destinationUrl: `http://127.0.0.1:${ports.destination}` }
	const deadline = Date.now() + 30_000
	while (!((await answers(urls.sourceUrl)) && (await answers(urls.destinationUrl)))) {
		if (Date.now() > deadline) {
			await stop()
			throw new Error("the anvil pair did not answer within 30 s")
		}
		await new Promise((r) => setTimeout(r, 100))
	}
	return { ...urls, stop }
}
