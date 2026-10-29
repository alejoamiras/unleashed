import { type ChildProcess, spawn } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { reapDeadStores, storeRoot } from "./wallet-store"

const module = join(import.meta.dirname, "wallet-store.ts")
const keepAlive = "setInterval(() => {}, 1000);"
const hasProc = existsSync("/proc/self/fd")

type Child = { proc: ChildProcess; lines: string[]; exited: Promise<number | null> }
const spawned: Child[] = []

afterEach(async () => {
	for (const c of spawned.splice(0)) {
		if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill("SIGTERM")
		await c.exited
	}
})

/** A `bun -e` child; `exited` settles once its stdio closes, so every line it printed is in `lines`. */
function bun(body: string): Child {
	const proc = spawn("bun", ["-e", body], { stdio: ["ignore", "pipe", "inherit"] })
	const lines: string[] = []
	proc.stdout?.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)))
	const exited = new Promise<number | null>((resolve) => proc.on("close", (code) => resolve(code)))
	const c = { proc, lines, exited }
	spawned.push(c)
	return c
}

/** A child that takes a store and prints its path; `before` runs first, `after` keeps it alive or not. */
function child(before: string, after: string): Child {
	return bun(
		`${before} const { ownedWalletStore } = await import(${JSON.stringify(module)}); console.log(ownedWalletStore("test", { allowDisk: true })); ${after}`,
	)
}

/** The child's first line; rejects if it exits without printing one. */
async function firstLine(c: Child): Promise<string> {
	let closed = false
	void c.exited.then(() => {
		closed = true
	})
	while (c.lines.length === 0) {
		if (closed) throw new Error("the child exited before printing")
		await new Promise((r) => setTimeout(r, 10))
	}
	return c.lines[0] as string
}

describe("ownedWalletStore", () => {
	it("removes the store when the process exits", async () => {
		const c = child("", "")
		const dir = await firstLine(c)
		expect(await c.exited).toBe(0)
		expect(dir).toMatch(/unleashed[-/\\]\d+-test-/)
		expect(existsSync(dir)).toBe(false)
	})

	it("removes the store when a signal ends the process", async () => {
		const c = child("", keepAlive)
		const dir = await firstLine(c)
		expect(existsSync(dir)).toBe(true)
		c.proc.kill("SIGTERM")
		expect(await c.exited).toBe(143)
		expect(existsSync(dir)).toBe(false)
	})

	it("leaves a signal to an earlier async handler, then removes the store on its exit", async () => {
		const reaper = `process.once("SIGTERM", async () => { await new Promise((r) => setTimeout(r, 200)); console.log("reaped"); process.exit(0) });`
		const c = child(reaper, keepAlive)
		const dir = await firstLine(c)
		c.proc.kill("SIGTERM")
		expect(await c.exited).toBe(0)
		expect(c.lines).toContain("reaped")
		expect(existsSync(dir)).toBe(false)
	})

	// Another worktree's run on the same host may reap the killed child's store first, so its survival is not asserted.
	it.skipIf(!hasProc)("reaps a SIGKILLed creator's store at the next creation and keeps a live creator's", async () => {
		const killed = child("", keepAlive)
		const killedDir = await firstLine(killed)
		try {
			expect(basename(killedDir)).toMatch(new RegExp(`^unleashed-${killed.proc.pid}-test-`))
			killed.proc.kill("SIGKILL")
			await killed.exited
			const live = child("", keepAlive)
			const liveDir = await firstLine(live)
			const next = child("", "")
			await firstLine(next)
			expect(await next.exited).toBe(0)
			expect(existsSync(killedDir)).toBe(false)
			expect(existsSync(liveDir)).toBe(true)
			live.proc.kill("SIGTERM")
			expect(await live.exited).toBe(143)
			expect(existsSync(liveDir)).toBe(false)
		} finally {
			rmSync(killedDir, { recursive: true, force: true })
		}
	})
})

describe("reapDeadStores", () => {
	it.skipIf(!hasProc)("removes only a dead creator's unheld directory, in a root no other uid can rename in", async () => {
		// The space checks that a `maps` path is read whole.
		const root = mkdtempSync(join(tmpdir(), "reap test-"))
		const outside = mkdtempSync(join(tmpdir(), "reap-outside-"))
		try {
			writeFileSync(join(outside, "keep"), "x")
			const gone = bun("")
			await gone.exited
			const store = (id: string, pid = gone.proc.pid) => join(root, `unleashed-${pid}-test-${id}`)
			const [unheld, byFd, byCwd, byMap, own, old] = [
				...["a", "b", "c", "d"].map((id) => store(id)),
				store("f", process.pid),
				join(root, "unleashed-test-g"),
			]
			for (const dir of [unheld, byFd, byCwd, byMap, own, old]) {
				mkdirSync(dir)
				writeFileSync(join(dir, "data"), "x")
			}
			symlinkSync(outside, join(unheld, "link"))
			const link = store("e")
			symlinkSync(outside, link)
			const holder = bun(
				`const fs = require("node:fs"); fs.openSync(${JSON.stringify(join(byFd, "data"))}, "r"); process.chdir(${JSON.stringify(byCwd)}); globalThis.held = Bun.mmap(${JSON.stringify(join(byMap, "data"))}); console.log("ready"); ${keepAlive}`,
			)
			await firstLine(holder)

			chmodSync(root, 0o777)
			reapDeadStores(root)
			expect(existsSync(unheld)).toBe(true)
			chmodSync(root, 0o700)

			reapDeadStores(root)
			expect(existsSync(unheld)).toBe(false)
			expect(existsSync(join(outside, "keep"))).toBe(true)
			expect(lstatSync(link).isSymbolicLink()).toBe(true)
			for (const dir of [byFd, byCwd, byMap, own, old]) expect(existsSync(join(dir, "data"))).toBe(true)

			holder.proc.kill("SIGTERM")
			await holder.exited
			reapDeadStores(root)
			for (const dir of [byFd, byCwd, byMap]) expect(existsSync(dir)).toBe(false)
		} finally {
			rmSync(root, { recursive: true, force: true })
			rmSync(outside, { recursive: true, force: true })
		}
	})
})

describe("storeRoot", () => {
	it.skipIf(process.platform !== "linux")("takes /dev/shm where it is a tmpfs", () => {
		expect(storeRoot({ allowDisk: false })).toBe("/dev/shm")
	})

	it("refuses a disk-backed root unless the keys are sandbox keys", () => {
		const disk = import.meta.dirname
		expect(() => storeRoot({ allowDisk: false, shm: disk })).toThrow(/not a tmpfs/)
		expect(storeRoot({ allowDisk: true, shm: disk })).toBe(join(homedir(), ".cache", "unleashed"))
	})
})
