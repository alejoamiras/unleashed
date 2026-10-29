import { describe, expect, it } from "vitest"
import { MAX_SCAN_BLOCKS, SCAN_WINDOW_S, type ScanWindow, scanWindow } from "./window"

const HEAD = 50_000_000n
const T = 1_800_000_000n
const SINCE = T - SCAN_WINDOW_S
/** Base Sepolia today: five blocks to each second, `head` stamped `T`. */
const fifths = (head: bigint) => async (n: bigint) => T - (head - n) / 5n

describe("scanWindow", () => {
	it("finds the window's first block and the last 30 s's by timestamps, whatever the block time", async () => {
		// 2 s blocks up to 10,000 below the head, 0.2 s after: a rate read off the newest blocks would start 2,900 late.
		const changed = async (n: bigint) => (n >= HEAD - 10_000n ? T - (HEAD - n) / 5n : T - 2_000n - (HEAD - 10_000n - n) * 2n)
		const cases: [string, (n: bigint) => Promise<bigint>, bigint, ScanWindow][] = [
			["2 s then 0.2 s blocks", changed, HEAD, { from: HEAD - 12_900n, recentFrom: HEAD - 154n }],
			// Five blocks share the window's first second; the window starts at the first of them.
			["a cutoff inside a shared second", fifths(HEAD), HEAD, { from: HEAD - 39_004n, recentFrom: HEAD - 154n }],
			["a chain younger than the window", fifths(1_000n), 1_000n, { from: 0n, recentFrom: 846n }],
			["a head of 0", fifths(0n), 0n, { from: 0n, recentFrom: 0n }],
		]
		for (const [name, stamp, head, window] of cases) expect(await scanWindow(stamp, head, SINCE), name).toEqual(window)
	})

	it("refuses a window whose cap floor is stamped at its start, or a head stamped before it", async () => {
		const toCap = async (n: bigint) => T - ((HEAD - n) * SCAN_WINDOW_S) / MAX_SCAN_BLOCKS
		await expect(scanWindow(toCap, HEAD, SINCE)).rejects.toThrow(/passes 100000 source blocks/)
		await expect(scanWindow(fifths(HEAD), HEAD, T + 1n)).rejects.toThrow(/stamped 1 s before the scan window/)
	})
})
