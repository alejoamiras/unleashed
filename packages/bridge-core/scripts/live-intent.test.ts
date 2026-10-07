import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TESTNET_FILLER } from "../src/across-self-built"
import { type ManifestToken, type ManifestV2, parseManifestV2 } from "../src/manifest-v2"
import { assertFaucetCandidateShape, assertZeroSeed } from "../src/promotion"
import { legacyRoutersOf } from "../src/send-generation"
import { type DeployStep, writeCandidateAtomically } from "./deploy-manifest"
import { preLifiTestnetManifest } from "./lifi-canary-fixture"
import {
	assertL1Pins,
	assertNoSourceDrift,
	assertNothingJournalled,
	assertRetireRouterScope,
	assertRouterOnlyJournal,
	assertRouterOnlyScope,
	isAllowlistedPath,
	type NodeIdentity,
	PLAN_PINNED_CANARY_SIGNERS,
	PLAN_PINNED_L1_SIGNERS,
	type RetireRouterScope,
	requirePinnedCanarySigner,
	retireRouterCandidate,
	routerOnlyScopeOf,
} from "./live-intent"
import { requireBridge } from "./script-bootstrap"

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

	it("lets the lifi-routing arc's lessons change mid-arc, but never the reset baseline", () => {
		expect(isAllowlistedPath("implementations-plan/lifi-routing/lessons/phase-6.md")).toBe(true)
		expect(isAllowlistedPath("implementations-plan/lifi-routing/plan.md")).toBe(false)
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
		expect(() => assertRouterOnlyScope(scope, candidate({ router: routerOnly.depositRouter }))).toThrow(/candidate router/)
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

describe("retire-router intent", () => {
	const bytes = readFileSync(join(import.meta.dirname, "../test/fixtures/testnet-bridge.pre-arc5.json"), "utf8")
	const live = parseManifestV2(JSON.parse(bytes))
	const scope: RetireRouterScope = {
		live: { path: "apps/tools/public/testnet-bridge.json", sha256: createHash("sha256").update(bytes).digest("hex") },
		journal: { path: "packages/bridge-core/deploy-journal/testnet-generation.jsonl", steps: 3 },
	}

	it("writes the live testnet manifest back as a promotable candidate with its old router legacy and no V4 field", async () => {
		const dir = mkdtempSync(join(tmpdir(), "retire-router-"))
		writeCandidateAtomically(join(dir, "candidate.json"), retireRouterCandidate(live))
		const candidate = await assertFaucetCandidateShape(JSON.parse(readFileSync(join(dir, "candidate.json"), "utf8")))
		rmSync(dir, { recursive: true })
		expect(() => assertZeroSeed(candidate, live)).not.toThrow()
		expect(() => assertRetireRouterScope(scope, candidate, bytes)).not.toThrow()
		const { router, swapTarget, swap, ...kept } = requireBridge(live).l1
		expect(swapTarget && swap).toBeTruthy()
		expect(candidate.bridge?.l1).toEqual({ ...kept, legacyRouters: [router] })
		expect(legacyRoutersOf(requireBridge(candidate))).toEqual(legacyRoutersOf(requireBridge(live)))
		expect({ ...candidate, bridge: { ...candidate.bridge, l1: null } }).toEqual({ ...live, bridge: { ...live.bridge, l1: null } })
	})

	it("refuses any other candidate, another live manifest, a journalled deploy, and a manifest with no router to retire", () => {
		const candidate = parseManifestV2(retireRouterCandidate(live))
		const b = requireBridge(candidate)
		const moved = { ...candidate, bridge: { ...b, l1: { ...b.l1, depositRouter: `0x${"d1".repeat(20)}` } } }
		expect(() => assertRetireRouterScope(scope, moved, bytes)).toThrow(/not the live manifest with its old router retired/)
		const forgotten = { ...candidate, bridge: { ...b, l1: { ...b.l1, legacyRouters: undefined } } }
		expect(() => assertRetireRouterScope(scope, forgotten, bytes)).toThrow(/old router retired/)
		expect(() => assertRetireRouterScope(scope, candidate, `${bytes} `)).toThrow(/not the recorded/)
		expect(() => assertNothingJournalled(scope.journal, [])).toThrow(/deploys nothing/)
		expect(() => retireRouterCandidate(candidate)).toThrow(/nothing to retire/)
	})
})
