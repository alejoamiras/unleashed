import { TESTNET_FILLER } from "@unleashed/bridge-core/across-fill"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RelayLine } from "./log"
import { connectRelay, type PassBounds, type RunOutcome, type RunSummary, relayOnce, relayPass } from "./run"
import worker, { scheduledRun } from "./worker"

const run = vi.hoisted(() => ({ msLeft: 58_000, passes: 2 }))
vi.mock("./run", async (importOriginal) => ({
	...(await importOriginal<typeof import("./run")>()),
	connectRelay: vi.fn(),
	relayOnce: vi.fn(),
	relayPass: vi.fn(),
}))
// `run.passes` passes, each told the run ends `run.msLeft` from now.
vi.mock("./schedule", () => ({
	relayRun: async (pass: (b: PassBounds) => Promise<RunSummary>) => {
		const summaries: RunSummary[] = []
		for (let i = 0; i < run.passes; i++) summaries.push(await pass({ runEnd: Date.now() + run.msLeft }))
		return summaries
	},
}))

const MIDNIGHT = Date.UTC(2026, 9, 29)
const env = { RELAYER_PRIVATE_KEY: `0x${"11".repeat(32)}`, CIRCLE_API_KEY: "TEST_API_KEY:0123456789abcdef:secret0123456789" }
const readContract = vi.fn(async () => 1_000_000n)
const drip = vi.fn(async () => new Response(null, { status: 204 }))

beforeEach(() => {
	readContract.mockClear()
	drip.mockClear()
	vi.stubGlobal("fetch", drip)
	vi.mocked(connectRelay).mockReturnValue({ source: {}, destination: { public: { readContract }, wallet: {} } } as never)
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
	run.msLeft = 58_000
	run.passes = 2
})

/** Every pass ends in `outcome`, the first in `first`. */
const runs = (outcome: RunOutcome, first = outcome) => {
	vi.mocked(relayOnce).mockResolvedValue({ outcome })
	vi.mocked(relayPass).mockReset().mockResolvedValueOnce({ outcome: first }).mockResolvedValue({ outcome })
}

describe("the Worker's restock", () => {
	it("asks for a drip once a run, after its first pass that passed its checks, at the cron trigger's time", async () => {
		const quiet = vi.spyOn(console, "log").mockImplementation(() => {})
		for (const outcome of ["idle", "busy", "gas-price", "late", "filled", "already-filled", "skipped"] as const) {
			runs(outcome)
			drip.mockClear()
			await worker.scheduled({ scheduledTime: MIDNIGHT }, env)
			expect(drip, outcome).toHaveBeenCalledTimes(1)
			// workerd's fetch refuses a foreign `this`; a bare call gives it none.
			expect(drip.mock.contexts).toEqual([undefined])
		}
		runs("idle", "failed")
		drip.mockClear()
		await worker.scheduled({ scheduledTime: MIDNIGHT }, env)
		expect(drip).toHaveBeenCalledTimes(1)
		expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "balanceOf", args: [TESTNET_FILLER] }))
		quiet.mockRestore()
	})

	it("reads nothing and asks nothing after a refused or failed run, outside the minute, without a key, or on a manual run", async () => {
		const lines: RelayLine[] = []
		const log = (l: RelayLine) => lines.push(l)
		for (const outcome of ["refused", "failed"] as const) {
			runs(outcome)
			await scheduledRun(env, log, MIDNIGHT)
		}
		runs("idle")
		await scheduledRun(env, log, MIDNIGHT + 60_000)
		await scheduledRun({ ...env, CIRCLE_API_KEY: undefined }, log, MIDNIGHT)
		await scheduledRun(env, log)
		expect(readContract).not.toHaveBeenCalled()
		expect(drip).not.toHaveBeenCalled()
		expect(lines).toEqual([])
	})

	it("asks nothing when too little of the run is left for the float read and Circle's answer, or for any pass", async () => {
		const lines: RelayLine[] = []
		runs("idle")
		run.msLeft = 5_000
		await scheduledRun(env, (l) => lines.push(l), MIDNIGHT)
		run.passes = 0
		vi.setSystemTime(MIDNIGHT + 54_000)
		expect(await scheduledRun(env, (l) => lines.push(l), MIDNIGHT)).toEqual({ outcome: "late" })
		expect(lines).toEqual([
			{ event: "restock-refused", reason: "too little of the run is left" },
			{ event: "late", reason: "the run started 54 s after its cron time" },
		])
		expect(readContract).not.toHaveBeenCalled()
		expect(drip).not.toHaveBeenCalled()
	})
})
