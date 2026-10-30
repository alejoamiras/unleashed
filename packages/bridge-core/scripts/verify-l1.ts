/**
 * The L1 half of a generation, verified against the manifest that claims it — the gate an operator
 * runs before promoting a candidate.
 *
 *   bun packages/bridge-core/scripts/verify-l1.ts [--config <manifest path>] [--strict]
 *
 * Four passes over a bridge, each read straight off the chain:
 *  - the generation: code at every `bridge.l1` address, the factory/implementation cross-bindings
 *    (implementation, hub, guardian, rollup inbox+outbox+version), the DepositRouter's immutables,
 *    witness type string and owner, the fuel swapper's bindings, a rate for every token and its
 *    inventory (a low one is a warning), and each legacy router's factory and owner;
 *  - each token: its portal is the factory's CREATE2, the frozen registration matches the manifest's
 *    words, and the live ERC-20 still sanitizes to exactly those words at exactly that `decimals()`;
 *  - with `routing`, LI.FI's address book on the manifest's L1 and every source chain: code at each
 *    entry and the pinned runtime code hashes (a facet moved behind the Diamond is a warning);
 *  - the deployed runtime code of the implementation, factory or gate, DepositRouter and fuel swapper,
 *    with each build's immutable slots (per-deployment values) and metadata trailer (per-checkout paths)
 *    masked out: on a live chain against the generation record the manifest binds, on a sandbox against
 *    this checkout's forge build and the SDK's pins.
 *
 * A fuel-only route (no bridge) gets its own: code at the router, the gate, Permit2 and the portal; the router's
 * immutables and owner; the gate's owner and pause; the portal paying the manifest's fee asset into the registry's
 * canonical rollup at the manifest's version; LI.FI's book on mainnet, or the swapper on the sandbox; the code hashes.
 *
 * `--strict` is the promotion gate: every input a pass cannot obtain is a FAILURE rather than a noted
 * skip. A record is then held to its kept artifacts, and each entry the live baseline does not hold (one
 * this arc deployed) to a fresh build of this checkout, compiled into a fresh directory (never over a
 * shared `out/` a running sandbox deploys from, and never trusting a stale or planted one). Without it
 * (the default) a sandbox's code-hash pass reuses whatever build is on disk and skips when there is none.
 *
 * A live manifest's record is the working tree's live or candidate record that binds it, and its baseline
 * the live record as committed at HEAD.
 *
 * Needs an L1 RPC: ETH_RPC_URL for a mainnet manifest, else SEPOLIA_RPC_URL or ETH_RPC_URL (bun auto-loads
 * packages/bridge-core/.env), a read
 * RPC per routing source (BASE_SEPOLIA_RPC_URL defaults to PublicNode), and foundry for the code-hash
 * pass, plus a `remappings.txt` from `gen-remappings.ts` whenever that pass builds (always under
 * `--strict`, otherwise only without an `out/`). Exits non-zero if any check FAILs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { FeeJuicePortalAbi } from "@aztec-foundation/l1-artifacts"
import { type Address, type Hex, hexToBytes, keccak256, type PublicClient } from "viem"
import {
	assertRecordBinds,
	assertRecordIntegrity,
	CANONICAL_PERMIT2,
	CODE_PINS,
	type CodePin,
	deployedHash,
	type ImmutableSpan,
	type PinnedContract,
	pinnedContractsOf,
	pinOfBuild,
	SANDBOX_LIFI_CHAIN_IDS,
	samePin,
	readErc20Metadata,
	FUEL_SWAP_SELECTORS,
	LIFI_BOOK,
	type LifiChainBook,
	type LifiCodeHashes,
	type BridgeBlock,
	type FuelRouteBlock,
	type ManifestToken,
	type ManifestV2,
	toWord,
	walletChainIdOf,
} from "@unleashed/sdk/protocol"
import {
	type Binding,
	type BridgeContracts,
	factoryBindings,
	implementationBindings,
	legacyRoutersOf,
	portalBindings,
	readRegistration,
	readRollupBinding,
	type RouterExpectation as RouterBindingExpectation,
	routerBindings,
	swapTargetOf,
} from "@unleashed/sdk/internal"
import { liveBaseline, liveNetworkOf, type RecordSource, recordFor } from "./generation-paths"
import { redactSecrets } from "./keyed-env"
import { runKeyed } from "./keyed-run"
import { resolveBin, run } from "./run"
import { createL1PublicClient, loadManifestV2FromConfigArg, requireRoute } from "./script-bootstrap"
import {
	assertFactoryPortal,
	ERC20_MIN_ABI,
	FACTORY_CONSTANTS_ABI,
	FUEL_GATE_ABI,
	FUEL_SWAPPER_ABI,
	manifestL1Chain,
	ROUTER_CONSTANTS_ABI,
	sourceRpcUrl,
	swapperInventoryFloor,
} from "./script-l1"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..")
const EVM_ROOT = join(repoRoot, "contracts", "bridge", "evm")

/** The deterministic Multicall3 deployment, live at the same address on every chain we bridge from. */
const CANONICAL_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"

const DIAMOND_LOUPE_ABI = [
	{ type: "function", name: "facetAddress", stateMutability: "view", inputs: [{ type: "bytes4" }], outputs: [{ type: "address" }] },
] as const

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

let failures = 0
let warnings = 0

const ok = (label: string) => console.log(`✓ ${label}`)
const skip = (label: string, why: string) => console.log(`— ${label}: ${why}`)

/** `detail` is often a caught viem error, whose text carries the RPC URL. */
function fail(label: string, detail: string): void {
	failures++
	console.error(redactSecrets(`✗ ${label}: ${detail}`))
}

/** Worth an operator's look, never a reason to refuse: the next check that depends on it is still exact. */
function warn(label: string, detail: string): void {
	warnings++
	console.warn(redactSecrets(`! ${label}: ${detail}`))
}

function same(label: string, actual: unknown, expected: unknown, expectedSource = "manifest"): void {
	const got = String(actual).toLowerCase()
	const want = String(expected).toLowerCase()
	if (got === want) ok(`${label} = ${want}`)
	else fail(label, `on-chain ${got} != ${expectedSource} ${want}`)
}

/** The SDK's own trust-root comparisons, reported line by line. They compare exactly: addresses arrive lower-cased,
 *  the witness type string as signed. */
function report(bindings: readonly Binding[]): void {
	for (const b of bindings) {
		if (b.actual === b.expected) ok(`${b.label} = ${b.expected}`)
		else fail(b.label, `on-chain ${b.actual} != ${b.source} ${b.expected}`)
	}
}

/** Every check runs; a thrown one is a FAIL of its own rather than the end of the report. */
async function guarded(label: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn()
	} catch (e) {
		fail(label, e instanceof Error ? e.message : String(e))
	}
}

async function checkCode(pub: PublicClient, label: string, address: Address): Promise<void> {
	const code = await pub.getCode({ address })
	if (code && code !== "0x") ok(`code at ${label} (${address})`)
	else fail(`code at ${label}`, `${address} has no code`)
}

/** Reads are not chain-checked by viem: an RPC for another chain would answer every check about strangers' code. */
async function checkChainId(pub: PublicClient, label: string, chainId: number): Promise<void> {
	same(`${label} chain id`, await pub.getChainId(), chainId, "expected")
}

const contractsOf = (b: BridgeBlock): BridgeContracts => ({
	factory: b.l1.factory as Address,
	implementation: b.l1.implementation as Address,
	hub: b.l2.hub.address,
})

/** The factory exposes no registry getter: the Inbox and rollup version its constructor froze must be what the
 *  manifest's registry resolves to right now. Each group reads the registry for itself, so one bad read fails one. */
async function checkFactory(pub: PublicClient, b: BridgeBlock): Promise<void> {
	const owner = await pub.readContract({ address: b.l1.factory as Address, abi: FACTORY_CONSTANTS_ABI, functionName: "owner" })
	same("factory.owner (the guardian)", owner, b.l1.guardian)
	await guarded("factory rollup binding", async () =>
		report(await factoryBindings(pub, contractsOf(b), await readRollupBinding(pub, b.l1.registry as Address))),
	)
}

/** The implementation froze its own copy of every pointer a clone delegates into, and a clone has no storage to
 *  repoint: an implementation bound elsewhere is every token's portal bound elsewhere. */
async function checkPortalImpl(pub: PublicClient, b: BridgeBlock): Promise<void> {
	report(await implementationBindings(pub, contractsOf(b), await readRollupBinding(pub, b.l1.registry as Address)))
}

/** A retired router only answers reconcile's reads, but one bound to another factory or owner is not this
 *  generation's: its events would credit deposits that never reached this generation's portals. */
async function checkLegacyRouter(pub: PublicClient, b: BridgeBlock, router: Address): Promise<void> {
	const [factory, owner] = await Promise.all([
		pub.readContract({ address: router, abi: ROUTER_CONSTANTS_ABI, functionName: "FACTORY" }),
		pub.readContract({ address: router, abi: ROUTER_CONSTANTS_ABI, functionName: "owner" }),
	])
	same(`legacy router ${router} FACTORY`, factory, b.l1.factory)
	same(`legacy router ${router} owner (the guardian)`, owner, b.l1.guardian)
}

/** What a router's immutables and owner must be: a bridge's binds its factory, a fuel route's its gate. */
interface RouterExpectation extends RouterBindingExpectation {
	guardian: string
}

const routerExpectation = (m: ManifestV2, l1: { permit2: string; guardian: string; fuelSwapper?: string }, factory: string) => ({
	factory,
	permit2: l1.permit2,
	feeJuicePortal: m.feeJuice.portal,
	feeAsset: m.feeJuice.asset,
	guardian: l1.guardian,
	swapTarget: swapTargetOf(m.l1ChainId, l1.fuelSwapper),
})

/** Every DepositRouter immutable is fixed for the router's life; its owner can only `sweep`, and must be the guardian. */
async function checkDepositRouter(pub: PublicClient, want: RouterExpectation, router: Address): Promise<void> {
	const [bindings, owner] = await Promise.all([
		routerBindings(pub, router, want),
		pub.readContract({ address: router, abi: ROUTER_CONSTANTS_ABI, functionName: "owner" }),
	])
	report(bindings)
	same("depositRouter.owner (the guardian)", owner, want.guardian)
}

/** Whose the swapper must be, which tokens it must price, and the fuel floor its inventory is measured against. */
interface SwapperExpectation {
	guardian: string
	tokens: readonly ManifestToken[]
	minFuelFj: string | undefined
}

/** The swapper pays the router's fuel at owner-set rates: it must pay the manifest's fee asset, belong to the
 *  guardian, price every manifest token, and hold inventory (a shortfall only costs the next swap a faucet call). */
async function checkFuelSwapper(pub: PublicClient, m: ManifestV2, want: SwapperExpectation, swapper: Address): Promise<void> {
	// Its chain-1 refusal lives in the constructor alone, so the deployed code cannot show it; the chain can.
	if (m.l1ChainId === 1) fail("fuelSwapper", "the testnet fuel swapper is refused on Ethereum mainnet")
	const read = (functionName: "FEE_ASSET" | "FEE_ASSET_HANDLER" | "owner") =>
		pub.readContract({ address: swapper, abi: FUEL_SWAPPER_ABI, functionName })
	const [feeAsset, handler, owner] = await Promise.all([read("FEE_ASSET"), read("FEE_ASSET_HANDLER"), read("owner")])
	same("fuelSwapper.FEE_ASSET", feeAsset, m.feeJuice.asset)
	same("fuelSwapper.FEE_ASSET_HANDLER", handler, m.feeJuice.feeAssetHandler ?? ZERO_ADDRESS)
	same("fuelSwapper.owner (the guardian)", owner, want.guardian)
	for (const t of want.tokens) {
		const rate = await pub.readContract({ address: swapper, abi: FUEL_SWAPPER_ABI, functionName: "rate", args: [t.erc20 as Address] })
		if (rate > 0n) ok(`fuelSwapper.rate(${t.displaySymbol}) = ${rate}`)
		else fail(`fuelSwapper.rate(${t.displaySymbol})`, `no rate for ${t.erc20}: a fueled send of it reverts`)
	}
	if (!want.minFuelFj) return
	const floor = swapperInventoryFloor(want.minFuelFj)
	const inventory = await pub.readContract({
		address: m.feeJuice.asset as Address,
		abi: ERC20_MIN_ABI,
		functionName: "balanceOf",
		args: [swapper],
	})
	if (inventory >= floor) ok(`fuelSwapper inventory ${inventory} ≥ floor ${floor}`)
	else warn("fuelSwapper inventory", `${inventory} < floor ${floor}: swaps mint from the faucet until it is refilled`)
}

async function checkGeneration(pub: PublicClient, m: ManifestV2, b: BridgeBlock, strict: boolean): Promise<void> {
	const legacyRouters = legacyRoutersOf(b)
	const deployed: Array<[string, string | undefined]> = [
		["factory", b.l1.factory],
		["implementation", b.l1.implementation],
		["permit2", b.l1.permit2],
		["feeJuicePortal", b.l1.feeJuicePortal],
		["depositRouter", b.l1.depositRouter],
		["fuelSwapper", b.l1.fuelSwapper],
		...legacyRouters.map((a): [string, string] => ["legacy router", a]),
	]
	for (const [label, address] of deployed) {
		if (address) await guarded(`code at ${label}`, () => checkCode(pub, label, address as Address))
	}
	await guarded("factory bindings", () => checkFactory(pub, b))
	await guarded("implementation bindings", () => checkPortalImpl(pub, b))
	const { depositRouter, fuelSwapper } = b.l1
	if (depositRouter) {
		const want = routerExpectation(m, b.l1, b.l1.factory)
		await guarded("depositRouter bindings", () => checkDepositRouter(pub, want, depositRouter as Address))
	} else {
		unavailable(strict, "depositRouter bindings", "the manifest names no depositRouter")
	}
	const swapper = { guardian: b.l1.guardian, tokens: b.tokens, minFuelFj: b.l1.fuel?.minFuelFj }
	if (fuelSwapper) await guarded("fuelSwapper bindings", () => checkFuelSwapper(pub, m, swapper, fuelSwapper as Address))
	for (const router of legacyRouters) await guarded(`legacy router ${router}`, () => checkLegacyRouter(pub, b, router))
}

/** The gate stands in the router's factory slot: its owner, the guardian, alone pauses, and no handover may be pending.
 *  A paused gate reverts every send, so a promotion gate refuses it. */
async function checkGate(pub: PublicClient, r: FuelRouteBlock, strict: boolean): Promise<void> {
	const read = (functionName: "owner" | "pendingOwner" | "depositsPaused") =>
		pub.readContract({ address: r.gate as Address, abi: FUEL_GATE_ABI, functionName })
	const [owner, pendingOwner, paused] = await Promise.all([read("owner"), read("pendingOwner"), read("depositsPaused")])
	same("gate.owner (the guardian)", owner, r.guardian)
	same("gate.pendingOwner", pendingOwner, ZERO_ADDRESS, "expected")
	const why = "every send through this route reverts until the guardian unpauses"
	if (!paused) ok("gate.depositsPaused = false")
	else if (strict) fail("gate.depositsPaused", why)
	else warn("gate.depositsPaused", why)
}

/** The router froze its portal for life, and the registry keeps older rollups whose portals still take deposits: the
 *  registry's canonical rollup must name the portal (any contract can answer the portal's own reads), and the portal
 *  must name that rollup, pay the fee asset and carry the version the wallet chain id encodes. */
async function checkRoutePortal(pub: PublicClient, m: ManifestV2, r: FuelRouteBlock): Promise<void> {
	const portal = m.feeJuice.portal as Address
	const rollup = await readRollupBinding(pub, r.registry as Address)
	const [bindings, version] = await Promise.all([
		portalBindings(pub, portal, m.feeJuice.asset, rollup),
		pub.readContract({ address: portal, abi: FeeJuicePortalAbi, functionName: "VERSION" }),
	])
	report(bindings)
	same("walletChainId from feeJuicePortal.VERSION", walletChainIdOf(m.l1ChainId, Number(version)), m.walletChainId)
}

async function checkFuelRoute(pub: PublicClient, m: ManifestV2, r: FuelRouteBlock, strict: boolean): Promise<void> {
	const deployed: Array<[string, string | undefined]> = [
		["depositRouter", r.depositRouter],
		["gate", r.gate],
		["permit2", r.permit2],
		["feeJuicePortal", m.feeJuice.portal],
		["fuelSwapper", r.fuelSwapper],
	]
	for (const [label, address] of deployed) {
		if (address) await guarded(`code at ${label}`, () => checkCode(pub, label, address as Address))
	}
	same("fuelRoute.permit2", r.permit2, CANONICAL_PERMIT2, "the canonical Permit2")
	const router = routerExpectation(m, r, r.gate)
	await guarded("depositRouter bindings", () => checkDepositRouter(pub, router, r.depositRouter as Address))
	await guarded("gate bindings", () => checkGate(pub, r, strict))
	await guarded("feeJuicePortal binding", () => checkRoutePortal(pub, m, r))
	const swapper = { guardian: r.guardian, tokens: [], minFuelFj: r.fuel.minFuelFj }
	if (r.fuelSwapper) await guarded("fuelSwapper bindings", () => checkFuelSwapper(pub, m, swapper, r.fuelSwapper as Address))
}

/** The factory's frozen record, once the portal exists. Before that there is nothing to compare —
 *  the router creates the clone on the first deposit. */
async function checkRegistration(pub: PublicClient, b: BridgeBlock, t: ManifestToken, label: string): Promise<void> {
	const code = await pub.getCode({ address: t.portal as Address })
	if (!code || code === "0x") {
		skip(`${label} registration`, "portal not created yet — the first deposit creates it")
		return
	}
	const registration = await readRegistration(pub, b.l1.factory as Address, t.erc20 as Address)
	if (!registration) throw new Error("the portal has code but the factory holds no registration for this token")
	same(`${label} registration.portal`, registration.portal, t.portal)
	same(`${label} registration.nameWord`, registration.nameWord, t.nameWord)
	same(`${label} registration.symbolWord`, registration.symbolWord, t.symbolWord)
	same(`${label} registration.decimals`, registration.decimals, t.decimals)
}

/** The live token still has to sanitize to the words the manifest carries: the hub derives the L2
 *  token address from them, so a token that renamed itself since the record was taken derives a
 *  different address than the one every claim targets. */
async function checkTokenMetadata(pub: PublicClient, t: ManifestToken, label: string): Promise<void> {
	const meta = await readErc20Metadata(pub, t.erc20 as Address)
	same(`${label} decimals()`, meta.decimals, t.decimals)
	same(`${label} nameWord`, toWord(meta.nameRaw), t.nameWord)
	same(`${label} symbolWord`, toWord(meta.symbolRaw), t.symbolWord)
}

async function checkToken(pub: PublicClient, b: BridgeBlock, t: ManifestToken): Promise<void> {
	const label = `token ${t.displaySymbol} (${t.erc20})`
	await guarded(`${label} portal`, () =>
		assertFactoryPortal(pub, b.l1.factory as Address, b.l1.implementation as Address, t.erc20 as Address, t.portal),
	)
	await guarded(`${label} registration`, () => checkRegistration(pub, b, t, label))
	await guarded(`${label} metadata`, () => checkTokenMetadata(pub, t, label))
}

/** Every book entry a route on this chain can touch, which must carry code. */
function bookEntries(book: LifiChainBook): Array<[string, string]> {
	const entries: Array<[string, string | undefined]> = [
		["diamond", book.diamond],
		["executor", book.executor],
		["receiverAcrossV4", book.receiverAcrossV4],
		["receiverStargateV2", book.receiverStargateV2],
		["feeForwarder", book.feeForwarder],
		["acrossSpokePool", book.acrossSpokePool],
		["stargate.tokenMessaging", book.stargate?.tokenMessaging],
		["layerZero.endpointV2", book.layerZero?.endpointV2],
		...(book.stargate?.pools ?? []).map((p): [string, string] => [`stargate pool ${p.assetId}`, p.pool]),
		...Object.entries(book.fuelVenues).map(([tool, venue]): [string, string] => [`fuel venue ${tool}`, venue]),
	]
	return entries.filter((e): e is [string, string] => e[1] !== undefined)
}

/** What one chain answers for the book: its id, the runtime code at every entry, and the facet behind each pinned selector. */
export interface ObservedBook {
	chainId: number
	code: Readonly<Record<string, Hex | undefined>>
	facets: Readonly<Record<string, string>>
}

export interface BookFinding {
	level: "ok" | "fail" | "warn"
	label: string
	detail: string
}

/**
 * The book's pins against one chain's answers: code at every entry, and the runtime code hashes of the immutable
 * periphery exactly. A moved fuel-swap facet only warns: it runs inside the router's call, whose floor bounds it.
 * A moved bridge facet fails: it holds the user's approved input on the source chain before any check of ours
 * runs, and the decoder reads calldata, not the code that executes it.
 */
export function judgeBook(book: LifiChainBook, seen: ObservedBook): BookFinding[] {
	const label = `LI.FI book (chain ${book.chainId})`
	const findings: BookFinding[] = []
	const push = (pass: boolean, what: string, detail: string, onMiss: "fail" | "warn" = "fail") =>
		findings.push({ level: pass ? "ok" : onMiss, label: `${label} ${what}`, detail })
	push(seen.chainId === book.chainId, "chain id", `the RPC answers chain ${seen.chainId}`)
	const codeAt = (address: string) => seen.code[address.toLowerCase()]
	for (const [name, address] of bookEntries(book)) {
		const code = codeAt(address)
		push(Boolean(code && code !== "0x"), `code at ${name}`, `${address}${code && code !== "0x" ? "" : " has no code"}`)
	}
	for (const [key, pinned] of Object.entries(book.codeHashes) as Array<[keyof LifiCodeHashes, Hex]>) {
		const hash = keccak256(codeAt(book[key] as string) ?? "0x")
		push(hash === pinned.toLowerCase(), `${key} runtime code hash`, `${hash} vs pinned ${pinned}`)
	}
	for (const [selector, facet] of Object.entries(book.facets)) {
		const live = seen.facets[selector] ?? "(none)"
		const onMiss = FUEL_SWAP_SELECTORS.includes(selector as Hex) ? "warn" : "fail"
		push(live.toLowerCase() === facet.toLowerCase(), `facet behind ${selector}`, `${live} vs pinned ${facet}: review the facet`, onMiss)
	}
	return findings
}

async function observeBook(client: PublicClient, book: LifiChainBook): Promise<ObservedBook> {
	const code: Record<string, Hex | undefined> = {}
	for (const [, address] of bookEntries(book)) code[address.toLowerCase()] = await client.getCode({ address: address as Address })
	const facets: Record<string, string> = {}
	for (const selector of Object.keys(book.facets)) {
		facets[selector] = await client.readContract({
			address: book.diamond,
			abi: DIAMOND_LOUPE_ABI,
			functionName: "facetAddress",
			args: [selector as Hex],
		})
	}
	return { chainId: await client.getChainId(), code, facets }
}

async function checkLifiChain(client: PublicClient, book: LifiChainBook): Promise<void> {
	for (const f of judgeBook(book, await observeBook(client, book))) {
		if (f.level === "ok") ok(f.label)
		else if (f.level === "warn") warn(f.label, f.detail)
		else fail(f.label, f.detail)
	}
}

/** The chains a LI.FI route spans: a bridge's L1 and each routing source, or mainnet alone for a fuel route there,
 *  whose router swaps through the Diamond. Empty for a manifest that routes nothing through LI.FI. */
function lifiChainsOf(m: ManifestV2): number[] {
	if (m.bridge?.routing) return [m.l1ChainId, ...m.bridge.routing.sources.map((s) => s.chainId)]
	return !m.bridge && m.fuelRoute && m.l1ChainId === 1 ? [1] : []
}

async function checkLifiBook(
	pub: PublicClient,
	m: ManifestV2,
	strict: boolean,
	rpcFor: (chainId: number) => string | undefined,
): Promise<void> {
	const chains = lifiChainsOf(m)
	if (chains.length === 0) {
		skip("LI.FI address book", "the manifest routes nothing")
		return
	}
	for (const chainId of chains) {
		const book = LIFI_BOOK[chainId]
		if (!book) {
			fail(`LI.FI book (chain ${chainId})`, "lifi-addresses.ts has no book for a chain this manifest routes through")
			continue
		}
		const rpcUrl = chainId === m.l1ChainId ? undefined : rpcFor(chainId)
		if (chainId !== m.l1ChainId && !rpcUrl) {
			unavailable(strict, `LI.FI book (chain ${chainId})`, "no read RPC for this source chain")
			continue
		}
		const client = rpcUrl
			? createL1PublicClient({ chain: manifestL1Chain({ network: `source-${chainId}`, l1ChainId: chainId }, rpcUrl), rpcUrl })
			: pub
		await guarded(`LI.FI book (chain ${chainId})`, () => checkLifiChain(client, book))
	}
}

interface ForgeArtifact {
	deployedBytecode?: { object?: Hex; immutableReferences?: Record<string, ImmutableSpan[]> }
}

type ForgeBuild = { out: string; dispose: () => void } | { why: string }

function forgeBinary(): string {
	return resolveBin("forge", { envVar: "FORGE_BIN", candidates: [join(homedir(), ".aztec", "current", "bin", "forge")], prefer: "path" })
}

/** The forge build the deployed code is measured against. A strict run always compiles this
 *  checkout's sources into a fresh directory: whatever `out/` happens to hold is an input nothing has
 *  verified, a stale or planted one blesses exactly the runtime it was written to match, and
 *  rebuilding it in place would pull artifacts from under a sandbox deploying from it. */
function forgeBuild(strict: boolean): ForgeBuild {
	const shared = join(EVM_ROOT, "out")
	if (!strict && existsSync(shared)) return { out: shared, dispose: () => {} }
	const dir = strict ? mkdtempSync(join(tmpdir(), "verify-l1-forge-")) : undefined
	const dispose = () => (dir ? rmSync(dir, { recursive: true, force: true }) : undefined)
	const out = dir ? join(dir, "out") : shared
	try {
		const fresh = dir ? ["--out", out, "--cache-path", join(dir, "cache"), "--skip", "test", "--skip", "script"] : []
		run(forgeBinary(), ["build", "--root", EVM_ROOT, ...fresh])
	} catch (e) {
		dispose()
		return { why: e instanceof Error ? e.message : String(e) }
	}
	if (existsSync(out)) return { out, dispose }
	dispose()
	return { why: "forge wrote no artifacts" }
}

/** A promotion gate has no unavailable inputs: what an ordinary run notes and moves past, `--strict`
 *  fails on, because a comparison that did not happen is indistinguishable from one that passed. */
function unavailable(strict: boolean, label: string, why: string): void {
	if (strict) fail(label, why)
	else skip(label, why)
}

/** The pin of `contract` in a forge build, or why there is none. */
function buildPinIn(out: string, contract: PinnedContract): CodePin | string {
	const artifactPath = join(out, `${contract}.sol`, `${contract}.json`)
	if (!existsSync(artifactPath)) return `the build has no ${contract}.sol/${contract}.json`
	const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as ForgeArtifact
	const object = artifact.deployedBytecode?.object
	if (!object) return "the artifact carries no deployedBytecode"
	// forge omits immutableReferences for a contract with none (FuelOnlyGate). An empty mask compares every
	// byte, and the build holds zeros where immutables sit, so dropped spans fail unless the deployed values are zero too.
	return pinOfBuild(hexToBytes(object), artifact.deployedBytecode?.immutableReferences)
}

async function checkDeployed(pub: PublicClient, contract: PinnedContract, address: Address, pin: CodePin, source: string): Promise<void> {
	const onChain = hexToBytes(((await pub.getCode({ address })) ?? "0x") as Hex)
	const deployed = deployedHash(onChain, pin)
	if (deployed === undefined) throw new Error(`length ${onChain.length} != ${source} ${pin.length}, or an immutable's copies disagree`)
	same(`${contract} runtime code hash (immutables and metadata masked)`, deployed, pin.hash, source)
}

/** What a manifest's code is checked against: the record it binds on a live chain, this checkout's build on a sandbox. */
export type CodeCheck = { kind: "record"; record: RecordSource; baseline?: RecordSource } | { kind: "build" }

/** Refuses a live chain given no record, and any chain that is neither live nor a sandbox: a live generation is never
 *  checked against what the current sources build. */
export function codeCheckOf(manifest: ManifestV2, options: Pick<VerifyL1Options, "record" | "baseline">): CodeCheck {
	if (options.record) return { kind: "record", record: options.record, baseline: options.baseline }
	if (liveNetworkOf(manifest.l1ChainId) || !SANDBOX_LIFI_CHAIN_IDS.includes(manifest.l1ChainId))
		throw new Error(`chain ${manifest.l1ChainId} is checked only against a generation record, and none was given — STOP`)
	return { kind: "build" }
}

/** An entry the baseline holds at the same address was proven when it was promoted, from its own build commit. */
const inBaseline = (baseline: RecordSource | undefined, contract: PinnedContract, address: string) =>
	baseline?.record.evm[contract]?.address === address.toLowerCase()

/** A fresh build's pin of `contract`, or why there is none. */
function freshPin(build: ForgeBuild | undefined, contract: PinnedContract): CodePin | string {
	if (!build) return "no fresh build was made"
	return "out" in build ? buildPinIn(build.out, contract) : `no fresh build: ${build.why}`
}

function checkFreshBuild(build: ForgeBuild | undefined, contract: PinnedContract, recorded: CodePin): void {
	const pin = freshPin(build, contract)
	if (typeof pin === "string") fail(`${contract} build`, pin)
	else if (samePin(pin, recorded)) ok(`${contract} build = ${pin.hash}`)
	else fail(`${contract} build`, `${pin.hash} is not the record's pin ${recorded.hash} (code, immutable spans or trailer)`)
}

async function checkAgainstRecord(pub: PublicClient, m: ManifestV2, check: Extract<CodeCheck, { kind: "record" }>, strict: boolean) {
	const { record, read, dir } = check.record
	await guarded("generation record", async () => {
		assertRecordBinds(record, m)
		if (strict) await assertRecordIntegrity(record, read)
		ok(`${dir} binds the manifest${strict ? ", intact and solc-shaped" : ""}`)
	})
	const arcDeployed = pinnedContractsOf(m).filter(([c, a]) => !inBaseline(check.baseline, c, a))
	const fresh = strict && arcDeployed.length > 0 ? forgeBuild(true) : undefined
	try {
		for (const [contract, address] of pinnedContractsOf(m)) {
			const entry = record.evm[contract]
			if (!entry) continue
			await guarded(`${contract} runtime code`, () => checkDeployed(pub, contract, address as Address, entry.pin, "the record"))
			if (strict && !inBaseline(check.baseline, contract, address)) checkFreshBuild(fresh, contract, entry.pin)
		}
	} finally {
		if (fresh && "out" in fresh) fresh.dispose()
	}
}

async function checkAgainstBuild(pub: PublicClient, m: ManifestV2, strict: boolean): Promise<void> {
	const build = forgeBuild(strict)
	if (!("out" in build)) {
		unavailable(strict, "runtime code hashes", `no usable forge build of contracts/bridge/evm: ${build.why}`)
		return
	}
	try {
		for (const [contract, address] of pinnedContractsOf(m)) {
			await guarded(`${contract} runtime code`, async () => {
				const pin = buildPinIn(build.out, contract)
				if (typeof pin === "string") return unavailable(strict, `${contract} runtime code`, pin)
				await checkDeployed(pub, contract, address as Address, pin, "build")
				// The SDK checks a sandbox's code against its pinned build, so the build verified here must be that one.
				same(`${contract} build`, pin.hash, CODE_PINS[contract].hash, "the SDK's code pin")
			})
		}
	} finally {
		build.dispose()
	}
}

export interface VerifyL1Options {
	/** The promotion gate: fail on any input a check cannot obtain, hold the record to its files and the entries this
	 *  arc deployed to a fresh build. */
	strict?: boolean
	/** The generation record the manifest binds; required on a live chain. */
	record?: RecordSource
	/** The live record as committed at the arc's build; its entries are not rebuilt. */
	baseline?: RecordSource
	/** A routing source's read RPC; defaults to its env override, then the source catalogue's keyless provider. */
	sourceRpcUrl?: (chainId: number) => string | undefined
}

/**
 * Every L1 check over a manifest — the generation's bindings and each token, or a fuel route's, then LI.FI's address
 * book where the manifest routes through it, then the code hashes. Returns the failure count; warnings never count.
 * `strict` fails on any input a check cannot obtain, a missing deposit router included. Throws for a placeholder, and
 * for a live chain given no record (`codeCheckOf`).
 */
export async function verifyL1Manifest(manifest: ManifestV2, rpcUrl: string, options: VerifyL1Options = {}): Promise<number> {
	const route = requireRoute(manifest)
	const codeCheck = codeCheckOf(manifest, options)
	const pub = createL1PublicClient({
		chain: manifestL1Chain(manifest, rpcUrl, CANONICAL_MULTICALL3),
		rpcUrl,
	})
	const strict = options.strict === true
	failures = 0
	warnings = 0
	const what = "bridge" in route ? `${route.bridge.tokens.length} token(s)` : "fuel-only route"
	console.log(`verifying ${manifest.network} (l1ChainId ${manifest.l1ChainId}) — ${what}${strict ? ", strict" : ""}\n`)
	await guarded("L1 chain id", () => checkChainId(pub, "L1 RPC", manifest.l1ChainId))
	if ("bridge" in route) {
		await checkGeneration(pub, manifest, route.bridge, strict)
		for (const token of route.bridge.tokens) await checkToken(pub, route.bridge, token)
	} else {
		await checkFuelRoute(pub, manifest, route.fuelRoute, strict)
	}
	await checkLifiBook(pub, manifest, strict, options.sourceRpcUrl ?? ((chainId) => sourceRpcUrl(chainId)))
	if (codeCheck.kind === "record") await checkAgainstRecord(pub, manifest, codeCheck, strict)
	else await checkAgainstBuild(pub, manifest, strict)
	const warned = warnings > 0 ? ` (${warnings} warning(s) to review)` : ""
	console.log(failures === 0 ? `\n✓ L1 verification passed${warned}` : `\n✗ ${failures} check(s) FAILED${warned}`)
	return failures
}

async function main(): Promise<number> {
	const manifest = loadManifestV2FromConfigArg(process.argv, {
		mode: "fallback",
		fallbackPath: join(repoRoot, "apps", "tools", "public", "testnet-bridge.json"),
	})
	// A mainnet keyed run carries ETH_RPC_URL alone; the chain-id check refuses an RPC for another chain either way.
	const rpcUrl = manifest.l1ChainId === 1 ? process.env.ETH_RPC_URL : (process.env.SEPOLIA_RPC_URL ?? process.env.ETH_RPC_URL)
	if (!rpcUrl) {
		console.error(
			`${manifest.l1ChainId === 1 ? "ETH_RPC_URL" : "SEPOLIA_RPC_URL (or ETH_RPC_URL)"} is not set — run it through its keyed-run template.`,
		)
		return 1
	}
	const network = liveNetworkOf(manifest.l1ChainId)
	const records = network ? { record: recordFor(manifest), baseline: liveBaseline(network, "HEAD") } : {}
	return (await verifyL1Manifest(manifest, rpcUrl, { strict: process.argv.includes("--strict"), ...records })) === 0 ? 0 : 1
}

if (import.meta.main)
	runKeyed(
		async () => process.exit(await main()),
		(e) => `✗ ${e instanceof Error ? e.message : String(e)}`,
	)
