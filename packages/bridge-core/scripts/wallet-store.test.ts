import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { storeRoot } from "./wallet-store"

const module = join(import.meta.dirname, "wallet-store.ts")
const keepAlive = "setInterval(() => {}, 1000);"

/** A child that takes a store and prints its path; `before` runs first, `after` keeps it alive or not. */
function child(before: string, after: string): { proc: ChildProcess; lines: string[]; exited: Promise<number | null> } {
	const body = `${before} const { ownedWalletStore } = await import(${JSON.stringify(module)}); console.log(ownedWalletStore("test", { allowDisk: true })); ${after}`
	const proc = spawn("bun", ["-e", body], { stdio: ["ignore", "pipe", "inherit"] })
	const lines: string[] = []
	proc.stdout?.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)))
	const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)))
	return { proc, lines, exited }
}

/** The store path, once the child has printed it. */
async function storeOf(lines: string[]): Promise<string> {
	while (lines.length === 0) await new Promise((r) => setTimeout(r, 10))
	return lines[0] as string
}

describe("ownedWalletStore", () => {
	it("removes the store when the process exits", async () => {
		const c = child("", "")
		const dir = await storeOf(c.lines)
		expect(await c.exited).toBe(0)
		expect(dir).toMatch(/unleashed[-/\\]test-/)
		expect(existsSync(dir)).toBe(false)
	})

	it("removes the store when a signal ends the process", async () => {
		const c = child("", keepAlive)
		const dir = await storeOf(c.lines)
		expect(existsSync(dir)).toBe(true)
		c.proc.kill("SIGTERM")
		expect(await c.exited).toBe(143)
		expect(existsSync(dir)).toBe(false)
	})

	it("leaves a signal to an earlier async handler, then removes the store on its exit", async () => {
		const reaper = `process.once("SIGTERM", async () => { await new Promise((r) => setTimeout(r, 200)); console.log("reaped"); process.exit(0) });`
		const c = child(reaper, keepAlive)
		const dir = await storeOf(c.lines)
		c.proc.kill("SIGTERM")
		expect(await c.exited).toBe(0)
		expect(c.lines).toContain("reaped")
		expect(existsSync(dir)).toBe(false)
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
