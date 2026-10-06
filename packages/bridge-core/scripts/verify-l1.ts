/**
 * The L1 half of a generation, verified against the manifest that claims it — the gate an operator
 * runs before promoting a candidate.
 *
 *   bun packages/bridge-core/scripts/verify-l1.ts [--config <manifest path>] [--strict]
 *
 * Four passes, each read straight off the chain:
 *  - the generation: code at every `bridge.l1` address, and the factory/implementation/router
 *    cross-bindings (implementation, hub, guardian, rollup inbox+outbox+version, Permit2, fee asset,
 *    swap target, the router's Permit2 witness shape, and the swap target's own pool manager, fee
 *    asset and WETH); with the DepositRouter fields, that router's immutables and owner and the fuel
 *    swapper's bindings, a rate for every token and its inventory (a low one is a warning);
 *  - each token: its portal is the factory's CREATE2, the frozen registration matches the manifest's
 *    words, and the live ERC-20 still sanitizes to exactly those words at exactly that `decimals()`;
 *  - with `routing`, LI.FI's address book on the manifest's L1 and every source chain: code at each
 *    entry and the pinned runtime code hashes (a facet moved behind the Diamond is a warning);
 *  - the deployed runtime code of the implementation, factory, routers and swap targets against this
 *    checkout's forge build, with each artifact's immutable slots (per-deployment values) and metadata
 *    trailer (per-checkout paths) masked out, so it passes from any checkout of the deployed sources.
 *
 * `--strict` is the promotion gate: the artifacts are rebuilt from source into a fresh directory first
 * (never over a shared `out/` a running sandbox deploys from), and every input a pass cannot obtain is
 * a FAILURE rather than a noted skip — a stale or planted `out/` would otherwise bless whatever runtime
 * it was written to match. Without it (the default) the code-hash pass reuses whatever build is on disk
 * and skips when there is none.
 *
 * Needs an L1 RPC in SEPOLIA_RPC_URL or ETH_RPC_URL (bun auto-loads packages/bridge-core/.env), a read
 * RPC per routing source (BASE_SEPOLIA_RPC_URL defaults to PublicNode), and foundry for the code-hash
 * pass, plus a `remappings.txt` from `gen-remappings.ts` whenever that pass builds (always under
 * `--strict`, otherwise only without an `out/`). Exits non-zero if any check FAILs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, type Hex, hexToBytes, keccak256, type PublicClient } from "viem"
import { DEPOSIT_ROUTER_ABI } from "../src/deposit-router-abi"
import { readErc20Metadata } from "../src/erc20"
import { PORTAL_FACTORY_ABI } from "../src/factory-abi"
import { readRegistration } from "../src/factory-registry"
import { DEPOSIT_WITNESS_TYPE_STRING } from "../src/l1"
import { FUEL_SWAP_SELECTORS } from "../src/lifi-abi"
import { LIFI_BOOK, type LifiChainBook, type LifiCodeHashes } from "../src/lifi-addresses"
import type { BridgeBlock, ManifestToken, ManifestV2 } from "../src/manifest-v2"
import { toWord } from "../src/register-hash"
import { SWAP_BRIDGE_ROUTER_ABI } from "../src/router-abi"
import { resolveBin, run } from "./run"
import { createL1PublicClient, loadManifestV2FromConfigArg, requireBridge } from "./script-bootstrap"
import {
	assertFactoryPortal,
	assertRouterWitnessShape,
	ERC20_MIN_ABI,
	FACTORY_CONSTANTS_ABI,
	FUEL_SWAPPER_ABI,
	manifestL1Chain,
	PORTAL_IMPL_CONSTANTS_ABI,
	ROUTER_CONSTANTS_ABI,
	sourceRpcUrl,
	swapperInventoryFloor,
} from "./script-l1"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..")
const EVM_ROOT = join(repoRoot, "contracts", "bridge", "evm")

/** The deterministic Multicall3 deployment, live at the same address on every chain we bridge from;
 *  a manifest that names its own (the swap block does) wins over it. */
const CANONICAL_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"

/** The registry's canonical rollup, and the values the factory and the implementation each froze
 *  from it at construction. */
const REGISTRY_MIN_ABI = [
	{ type: "function", name: "getCanonicalRollup", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const
const ROLLUP_MIN_ABI = [
	{ type: "function", name: "getInbox", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "getOutbox", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "getVersion", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const

/** The three pointers UniswapFuelSwap froze at construction. */
const SWAP_TARGET_ABI = [
	{ type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "feeJuice", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "weth", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const

const DIAMOND_LOUPE_ABI = [
	{ type: "function", name: "facetAddress", stateMutability: "view", inputs: [{ type: "bytes4" }], outputs: [{ type: "address" }] },
] as const

/** The local sandbox's chain: its legacy router swaps through the harness's fixed-rate mock, never UniswapFuelSwap. */
const SANDBOX_CHAIN_ID = 31337
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

let failures = 0
let warnings = 0

const ok = (label: string) => console.log(`✓ ${label}`)
const skip = (label: string, why: string) => console.log(`— ${label}: ${why}`)

function fail(label: string, detail: string): void {
	failures++
	console.error(`✗ ${label}: ${detail}`)
}

/** Worth an operator's look, never a reason to refuse: the next check that depends on it is still exact. */
function warn(label: string, detail: string): void {
	warnings++
	console.warn(`! ${label}: ${detail}`)
}

function same(label: string, actual: unknown, expected: unknown, expectedSource = "manifest"): void {
	const got = String(actual).toLowerCase()
	const want = String(expected).toLowerCase()
	if (got === want) ok(`${label} = ${want}`)
	else fail(label, `on-chain ${got} != ${expectedSource} ${want}`)
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

interface RollupBinding {
	inbox: Address
	outbox: Address
	version: bigint
}

/** What the manifest's registry resolves to right now — the only source the frozen L1 pointers are
 *  allowed to have come from. Each caller reads it for itself so one bad read fails one check. */
async function readRollupBinding(pub: PublicClient, registry: Address): Promise<RollupBinding> {
	const rollup = await pub.readContract({ address: registry, abi: REGISTRY_MIN_ABI, functionName: "getCanonicalRollup" })
	const [inbox, outbox, version] = await Promise.all([
		pub.readContract({ address: rollup, abi: ROLLUP_MIN_ABI, functionName: "getInbox" }),
		pub.readContract({ address: rollup, abi: ROLLUP_MIN_ABI, functionName: "getOutbox" }),
		pub.readContract({ address: rollup, abi: ROLLUP_MIN_ABI, functionName: "getVersion" }),
	])
	return { inbox, outbox, version }
}

/** The factory exposes no registry getter: the inbox and rollup version its constructor froze are
 *  the observable half, so the manifest's registry must still resolve to a rollup producing both. */
async function checkRegistryBinding(pub: PublicClient, b: BridgeBlock): Promise<void> {
	const factory = b.l1.factory as Address
	const [rollup, frozenInbox, frozenVersion] = await Promise.all([
		readRollupBinding(pub, b.l1.registry as Address),
		pub.readContract({ address: factory, abi: FACTORY_CONSTANTS_ABI, functionName: "INBOX" }),
		pub.readContract({ address: factory, abi: FACTORY_CONSTANTS_ABI, functionName: "ROLLUP_VERSION" }),
	])
	same("factory.INBOX", frozenInbox, rollup.inbox, "registry→rollup.getInbox()")
	same("factory.ROLLUP_VERSION", frozenVersion, rollup.version, "registry→rollup.getVersion()")
}

/** The implementation froze its own copy of every pointer a clone delegates into, and a clone has no
 *  storage to repoint: an implementation bound elsewhere is every token's portal bound elsewhere. */
async function checkPortalImpl(pub: PublicClient, b: BridgeBlock): Promise<void> {
	const address = b.l1.implementation as Address
	const abi = PORTAL_IMPL_CONSTANTS_ABI
	const [rollup, factory, inbox, outbox, version, hub] = await Promise.all([
		readRollupBinding(pub, b.l1.registry as Address),
		pub.readContract({ address, abi, functionName: "FACTORY" }),
		pub.readContract({ address, abi, functionName: "INBOX" }),
		pub.readContract({ address, abi, functionName: "OUTBOX" }),
		pub.readContract({ address, abi, functionName: "ROLLUP_VERSION" }),
		pub.readContract({ address, abi, functionName: "L2_HUB" }),
	])
	same("implementation.FACTORY", factory, b.l1.factory)
	same("implementation.L2_HUB", hub, b.l2.hub.address)
	same("implementation.INBOX", inbox, rollup.inbox, "registry→rollup.getInbox()")
	same("implementation.OUTBOX", outbox, rollup.outbox, "registry→rollup.getOutbox()")
	same("implementation.ROLLUP_VERSION", version, rollup.version, "registry→rollup.getVersion()")
}

async function checkFactory(pub: PublicClient, b: BridgeBlock): Promise<void> {
	const factory = b.l1.factory as Address
	const [implementation, hub, owner] = await Promise.all([
		pub.readContract({ address: factory, abi: PORTAL_FACTORY_ABI, functionName: "IMPLEMENTATION" }),
		pub.readContract({ address: factory, abi: PORTAL_FACTORY_ABI, functionName: "L2_HUB" }),
		pub.readContract({ address: factory, abi: FACTORY_CONSTANTS_ABI, functionName: "owner" }),
	])
	same("factory.IMPLEMENTATION", implementation, b.l1.implementation)
	same("factory.L2_HUB", hub, b.l2.hub.address)
	same("factory.owner (the guardian)", owner, b.l1.guardian)
	await guarded("factory rollup binding", () => checkRegistryBinding(pub, b))
}

async function checkRouter(pub: PublicClient, m: ManifestV2, b: BridgeBlock): Promise<void> {
	const router = b.l1.router as Address
	const [factory, feeJuicePortal, feeAsset, permit2] = await Promise.all([
		pub.readContract({ address: router, abi: SWAP_BRIDGE_ROUTER_ABI, functionName: "FACTORY" }),
		pub.readContract({ address: router, abi: SWAP_BRIDGE_ROUTER_ABI, functionName: "feeJuicePortal" }),
		pub.readContract({ address: router, abi: SWAP_BRIDGE_ROUTER_ABI, functionName: "FEE_ASSET" }),
		pub.readContract({ address: router, abi: ROUTER_CONSTANTS_ABI, functionName: "permit2" }),
	])
	same("router.FACTORY", factory, b.l1.factory)
	same("router.feeJuicePortal", feeJuicePortal, b.l1.feeJuicePortal)
	same("router.FEE_ASSET", feeAsset, m.feeJuice.asset)
	same("router.permit2", permit2, b.l1.permit2)
	await guarded("router witness shape", () => assertRouterWitnessShape(pub, router, b.l1.swapTarget))
}

/** The contract the legacy router's swap target must be on this chain. */
function legacySwapTargetContract(l1ChainId: number): "MockSwapTarget" | "UniswapFuelSwap" {
	return l1ChainId === SANDBOX_CHAIN_ID ? "MockSwapTarget" : "UniswapFuelSwap"
}

/** The router hands the swap target the user's tokens, so a target bound to another pool manager or
 *  paying out another asset is a different contract however familiar its code looks. A manifest
 *  without a swap block leaves nothing to compare: strict verification refuses that, or dropping the
 *  block would skip every check here. The sandbox's mock binds only its payout asset. */
async function checkSwapTarget(pub: PublicClient, m: ManifestV2, b: BridgeBlock, strict: boolean): Promise<void> {
	const swap = b.l1.swap
	if (!swap) {
		unavailable(strict, "swapTarget bindings", "the manifest carries no swap block")
		return
	}
	const address = b.l1.swapTarget as Address
	const feeJuice = await pub.readContract({ address, abi: SWAP_TARGET_ABI, functionName: "feeJuice" })
	// The router pays the portal in `feeJuice.asset`: a target paying out anything else strands the swap.
	same("swapTarget.feeJuice against feeJuice.asset", feeJuice, m.feeJuice.asset)
	if (legacySwapTargetContract(m.l1ChainId) === "MockSwapTarget") return
	const [poolManager, weth] = await Promise.all([
		pub.readContract({ address, abi: SWAP_TARGET_ABI, functionName: "poolManager" }),
		pub.readContract({ address, abi: SWAP_TARGET_ABI, functionName: "weth" }),
	])
	same("swapTarget.poolManager", poolManager, swap.poolManager)
	same("swapTarget.feeJuice", feeJuice, swap.feeJuice)
	same("swapTarget.weth", weth, swap.weth)
}

/** The DepositRouter's swap target: the manifest's fuel swapper off mainnet, LI.FI's Diamond on it. */
function depositRouterSwapTarget(m: ManifestV2, b: BridgeBlock): string | undefined {
	return b.l1.fuelSwapper ?? (m.l1ChainId === 1 ? LIFI_BOOK[1]?.diamond : undefined)
}

/** Every DepositRouter immutable is fixed for the router's life; its owner can only `sweep`, and must be the guardian. */
async function checkDepositRouter(pub: PublicClient, m: ManifestV2, b: BridgeBlock, router: Address): Promise<void> {
	const read = (functionName: "PERMIT2" | "FEE_JUICE_PORTAL" | "FACTORY" | "FEE_ASSET" | "SWAP_TARGET" | "DEPOSIT_WITNESS_TYPE_STRING") =>
		pub.readContract({ address: router, abi: DEPOSIT_ROUTER_ABI, functionName })
	const [permit2, feeJuicePortal, factory, feeAsset, swapTarget, witness, owner] = await Promise.all([
		read("PERMIT2"),
		read("FEE_JUICE_PORTAL"),
		read("FACTORY"),
		read("FEE_ASSET"),
		read("SWAP_TARGET"),
		read("DEPOSIT_WITNESS_TYPE_STRING"),
		pub.readContract({ address: router, abi: ROUTER_CONSTANTS_ABI, functionName: "owner" }),
	])
	same("depositRouter.SWAP_TARGET", swapTarget, depositRouterSwapTarget(m, b) ?? "(no fuel swapper and no Diamond for this chain)")
	same("depositRouter.FACTORY", factory, b.l1.factory)
	same("depositRouter.PERMIT2", permit2, b.l1.permit2)
	same("depositRouter.FEE_JUICE_PORTAL", feeJuicePortal, b.l1.feeJuicePortal)
	same("depositRouter.FEE_ASSET", feeAsset, m.feeJuice.asset)
	same("depositRouter.owner (the guardian)", owner, b.l1.guardian)
	// The app signs this exact string, case included; a router hashing another one rejects every Permit2 signature.
	if (witness === DEPOSIT_WITNESS_TYPE_STRING) ok(`depositRouter.DEPOSIT_WITNESS_TYPE_STRING = ${witness}`)
	else fail("depositRouter.DEPOSIT_WITNESS_TYPE_STRING", `on-chain ${witness} != client ${DEPOSIT_WITNESS_TYPE_STRING}`)
}

/** The swapper pays the router's fuel at owner-set rates: it must pay the manifest's fee asset, belong to the
 *  guardian, price every manifest token, and hold inventory (a shortfall only costs the next swap a faucet call). */
async function checkFuelSwapper(pub: PublicClient, m: ManifestV2, b: BridgeBlock, swapper: Address): Promise<void> {
	// Its chain-1 refusal lives in the constructor alone, so the deployed code cannot show it; the chain can.
	if (m.l1ChainId === 1) fail("fuelSwapper", "the testnet fuel swapper is refused on Ethereum mainnet")
	const read = (functionName: "FEE_ASSET" | "FEE_ASSET_HANDLER" | "owner") =>
		pub.readContract({ address: swapper, abi: FUEL_SWAPPER_ABI, functionName })
	const [feeAsset, handler, owner] = await Promise.all([read("FEE_ASSET"), read("FEE_ASSET_HANDLER"), read("owner")])
	same("fuelSwapper.FEE_ASSET", feeAsset, m.feeJuice.asset)
	same("fuelSwapper.FEE_ASSET_HANDLER", handler, m.feeJuice.feeAssetHandler ?? ZERO_ADDRESS)
	same("fuelSwapper.owner (the guardian)", owner, b.l1.guardian)
	for (const t of b.tokens) {
		const rate = await pub.readContract({ address: swapper, abi: FUEL_SWAPPER_ABI, functionName: "rate", args: [t.erc20 as Address] })
		if (rate > 0n) ok(`fuelSwapper.rate(${t.displaySymbol}) = ${rate}`)
		else fail(`fuelSwapper.rate(${t.displaySymbol})`, `no rate for ${t.erc20}: a fueled send of it reverts`)
	}
	if (!b.l1.fuel) return
	const floor = swapperInventoryFloor(b.l1.fuel.minFuelFj)
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
	const deployed: Array<[string, string | undefined]> = [
		["factory", b.l1.factory],
		["implementation", b.l1.implementation],
		["router", b.l1.router],
		["permit2", b.l1.permit2],
		["swapTarget", b.l1.swapTarget],
		["feeJuicePortal", b.l1.feeJuicePortal],
		["depositRouter", b.l1.depositRouter],
		["fuelSwapper", b.l1.fuelSwapper],
	]
	for (const [label, address] of deployed) {
		if (address) await guarded(`code at ${label}`, () => checkCode(pub, label, address as Address))
	}
	await guarded("factory bindings", () => checkFactory(pub, b))
	await guarded("implementation bindings", () => checkPortalImpl(pub, b))
	await guarded("router bindings", () => checkRouter(pub, m, b))
	await guarded("swapTarget bindings", () => checkSwapTarget(pub, m, b, strict))
	const { depositRouter, fuelSwapper } = b.l1
	if (depositRouter) await guarded("depositRouter bindings", () => checkDepositRouter(pub, m, b, depositRouter as Address))
	if (fuelSwapper) await guarded("fuelSwapper bindings", () => checkFuelSwapper(pub, m, b, fuelSwapper as Address))
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

/** The manifest's L1 and each routing source, the chains a LI.FI route spans. A manifest that routes nothing has no
 *  book to check. */
async function checkLifiBook(
	pub: PublicClient,
	m: ManifestV2,
	b: BridgeBlock,
	strict: boolean,
	rpcFor: (chainId: number) => string | undefined,
): Promise<void> {
	if (!b.routing) {
		skip("LI.FI address book", "the manifest routes nothing")
		return
	}
	for (const chainId of [m.l1ChainId, ...b.routing.sources.map((s) => s.chainId)]) {
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

export interface ImmutableSpan {
	start: number
	length: number
}
interface ForgeArtifact {
	deployedBytecode?: { object?: Hex; immutableReferences?: Record<string, ImmutableSpan[]> }
}

interface CodeTarget {
	contract: string
	address: string | undefined
	/** Why the target cannot be compared, when the manifest does not say what contract it is. */
	unknown?: string
}

/** Each deployed contract the manifest names and the forge artifact its runtime must equal. */
function codeTargets(m: ManifestV2, b: BridgeBlock): CodeTarget[] {
	const targets: CodeTarget[] = [
		{ contract: "TokenPortalImpl", address: b.l1.implementation },
		{ contract: "PortalFactory", address: b.l1.factory },
		{ contract: "SwapBridgeRouter", address: b.l1.router },
		// Only a manifest with a swap block claims what its legacy target is.
		{
			contract: legacySwapTargetContract(m.l1ChainId),
			address: b.l1.swapTarget,
			...(b.l1.swap ? {} : { unknown: "the manifest carries no swap block" }),
		},
	]
	if (b.l1.depositRouter) targets.push({ contract: "DepositRouter", address: b.l1.depositRouter })
	if (b.l1.fuelSwapper) targets.push({ contract: "TestnetFuelSwapper", address: b.l1.fuelSwapper })
	return targets
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

/** Immutables are written into the runtime code at deploy time, so the deployed bytes never equal
 *  the artifact's; zeroing the spans the compiler recorded leaves exactly the compiled logic. */
function maskImmutables(code: Uint8Array, refs: Record<string, ImmutableSpan[]>): Uint8Array {
	const masked = Uint8Array.from(code)
	for (const spans of Object.values(refs)) for (const s of spans) masked.fill(0, s.start, s.start + s.length)
	return masked
}

/** solc ends the runtime with a CBOR metadata map and its 2-byte big-endian length. The map hashes the
 *  compiler input, remapped absolute paths included, so it differs per checkout; execution never
 *  reaches it. A sanity check on trusted compiler output, not a parser: a declared length that leaves
 *  no code before it or does not land on a CBOR map header throws. */
function metadataTrailerSize(code: Uint8Array): number {
	const n = code.length
	const cborLength = n >= 2 ? ((code[n - 2] ?? 0) << 8) | (code[n - 1] ?? 0) : 0
	const size = cborLength + 2
	// Major type 5 (a map) is the top three bits 101.
	if (cborLength === 0 || size >= n || ((code[n - size] ?? 0) & 0xe0) !== 0xa0) {
		throw new Error(`the build's metadata trailer is malformed (declared length ${cborLength} in ${n} bytes)`)
	}
	return size
}

/**
 * The deployed and built runtimes, each hashed with the build's immutable spans and metadata trailer
 * zeroed. Both masks come from the build alone, and equal lengths are required, so every byte before
 * the trailer, immutables aside, must match exactly. Throws on a length mismatch or a malformed build
 * trailer.
 */
export function maskedRuntimeHashes(
	onChain: Uint8Array,
	built: Uint8Array,
	refs: Record<string, ImmutableSpan[]>,
): { onChain: Hex; built: Hex } {
	if (onChain.length !== built.length) throw new Error(`length ${onChain.length} != build ${built.length}`)
	const trailerStart = built.length - metadataTrailerSize(built)
	const hash = (code: Uint8Array) => keccak256(maskImmutables(code, refs).fill(0, trailerStart))
	return { onChain: hash(onChain), built: hash(built) }
}

async function checkCodeHash(pub: PublicClient, out: string, contract: string, address: Address, strict: boolean): Promise<void> {
	const label = `${contract} runtime code`
	const artifactPath = join(out, `${contract}.sol`, `${contract}.json`)
	if (!existsSync(artifactPath)) {
		unavailable(strict, label, `the build has no ${contract}.sol/${contract}.json`)
		return
	}
	const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as ForgeArtifact
	const object = artifact.deployedBytecode?.object
	if (!object) {
		unavailable(strict, label, "the artifact carries no deployedBytecode")
		return
	}
	const built = hexToBytes(object)
	const onChain = hexToBytes(((await pub.getCode({ address })) ?? "0x") as Hex)
	const refs = artifact.deployedBytecode?.immutableReferences
	if (!refs) {
		// A length match over unmasked bytes proves nothing about the logic between the immutables.
		if (strict) fail(label, "the artifact records no immutableReferences — the masked comparison cannot run")
		else if (onChain.length === built.length) ok(`${label} length ${built.length} — immutables-masked comparison unavailable`)
		else fail(label, `length ${onChain.length} != build ${built.length}; immutables-masked comparison unavailable`)
		return
	}
	const hashes = maskedRuntimeHashes(onChain, built, refs)
	same(`${label} hash (immutables and metadata masked)`, hashes.onChain, hashes.built, "build")
}

async function checkCodeHashes(pub: PublicClient, m: ManifestV2, b: BridgeBlock, strict: boolean): Promise<void> {
	const build = forgeBuild(strict)
	if (!("out" in build)) {
		unavailable(strict, "runtime code hashes", `no usable forge build of contracts/bridge/evm: ${build.why}`)
		return
	}
	try {
		for (const t of codeTargets(m, b)) {
			const label = `${t.contract} runtime code`
			if (t.unknown) unavailable(strict, label, t.unknown)
			else await guarded(label, () => checkCodeHash(pub, build.out, t.contract, t.address as Address, strict))
		}
	} finally {
		build.dispose()
	}
}

export interface VerifyL1Options {
	/** The promotion gate: rebuild the artifacts, fail on any input a check cannot obtain. */
	strict?: boolean
	/** A routing source's read RPC; defaults to its env override, then the source catalogue's keyless provider. */
	sourceRpcUrl?: (chainId: number) => string | undefined
}

/**
 * Every L1 check over a manifest — the generation's bindings, each token, LI.FI's address book where the
 * manifest routes, the code hashes. Returns the failure count; warnings never count. `strict` fails on any
 * input a check cannot obtain, a missing swap block included.
 */
export async function verifyL1Manifest(manifest: ManifestV2, rpcUrl: string, options: VerifyL1Options = {}): Promise<number> {
	const bridge = requireBridge(manifest)
	const pub = createL1PublicClient({
		chain: manifestL1Chain(manifest, rpcUrl, bridge.l1.swap?.multicall3 ?? CANONICAL_MULTICALL3),
		rpcUrl,
	})
	const strict = options.strict === true
	failures = 0
	warnings = 0
	console.log(
		`verifying ${manifest.network} (l1ChainId ${manifest.l1ChainId}) — ${bridge.tokens.length} token(s)${strict ? ", strict" : ""}\n`,
	)
	await guarded("L1 chain id", () => checkChainId(pub, "L1 RPC", manifest.l1ChainId))
	await checkGeneration(pub, manifest, bridge, strict)
	for (const token of bridge.tokens) await checkToken(pub, bridge, token)
	await checkLifiBook(pub, manifest, bridge, strict, options.sourceRpcUrl ?? ((chainId) => sourceRpcUrl(chainId)))
	await checkCodeHashes(pub, manifest, bridge, strict)
	const warned = warnings > 0 ? ` (${warnings} warning(s) to review)` : ""
	console.log(failures === 0 ? `\n✓ L1 verification passed${warned}` : `\n✗ ${failures} check(s) FAILED${warned}`)
	return failures
}

async function main(): Promise<number> {
	const manifest = loadManifestV2FromConfigArg(process.argv, {
		mode: "fallback",
		fallbackPath: join(repoRoot, "apps", "tools", "public", "testnet-bridge.json"),
	})
	const rpcUrl = process.env.SEPOLIA_RPC_URL ?? process.env.ETH_RPC_URL
	if (!rpcUrl) {
		console.error("SEPOLIA_RPC_URL (or ETH_RPC_URL) is not set — add it to packages/bridge-core/.env.")
		return 1
	}
	return (await verifyL1Manifest(manifest, rpcUrl, { strict: process.argv.includes("--strict") })) === 0 ? 0 : 1
}

if (import.meta.main) {
	try {
		process.exit(await main())
	} catch (e) {
		console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
		process.exit(1)
	}
}
