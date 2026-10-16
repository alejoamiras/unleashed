/**
 * A per-run local network (anvil + `aztec start --local-network`, plus a second anvil as the
 * cross-chain source) the sandbox scripts OWN: ports drawn from a static window below the ephemeral
 * floor, data on real disk, and a `stop()` that signals exactly the process GROUPS this module
 * spawned. Other agents run their own anvil and aztec on the same machine, so a name-matched kill
 * would take down someone else's network.
 *
 * `SANDBOX_L1_RPC` + `SANDBOX_NODE_URL` + `SANDBOX_SOURCE_RPC` together attach to an
 * already-running network instead (a no-op `stop()`), which is how `--keep` is re-entered.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
	accessSync,
	closeSync,
	constants,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ANVIL_ACCOUNTS, CHAIN_ID, SOURCE_CHAIN_ID } from "./constants"

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, "..", "..")
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── Port reservation ────────────────────────────────────────────────────────

/** Ports at or above the OS dynamic range can be handed to an OUTGOING connection between the
 *  bind test and the spawn; ports below it never are, which is the property the pack needs. */
const DEFAULT_EPHEMERAL_FLOOR = 32768
const STATIC_LO = 10_000
const FLOOR_GUARD = 512
const MAX_STATIC_TRIES = 256

interface PortReservation {
	port: number
	release: () => Promise<void>
}

async function ephemeralFloor(): Promise<number> {
	try {
		const raw = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
		const lo = Number.parseInt(raw.trim().split(/\s+/)[0] ?? "", 10)
		return Number.isFinite(lo) && lo > STATIC_LO + 256 ? lo : DEFAULT_EPHEMERAL_FLOOR
	} catch {
		return DEFAULT_EPHEMERAL_FLOOR
	}
}

/** Resolves `null` on ANY bind failure so the probe loop stays a plain retry. */
function tryBind(port: number): Promise<PortReservation | null> {
	return new Promise((res) => {
		const srv = createServer()
		srv.unref()
		let settled = false
		const settle = (v: PortReservation | null) => {
			if (settled) return
			settled = true
			res(v)
		}
		srv.once("error", () => {
			srv.close()
			settle(null)
		})
		srv.listen(port, "127.0.0.1", () => {
			const addr = srv.address()
			if (!addr || typeof addr !== "object") {
				srv.close()
				settle(null)
				return
			}
			settle({ port: addr.port, release: () => new Promise<void>((rs) => srv.close(() => rs())) })
		})
	})
}

async function reservePort(): Promise<PortReservation> {
	const hi = Math.max(STATIC_LO + 256, (await ephemeralFloor()) - FLOOR_GUARD)
	const span = hi - STATIC_LO
	// A port another run claimed in the registry is taken even while nothing listens on it yet.
	const claimed = registeredPorts()
	for (let i = 0; i < MAX_STATIC_TRIES && span >= 256; i++) {
		const candidate = STATIC_LO + Math.floor(Math.random() * span)
		if (claimed.has(candidate)) continue
		const reservation = await tryBind(candidate)
		if (reservation) return reservation
	}
	throw new Error(`no free loopback port in [${STATIC_LO}, ${hi}) after ${MAX_STATIC_TRIES} probes — the static window is exhausted`)
}

export type SandboxPorts = {
	anvil: number
	aztec: number
	aztecAdmin: number
	aztecP2P: number
	sourceAnvil: number
}

/** Five distinct loopback ports, bind-tested against each other and released for the spawn. */
export async function reserveSandboxPorts(): Promise<SandboxPorts> {
	const held = [await reservePort(), await reservePort(), await reservePort(), await reservePort(), await reservePort()]
	const ports = {
		anvil: held[0].port,
		aztec: held[1].port,
		aztecAdmin: held[2].port,
		aztecP2P: held[3].port,
		sourceAnvil: held[4].port,
	}
	await Promise.all(held.map((h) => h.release()))
	return ports
}

// ─── Host port registry (~/.agents/ports.md) ─────────────────────────────────

const REGISTRY = join(homedir(), ".agents", "ports.md")
const REGISTRY_LOCK = `${REGISTRY}.lock`
/** A lock older than this belonged to a run that died holding it; the alternative is a deadlock. */
const LOCK_STALE_MS = 15_000

function tryAcquireLock(): boolean {
	try {
		closeSync(openSync(REGISTRY_LOCK, "wx", 0o600))
		return true
	} catch {
		try {
			if (Date.now() - statSync(REGISTRY_LOCK).mtimeMs > LOCK_STALE_MS) unlinkSync(REGISTRY_LOCK)
		} catch {}
		return false
	}
}

const REGISTRY_HEADER = [
	"# Ports registry — who is RUNNING what, where (atomic-locked)",
	"| port | service | owner (run) | worktree | pid-hint | claimed |",
	"|---|---|---|---|---|---|",
]

/** Rewrites the registry under the lock; `false` when the lock never came free. A host without a
 *  registry gets one — created under that same lock, so two first runs cannot both create it —
 *  because the claims are what keep a run's own ports apart from its next allocation. */
async function withRegistry(mutate: (lines: string[]) => string[]): Promise<boolean> {
	mkdirSync(dirname(REGISTRY), { recursive: true })
	for (let i = 0; i < 60; i++) {
		if (tryAcquireLock()) {
			try {
				const current = existsSync(REGISTRY) ? readFileSync(REGISTRY, "utf8") : `${REGISTRY_HEADER.join("\n")}\n`
				writeFileSync(REGISTRY, `${mutate(current.split("\n")).join("\n")}`)
			} finally {
				try {
					unlinkSync(REGISTRY_LOCK)
				} catch {}
			}
			return true
		}
		await sleep(100)
	}
	return false
}

const ownerCell = (runId: string) => `| ${runId} |`

const portOf = (line: string): number | undefined => {
	const port = Number.parseInt(line.split("|")[1]?.trim() ?? "", 10)
	return Number.isInteger(port) ? port : undefined
}

/** Every port the registry lists, whoever claimed it; empty when the host keeps no registry yet. */
export function registeredPorts(): Set<number> {
	const ports = new Set<number>()
	if (!existsSync(REGISTRY)) return ports
	for (const line of readFileSync(REGISTRY, "utf8").split("\n")) {
		const port = portOf(line)
		if (port !== undefined) ports.add(port)
	}
	return ports
}

/** A claim that found one of its ports already owned by another run: pick again. */
export class PortClaimConflict extends Error {
	constructor(readonly ports: number[]) {
		super(`ports already claimed in ${REGISTRY}: ${ports.join(", ")}`)
	}
}

/**
 * Claim ports in the host registry under `runId`, one row per service (`<label>-<service>`), so
 * every other run on this host — this package's sandboxes included — picks around them from the
 * moment they are resolved, not from the moment something listens on them. The check and the
 * write happen under one lock: a port another run claimed meanwhile throws `PortClaimConflict`,
 * and a lock that never comes free throws — an unclaimed port is not one to build on.
 */
export async function registerHostPorts(runId: string, label: string, ports: Record<string, number>, pidHint: number): Promise<void> {
	const claimed = new Date().toISOString()
	const wanted = new Set(Object.values(ports))
	let conflicts: number[] = []
	const written = await withRegistry((lines) => {
		const body = lines.filter((l) => l.trim().length > 0)
		conflicts = body.map(portOf).filter((p): p is number => p !== undefined && wanted.has(p))
		if (conflicts.length > 0) return lines
		const rows = Object.entries(ports).map(
			([service, port]) => `| ${port} | ${label}-${service} | ${runId} | ${REPO_ROOT} | ${pidHint} | ${claimed} |`,
		)
		return [...body, ...rows, ""]
	})
	if (!written) throw new Error(`${REGISTRY} stayed locked — could not claim ports ${[...wanted].join(", ")} for ${runId}`)
	if (conflicts.length > 0) throw new PortClaimConflict(conflicts)
}

/** Drop every row `runId` owns. A registry that stayed locked keeps them; the warning is what makes
 *  the leak recoverable by hand. Never throws — a registry hiccup must not fail an otherwise clean run. */
export async function releaseHostPorts(runId: string, ports: Record<string, number>): Promise<void> {
	if (await withRegistry((lines) => lines.filter((l) => !l.includes(ownerCell(runId))))) return
	console.warn(
		`[sandbox] ${REGISTRY} stayed locked — remove the rows owned by ${runId} (ports ${Object.values(ports).join(", ")}) by hand`,
	)
}

const releasePorts = (runId: string, ports: SandboxPorts) => releaseHostPorts(runId, ports)

/** The ports reserved AND claimed: a pick another run claimed in between is simply picked again. */
async function claimSandboxPorts(runId: string): Promise<SandboxPorts> {
	for (let attempt = 0; ; attempt++) {
		const ports = await reserveSandboxPorts()
		try {
			await registerHostPorts(runId, "bridge-sandbox", ports, process.pid)
			return ports
		} catch (e) {
			if (!(e instanceof PortClaimConflict) || attempt >= 4) throw e
		}
	}
}

// ─── Toolchain ───────────────────────────────────────────────────────────────

/** The `@aztec-labs/aztec.js` pin this package declares — the toolchain version that matches it. */
export function aztecPin(): string {
	const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> }
	const pin = pkg.dependencies?.["@aztec-labs/aztec.js"]
	if (typeof pin !== "string" || pin.length === 0) {
		throw new Error("packages/bridge-core/package.json declares no @aztec-labs/aztec.js — cannot locate the matching toolchain")
	}
	return pin
}

function isExecutable(p: string): boolean {
	try {
		accessSync(p, constants.X_OK)
		return true
	} catch {
		return false
	}
}

interface Toolchain {
	anvilBin: string
	aztecBin: string
	internalBin: string
}

/**
 * The pinned root is usable only as a COMPLETE toolchain: `@aztec-labs/ethereum` resolves forge/anvil
 * from `~/.aztec/current` ahead of PATH, so a partial install would silently deploy L1 with
 * whatever version another agent's `aztec-up` last pointed that symlink at.
 */
function resolveToolchain(root: string): Toolchain {
	const tool = {
		anvilBin: join(root, "bin", "aztec-anvil"),
		aztecBin: join(root, "node_modules", ".bin", "aztec"),
		internalBin: join(root, "internal-bin"),
	}
	const missing = [tool.anvilBin, tool.aztecBin, join(tool.internalBin, "forge"), join(tool.internalBin, "anvil")].filter(
		(p) => !isExecutable(p),
	)
	if (missing.length > 0) {
		throw new Error(`aztec toolchain at ${root} is incomplete (missing ${missing.join(", ")}) — run: aztec-up install ${aztecPin()}`)
	}
	return tool
}

// ─── Listening sockets ───────────────────────────────────────────────────────

/** `aztec start` has no bind-host option: its JSON-RPC server listens on every interface. The
 *  sockets are logged at boot so a run's exposure is visible in its log, never assumed. */
function listeningSockets(pids: number[]): string {
	try {
		const out = execFileSync("ss", ["-ltnpH"], { encoding: "utf8" })
		const mine = out
			.split("\n")
			.filter((l) => pids.some((pid) => l.includes(`pid=${pid},`)))
			.map((l) => l.trim().split(/\s+/)[3] ?? "")
			.filter(Boolean)
		return mine.length > 0 ? mine.join(" ") : "(none found — ss reported no socket for the spawned pids)"
	} catch {
		return "(ss unavailable)"
	}
}

// ─── Health ──────────────────────────────────────────────────────────────────

async function rpcResponds(url: string, method: string): Promise<boolean> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
		})
		if (!res.ok) return false
		return ((await res.json()) as { result?: unknown }).result != null
	} catch {
		return false
	}
}

async function waitHealthy(label: string, probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (await probe()) return
		await sleep(500)
	}
	throw new Error(`${label} did not answer within ${timeoutMs}ms`)
}

// ─── Process ownership ───────────────────────────────────────────────────────

/** A spawned child plus the one authority on whether it is still running: its own `exit` event.
 *  `killed` only records that a signal was sent, and an exited PID may already name someone else. */
interface OwnedChild {
	child: ChildProcess
	hasExited: () => boolean
	exited: Promise<void>
}

function own(child: ChildProcess): OwnedChild {
	let done = false
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => {
			done = true
			resolve()
		})
	})
	return { child, hasExited: () => done, exited }
}

/** The timer is cleared on exit so a child that goes down at once does not hold the loop open. */
function exitedWithin(owned: OwnedChild, ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		void owned.exited.then(() => {
			clearTimeout(timer)
			resolve()
		})
	})
}

/** Signals the process GROUP this module created (`detached: true` makes the child a group leader),
 *  so the node's own children die with it, and nothing else on the machine is touched. A child that
 *  already exited is left alone: the kernel may have handed its PID — and so its group — to a
 *  stranger. */
async function killGroup(owned: OwnedChild): Promise<void> {
	const pid = owned.child.pid
	if (pid === undefined || owned.hasExited()) return
	const signal = (sig: NodeJS.Signals) => {
		try {
			process.kill(-pid, sig)
		} catch {
			try {
				owned.child.kill(sig)
			} catch {}
		}
	}
	signal("SIGTERM")
	await exitedWithin(owned, 5_000)
	if (!owned.hasExited()) signal("SIGKILL")
}

/**
 * BOTH streams must be consumed. A piped stdout nobody reads fills its 64 KiB kernel buffer and the
 * child blocks on its next write — the aztec node stops sequencing a few blocks in, with no error
 * anywhere. Attaching a listener puts the stream in flowing mode, which is the drain.
 */
/** The sandbox's home on real disk; each run owns one subdirectory. The CI workflows upload
 *  `logs/` from this same path. */
export const SANDBOX_CACHE_DIR = join(homedir(), ".cache", "unleashed", "bridge-sandbox")

/** Where a run's node and anvil output goes — outside the data directory, which teardown removes,
 *  so a failed CI run can still upload it. */
export const SANDBOX_LOG_DIR = join(SANDBOX_CACHE_DIR, "logs")

/** The full stream to a per-run file; errors echoed to the console as they happen. */
function drainOutput(child: ChildProcess, label: string, logFile: string): void {
	mkdirSync(dirname(logFile), { recursive: true })
	const sink = createWriteStream(logFile, { flags: "a" })
	const report = (data: Buffer) => {
		sink.write(data)
		const line = data.toString().trim()
		if (/\bERROR\b|\bFATAL\b|already in use/i.test(line)) console.error(`[${label}]`, line.slice(0, 200))
	}
	child.stdout?.on("data", report)
	child.stderr?.on("data", report)
	// `close` follows the stdio streams' end; `exit` can precede their last chunks.
	child.once("close", () => sink.end())
}

interface AnvilSpec {
	label: string
	port: number
	chainId: number
	logFile: string
	/** Where anvil persists the historical states it pages out of memory; its default is outside the run. */
	cachePath?: string
}

function spawnAnvil(tool: Toolchain, a: AnvilSpec): ChildProcess {
	const child = spawn(
		tool.anvilBin,
		// Every key the handle advertises (`deploy.ts` funds none itself) must be one anvil pre-funds.
		[
			"--host",
			"127.0.0.1",
			"--port",
			String(a.port),
			"--chain-id",
			String(a.chainId),
			"--slots-in-an-epoch",
			"1",
			"--accounts",
			String(ANVIL_ACCOUNTS),
			...(a.cachePath ? ["--cache-path", a.cachePath] : []),
			"--silent",
		],
		{ stdio: "pipe", detached: true },
	)
	drainOutput(child, a.label, a.logFile)
	return child
}

function nodeEnv(tool: Toolchain, anvilUrl: string): NodeJS.ProcessEnv {
	const forge = join(tool.internalBin, "forge")
	const anvil = join(tool.internalBin, "anvil")
	// A shell that disables or resets the admin key would override the hash below: the node reads
	// those switches first. The child never inherits them.
	const { AZTEC_DISABLE_ADMIN_API_KEY: _disable, AZTEC_RESET_ADMIN_API_KEY: _reset, ...inherited } = process.env
	return {
		...inherited,
		PATH: `${tool.internalBin}${delimiter}${process.env.PATH ?? ""}`,
		// Drops the sequencer's per-block transaction floor so a single tx makes a block. It does NOT
		// make the chain tick on its own — this network still builds a block only when a transaction
		// arrives, which is why the L1→L2 waits carry a `forceBlock`.
		SEQ_MIN_TX_PER_BLOCK: "0",
		ETHEREUM_HOSTS: anvilUrl,
		// The admin listener stays authenticated, behind a key hash nothing matches: a key the node
		// mints itself is PRINTED — into the log this run keeps and CI uploads — and disabling the key
		// would leave the admin API open on every interface. Nothing here needs that API.
		AZTEC_ADMIN_API_KEY_HASH: randomBytes(32).toString("hex"),
		// `@aztec-labs/ethereum`'s resolver reads `~/.aztec/current/internal-bin/forge` ahead of PATH; these
		// overrides are its highest-priority source and the only way to pin the L1 deploy to this version.
		...(isExecutable(forge) ? { FORGE_BIN: forge } : {}),
		...(isExecutable(anvil) ? { ANVIL_BIN: anvil } : {}),
	}
}

function spawnNode(tool: Toolchain, p: { ports: SandboxPorts; anvilUrl: string; dataDir: string; logFile: string }): ChildProcess {
	const child = spawn(
		tool.aztecBin,
		[
			"start",
			"--local-network",
			"--port",
			String(p.ports.aztec),
			"--admin-port",
			String(p.ports.aztecAdmin),
			"--p2p.p2pPort",
			String(p.ports.aztecP2P),
			"--l1-rpc-urls",
			p.anvilUrl,
			"--data-directory",
			p.dataDir,
		],
		{ stdio: "pipe", detached: true, env: nodeEnv(tool, p.anvilUrl) },
	)
	drainOutput(child, "aztec", p.logFile)
	return child
}

// ─── Public surface ──────────────────────────────────────────────────────────

export interface LocalNetwork {
	anvilUrl: string
	nodeUrl: string
	/** The source-chain anvil (`SOURCE_CHAIN_ID`) cross-chain sends start on. */
	sourceUrl: string
	stop(): Promise<void>
}

const ATTACH_VARS = ["SANDBOX_L1_RPC", "SANDBOX_NODE_URL", "SANDBOX_SOURCE_RPC"] as const

/** All three env vars together mean "use the network already running"; a subset would boot a fresh
 *  network whose other parts the operator pointed elsewhere, so it is refused rather than guessed. */
function attachedNetwork(): LocalNetwork | undefined {
	const [anvilUrl, nodeUrl, sourceUrl] = ATTACH_VARS.map((v) => process.env[v])
	const set = ATTACH_VARS.filter((v) => process.env[v])
	if (set.length === 0) return undefined
	if (!anvilUrl || !nodeUrl || !sourceUrl) {
		throw new Error(`${ATTACH_VARS.join(", ")} must be set together — only ${set.join(", ")} is set`)
	}
	return { anvilUrl, nodeUrl, sourceUrl, stop: () => Promise.resolve() }
}

export interface StartLocalNetworkOptions {
	/** Names the data directory and the registry rows this run owns. */
	runId: string
	/** Defaults to the installed toolchain matching this package's `@aztec-labs/aztec.js` pin. */
	toolchainRoot?: string
}

/**
 * Each child leads its own process group, so an interrupt to THIS group leaves them running with
 * their ports still claimed: reap them on the way out, on SIGHUP too. The handlers stay registered
 * (`stop` must be idempotent) because `signal-exit` re-raises a signal it finds itself alone on and
 * `bun run` forwards a second SIGTERM; a `once` handler let that one orphan anvil.
 */
export function reapOnSignals(stop: () => Promise<void>): void {
	const onSignal = () => {
		void stop().then(() => process.exit(130))
	}
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal)
}

/**
 * Boots anvil + an aztec local network + the source-chain anvil, or attaches to the ones the env
 * names. The data directory is on real disk under `~/.cache`: a tmpfs store killed before teardown
 * pins multi-GB of RAM in a deleted-but-open file until its holder dies.
 */
export async function startLocalNetwork(opts: StartLocalNetworkOptions): Promise<LocalNetwork> {
	const attached = attachedNetwork()
	if (attached) {
		console.log(`[sandbox] attaching to ${attached.anvilUrl} + ${attached.nodeUrl} + ${attached.sourceUrl}`)
		return attached
	}
	const tool = resolveToolchain(opts.toolchainRoot ?? join(homedir(), ".aztec", "versions", aztecPin()))
	const ports = await claimSandboxPorts(opts.runId)
	const anvilUrl = `http://127.0.0.1:${ports.anvil}`
	const nodeUrl = `http://127.0.0.1:${ports.aztec}`
	const sourceUrl = `http://127.0.0.1:${ports.sourceAnvil}`
	const dataDir = join(SANDBOX_CACHE_DIR, opts.runId)
	mkdirSync(dataDir, { recursive: true })
	const spawned: OwnedChild[] = []
	let stopping: Promise<void> | undefined
	// Idempotent: a second signal while the first stop runs must not re-walk (and re-reverse) the list.
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			for (const owned of [...spawned].reverse()) await killGroup(owned)
			await releasePorts(opts.runId, ports)
			// The store belongs to this network and nothing outlives it; removing it only after the
			// holders are gone is what keeps the pages from staying pinned.
			rmSync(dataDir, { recursive: true, force: true })
		})()
		return stopping
	}
	reapOnSignals(stop)
	// A host that exits without waiting (vitest's own signal handling, an uncaught error) still must
	// not orphan a node holding a multi-GB store: the last-resort reap is synchronous.
	process.once("exit", () => {
		// Only groups still alive: a pid that already exited may since belong to someone else's process.
		for (const owned of spawned) {
			if (owned.hasExited() || owned.child.pid === undefined) continue
			try {
				process.kill(-owned.child.pid, "SIGKILL")
			} catch {}
		}
		rmSync(dataDir, { recursive: true, force: true })
	})
	const log = (name: string) => join(SANDBOX_LOG_DIR, `${opts.runId}-${name}.log`)
	try {
		console.log(`[sandbox] anvil ${anvilUrl}, aztec ${nodeUrl}, source anvil ${sourceUrl}, data ${dataDir}`)
		spawned.push(own(spawnAnvil(tool, { label: "anvil", port: ports.anvil, chainId: CHAIN_ID, logFile: log("anvil") })))
		await waitHealthy(`anvil at ${anvilUrl}`, () => rpcResponds(anvilUrl, "eth_chainId"), 60_000)
		const source = { label: "source-anvil", port: ports.sourceAnvil, chainId: SOURCE_CHAIN_ID, logFile: log("source-anvil") }
		spawned.push(own(spawnAnvil(tool, { ...source, cachePath: join(dataDir, "source-anvil") })))
		await waitHealthy(`source anvil at ${sourceUrl}`, () => rpcResponds(sourceUrl, "eth_chainId"), 60_000)
		spawned.push(own(spawnNode(tool, { ports, anvilUrl, dataDir, logFile: log("aztec") })))
		await waitHealthy(`aztec node at ${nodeUrl}`, () => rpcResponds(nodeUrl, "node_getNodeInfo"), 180_000)
	} catch (e) {
		await stop()
		throw e
	}
	const pids = spawned.map((o) => o.child.pid).filter((p): p is number => p !== undefined)
	console.log(`[sandbox] local network ready — listening on ${listeningSockets(pids)}`)
	return { anvilUrl, nodeUrl, sourceUrl, stop }
}
