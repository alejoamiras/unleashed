import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem"
import { describe, expect, it, vi } from "vitest"
import type { L1Ctx } from "../src/flows"
import { FeeJuicePortalAbi, type FuelDepositPlan } from "../src/fuel"
import { depositFeeJuicePublic } from "./fee-juice-l2"

const ASSET = `0x${"a5".repeat(20)}` as const
const PORTAL = `0x${"9e".repeat(20)}` as const
const plan: FuelDepositPlan = {
	to: `0x${"0d".repeat(32)}`,
	amount: 40n,
	secretHash: `0x${"11".repeat(32)}`,
	secret: undefined as never,
	isPrivate: false,
}
const depositLog = {
	address: PORTAL,
	topics: encodeEventTopics({ abi: FeeJuicePortalAbi, eventName: "DepositToAztecPublic", args: { to: plan.to } }),
	data: encodeAbiParameters(
		[{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
		[plan.amount, plan.secretHash, `0x${"22".repeat(32)}`, 3n],
	),
}

/** An L1 that records each write's function and nonce. */
function chain(allowance: bigint) {
	const writes: Array<{ fn: string; nonce?: number }> = []
	const l1 = {
		account: { address: `0x${"f1".repeat(20)}` },
		wallet: {
			chain: undefined,
			writeContract: vi.fn(async (w: { functionName: string; args: readonly unknown[]; nonce?: number }) => {
				writes.push({ fn: w.functionName, ...(w.nonce === undefined ? {} : { nonce: w.nonce }) })
				if (w.functionName === "approve") allowance = w.args[1] as bigint
				return `0x${writes.length.toString(16).padStart(64, "0")}` as Hex
			}),
		},
		pub: {
			readContract: vi.fn(async () => allowance),
			waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 1n, logs: [depositLog] })),
		},
	} as unknown as L1Ctx
	return { l1, writes }
}

describe("depositFeeJuicePublic", () => {
	it("binds every write to consecutive nonces from the scanned one, so a stale decision collides instead of paying twice", async () => {
		const fresh = chain(0n)
		await depositFeeJuicePublic(fresh.l1, { asset: ASSET, portal: PORTAL, plan, firstNonce: 7 })
		expect(fresh.writes).toEqual([
			{ fn: "approve", nonce: 7 },
			{ fn: "depositToAztecPublic", nonce: 8 },
		])
		const leftover = chain(5n)
		await depositFeeJuicePublic(leftover.l1, { asset: ASSET, portal: PORTAL, plan, firstNonce: 7 })
		expect(leftover.writes.map((w) => w.nonce)).toEqual([7, 8, 9])
		const approved = chain(plan.amount)
		await expect(depositFeeJuicePublic(approved.l1, { asset: ASSET, portal: PORTAL, plan, firstNonce: 7 })).resolves.toMatchObject({
			amount: 40n,
			leafIndex: 3n,
		})
		expect(approved.writes).toEqual([{ fn: "depositToAztecPublic", nonce: 7 }])
	})
})
