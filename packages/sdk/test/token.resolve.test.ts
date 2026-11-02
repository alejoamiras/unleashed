import { type Address, ExecutionRevertedError, HttpRequestError, zeroAddress } from "viem"
import { describe, expect, it, vi } from "vitest"
import { resolveToken } from "../src/bridge/index.ts"
import { parseNetwork } from "../src/network.ts"
import { ATTACKER, readsOf, testnet, worldOf } from "./fakes.ts"

vi.mock("../src/protocol/generation-record.ts", async (importOriginal) =>
	(await import("./fakes.ts")).withSyntheticCode(await importOriginal()),
)
vi.mock("../src/execution/hub-l2.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/hub-l2.ts")>()),
	hubBindingAt: async () => undefined,
}))

describe("resolveToken", () => {
	it("resolves a token only when its stored portal is the factory's clone", async () => {
		const w = worldOf(testnet())
		const token = w.m.bridge?.tokens[0]
		if (!token || !w.m.bridge) throw new Error("the testnet manifest lists a token")
		const { decimals, nameWord, symbolWord } = token
		const registeredAt = (portal: string) => () => ({
			portal,
			decimals,
			registerIndex: 1n,
			nameWord,
			symbolWord,
			registerKey: `0x${"ab".repeat(32)}`,
		})
		const registrationOf = `${w.m.bridge.l1.factory.toLowerCase()}:registrationOf`
		const r = readsOf(w)
		const net = await parseNetwork(w.m, r)

		w.reads.set(registrationOf, registeredAt(token.portal))
		expect((await resolveToken(net, r, token.erc20 as Address)).portal.toLowerCase()).toBe(token.portal.toLowerCase())
		w.reads.set(registrationOf, registeredAt(ATTACKER))
		await expect(resolveToken(net, r, token.erc20 as Address)).rejects.toMatchObject({
			code: "invalid-network",
			message: expect.stringMatching(/not its clone/),
		})
	})

	it.each([
		["omitted", undefined],
		["a custom resolver", { request: async () => "0x" }],
	] as const)("refuses an l1 client whose ccipRead is %s before any read", async (_label, ccipRead) => {
		const w = worldOf(testnet())
		const token = w.m.bridge?.tokens[0]
		if (!token || !w.m.bridge) throw new Error("the testnet manifest lists a token")
		const { decimals, nameWord, symbolWord, portal } = token
		const registerKey = `0x${"ab".repeat(32)}`
		w.reads.set(`${w.m.bridge.l1.factory.toLowerCase()}:registrationOf`, () => ({
			portal,
			decimals,
			registerIndex: 1n,
			nameWord,
			symbolWord,
			registerKey,
		}))
		const r = readsOf(w)
		const net = await parseNetwork(w.m, r)
		const read = vi.fn(async () => {
			throw new Error("no read expected")
		})
		const lookups = { ...r, l1: { ...(r.l1 as object), ccipRead, readContract: read, call: read } as never }
		await expect(resolveToken(net, lookups, token.erc20 as Address)).rejects.toMatchObject({ code: "invalid-request", retry: "never" })
		expect(read).not.toHaveBeenCalled()
		await expect(resolveToken(net, r, token.erc20 as Address)).resolves.toMatchObject({ erc20: token.erc20 })
	})

	it("reports a first-time token's refused metadata read as one to retry, and a reverted decimals() as final", async () => {
		const w = worldOf(testnet())
		if (!w.m.bridge) throw new Error("the testnet manifest has a bridge")
		w.reads.set(`${w.m.bridge.l1.factory.toLowerCase()}:registrationOf`, { portal: zeroAddress })
		const net = await parseNetwork(w.m, readsOf(w))
		const failing = (error: () => Error) => {
			const r = readsOf(w)
			const call = async () => {
				throw error()
			}
			return { ...r, l1: { ...(r.l1 as object), call } as never }
		}
		const token = "0x00000000000000000000000000000000000c0de1" as Address
		const refused = () => new HttpRequestError({ url: "https://rpc.invalid", status: 429, body: {} })
		const reverted = () => new ExecutionRevertedError()
		await expect(resolveToken(net, failing(refused), token)).rejects.toMatchObject({ code: "read-failed", retry: "after-wait" })
		await expect(resolveToken(net, failing(reverted), token)).rejects.toMatchObject({ code: "invalid-request", retry: "never" })
	})
})
