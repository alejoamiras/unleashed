import type { Address } from "viem"
import { describe, expect, it, vi } from "vitest"
import { resolveToken } from "../src/bridge/index.ts"
import { parseNetwork } from "../src/network.ts"
import { ATTACKER, readsOf, testnet, worldOf } from "./fakes.ts"

vi.mock("../src/protocol/code-hash.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/protocol/code-hash.ts")>()
	const { syntheticPins } = await import("./fakes.ts")
	return { ...real, CODE_PINS: syntheticPins(real.pinOfBuild) }
})
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
})
