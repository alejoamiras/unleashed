/** The probe proposes the app's cap; what comes back is whatever the wallet will really submit under, within the bound. */
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../protocol/fee-juice.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../protocol/fee-juice.ts")>()),
	predictedWorstMinFees: async () => ({ feePerDaGas: 0n, feePerL2Gas: 20n }),
}))

import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { feeJuiceAddress } from "../protocol/fee-juice.ts"
import { clampGas, forgetWalletFees, type MaxFees, walletMaxFees as walletMaxFeesOn } from "./wallet-fee-budget.ts"

const nodeWithMax = (daGas: number, l2Gas: number) =>
	({ getNodeInfo: async () => ({ txsLimits: { gas: { daGas, l2Gas } } }) }) as unknown as AztecNode
const node = nodeWithMax(55_882, 6_540_000)
const GAS = { daGas: 1, l2Gas: 1 }
const BOUND: MaxFees = { feePerDaGas: 0n, feePerL2Gas: 60n }
const walletMaxFees = (w: unknown, gas = GAS, bound: MaxFees = BOUND) => walletMaxFeesOn(node, w, gas, async () => bound)

type Opts = {
	from: unknown
	fee: { gasSettings: { gasLimits: { daGas: number; l2Gas: number }; maxFeesPerGas?: unknown; maxFeePerGas?: unknown } }
}
type Payload = { calls: { to: { toString(): string }; name: string; args: { isZero(): boolean }[] }[] }
const simulated = (maxFeesPerGas: MaxFees | Record<string, unknown>) => ({
	publicInputs: { constants: { txContext: { gasSettings: { maxFeesPerGas } } } },
})

/** A wallet that honors a dApp's cap (Nulo) answers with the proposal; one that ignores it (stock) with its own. */
function wallet(policy: "honors" | "ignores", own: MaxFees | Record<string, unknown> = { feePerDaGas: 0n, feePerL2Gas: 30n }) {
	const seen: { payload: Payload; opts: Opts }[] = []
	return {
		seen,
		simulateTx: vi.fn(async (payload: unknown, opts: unknown) => {
			seen.push({ payload: payload as Payload, opts: opts as Opts })
			const cap = (opts as Opts).fee.gasSettings.maxFeesPerGas as MaxFees | undefined
			return simulated(policy === "honors" && cap ? cap : own)
		}),
	}
}

/** A wallet whose one probe answers only once released. */
function gatedWallet(answer: MaxFees) {
	let release: (() => void) | undefined
	const gate = new Promise<void>((r) => {
		release = r
	})
	const simulateTx = vi.fn(async () => {
		await gate
		return simulated(answer)
	})
	return { w: { simulateTx }, release: () => release?.() }
}

describe("walletMaxFees", () => {
	beforeEach(() => forgetWalletFees())

	it("proposes the node's worst predicted min fees, in both spellings, under the clamped limits", async () => {
		const w = wallet("honors")
		await walletMaxFees(w, { daGas: 100_000, l2Gas: 2_000_000 })
		const settings = w.seen[0]?.opts.fee.gasSettings
		expect(settings?.maxFeesPerGas).toEqual({ feePerDaGas: 0n, feePerL2Gas: 20n })
		expect(settings?.maxFeePerGas).toEqual({ feePerDaGas: 0n, feePerL2Gas: 20n })
		expect(settings?.gasLimits, "clamped to the network's per-tx admission").toEqual({ daGas: 55_882, l2Gas: 2_000_000 })
		expect(clampGas(node, { daGas: 100_000, l2Gas: 9_000_000 })).toEqual({ daGas: 55_882, l2Gas: 6_540_000 })
	})

	it("probes without a sender: Fee Juice's public balance of the zero address, from NO_FROM", async () => {
		const w = wallet("ignores")
		await walletMaxFees(w)
		const [{ payload, opts }] = w.seen
		expect(opts.from).toBe(NO_FROM)
		expect(payload.calls.map((c) => [c.to.toString(), c.name])).toEqual([[feeJuiceAddress, "balance_of_public"]])
		expect(payload.calls[0]?.args.every((a) => a.isZero())).toBe(true)
	})

	it("limits and quotes are per node: a second network's maximum never clamps the first's, nor its quote serves it", async () => {
		const other = nodeWithMax(1_000, 1_000)
		const w = wallet("honors")
		await walletMaxFeesOn(other, w, GAS, async () => BOUND)
		expect(clampGas(other, { daGas: 5_000, l2Gas: 5_000 })).toEqual({ daGas: 1_000, l2Gas: 1_000 })
		await walletMaxFees(w)
		expect(clampGas(node, { daGas: 5_000, l2Gas: 5_000 })).toEqual({ daGas: 5_000, l2Gas: 5_000 })
		expect(w.simulateTx).toHaveBeenCalledTimes(2)
	})

	it("a wallet that honors the cap prices at exactly the proposal — no padding for its users", async () => {
		expect(await walletMaxFees(wallet("honors"))).toEqual({ feePerDaGas: 0n, feePerL2Gas: 20n })
	})

	it("a wallet that ignores the cap prices at what it will really submit under", async () => {
		expect(await walletMaxFees(wallet("ignores"))).toEqual({ feePerDaGas: 0n, feePerL2Gas: 30n })
	})

	it("refuses a quote above the bound on either component, and accepts one at it", async () => {
		await expect(walletMaxFees(wallet("ignores", { feePerDaGas: 0n, feePerL2Gas: 61n }))).rejects.toThrow("above the rollup's bound")
		await expect(walletMaxFees(wallet("ignores", { feePerDaGas: 1n, feePerL2Gas: 30n }))).rejects.toThrow("above the rollup's bound")
		expect(await walletMaxFees(wallet("ignores", { feePerDaGas: 0n, feePerL2Gas: 60n }))).toEqual(BOUND)
	})

	it("refuses a negative component", async () => {
		await expect(walletMaxFees(wallet("ignores", { feePerDaGas: "-1", feePerL2Gas: "30" }))).rejects.toThrow("negative")
	})

	it("a cached quote, and one still pending, are checked against a tighter bound", async () => {
		const tight: MaxFees = { feePerDaGas: 0n, feePerL2Gas: 25n }
		const w = wallet("ignores")
		await walletMaxFees(w)
		await expect(walletMaxFees(w, GAS, tight)).rejects.toThrow("above the rollup's bound")
		expect(w.simulateTx).toHaveBeenCalledTimes(1)

		forgetWalletFees()
		const g = gatedWallet({ feePerDaGas: 0n, feePerL2Gas: 30n })
		const first = walletMaxFees(g.w)
		const second = walletMaxFees(g.w, GAS, tight)
		g.release()
		expect(await first).toEqual({ feePerDaGas: 0n, feePerL2Gas: 30n })
		await expect(second).rejects.toThrow("above the rollup's bound")
		expect(g.w.simulateTx).toHaveBeenCalledTimes(1)
	})

	it("a failed bound read refuses whatever the wallet quoted", async () => {
		const w = wallet("honors")
		await expect(walletMaxFeesOn(node, w, GAS, () => Promise.reject(new Error("l1 down")))).rejects.toThrow("l1 down")
	})

	it("a quote is reused while fresh, and a forget prices afresh", async () => {
		const w = wallet("ignores")
		await walletMaxFees(w)
		await walletMaxFees(w)
		expect(w.simulateTx).toHaveBeenCalledTimes(1)
		forgetWalletFees()
		await walletMaxFees(w)
		expect(w.simulateTx).toHaveBeenCalledTimes(2)
	})

	it("a probe still running when the quotes are forgotten lands nowhere", async () => {
		const g = gatedWallet({ feePerDaGas: 0n, feePerL2Gas: 50n })
		const stale = walletMaxFees(g.w)
		forgetWalletFees()
		g.release()
		await stale
		// The next read must not find the stale figure cached: it probes again.
		const fresh = wallet("ignores")
		await walletMaxFees(fresh)
		expect(fresh.simulateTx).toHaveBeenCalledTimes(1)
	})

	it("each wallet is asked itself: another wallet is another policy", async () => {
		const honors = wallet("honors")
		const ignores = wallet("ignores")
		expect(await walletMaxFees(honors)).toEqual({ feePerDaGas: 0n, feePerL2Gas: 20n })
		expect(await walletMaxFees(ignores)).toEqual({ feePerDaGas: 0n, feePerL2Gas: 30n })
		expect(honors.simulateTx).toHaveBeenCalledTimes(1)
		expect(ignores.simulateTx).toHaveBeenCalledTimes(1)
	})

	it("a wallet with no simulation is priced from the node's prediction, within the bound", async () => {
		expect(await walletMaxFees({})).toEqual({ feePerDaGas: 0n, feePerL2Gas: 20n })
		await expect(walletMaxFees({}, GAS, { feePerDaGas: 0n, feePerL2Gas: 19n })).rejects.toThrow("above the rollup's bound")
	})
})
