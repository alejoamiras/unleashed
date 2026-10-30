import { describe, expect, it, vi } from "vitest"
import type { BridgeToken } from "../src/bridge/token.ts"
import { type Capability, capabilitiesFor } from "../src/capabilities.ts"
import type { BridgeError } from "../src/errors.ts"
import { parseNetwork } from "../src/network.ts"
import { feeJuiceAddress } from "../src/protocol/fee-juice.ts"
import { readsOf, testnet, worldOf } from "./fakes.ts"

vi.mock("../src/protocol/generation-record.ts", async (importOriginal) =>
	(await import("./fakes.ts")).withSyntheticCode(await importOriginal()),
)

const L2_TOKEN = "0x0000000000000000000000000000000000000000000000000000000000000abc"

async function network() {
	const w = worldOf(testnet())
	return parseNetwork(w.m, readsOf(w))
}

const named = (caps: Capability[]) =>
	caps.flatMap((c) => {
		if (c.type === "contracts") return c.contracts.map((a) => `contract ${a.toString()}`)
		if (c.type === "transaction") return c.scope.map((s) => `send ${s.contract.toString()}.${s.function}`)
		if (c.type === "simulation")
			return [...c.utilities.scope, ...c.transactions.scope].map((s) => `dry ${s.contract.toString()}.${s.function}`)
		return []
	})

describe("capabilitiesFor", () => {
	it("grants a gas claim the Fee Juice and PrivateFPC calls only, and a token claim its hub and exact L2 token too", async () => {
		const net = await network()
		const hub = net.bridge?.hub.toLowerCase() as string
		const gas = named(capabilitiesFor(net, { fuel: true }))
		expect(gas).toContain(`send ${feeJuiceAddress.toString()}.claim_and_end_setup`)
		expect(gas).toContain(`send ${net.privateFpc.toLowerCase()}.mint_and_pay_fee`)
		expect(gas.some((g) => g.includes(hub))).toBe(false)
		const token = { network: net, l2Token: L2_TOKEN } as unknown as BridgeToken
		const both = named(capabilitiesFor(net, { fuel: true, tokens: [token, token] }))
		expect(both).toContain(`contract ${L2_TOKEN}`)
		expect(both.filter((g) => g === `contract ${L2_TOKEN}`)).toHaveLength(1)
		expect(both).toContain(`send ${hub}.register_and_claim_public`)
		expect(both.filter((g) => g.startsWith("send ") || g.startsWith("dry ")).every((g) => !g.includes("*"))).toBe(true)
	})

	it("refuses a token resolved on another network", async () => {
		const [net, other] = [await network(), await network()]
		const foreign = { network: other, l2Token: L2_TOKEN } as unknown as BridgeToken
		expect(() => capabilitiesFor(net, { tokens: [foreign] })).toThrow(
			expect.objectContaining({ code: "invalid-request" }) as BridgeError,
		)
	})
})
