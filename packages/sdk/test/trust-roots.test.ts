import { describe, expect, it, vi } from "vitest"
import { BridgeError } from "../src/errors.ts"
import { parseNetwork } from "../src/network.ts"
import { ATTACKER, ROLLUP, readsOf, testnet, type World, worldOf } from "./fakes.ts"

vi.mock("../src/protocol/code-hash.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/protocol/code-hash.ts")>()
	const { syntheticPins } = await import("./fakes.ts")
	return { ...real, CODE_PINS: syntheticPins(real.pinOfBuild) }
})

const refusedWith = async (w: World, code: string, why?: RegExp) => {
	const e = await parseNetwork(w.m, readsOf(w)).then(
		() => undefined,
		(err: unknown) => err,
	)
	expect(e).toBeInstanceOf(BridgeError)
	expect((e as BridgeError).code).toBe(code)
	expect((e as BridgeError).submission).toBe("none")
	if (why) expect((e as BridgeError).message).toMatch(why)
}

const router = (w: World) => w.m.bridge?.l1.depositRouter as string

describe("parseNetwork's trust roots", () => {
	it("accepts the bundled testnet manifest on a chain that answers as it says", async () => {
		const w = worldOf(testnet())
		const net = await parseNetwork(w.m, readsOf(w))
		expect(net.bridge?.factory).toBe(w.m.bridge?.l1.factory)
		expect(net.fuel.fuelSwapper).toBe(w.m.bridge?.l1.fuelSwapper)
		expect(Object.isFrozen(net)).toBe(true)
	})

	it("refuses a genuine router bound to the attacker's Permit2, portal or swap target", async () => {
		for (const fn of ["PERMIT2", "FEE_JUICE_PORTAL", "SWAP_TARGET"]) {
			const w = worldOf(testnet())
			w.reads.set(`${router(w).toLowerCase()}:${fn}`, ATTACKER)
			await refusedWith(w, "invalid-network", new RegExp(`depositRouter.${fn}`))
		}
	})

	it("refuses a manifest naming a non-canonical Permit2 or a slippage above the cap, before any read", async () => {
		const permit = worldOf(testnet())
		if (permit.m.bridge) permit.m.bridge.l1.permit2 = ATTACKER
		await refusedWith(permit, "invalid-network", /canonical Permit2/)
		const slippage = worldOf(testnet())
		if (slippage.m.bridge?.l1.fuel) slippage.m.bridge.l1.fuel.slippageBps = 301
		await refusedWith(slippage, "invalid-network", /301 bps/)
	})

	it("refuses a genuine factory built on a registry the Aztec node does not run, whose rollup reports a foreign Outbox", async () => {
		// The hostile registry resolves to the same rollup, so every pointer agrees with it: only the node anchors it.
		const w = worldOf(testnet())
		if (w.m.bridge) w.m.bridge.l1.registry = ATTACKER
		w.reads.set(`${ATTACKER}:getCanonicalRollup`, ROLLUP)
		await refusedWith(w, "invalid-network", /registry .* is not the Aztec node's/)
		// The registry the node runs, but an implementation that froze another Outbox.
		const outbox = worldOf(testnet())
		outbox.reads.set(`${outbox.m.bridge?.l1.implementation.toLowerCase()}:OUTBOX`, ATTACKER)
		await refusedWith(outbox, "invalid-network", /implementation.OUTBOX/)
	})

	it("refuses a router whose code is not this release's build, and a node on another rollup", async () => {
		const code = worldOf(testnet())
		code.code.set(router(code).toLowerCase(), new Uint8Array(10))
		await refusedWith(code, "invalid-network", /DepositRouter runtime/)
		const node = worldOf(testnet())
		node.node.rollupVersion += 1
		await refusedWith(node, "wrong-aztec-network")
	})
})
