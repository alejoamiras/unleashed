import { pad } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BridgeError } from "../src/errors.ts"
import { parseNetwork, type Reads } from "../src/network.ts"
import { TESTNET_MANIFEST } from "../src/networks.ts"
import type { ManifestV2 } from "../src/protocol/manifest-v2.ts"
import { predictPortal } from "../src/protocol/portal-address.ts"
import { ATTACKER, ROLLUP, readsOf, testnet, type World, worldOf } from "./fakes.ts"

vi.mock("../src/protocol/generation-record.ts", async (importOriginal) =>
	(await import("./fakes.ts")).withSyntheticCode(await importOriginal()),
)

/** A synthetic manifest stands in for the bundle on the chains a case sets; every other chain keeps the real one. */
const bundles = vi.hoisted(() => new Map<number, unknown>())
vi.mock("../src/networks.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/networks.ts")>()
	return { ...real, bundledManifest: (id: number) => (bundles.has(id) ? bundles.get(id) : real.bundledManifest(id)) }
})
afterEach(() => bundles.clear())

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

type Bridge = NonNullable<ManifestV2["bridge"]>

/** Another factory, with everything strict validation derives from it re-derived: the hub's salt and args, the portals. */
function withFactory(b: Bridge): void {
	b.l1.factory = ATTACKER
	b.l2.hub.constructorArgs[1] = ATTACKER
	b.l2.hub.salt = pad(ATTACKER, { size: 32 })
	for (const t of b.tokens) t.portal = predictPortal(ATTACKER, b.l1.implementation, t.erc20)
}

describe("parseNetwork's trust roots", () => {
	it("accepts the bundled testnet manifest on a chain that answers as it says", async () => {
		const w = worldOf(testnet())
		const net = await parseNetwork(w.m, readsOf(w))
		expect(net.bridge?.factory).toBe(w.m.bridge?.l1.factory)
		expect(net.fuel.fuelSwapper).toBe(w.m.bridge?.l1.fuelSwapper)
		expect(Object.isFrozen(net)).toBe(true)
	})

	it("accepts only the bundled network on a chain the bundle covers", async () => {
		const hexCase = JSON.parse(JSON.stringify(TESTNET_MANIFEST).replace(/0x[0-9a-fA-F]+/g, (h) => h.toLowerCase()))
		const reordered = Object.fromEntries(Object.entries(hexCase).reverse())
		expect((await parseNetwork(reordered, readsOf(worldOf(testnet())))).name).toBe("testnet")

		// No reads: a check that reached the chain would fail as a TypeError, not as a refusal.
		const noReads = {} as Reads
		const edits: Record<string, (b: Bridge) => void> = {
			factory: withFactory,
			router: (b) => Object.assign(b.l1, { depositRouter: ATTACKER }),
			guardian: (b) => Object.assign(b.l1, { guardian: ATTACKER }),
			budget: (b) => Object.assign(b.l1.fuel ?? {}, { fjPerTx: "1" }),
		}
		for (const [name, change] of Object.entries(edits)) {
			const m = testnet()
			if (m.bridge) change(m.bridge)
			await expect(parseNetwork(m, noReads), name).rejects.toMatchObject({
				code: "invalid-network",
				message: expect.stringMatching(/not the network this release bundles for chain 11155111/),
			})
		}
		await expect(parseNetwork({ ...testnet(), l1ChainId: 8453 }, noReads)).rejects.toMatchObject({
			code: "invalid-network",
			message: expect.stringMatching(/bundles no network for chain 8453/),
		})
		expect(() => {
			;(TESTNET_MANIFEST as { network: string }).network = "mainnet"
		}).toThrow(TypeError)
	})

	it("refuses a genuine router bound to the attacker's Permit2, portal or swap target, or a swapper paying another asset", async () => {
		for (const fn of ["PERMIT2", "FEE_JUICE_PORTAL", "SWAP_TARGET"]) {
			const w = worldOf(testnet())
			w.reads.set(`${router(w).toLowerCase()}:${fn}`, ATTACKER)
			await refusedWith(w, "invalid-network", new RegExp(`depositRouter.${fn}`))
		}
		const swapper = worldOf(testnet())
		const listed = swapper.m.bridge?.l1.fuelSwapper
		if (!listed) throw new Error("the testnet manifest lists a fuel swapper")
		swapper.reads.set(`${listed.toLowerCase()}:FEE_ASSET`, ATTACKER)
		await refusedWith(swapper, "invalid-network", /fuelSwapper.FEE_ASSET/)
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
		bundles.set(w.m.l1ChainId, w.m)
		w.reads.set(`${ATTACKER}:getCanonicalRollup`, ROLLUP)
		await refusedWith(w, "invalid-network", /registry .* is not the Aztec node's/)
		bundles.clear()
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
