/** The probe proposes the app's cap; what comes back is whatever the wallet will really submit under. */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@aztec-labs/aztec.js/authorization", () => ({
	SetPublicAuthwitContractInteraction: { create: async () => ({ request: async () => ({ noop: true }) }) },
}))
vi.mock("@aztec-labs/aztec.js/node", () => ({
	createAztecNodeClient: () => ({ getNodeInfo: async () => ({ txsLimits: { gas: { daGas: 55_882, l2Gas: 6_540_000 } } }) }),
}))
vi.mock("@unleashed/bridge-core", () => ({
	predictedWorstMinFees: async () => ({ feePerDaGas: 10n, feePerL2Gas: 20n }),
}))
vi.mock("@/lib/network", () => ({ NETWORK: { nodeUrl: "http://127.0.0.1:1" } }))

import { clampGas, forgetWalletFees, walletMaxFees } from "./wallet-fee-budget"

type Opts = { fee: { gasSettings: { gasLimits: { daGas: number; l2Gas: number }; maxFeesPerGas?: unknown; maxFeePerGas?: unknown } } }
const account = AztecAddress.fromStringUnsafe(`0x${"11".repeat(32)}`)
const simulated = (maxFeesPerGas: { feePerDaGas: bigint; feePerL2Gas: bigint }) => ({
	publicInputs: { constants: { txContext: { gasSettings: { maxFeesPerGas } } } },
})

/** A wallet that honors a dApp's cap (Nulo) answers with the proposal; one that ignores it (stock) with its own. */
function wallet(policy: "honors" | "ignores", own = { feePerDaGas: 15n, feePerL2Gas: 30n }) {
	const seen: Opts[] = []
	return {
		seen,
		simulateTx: vi.fn(async (_payload: unknown, opts: unknown) => {
			seen.push(opts as Opts)
			const cap = (opts as Opts).fee.gasSettings.maxFeesPerGas as { feePerDaGas: bigint; feePerL2Gas: bigint } | undefined
			return simulated(policy === "honors" && cap ? cap : own)
		}),
	}
}

describe("walletMaxFees", () => {
	beforeEach(() => forgetWalletFees())

	it("proposes the node's worst predicted min fees, in both spellings, under the clamped limits", async () => {
		const w = wallet("honors")
		await walletMaxFees(w, account, { daGas: 100_000, l2Gas: 2_000_000 })
		const settings = w.seen[0]?.fee.gasSettings
		expect(settings?.maxFeesPerGas).toEqual({ feePerDaGas: 10n, feePerL2Gas: 20n })
		expect(settings?.maxFeePerGas).toEqual({ feePerDaGas: 10n, feePerL2Gas: 20n })
		expect(settings?.gasLimits, "clamped to the network's per-tx admission").toEqual({ daGas: 55_882, l2Gas: 2_000_000 })
		expect(clampGas({ daGas: 100_000, l2Gas: 9_000_000 })).toEqual({ daGas: 55_882, l2Gas: 6_540_000 })
	})

	it("a wallet that honors the cap prices at exactly the proposal — no padding for its users", async () => {
		expect(await walletMaxFees(wallet("honors"), account, { daGas: 1, l2Gas: 1 })).toEqual({ feePerDaGas: 10n, feePerL2Gas: 20n })
	})

	it("a wallet that ignores the cap prices at what it will really submit under", async () => {
		expect(await walletMaxFees(wallet("ignores"), account, { daGas: 1, l2Gas: 1 })).toEqual({ feePerDaGas: 15n, feePerL2Gas: 30n })
	})

	it("a quote is reused while fresh, and a forget prices afresh", async () => {
		const w = wallet("ignores")
		await walletMaxFees(w, account, { daGas: 1, l2Gas: 1 })
		await walletMaxFees(w, account, { daGas: 1, l2Gas: 1 })
		expect(w.simulateTx).toHaveBeenCalledTimes(1)
		forgetWalletFees()
		await walletMaxFees(w, account, { daGas: 1, l2Gas: 1 })
		expect(w.simulateTx).toHaveBeenCalledTimes(2)
	})

	it("a probe still running when the quotes are forgotten lands nowhere", async () => {
		let release: (() => void) | undefined
		const gate = new Promise<void>((r) => {
			release = r
		})
		const w = {
			simulateTx: vi.fn(async () => {
				await gate
				return simulated({ feePerDaGas: 99n, feePerL2Gas: 99n })
			}),
		}
		const stale = walletMaxFees(w, account, { daGas: 1, l2Gas: 1 })
		forgetWalletFees()
		release?.()
		await stale
		// The next read must not find the stale figure cached: it probes again.
		const fresh = wallet("ignores")
		await walletMaxFees(fresh, account, { daGas: 1, l2Gas: 1 })
		expect(fresh.simulateTx).toHaveBeenCalledTimes(1)
	})

	it("the same address through another wallet is another policy: each wallet is asked itself", async () => {
		const honors = wallet("honors")
		const ignores = wallet("ignores")
		expect(await walletMaxFees(honors, account, { daGas: 1, l2Gas: 1 })).toEqual({ feePerDaGas: 10n, feePerL2Gas: 20n })
		expect(await walletMaxFees(ignores, account, { daGas: 1, l2Gas: 1 })).toEqual({ feePerDaGas: 15n, feePerL2Gas: 30n })
		expect(honors.simulateTx).toHaveBeenCalledTimes(1)
		expect(ignores.simulateTx).toHaveBeenCalledTimes(1)
	})

	it("a wallet with no simulation is priced from the node's prediction", async () => {
		expect(await walletMaxFees({}, account, { daGas: 1, l2Gas: 1 })).toEqual({ feePerDaGas: 10n, feePerL2Gas: 20n })
	})
})
