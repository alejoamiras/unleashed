import { inspect } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { requireDrpcNodeUrl } from "../src/drpc-node"
import { assertL1Pins, assertNoSourceDrift, authenticatedNode, type NodeIdentity } from "./live-intent"

const pinned = {
	rollup: "0x8c2fb2a68a3d362ab1de99e06f83f8903160bbd9",
	feeJuicePortal: "0x5bb7523a95c1fdf1d2a3dd9fb7d497e7f5142d7f",
	feeJuice: "0x762c132040fda6183066fa3b14d985ee55aa3c18",
	feeAssetHandler: "0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9",
	registry: "0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba",
}
const node = (registryAddress: string): NodeIdentity => ({
	nodeVersion: "6.0.0-rc.1",
	l1ChainId: 11155111,
	rollupVersion: 2914217885,
	l1ContractAddresses: {
		rollupAddress: "0x8C2FB2A68A3D362AB1DE99E06F83F8903160BBD9",
		feeJuicePortalAddress: pinned.feeJuicePortal,
		feeJuiceAddress: pinned.feeJuice,
		feeAssetHandlerAddress: pinned.feeAssetHandler,
		registryAddress,
	},
})

describe("assertL1Pins", () => {
	it("accepts a node whose five L1 addresses equal the pins, case aside", () => {
		expect(() => assertL1Pins(node(pinned.registry), pinned, "intent")).not.toThrow()
	})

	it("refuses a node that substitutes only the registry", () => {
		expect(() => assertL1Pins(node(`0x${"ab".repeat(20)}`), pinned, "intent")).toThrow(/registry .* != intent/)
	})
})

describe("assertNoSourceDrift", () => {
	const source = (commit: string) => ({ source: { commit, treeClean: true, operationalAllowlist: [] } })

	it("refuses an intent that records no build commit, or a malformed one", () => {
		expect(() => assertNoSourceDrift(source(""))).toThrow(/source\.commit is empty/)
		expect(() => assertNoSourceDrift({} as never)).toThrow(/source\.commit is empty/)
		expect(() => assertNoSourceDrift(source("HEAD"))).toThrow(/not a 40-hex commit/)
	})
})

describe("a failing node call", () => {
	const sentinel = "sentinel_Key-0123456789"
	const url = requireDrpcNodeUrl("testnet", { DRPC_API_KEY: sentinel })
	afterEach(() => vi.unstubAllGlobals())

	const failures: Record<string, () => Promise<Response>> = {
		"a rejected fetch": () =>
			Promise.reject(Object.assign(new TypeError(`fetch failed: ${url}`), { code: "ConnectionRefused", path: url })),
		"an HTTP error": async () => new Response("", { status: 503 }),
		"a JSON-RPC error": async () => Response.json({ jsonrpc: "2.0", id: 1, error: { message: "upstream unavailable" } }),
		"a JSON-RPC error echoing the URL and the key": async () =>
			Response.json({ jsonrpc: "2.0", id: 1, error: { message: `no route for ${url} (key ${sentinel})` } }),
		"a body read that rejects": async () =>
			new Response(
				new ReadableStream({ start: (c) => c.error(Object.assign(new TypeError(`body read failed: ${url}`), { path: url })) }),
			),
	}

	// `inspect` renders what a crash prints: message, stack, own properties and cause. Booleans only,
	// so a failure never prints the key either.
	it.each(Object.entries(failures))("never puts the node URL or its key in the error: %s", async (_, failure) => {
		vi.stubGlobal("fetch", vi.fn(failure))
		const err = await authenticatedNode(url).then(
			() => undefined,
			(e: unknown) => e,
		)
		expect(err instanceof Error).toBe(true)
		const printed = inspect(err)
		expect(printed.includes(url) || printed.includes(sentinel)).toBe(false)
	})
})
