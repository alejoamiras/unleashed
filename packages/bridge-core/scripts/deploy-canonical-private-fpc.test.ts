import { beforeEach, describe, expect, test, vi } from "vitest"

const seams = vi.hoisted(() => ({
	getContract: vi.fn(async (_addr: unknown): Promise<unknown> => undefined),
	createL2Wallet: vi.fn(async () => ({ fake: "ewallet" })),
	deploy: vi.fn(),
	deployedAddress: { value: "" },
}))

vi.mock("./script-bootstrap", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		createNode: () => ({ getContract: seams.getContract }),
		createL2Wallet: seams.createL2Wallet,
	}
})

vi.mock("@alejoamiras/private-fee-juice/artifacts/private", () => ({
	PrivateFPCContract: {
		deploy: (...args: unknown[]) => {
			seams.deploy(...args)
			return {
				send: async (sendArgs: unknown) => {
					seams.deploy("send", sendArgs)
					return { instance: { address: { toString: () => seams.deployedAddress.value } } }
				},
			}
		},
	},
}))

import { PRIVATE_FPC_ADDRESS, PRIVATE_FPC_SALT } from "../src/private-fuel"
import { deployCanonicalPrivateFpc } from "./deploy-canonical-private-fpc"

describe("deployCanonicalPrivateFpc", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		seams.getContract.mockResolvedValue(undefined)
		seams.deployedAddress.value = PRIVATE_FPC_ADDRESS
	})

	test("existence check runs FIRST: an already-deployed pin early-returns before any wallet creation", async () => {
		seams.getContract.mockResolvedValue({ exists: true })
		await deployCanonicalPrivateFpc({ nodeUrl: "http://n", prepare: vi.fn() })
		expect(seams.createL2Wallet).not.toHaveBeenCalled()
		expect(seams.deploy).not.toHaveBeenCalled()
	})

	test("sequencing: node-check → wallet → prepare(ctx) → deploy with prepare's from/fee", async () => {
		const order: string[] = []
		seams.getContract.mockImplementation(async () => {
			order.push("exists-check")
			return undefined
		})
		seams.createL2Wallet.mockImplementation(async () => {
			order.push("wallet")
			return { fake: "ewallet" }
		})
		const fee = { paymentMethod: { tag: "fee" } }
		const from = { tag: "from" }
		const prepare = vi.fn(async (ctx: { ewallet: unknown; node: unknown; mins: () => string }) => {
			order.push("prepare")
			expect(ctx.ewallet).toEqual({ fake: "ewallet" })
			expect(typeof ctx.mins()).toBe("string")
			return { from: from as never, fee }
		})
		await deployCanonicalPrivateFpc({ nodeUrl: "http://n", prepare })
		expect(order).toEqual(["exists-check", "wallet", "prepare"])
		// The deploy carried the canonical salt + universalDeploy and prepare's from/fee.
		const deployOpts = seams.deploy.mock.calls[0]?.[1] as { salt: { toString(): string }; universalDeploy: boolean }
		expect(deployOpts.universalDeploy).toBe(true)
		expect(BigInt(deployOpts.salt.toString())).toBe(BigInt(PRIVATE_FPC_SALT))
		const sendArgs = seams.deploy.mock.calls.find((c) => c[0] === "send")?.[1] as { fee: unknown; from: unknown }
		expect(sendArgs.fee).toBe(fee)
		expect(sendArgs.from).toBe(from)
	})

	test("address-pin mismatch rejects with the investigate error", async () => {
		seams.deployedAddress.value = "0xdeadbeef"
		await expect(
			deployCanonicalPrivateFpc({
				nodeUrl: "http://n",
				prepare: async () => ({ from: {} as never, fee: { paymentMethod: {} } }),
			}),
		).rejects.toThrow(/!= pinned .* artifact\/pin mismatch/)
	})
})
