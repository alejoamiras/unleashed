import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	type Stats,
	statfsSync,
	statSync,
} from "node:fs"
import { constants as osConstants, homedir } from "node:os"
import { join } from "node:path"

const owned: string[] = []
const TMPFS_MAGIC = 0x01021994
const S_ISVTX = 0o1000
/** The creator's pid leads the name; older pid-less names never match, so they are never reaped. */
const STORE_NAME = /^unleashed-([1-9]\d*)-/
/** A `/proc/<pid>/maps` line's path is everything after its five fixed fields, spaces included. */
const MAPPED_PATH = /^\S+ \S+ \S+ \S+ \d+ +(\/.*)$/

/** Some hosts mount `/dev/shm` as a plain directory on disk, so existing is not enough. */
function isTmpfs(path: string): boolean {
	try {
		return statfsSync(path).type === TMPFS_MAGIC
	} catch {
		return false
	}
}

/**
 * Where stores are created: the RAM-backed `shm` when it is a tmpfs, else `~/.cache/unleashed` only
 * when `allowDisk` says the store holds nothing but public sandbox keys.
 * @throws when `shm` is not a tmpfs and `allowDisk` is false: real keys never reach disk.
 */
export function storeRoot(opts: { allowDisk: boolean; shm?: string }): string {
	const shm = opts.shm ?? "/dev/shm"
	if (isTmpfs(shm)) return shm
	if (!opts.allowDisk) {
		throw new Error(
			`${shm} is not a tmpfs, and a wallet store holding real keys must not be written to disk; run this on a host with a RAM-backed /dev/shm`,
		)
	}
	return join(homedir(), ".cache", "unleashed")
}

/** `mkdtemp` directly in the world-writable `/dev/shm`: a shared parent there could be pre-planted as
 *  a symlink to disk by another local user. */
function freshDir(root: string, label: string): string {
	if (root !== "/dev/shm") mkdirSync(root, { recursive: true, mode: 0o700 })
	return mkdtempSync(join(root, `unleashed-${process.pid}-${label}-`))
}

function attempt<T>(read: () => T, fallback: T): T {
	try {
		return read()
	} catch {
		return fallback
	}
}

/** Only ESRCH proves a pid gone: EPERM is another uid's live process, and a reused pid keeps a store (the safe side). */
function isDead(pid: string | undefined): boolean {
	if (pid === undefined) return false
	try {
		process.kill(Number(pid), 0)
		return false
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH"
	}
}

/** Whoever can rename entries in a root could swap a checked dead store for a live one before its removal: on a sticky
 *  root that is only its owner, elsewhere anyone with write access. */
function isGuarded(root: Stats, uid: number): boolean {
	if (root.mode & S_ISVTX) return root.uid === uid || root.uid === 0
	return root.uid === uid && (root.mode & 0o022) === 0
}

/** Directories in `root` named for a dead pid and owned by this uid, by `lstat`, so a planted symlink never qualifies. */
function deadStores(root: string): string[] {
	const uid = process.getuid?.()
	const real = realpathSync(root)
	if (uid === undefined || !isGuarded(statSync(real), uid)) return []
	return readdirSync(real)
		.filter((name) => isDead(STORE_NAME.exec(name)?.[1]))
		.map((name) => join(real, name))
		.filter((dir) => {
			const entry = attempt(() => lstatSync(dir), undefined)
			return entry?.isDirectory() === true && entry.uid === uid
		})
}

/**
 * Every real path a process holds by its cwd, an fd or a mapping, or undefined where `/proc` cannot be listed. A process
 * whose entries are unreadable is skipped: another uid's cannot enter a 0700 store, a zombie holds nothing, and no
 * non-dumpable process of this uid opens a wallet store.
 */
function heldPaths(): string[] | undefined {
	const pids = attempt(() => readdirSync("/proc").filter((name) => /^\d+$/.test(name)), undefined)
	return pids?.flatMap((pid) => {
		const proc = `/proc/${pid}`
		const fds = attempt(() => readdirSync(`${proc}/fd`), [])
		const maps = attempt(() => readFileSync(`${proc}/maps`, "utf8"), "").split("\n")
		return [
			...attempt(() => [readlinkSync(`${proc}/cwd`)], []),
			...fds.flatMap((fd) => attempt(() => [readlinkSync(`${proc}/fd/${fd}`)], [])),
			...maps.flatMap((line) => MAPPED_PATH.exec(line)?.[1] ?? []),
		]
	})
}

/**
 * Removes the stores in `root` that a dead process left: each `unleashed-<pid>-*` directory whose pid is gone, which
 * this uid owns (never a symlink), and which no readable live process holds by an fd, its cwd or a mapping. The scan
 * is a snapshot, which suffices because only a store's creator opens it by path. Never throws; removes nothing where
 * `/proc` cannot be listed or where another uid could rename entries in `root`.
 */
export function reapDeadStores(root: string): void {
	try {
		const dead = deadStores(root)
		const held = dead.length > 0 ? heldPaths() : undefined
		if (held === undefined) return
		for (const dir of dead) {
			if (held.some((path) => path === dir || path.startsWith(`${dir}/`))) continue
			try {
				rmSync(dir, { recursive: true, force: true })
			} catch {}
		}
	} catch {}
}

/**
 * A fresh wallet store this process owns, removed when it exits. The store holds the account's secret
 * and signing keys, so it never sits in the SDK's default `./aztec-wallet-data`, which is in the tree
 * and shared between runs, and never on disk unless `allowDisk` marks the keys as public sandbox keys
 * (the local sandbox on macOS). Removal covers an exit and a signal; a store that a SIGKILL or a crash
 * leaves is reaped by the next call on the host (`reapDeadStores`). The signal fallback is prepended so it
 * counts a `once` handler before that handler is dropped: it exits only when nothing else handles the
 * signal, and a handler that does (the sandbox's async reaper) exits through `process.exit`, which runs
 * the removal.
 * @throws when the host has no tmpfs `/dev/shm` and `allowDisk` is not set.
 */
export function ownedWalletStore(label: string, opts: { allowDisk?: boolean } = {}): string {
	const root = storeRoot({ allowDisk: opts.allowDisk ?? false })
	reapDeadStores(root)
	const dir = freshDir(root, label)
	if (owned.length === 0) {
		process.once("exit", () => {
			for (const dir of owned) rmSync(dir, { recursive: true, force: true })
		})
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			process.prependListener(signal, () => {
				if (process.listenerCount(signal) === 1) process.exit(128 + osConstants.signals[signal])
			})
		}
	}
	owned.push(dir)
	return dir
}
