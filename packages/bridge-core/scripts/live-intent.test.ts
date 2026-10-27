import { inspect } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TESTNET_FILLER } from "../src/across-self-built"
import { requireDrpcNodeUrl } from "../src/drpc-node"
import type { ManifestToken, ManifestV2 } from "../src/manifest-v2"
import type { DeployStep } from "./deploy-manifest"
import { preLifiTestnetManifest } from "./lifi-canary-fixture"
import {
	assertL1Pins,
	assertNoSourceDrift,
	assertRouterOnlyJournal,
	assertRouterOnlyScope,
	authenticatedNode,
	isAllowlistedPath,
	type NodeIdentity,
	PLAN_PINNED_CANARY_SIGNERS,
	PLAN_PINNED_L1_SIGNERS,
	requirePinnedCanarySigner,
	routerOnlyScopeOf,
} from "./live-intent"

const pinned = {
	rollup: "0x1f435a7f2da358caf887a470faeee7d5d5f4efba",
	feeJuicePortal: "0xe59acba462a0324b1d619a7a1b219419f156f505",
	feeJuice: "0x762c132040fda6183066fa3b14d985ee55aa3c18",
	feeAssetHandler: "0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9",
	registry: "0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba",
}
const node = (registryAddress: string): NodeIdentity => ({
	nodeVersion: "6.0.0",
	l1ChainId: 11155111,
	rollupVersion: 679261766,
	l1ContractAddresses: {
		rollupAddress: "0x1F435A7F2DA358CAF887A470FAEEE7D5D5F4EFBA",
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

	it("lets an archived plan's lessons change, but never the reset baseline", () => {
		expect(isAllowlistedPath("implementations-plan/archive/lifi-routing/lessons/phase-6.md")).toBe(true)
		expect(isAllowlistedPath("implementations-plan/archive/lifi-routing/plan.md")).toBe(false)
		expect(isAllowlistedPath("implementations-plan/archive/aztec-v6/lessons/intent.json")).toBe(false)
	})
})

describe("router-only intent", () => {
	const live = preLifiTestnetManifest()
	const bridge = live.bridge
	if (!bridge) throw new Error("the pre-promotion testnet manifest carries no bridge")
	const WETH = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14"
	const scope = routerOnlyScopeOf(live, [WETH.toUpperCase().replace("0X", "0x")], 12)
	const routerOnly = { depositRouter: `0x${"d1".repeat(20)}`, fuelSwapper: `0x${"f5".repeat(20)}` }
	const weth: ManifestToken = { ...(bridge.tokens[0] as ManifestToken), erc20: WETH }
	const candidate = (l1: object = {}, tokens = [...bridge.tokens, weth]): ManifestV2 => ({
		...live,
		bridge: { ...bridge, l1: { ...bridge.l1, ...routerOnly, ...l1 }, tokens },
	})

	it("accepts a candidate that only adds the two contracts and the named tokens", () => {
		expect(() => assertRouterOnlyScope(scope, candidate())).not.toThrow()
	})

	it("refuses a moved factory or legacy router, a dropped or re-derived live token, an unnamed token, or no new router", () => {
		expect(() => assertRouterOnlyScope(scope, candidate({ factory: routerOnly.depositRouter }))).toThrow(/candidate factory/)
		expect(() => assertRouterOnlyScope(scope, candidate({ legacyRouters: [] }))).toThrow(/drops legacy router/)
		expect(() => assertRouterOnlyScope(scope, candidate({}, bridge.tokens.slice(1)))).toThrow(/live token .* missing/)
		const rederived: ManifestToken = { ...(bridge.tokens[0] as ManifestToken), l2Token: `0x${"ab".repeat(32)}` }
		expect(() => assertRouterOnlyScope(scope, candidate({}, [rederived, ...bridge.tokens.slice(1)]))).toThrow(/derives elsewhere/)
		const stranger = { ...weth, erc20: `0x${"5a".repeat(20)}` }
		expect(() => assertRouterOnlyScope(scope, candidate({}, [...bridge.tokens, stranger]))).toThrow(/did not name/)
		expect(() => assertRouterOnlyScope(scope, candidate({ depositRouter: undefined }))).toThrow(/no depositRouter/)
	})

	it("allows only the arc's own journal steps after build, and refuses a rewritten journal", () => {
		const before = Array.from({ length: 12 }, (): DeployStep => ({ kind: "candidate-written", path: "x" }))
		const tx = `0x${"ab".repeat(32)}`
		const deployed = (kind: "fuel-swapper-deployed" | "deposit-router-deployed"): DeployStep => ({
			kind,
			address: routerOnly.depositRouter,
			txHash: tx,
			creationCodeHash: tx,
			constructorArgs: [WETH],
		})
		const precreated = (erc20: string): DeployStep => ({ kind: "token-precreated", erc20, portal: WETH })
		const ok = [...before, deployed("fuel-swapper-deployed"), deployed("deposit-router-deployed"), precreated(WETH)]
		expect(() => assertRouterOnlyJournal(scope, ok)).not.toThrow()
		expect(() => assertRouterOnlyJournal(scope, [...ok, { kind: "router-deployed", router: WETH, txHash: tx }])).toThrow(/outside/)
		expect(() => assertRouterOnlyJournal(scope, [...ok, precreated(`0x${"5a".repeat(20)}`)])).toThrow(/does not name/)
		expect(() => assertRouterOnlyJournal(scope, before.slice(1))).toThrow(/rewritten/)
	})

	it("refuses every canary-signed run while the canary key is unpinned, and never pins it to a deploy signer", () => {
		expect(PLAN_PINNED_CANARY_SIGNERS.mainnet).toBeNull()
		expect(() => requirePinnedCanarySigner("mainnet")).toThrow(/no pinned canary signer/)
		expect(requirePinnedCanarySigner("testnet")).toMatch(/^0x[0-9a-fA-F]{40}$/)
		const deploySigners = Object.values(PLAN_PINNED_L1_SIGNERS).map((s) => s?.toLowerCase())
		for (const canary of Object.values(PLAN_PINNED_CANARY_SIGNERS))
			if (canary) expect(deploySigners).not.toContain(canary.toLowerCase())
	})

	it("names the pinned testnet canary as the exclusive relayer of every testnet send", () => {
		expect(TESTNET_FILLER).toBe(PLAN_PINNED_CANARY_SIGNERS.testnet)
	})
})

describe("a failing node call", () => {
	const sentinel = "sentinel_Key-0123456789"
	const url = requireDrpcNodeUrl("testnet", { DRPC_API_KEY: sentinel })
	afterEach(() => vi.unstubAllGlobals())

	// A second endpoint may carry its key as a query parameter, where no path segment isolates it.
	const queryUrl = `https://node.invalid/ogrpc?network=aztec-testnet&dkey=${sentinel}`
	const failures: Array<[label: string, nodeUrl: string, failure: () => Promise<Response>]> = [
		[
			"a rejected fetch",
			url,
			() => Promise.reject(Object.assign(new TypeError(`fetch failed: ${url}`), { code: "ConnectionRefused", path: url })),
		],
		["an HTTP error", url, async () => new Response("", { status: 503 })],
		["a JSON-RPC error", url, async () => Response.json({ jsonrpc: "2.0", id: 1, error: { message: "upstream unavailable" } })],
		[
			"a JSON-RPC error echoing the URL and the key",
			url,
			async () => Response.json({ jsonrpc: "2.0", id: 1, error: { message: `no route for ${url} (key ${sentinel})` } }),
		],
		[
			"a JSON-RPC error echoing only a query-string key",
			queryUrl,
			async () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: `unknown dkey ${sentinel}` } }),
		],
		[
			"a body read that rejects",
			url,
			async () =>
				new Response(
					new ReadableStream({ start: (c) => c.error(Object.assign(new TypeError(`body read failed: ${url}`), { path: url })) }),
				),
		],
	]

	// `inspect` renders what a crash prints: message, stack, own properties and cause. Booleans only,
	// so a failure never prints the key either.
	it.each(failures)("never puts the node URL or its key in the error: %s", async (_, nodeUrl, failure) => {
		vi.stubGlobal("fetch", vi.fn(failure))
		const err = await authenticatedNode(nodeUrl).then(
			() => undefined,
			(e: unknown) => e,
		)
		expect(err instanceof Error).toBe(true)
		const printed = inspect(err)
		expect(printed.includes(nodeUrl) || printed.includes(sentinel)).toBe(false)
	})
})
