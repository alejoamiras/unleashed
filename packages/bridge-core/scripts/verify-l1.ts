/**
 * The L1 half of a generation, verified against the manifest that claims it — the gate an operator
 * runs before promoting a candidate.
 *
 *   bun packages/bridge-core/scripts/verify-l1.ts [--config <manifest path>] [--strict]
 *
 * Three passes, each read straight off the chain:
 *  - the generation: code at every `bridge.l1` address, and the factory/implementation/router
 *    cross-bindings (implementation, hub, guardian, rollup inbox+outbox+version, Permit2, fee asset,
 *    swap target, the router's Permit2 witness shape, and the swap target's own pool manager, fee
 *    asset and WETH);
 *  - each token: its portal is the factory's CREATE2, the frozen registration matches the manifest's
 *    words, and the live ERC-20 still sanitizes to exactly those words at exactly that `decimals()`;
 *  - the deployed runtime code of the implementation, factory, router and swap target against this
 *    checkout's forge build, with each artifact's immutable slots (per-deployment values) and metadata
 *    trailer (per-checkout paths) masked out, so it passes from any checkout of the deployed sources.
 *
 * `--strict` is the promotion gate: the artifacts are rebuilt from source first, and every input the
 * code-hash pass cannot obtain is a FAILURE rather than a noted skip — a stale or planted `out/`
 * would otherwise bless whatever runtime it was written to match. Without it (the default) that pass
 * reuses whatever build is on disk and skips when there is none.
 *
 * Needs an L1 RPC in SEPOLIA_RPC_URL or ETH_RPC_URL (bun auto-loads packages/bridge-core/.env), and
 * foundry for the code-hash pass, plus a `remappings.txt` from `gen-remappings.ts` whenever that pass
 * builds (always under `--strict`, otherwise only without an `out/`). Exits non-zero if any check FAILs.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, type Hex, hexToBytes, keccak256, type PublicClient } from "viem"
import { readErc20Metadata } from "../src/erc20"
import { PORTAL_FACTORY_ABI } from "../src/factory-abi"
import { readRegistration } from "../src/factory-registry"
import type { BridgeBlock, ManifestToken, ManifestV2 } from "../src/manifest-v2"
import { toWord } from "../src/register-hash"
import { SWAP_BRIDGE_ROUTER_ABI } from "../src/router-abi"
import { resolveBin, run } from "./run"
import { createL1PublicClient, loadManifestV2FromConfigArg, requireBridge } from "./script-bootstrap"
import {
	assertFactoryPortal,
	assertRouterWitnessShape,
	FACTORY_CONSTANTS_ABI,
	manifestL1Chain,
	PORTAL_IMPL_CONSTANTS_ABI,
	ROUTER_CONSTANTS_ABI,
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

let failures = 0

const ok = (label: string) => console.log(`✓ ${label}`)
const skip = (label: string, why: string) => console.log(`— ${label}: ${why}`)

function fail(label: string, detail: string): void {
	failures++
	console.error(`✗ ${label}: ${detail}`)
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

/** The router hands the swap target the user's tokens, so a target bound to another pool manager or
 *  paying out another asset is a different contract however familiar its code looks. The sandbox
 *  manifest carries no swap block (its target is a mock), which leaves nothing to compare: strict
 *  verification refuses that, or dropping the block would skip every check here. */
async function checkSwapTarget(pub: PublicClient, m: ManifestV2, b: BridgeBlock, strict: boolean): Promise<void> {
	const swap = b.l1.swap
	if (!swap) {
		unavailable(strict, "swapTarget bindings", "the manifest carries no swap block")
		return
	}
	const address = b.l1.swapTarget as Address
	const [poolManager, feeJuice, weth] = await Promise.all([
		pub.readContract({ address, abi: SWAP_TARGET_ABI, functionName: "poolManager" }),
		pub.readContract({ address, abi: SWAP_TARGET_ABI, functionName: "feeJuice" }),
		pub.readContract({ address, abi: SWAP_TARGET_ABI, functionName: "weth" }),
	])
	same("swapTarget.poolManager", poolManager, swap.poolManager)
	same("swapTarget.feeJuice", feeJuice, swap.feeJuice)
	// The router pays the portal in `feeJuice.asset`: a target paying out anything else strands the swap.
	same("swapTarget.feeJuice against feeJuice.asset", feeJuice, m.feeJuice.asset)
	same("swapTarget.weth", weth, swap.weth)
}

async function checkGeneration(pub: PublicClient, m: ManifestV2, b: BridgeBlock, strict: boolean): Promise<void> {
	const deployed: Array<[string, string]> = [
		["factory", b.l1.factory],
		["implementation", b.l1.implementation],
		["router", b.l1.router],
		["permit2", b.l1.permit2],
		["swapTarget", b.l1.swapTarget],
		["feeJuicePortal", b.l1.feeJuicePortal],
	]
	for (const [label, address] of deployed) await guarded(`code at ${label}`, () => checkCode(pub, label, address as Address))
	await guarded("factory bindings", () => checkFactory(pub, b))
	await guarded("implementation bindings", () => checkPortalImpl(pub, b))
	await guarded("router bindings", () => checkRouter(pub, m, b))
	await guarded("swapTarget bindings", () => checkSwapTarget(pub, m, b, strict))
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

export interface ImmutableSpan {
	start: number
	length: number
}
interface ForgeArtifact {
	deployedBytecode?: { object?: Hex; immutableReferences?: Record<string, ImmutableSpan[]> }
}

const CODE_TARGETS = [
	{ key: "implementation", contract: "TokenPortalImpl" },
	{ key: "factory", contract: "PortalFactory" },
	{ key: "router", contract: "SwapBridgeRouter" },
	{ key: "swapTarget", contract: "UniswapFuelSwap" },
] as const

/** The forge build the deployed code is measured against. A strict run always rebuilds every
 *  artifact from this checkout's sources: whatever `out/` happens to hold is an input nothing has
 *  verified, and a stale or planted one blesses exactly the runtime it was written to match. */
function forgeOut(strict: boolean): { out: string } | { why: string } {
	const out = join(EVM_ROOT, "out")
	if (!strict && existsSync(out)) return { out }
	try {
		const forge = resolveBin("forge", {
			envVar: "FORGE_BIN",
			candidates: [join(homedir(), ".aztec", "current", "bin", "forge")],
			prefer: "path",
		})
		run(forge, strict ? ["build", "--force", "--root", EVM_ROOT] : ["build", "--root", EVM_ROOT])
	} catch (e) {
		return { why: e instanceof Error ? e.message : String(e) }
	}
	return existsSync(out) ? { out } : { why: "forge wrote no contracts/bridge/evm/out" }
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
		unavailable(strict, label, `no artifact at contracts/bridge/evm/out/${contract}.sol/${contract}.json`)
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

async function checkCodeHashes(pub: PublicClient, b: BridgeBlock, strict: boolean): Promise<void> {
	const build = forgeOut(strict)
	if (!("out" in build)) {
		unavailable(strict, "runtime code hashes", `no usable forge build at contracts/bridge/evm/out: ${build.why}`)
		return
	}
	const addresses = { implementation: b.l1.implementation, factory: b.l1.factory, router: b.l1.router, swapTarget: b.l1.swapTarget }
	for (const t of CODE_TARGETS) {
		// Only a manifest with a swap block claims its target is UniswapFuelSwap.
		if (t.key === "swapTarget" && !b.l1.swap) {
			unavailable(strict, `${t.contract} runtime code`, "the manifest carries no swap block")
			continue
		}
		await guarded(`${t.contract} runtime code`, () => checkCodeHash(pub, build.out, t.contract, addresses[t.key] as Address, strict))
	}
}

/**
 * Every L1 check over a manifest — the generation's bindings, each token, the code hashes. Returns
 * the failure count. `strict` is the promotion gate: rebuild the artifacts, fail on any input a
 * check cannot obtain, a missing swap block included.
 */
export async function verifyL1Manifest(manifest: ManifestV2, rpcUrl: string, options: { strict?: boolean } = {}): Promise<number> {
	const bridge = requireBridge(manifest)
	const pub = createL1PublicClient({
		chain: manifestL1Chain(manifest, rpcUrl, bridge.l1.swap?.multicall3 ?? CANONICAL_MULTICALL3),
		rpcUrl,
	})
	const strict = options.strict === true
	failures = 0
	console.log(
		`verifying ${manifest.network} (l1ChainId ${manifest.l1ChainId}) — ${bridge.tokens.length} token(s)${strict ? ", strict" : ""}\n`,
	)
	await checkGeneration(pub, manifest, bridge, strict)
	for (const token of bridge.tokens) await checkToken(pub, bridge, token)
	await checkCodeHashes(pub, bridge, strict)
	console.log(failures === 0 ? "\n✓ L1 verification passed" : `\n✗ ${failures} check(s) FAILED`)
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
