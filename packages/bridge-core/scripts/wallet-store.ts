import { mkdirSync, mkdtempSync, rmSync, statfsSync } from "node:fs"
import { constants as osConstants, homedir } from "node:os"
import { join } from "node:path"

const owned: string[] = []
const TMPFS_MAGIC = 0x01021994

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
function freshDir(label: string, allowDisk: boolean): string {
	const root = storeRoot({ allowDisk })
	if (root !== "/dev/shm") mkdirSync(root, { recursive: true, mode: 0o700 })
	return mkdtempSync(join(root, `unleashed-${label}-`))
}

/**
 * A fresh wallet store this process owns, removed when it exits. The store holds the account's secret
 * and signing keys, so it never sits in the SDK's default `./aztec-wallet-data`, which is in the tree
 * and shared between runs, and never on disk unless `allowDisk` marks the keys as public sandbox keys
 * (the local sandbox on macOS). Removal covers an exit and a signal; a SIGKILL or a crash leaves a
 * tmpfs store until reboot. The signal fallback is prepended so it counts a `once` handler before that
 * handler is dropped: it exits only when nothing else handles the signal, and a handler that does (the
 * sandbox's async reaper) exits through `process.exit`, which runs the removal.
 * @throws when the host has no tmpfs `/dev/shm` and `allowDisk` is not set.
 */
export function ownedWalletStore(label: string, opts: { allowDisk?: boolean } = {}): string {
	const dir = freshDir(label, opts.allowDisk ?? false)
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
