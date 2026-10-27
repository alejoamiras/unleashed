import { describe, expect, it, vi } from "vitest"
import type { L1Ctx } from "../src/flows"
import { predictPortal } from "../src/portal-address"
import {
	approveExact,
	assertFactoryPortal,
	assertRouterWitnessShape,
	assertSame,
	type FactoryReader,
	retryOnRevert,
	type RouterReader,
	sourceRpcUrl,
} from "./script-l1"

const ROUTER = `0x${"1a".repeat(20)}` as const
const FACTORY = `0x${"2b".repeat(20)}` as const
const IMPLEMENTATION = `0x${"3c".repeat(20)}` as const
const ERC20 = `0x${"4d".repeat(20)}` as const
const SWAP_TARGET = `0x${"5e".repeat(20)}` as const

const WITNESS_TYPE_STRING = "BridgeWitness witness)BridgeWitness(address tokenPortal,bool isPrivate,address swapTarget)TokenPermissions()"

/** The preflights read through `readContract`, so answering by function name is a whole client. */
function router(answers: { swapTarget: string; typeString: string }): RouterReader {
	return {
		readContract: async ({ functionName }: { functionName: string }) =>
			(functionName === "swapTarget" ? answers.swapTarget : answers.typeString) as never,
	}
}

function factory(predicted: string): FactoryReader {
	return { readContract: async () => predicted as never }
}

describe("script-l1", () => {
	it("assertSame is case-insensitive and throws with both values on mismatch", () => {
		expect(() => assertSame("0xAB", "0xab", "x")).not.toThrow()
		expect(() => assertSame("0x01", "0x02", "portal.registry")).toThrow(/portal\.registry - on-chain 0x01 != expected 0x02/)
	})

	it("router witness gate passes on a router that binds the expected swap target", async () => {
		await expect(
			assertRouterWitnessShape(
				router({ swapTarget: SWAP_TARGET.toUpperCase(), typeString: WITNESS_TYPE_STRING }),
				ROUTER,
				SWAP_TARGET,
			),
		).resolves.toBeUndefined()
	})

	it("router witness gate rejects a wrong swap target and a witness that omits it", async () => {
		await expect(
			assertRouterWitnessShape(router({ swapTarget: `0x${"99".repeat(20)}`, typeString: WITNESS_TYPE_STRING }), ROUTER, SWAP_TARGET),
		).rejects.toThrow(/router\.swapTarget/)
		const unbound = "BridgeWitness witness)BridgeWitness(address tokenPortal,bool isPrivate)TokenPermissions()"
		await expect(
			assertRouterWitnessShape(router({ swapTarget: SWAP_TARGET, typeString: unbound }), ROUTER, SWAP_TARGET),
		).rejects.toThrow(/does not bind swapTarget/)
	})

	it("portal preflight requires the manifest AND the factory to agree with the CREATE2 derivation", async () => {
		const portal = predictPortal(FACTORY, IMPLEMENTATION, ERC20)
		await expect(assertFactoryPortal(factory(portal), FACTORY, IMPLEMENTATION, ERC20, portal)).resolves.toBeUndefined()
		// A carried portal address that is not this generation's CREATE2.
		await expect(assertFactoryPortal(factory(portal), FACTORY, IMPLEMENTATION, ERC20, `0x${"77".repeat(20)}`)).rejects.toThrow(
			/predictPortal/,
		)
		// The factory disagrees: its implementation is not the manifest's.
		await expect(assertFactoryPortal(factory(`0x${"88".repeat(20)}`), FACTORY, IMPLEMENTATION, ERC20, portal)).rejects.toThrow(
			/factory\.predictPortal/,
		)
	})

	it("approveExact leaves exactly the amount, resetting a non-zero allowance first, and sends nothing when it already is", async () => {
		let allowance = 5n
		const approvals: bigint[] = []
		const l1 = {
			account: { address: ROUTER },
			wallet: {
				chain: undefined,
				writeContract: vi.fn(async ({ args }: { args: [string, bigint] }) => {
					approvals.push(args[1])
					allowance = args[1]
					return "0xa1"
				}),
			},
			pub: {
				readContract: vi.fn(async () => allowance),
				waitForTransactionReceipt: vi.fn(async () => ({ status: approvals.at(-1) === 13n ? "reverted" : "success" })),
			},
		} as unknown as L1Ctx
		expect(await approveExact(l1, ERC20, SWAP_TARGET, 7n)).toHaveLength(2)
		expect(approvals).toEqual([0n, 7n])
		expect(await approveExact(l1, ERC20, SWAP_TARGET, 7n)).toEqual([])
		// A reverted approval stops the run rather than leaving an allowance nobody checked.
		await expect(approveExact(l1, ERC20, SWAP_TARGET, 13n)).rejects.toThrow(/REVERTED/)
	})

	it("sourceRpcUrl takes the chain's override, else the catalogue's keyless provider, else none", () => {
		expect(sourceRpcUrl(84532, {})).toBe("https://base-sepolia-rpc.publicnode.com")
		expect(sourceRpcUrl(84532, { BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:1" })).toBe("http://127.0.0.1:1")
		expect(sourceRpcUrl(8453, {})).toBeUndefined()
		expect(sourceRpcUrl(31338, {})).toBeUndefined()
	})

	it("retryOnRevert retries ONLY the transient REVERTED case, rethrows everything else", async () => {
		vi.useFakeTimers()
		try {
			let calls = 0
			const eventuallyOk = retryOnRevert(async () => {
				calls++
				if (calls < 3) throw new Error("execution REVERTED: subtree full")
				return "landed"
			})
			await vi.advanceTimersByTimeAsync(2 * 45_000)
			expect(await eventuallyOk).toBe("landed")
			expect(calls).toBe(3)

			await expect(retryOnRevert(async () => Promise.reject(new Error("insufficient funds")))).rejects.toThrow(/insufficient funds/)

			// Budget exhausted: the persistent revert surfaces after `tries` attempts.
			let persistent = 0
			const exhausted = retryOnRevert(async () => {
				persistent++
				throw new Error("execution REVERTED: forever")
			}, 2).catch((e: Error) => e)
			await vi.advanceTimersByTimeAsync(45_000)
			expect(((await exhausted) as Error).message).toMatch(/REVERTED: forever/)
			expect(persistent).toBe(2)
		} finally {
			vi.useRealTimers()
		}
	})
})
