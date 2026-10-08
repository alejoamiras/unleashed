/**
 * Deployment-intent tooling for live arcs: a schema-validated `intent.json` BUILT from dual-source
 * probes before any signing, and a `verify` stage re-run before every broadcast group and at
 * promotion. Executable enforcement, not narrative discipline.
 *
 *   bun packages/bridge-core/scripts/live-intent.ts build <intent-path>
 *   bun packages/bridge-core/scripts/live-intent.ts verify <intent-path> [--candidate <path>]
 *   bun packages/bridge-core/scripts/live-intent.ts promote <intent-path> [--bridge-only]
 *
 * `build` records: node identity from the PRIMARY Aztec RPC; an INDEPENDENT L1 corroboration
 * (direct `eth_getCode` on the node-claimed rollup + FeeJuicePortal via SEPOLIA_RPC_URL); a
 * second Aztec endpoint's identity when INTENT_SECOND_AZTEC_RPC is set, else the documented
 * single-node posture; the env-derived signer CHECKED against the pinned allowlist (the constant
 * below — not the env, breaking the env-file tautology); artifact digests (canonical PrivateFPC +
 * the committed Noir targets); the git source snapshot; and the spend caps.
 *
 * `verify` re-probes identity + signer + digests and fails on ANY divergence; with `--candidate` it
 * also digest-pins the candidate manifest, strict-validates it, cross-reads the fee-juice portal's
 * UNDERLYING() + handler's FEE_ASSET(), and reads the generation's own bindings back off L1 and L2.
 */
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Address, PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { DEPOSIT_ROUTER_ABI } from "../src/deposit-router-abi"
import { PORTAL_FACTORY_ABI } from "../src/factory-abi"
import { type BridgeBlock, type ManifestV2, parseManifestV2 } from "../src/manifest-v2"
import { PRIVATE_FPC_ADDRESS, PRIVATE_FPC_SALT } from "../src/private-fuel"
import { assertFaucetCandidateShape, assertZeroSeed } from "../src/promotion"
import { SWAP_BRIDGE_ROUTER_ABI } from "../src/router-abi"
import { type DeployStep, readDeployJournal } from "./deploy-manifest"
import { git, resolveBin, run } from "./run"
import { createL1PublicClient, createNode, requireBridge } from "./script-bootstrap"
import { FACTORY_CONSTANTS_ABI, FUEL_SWAPPER_ABI, manifestL1Chain, ROUTER_CONSTANTS_ABI, sourceRpcUrl } from "./script-l1"
import { deriveHubInstance } from "./script-l2"
import { verifyL1Manifest } from "./verify-l1"
import { walletChainIdOf } from "../src/wallet-chain-id"
import { TESTNET_NODE_URL } from "../src/testnet-node"

/**
 * The only L1 signers authorized to broadcast, one per network — keys never cross networks. Pinned
 * here rather than derived from the env being checked, which would make the check a tautology. A
 * network whose signer is `null` fails closed: no script can broadcast with an unpinned key.
 */
export const PLAN_PINNED_L1_SIGNERS: Record<"testnet" | "mainnet", string | null> = {
	// Key held owner-side only.
	testnet: "0x7F42018F47451417Fa4D39eDb6ad1e1C14C26a9a",
	// Network-keyed mainnet EOA; key held owner-side only.
	mainnet: "0xE75e277a6800a37429dac55FcD2f3540E371059c",
}

/** Fail-closed signer lookup — throws while a network's signer is unpinned. */
export function requirePinnedSigner(network: "testnet" | "mainnet"): string {
	const pinned = PLAN_PINNED_L1_SIGNERS[network]
	if (!pinned) {
		throw new Error(
			`no pinned L1 signer for ${network} — create the network-keyed EOA and pin it in ` +
				"PLAN_PINNED_L1_SIGNERS (live-intent.ts) before any broadcast. STOP.",
		)
	}
	return pinned
}

/** The testnet pin — the single-network export every testnet script asserts against. */
export const PLAN_PINNED_L1_SIGNER = requirePinnedSigner("testnet")

/**
 * The disposable canary key's public address per network, pinned here for the same reason as the deploy signers.
 * It is single-purpose and never a deploy signer. `null` until the key exists, and every canary-signed run is
 * refused while it is: pin the address and commit it before building the intent that covers the canary.
 */
export const PLAN_PINNED_CANARY_SIGNERS: Record<"testnet" | "mainnet", string | null> = {
	testnet: null,
	mainnet: null,
}

/** Fail-closed canary lookup — throws while the network's canary key is unpinned. */
export function requirePinnedCanarySigner(network: "testnet" | "mainnet"): string {
	const pinned = PLAN_PINNED_CANARY_SIGNERS[network]
	if (!pinned) {
		throw new Error(`no pinned canary signer for ${network} — pin the canary key's address in PLAN_PINNED_CANARY_SIGNERS first. STOP.`)
	}
	return pinned
}

/**
 * What the canary key may spend per chain it signs on, in ether: the source deposits on Base Sepolia, the
 * self-fills and Ethereum-origin rows on Sepolia. Its funding is the hard ceiling; these are the tally `verify`
 * reconciles against the balances `build` recorded, so an overspend stops the next row.
 */
export const CANARY_CAPS: Readonly<Record<string, { maxEthSpend: string }>> = {
	"84532": { maxEthSpend: "0.05" },
	"11155111": { maxEthSpend: "0.2" },
}

/** Hard exposure ceilings for one arc, sized for a ~1.25 WETH pool seed (price impact ~1.5% at a
 *  25-token fill). Testnet ETH only; a mainnet arc re-reviews these from scratch. */
export const CAPS = {
	maxTotalEthSpend: "2.0", // ether — L1 gas + WETH_SEED + pool seeding, everything
	maxWethSeed: "1.5", // ether — SeedTokenPool/DeployFuelLive's WETH_SEED must be explicit and ≤ this
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..")
let castPath: string | undefined

/** `CAST_BIN` → the current Aztec toolchain → the 5.0.0 pin → PATH; resolved on first use so
 *  importing this module for its signer constants never requires `cast` to exist. */
function castBin(): string {
	castPath ??= resolveBin("cast", {
		envVar: "CAST_BIN",
		candidates: [
			join(homedir(), ".aztec", "current", "internal-bin", "cast"),
			join(homedir(), ".aztec", "versions", "5.0.0", "internal-bin", "cast"),
		],
		prefer: "candidates",
	})
	return castPath
}

const NODE_URL = process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	})
	if (!res.ok) throw new Error(`${method} @ ${url}: HTTP ${res.status}`)
	const body = (await res.json()) as { result?: T; error?: { message: string } }
	if (body.error) throw new Error(`${method} @ ${url}: ${body.error.message}`)
	return body.result as T
}

const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex")

/** Run `cast` with an ARGV array — NEVER a shell string. A node-returned address containing shell
 *  metacharacters must not be able to execute commands (the deployer key is in this process's
 *  env); `run` never touches a shell and adds nothing from argv to a failure — what
 *  `cast` itself prints to stderr is kept verbatim. */
function cast(args: string[]): string {
	return run(castBin(), args, { stdio: ["ignore", "pipe", "pipe"] }).stdout.trim()
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const PRIVATE_KEY_HEX = /^(?:0x)?[0-9a-fA-F]{64}$/
const COMMIT_SHA = /^[0-9a-f]{40}$/

/** The signer's address, derived in this process: a key in a child's argv is readable by every
 *  process on the host. */
function signerOf(value: string): string {
	if (!PRIVATE_KEY_HEX.test(value)) throw new Error("PRIVATE_KEY is not a 32-byte hex key — STOP")
	return privateKeyToAccount((value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`).address
}
/** Fail-closed validation for any value that flows into a `cast` invocation from an UNTRUSTED source
 *  (a node RPC response, primarily). Even with `run` closing the shell vector, a malformed
 *  address must hard-stop rather than silently produce a wrong on-chain read. */
function requireAddress(value: string | undefined, label: string): string {
	if (!value || !EVM_ADDRESS.test(value)) {
		throw new Error(`${label} is not a valid 20-byte address: ${JSON.stringify(value)} — STOP`)
	}
	return value
}

export interface NodeIdentity {
	nodeVersion: string
	l1ChainId: number
	rollupVersion: number
	l1ContractAddresses: Record<string, string>
}

async function probeIdentity(url: string): Promise<NodeIdentity> {
	return rpc<NodeIdentity>(url, "node_getNodeInfo", [])
}

export interface DeployIntent {
	builtAt: string
	primaryRpc: string
	identity: { nodeVersion: string; l1ChainId: number; rollupVersion: number; walletChainId: number }
	l1: { rollup: string; feeJuicePortal: string; feeJuice: string; feeAssetHandler: string; registry: string }
	l1Corroboration: { rollupHasCode: boolean; portalHasCode: boolean; source: string }
	secondEndpoint:
		| { url: string; agreed: true }
		| { posture: "SINGLE-L2-NODE (documented residual: no second public endpoint; L1-anchored; caps bound exposure)" }
	signer: string
	caps: typeof CAPS
	/** The signer's ETH balance at build time (pre-spend). verify enforces `baseline - now <= cap`. */
	startingBalanceEth: number
	artifacts: { privateFpc: { address: string; salt: string; sha256: string }; noirTargets: Record<string, string> }
	source: { commit: string; treeClean: boolean; operationalAllowlist: string[] }
	candidateSha256?: string
	/** Present on a router-only intent: the generation the arc may not move, and the only changes it may make. */
	routerOnly?: RouterOnlyScope
	/** The canary key the intent covers; `signer: null` refuses every canary-signed run. */
	canary?: { signer: string | null; caps: typeof CANARY_CAPS; startingBalancesEth?: Record<string, number> }
}

/**
 * A router-only arc deploys the DepositRouter and its fuel swapper beside the generation and pre-creates the named
 * tokens; everything promotion locks (identity, factory, hub) and the legacy router stay as `build` found them.
 */
export interface RouterOnlyScope {
	generation: Record<
		"factory" | "implementation" | "registry" | "guardian" | "router" | "swapTarget" | "permit2" | "feeJuicePortal" | "hub",
		string
	>
	/** The live manifest's tokens by the addresses their generation derives; each stays in the candidate unchanged. */
	tokens: Array<{ erc20: string; portal: string; l2Token: string }>
	/** The only tokens the candidate may add. */
	preCreate: string[]
	/** The conductor's journal (repo-relative) and its length at build: every later step must be one this scope allows. */
	journal: { path: string; steps: number }
}

const OPERATIONAL_ALLOWLIST = [
	"apps/tools/public/testnet-bridge.candidate.json",
	"apps/tools/public/testnet-bridge.json",
	"apps/tools/src/contracts/deployments.candidate.json",
	"apps/tools/src/contracts/deployments.json",
	"packages/bridge-core/deploy-journal.jsonl",
	"packages/bridge-core/deploy-journal/",
	"implementations-plan/archive/aztec-5.0.0-stable/lessons/",
	"implementations-plan/archive/aztec-5.0.1-line/lessons/",
	"implementations-plan/archive/tools-two-network/lessons/",
	"implementations-plan/archive/any-erc20-bridge/lessons/",
	"implementations-plan/archive/protocol-labels/lessons/",
	"implementations-plan/lifi-routing/lessons/",
	"apps/tools/public/testnet-bridge.journal.jsonl",
]

/** The conductor's testnet journal, repo-relative: the router-only scope reads what was appended since `build`. */
const TESTNET_JOURNAL = "packages/bridge-core/deploy-journal/testnet-generation.jsonl"

/** A file entry matches exactly; only an entry ending in `/` matches by prefix — `deployments.json.ts`
 *  is not `deployments.json`. The reset baseline sits in an allowlisted lessons dir but is a trust
 *  anchor, so changing it after an intent is built is source drift. */
export const isAllowlistedPath = (p: string): boolean =>
	p !== NO_RESET_BASELINE && OPERATIONAL_ALLOWLIST.some((a) => (a.endsWith("/") ? p.startsWith(a) : p === a))

/** A porcelain line is allowlisted only when EVERY path on it is: a rename (`R  old -> new`) names
 *  two, and an allowlisted source must not launder a non-allowlisted destination. */
function isNotAllowlisted(line: string): boolean {
	return !line.slice(3).split(" -> ").every(isAllowlistedPath)
}

/** The committed intent every build pins the live identity against. A NETWORK RESET is the one
 *  event this pin is built to refuse, so a reset arc's first committed step is re-pointing it at
 *  the arc that recorded the new identity — never loosening the check. */
const NO_RESET_BASELINE = "implementations-plan/archive/aztec-v6/lessons/intent.json"

/** Network-identity pinning against the COMMITTED baseline intent: no network reset has
 *  happened since the baseline recorded this network's identity, so every node-claimed L1
 *  address MUST be byte-equal to the values it committed. A
 *  mismatch is a STOP — either the network reset (redeploy plan changes) or the node is
 *  lying/stale (never build an intent from it). Code-presence corroboration in `build` stays:
 *  this check authenticates the claims against history, that one against the L1 itself.
 *  Read the pin from the COMMITTED blob (git show HEAD:…), never the working tree:
 *  the lessons dir is allowlisted-dirty during live arcs, so a tree read could be
 *  silently re-pointed without tripping tree discipline. */
function assertNoResetPins(identity: Awaited<ReturnType<typeof probeIdentity>>): void {
	const baseline = JSON.parse(git(["show", `HEAD:${NO_RESET_BASELINE}`], repoRoot)) as {
		identity: { l1ChainId: number; rollupVersion: number }
		l1: Record<string, string>
	}
	if (identity.l1ChainId !== baseline.identity.l1ChainId || identity.rollupVersion !== baseline.identity.rollupVersion) {
		throw new Error(
			`network identity moved: live l1ChainId=${identity.l1ChainId}/rollupVersion=${identity.rollupVersion} != ` +
				`committed ${baseline.identity.l1ChainId}/${baseline.identity.rollupVersion} — RESET or wrong network; STOP`,
		)
	}
	assertL1Pins(identity, baseline.l1, "committed baseline")
}

/** All five node-claimed L1 addresses against an authenticated record: a substituted registry alone
 *  would let a lying node hand the factory an attacker's rollup, outbox included. */
export function assertL1Pins(identity: NodeIdentity, pinned: Record<string, string>, against: string): void {
	const claimed: Array<[string, string | undefined]> = [
		["rollup", identity.l1ContractAddresses.rollupAddress],
		["feeJuicePortal", identity.l1ContractAddresses.feeJuicePortalAddress],
		["feeJuice", identity.l1ContractAddresses.feeJuiceAddress],
		["feeAssetHandler", identity.l1ContractAddresses.feeAssetHandlerAddress],
		["registry", identity.l1ContractAddresses.registryAddress],
	]
	for (const [key, got] of claimed) {
		const want = pinned[key]
		if (!want || String(got).toLowerCase() !== want.toLowerCase()) {
			throw new Error(`node-claimed L1 ${key} ${got} != ${against} ${want} — STOP`)
		}
	}
}

/** The node at `nodeUrl`, refused unless its identity and L1 set equal the committed baseline. Deploy
 *  conductors call it before creating any account, so a wrong or lying endpoint never gets a broadcast. */
export async function authenticatedNode(nodeUrl: string): Promise<NodeIdentity> {
	const identity = await probeIdentity(nodeUrl)
	assertNoResetPins(identity)
	return identity
}

const lcAddr = (v: string) => v.toLowerCase()
const sameAddr = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase()

/** The scope a router-only intent pins: the live generation as committed, the tokens the arc may add, and how long
 *  the conductor's journal was. */
export function routerOnlyScopeOf(live: ManifestV2, preCreate: readonly string[], journalSteps: number): RouterOnlyScope {
	const { l1, l2, tokens } = requireBridge(live)
	const generation = {
		factory: l1.factory,
		implementation: l1.implementation,
		registry: l1.registry,
		guardian: l1.guardian,
		router: l1.router,
		swapTarget: l1.swapTarget,
		permit2: l1.permit2,
		feeJuicePortal: l1.feeJuicePortal,
		hub: l2.hub.address,
	}
	return {
		generation: Object.fromEntries(Object.entries(generation).map(([k, v]) => [k, lcAddr(v)])) as RouterOnlyScope["generation"],
		tokens: tokens.map((t) => ({ erc20: lcAddr(t.erc20), portal: lcAddr(t.portal), l2Token: lcAddr(t.l2Token) })),
		preCreate: preCreate.map((t) => lcAddr(requireAddress(t, "--pre-create token"))),
		journal: { path: TESTNET_JOURNAL, steps: journalSteps },
	}
}

/** The candidate moves nothing promotion locks, nor the legacy router; keeps every live token as its generation
 *  derives it; adds only the named tokens; and names the arc's two contracts. */
export function assertRouterOnlyScope(scope: RouterOnlyScope, candidate: ManifestV2): void {
	const { l1, l2, tokens } = requireBridge(candidate)
	const now: Record<keyof RouterOnlyScope["generation"], string> = { ...l1, hub: l2.hub.address }
	for (const [field, want] of Object.entries(scope.generation) as Array<[keyof RouterOnlyScope["generation"], string]>) {
		if (!sameAddr(now[field], want)) throw new Error(`router-only: candidate ${field} ${now[field]} != the generation's ${want} — STOP`)
	}
	if (!l1.depositRouter || !l1.fuelSwapper) throw new Error("router-only: the candidate names no depositRouter and fuelSwapper — STOP")
	const byErc20 = new Map(tokens.map((t) => [lcAddr(t.erc20), t]))
	for (const t of scope.tokens) {
		const c = byErc20.get(t.erc20)
		if (!c || !sameAddr(c.portal, t.portal) || !sameAddr(c.l2Token, t.l2Token)) {
			throw new Error(`router-only: live token ${t.erc20} is missing from the candidate or derives elsewhere — STOP`)
		}
	}
	const allowed = new Set([...scope.tokens.map((t) => t.erc20), ...scope.preCreate])
	const extra = tokens.filter((t) => !allowed.has(lcAddr(t.erc20))).map((t) => t.erc20)
	if (extra.length > 0) throw new Error(`router-only: the candidate adds tokens the intent did not name: ${extra.join(", ")} — STOP`)
}

/** What a router-only arc may journal: its two contracts, the named pre-creations, calibration and the candidate. */
const ROUTER_ONLY_STEPS: ReadonlySet<DeployStep["kind"]> = new Set([
	"fuel-swapper-deployed",
	"deposit-router-deployed",
	"token-precreated",
	"calibrated",
	"candidate-written",
])

/** Every step appended since `build` is one the router-only scope allows: a factory, hub or legacy router deploy
 *  under this intent would be a new generation the owner never authorized. */
export function assertRouterOnlyJournal(scope: RouterOnlyScope, steps: readonly DeployStep[]): void {
	if (steps.length < scope.journal.steps) {
		throw new Error(
			`the conductor journal has ${steps.length} step(s), fewer than the ${scope.journal.steps} at build — it was rewritten; STOP`,
		)
	}
	for (const s of steps.slice(scope.journal.steps)) {
		if (!ROUTER_ONLY_STEPS.has(s.kind)) throw new Error(`journal step ${s.kind} is outside this router-only intent — STOP`)
		if (s.kind === "token-precreated" && !scope.preCreate.includes(lcAddr(s.erc20))) {
			throw new Error(`journal pre-created ${s.erc20}, which this router-only intent does not name — STOP`)
		}
	}
}

/** A canary chain's read RPC: Sepolia's is the keyed one; a source chain's is its override or the catalogue's. */
function canaryChainRpc(chainId: string, sepolia: string): string {
	if (chainId === "11155111") return sepolia
	const url = sourceRpcUrl(Number(chainId))
	if (!url) throw new Error(`no read RPC for chain ${chainId} to reconcile the canary's spend against — STOP`)
	return url
}

function balanceEth(address: string, rpcUrl: string): number {
	const balance = Number(cast(["balance", requireAddress(address, "canary signer"), "--rpc-url", rpcUrl, "--ether"]))
	if (!Number.isFinite(balance)) throw new Error(`could not read ${address}'s balance — STOP`)
	return balance
}

/** The canary the intent covers, with its pre-spend balances when its key is pinned. */
function canaryRecord(sepolia: string): NonNullable<DeployIntent["canary"]> {
	const signer = PLAN_PINNED_CANARY_SIGNERS.testnet
	if (!signer) return { signer: null, caps: CANARY_CAPS }
	const startingBalancesEth = Object.fromEntries(
		Object.keys(CANARY_CAPS).map((id) => [id, balanceEth(signer, canaryChainRpc(id, sepolia))]),
	)
	return { signer, caps: CANARY_CAPS, startingBalancesEth }
}

/** A canary-signed run needs a pinned canary that the intent recorded; its spend per chain stays within the caps the
 *  intent recorded, measured from the balances recorded at build. */
function assertCanary(intent: DeployIntent, sepolia: string): void {
	const signer = intent.canary?.signer ?? null
	const key = process.env.CANARY_PRIVATE_KEY
	if (key) {
		const pinned = requirePinnedCanarySigner("testnet")
		const derived = signerOf(key)
		if (!sameAddr(derived, pinned) || !sameAddr(derived, signer ?? undefined)) {
			throw new Error(`canary key ${derived} != pinned ${pinned} / intent ${signer} — STOP`)
		}
	}
	const start = intent.canary?.startingBalancesEth
	if (!signer || !start) return
	for (const [chainId, before] of Object.entries(start)) {
		const spent = before - balanceEth(signer, canaryChainRpc(chainId, sepolia))
		const cap = Number(intent.canary?.caps[chainId]?.maxEthSpend)
		if (!(spent <= cap)) throw new Error(`canary spend ${spent.toFixed(6)} ETH on chain ${chainId} exceeds its ${cap} ETH cap — STOP`)
		console.log(`✓ canary spend on chain ${chainId}: ${spent.toFixed(6)}/${cap} ETH`)
	}
}

/** The conductor journal's committed length: steps appended before `build` but never committed are checked too. */
function committedJournalSteps(): number {
	const blob = run("git", ["show", `HEAD:${TESTNET_JOURNAL}`], { cwd: repoRoot, check: false })
	return blob.exitCode === 0 ? blob.stdout.split("\n").filter(Boolean).length : 0
}

/** The router-only scope from the COMMITTED live manifest: the working-tree copy is allowlisted and may be dirty. */
function routerOnlyScopeAtHead(preCreate: readonly string[]): RouterOnlyScope {
	const live = parseManifestV2(JSON.parse(git(["show", "HEAD:apps/tools/public/testnet-bridge.json"], repoRoot)))
	return routerOnlyScopeOf(live, preCreate, committedJournalSteps())
}

async function build(intentPath: string, opts: { routerOnly?: { preCreate: string[] } } = {}): Promise<void> {
	const sepolia = process.env.SEPOLIA_RPC_URL
	if (!sepolia) throw new Error("SEPOLIA_RPC_URL required (source packages/bridge-core/.env)")
	const pk = process.env.PRIVATE_KEY
	if (!pk) throw new Error("PRIVATE_KEY required (source packages/bridge-core/.env)")

	const identity = await probeIdentity(NODE_URL)
	const walletChainId = walletChainIdOf(identity.l1ChainId, identity.rollupVersion)
	assertNoResetPins(identity)

	// Independent L1 corroboration of the node's claims — a lying/stale node fails here. The node
	// controls these strings, so validate them as addresses BEFORE they reach `cast`.
	const rollup = requireAddress(identity.l1ContractAddresses.rollupAddress, "node rollupAddress")
	const portal = requireAddress(identity.l1ContractAddresses.feeJuicePortalAddress, "node feeJuicePortalAddress")
	const rollupCode = cast(["code", rollup, "--rpc-url", sepolia])
	const portalCode = cast(["code", portal, "--rpc-url", sepolia])

	// Second Aztec endpoint, when one exists.
	const secondUrl = process.env.INTENT_SECOND_AZTEC_RPC
	let secondEndpoint: DeployIntent["secondEndpoint"]
	if (secondUrl) {
		const second = await probeIdentity(secondUrl)
		if (second.rollupVersion !== identity.rollupVersion || second.l1ContractAddresses.rollupAddress !== rollup) {
			throw new Error(`second endpoint DISAGREES: rollupVersion ${second.rollupVersion} vs ${identity.rollupVersion}`)
		}
		secondEndpoint = { url: secondUrl, agreed: true }
	} else {
		secondEndpoint = { posture: "SINGLE-L2-NODE (documented residual: no second public endpoint; L1-anchored; caps bound exposure)" }
	}

	const signer = signerOf(pk)
	if (signer.toLowerCase() !== PLAN_PINNED_L1_SIGNER.toLowerCase()) {
		throw new Error(`env-derived signer ${signer} != plan-pinned ${PLAN_PINNED_L1_SIGNER} — HARD STOP`)
	}

	// The PRE-SPEND baseline the caps are measured against. Recorded ONCE at build (before any
	// broadcast); verify computes `baseline - current` and hard-stops if it exceeds maxTotalEthSpend.
	const startingBalanceEth = Number(cast(["balance", signer, "--rpc-url", sepolia, "--ether"]))
	if (!Number.isFinite(startingBalanceEth)) throw new Error(`could not read starting signer balance — STOP`)

	const commit = git(["rev-parse", "HEAD"], repoRoot)
	const dirty = run("git", ["status", "--porcelain"], { cwd: repoRoot }).stdout.split("\n").filter(Boolean).filter(isNotAllowlisted)

	const intent: DeployIntent = {
		builtAt: new Date().toISOString(),
		primaryRpc: NODE_URL,
		identity: {
			nodeVersion: identity.nodeVersion,
			l1ChainId: identity.l1ChainId,
			rollupVersion: identity.rollupVersion,
			walletChainId,
		},
		l1: {
			rollup,
			feeJuicePortal: portal,
			feeJuice: identity.l1ContractAddresses.feeJuiceAddress,
			feeAssetHandler: identity.l1ContractAddresses.feeAssetHandlerAddress,
			registry: identity.l1ContractAddresses.registryAddress,
		},
		l1Corroboration: {
			rollupHasCode: rollupCode.length > 4,
			portalHasCode: portalCode.length > 4,
			source: "direct eth_getCode via SEPOLIA_RPC_URL",
		},
		secondEndpoint,
		signer,
		caps: CAPS,
		startingBalanceEth,
		artifacts: {
			privateFpc: {
				address: PRIVATE_FPC_ADDRESS,
				salt: PRIVATE_FPC_SALT,
				sha256: JSON.parse(readFileSync(join(here, "..", "src", "private-fpc-canonical.json"), "utf8")).artifactSha256,
			},
			noirTargets: Object.fromEntries(
				["token_bridge_hub/target/token_bridge_hub_contract-TokenBridgeHub.json", "keystone/target/keystone.json"].map((rel) => [
					rel,
					sha256(join(repoRoot, "contracts", "bridge", "aztec", rel)),
				]),
			),
		},
		source: { commit, treeClean: dirty.length === 0, operationalAllowlist: OPERATIONAL_ALLOWLIST },
		...(opts.routerOnly ? { routerOnly: routerOnlyScopeAtHead(opts.routerOnly.preCreate) } : {}),
		canary: canaryRecord(sepolia),
	}
	if (!intent.l1Corroboration.rollupHasCode || !intent.l1Corroboration.portalHasCode) {
		throw new Error("L1 corroboration FAILED: node-claimed rollup/portal has no code on Sepolia — HARD STOP")
	}
	if (dirty.length > 0) {
		throw new Error(`source tree not clean outside the operational allowlist:\n${dirty.join("\n")}`)
	}
	writeFileSync(intentPath, `${JSON.stringify(intent, null, "\t")}\n`)
	console.log(
		`✓ intent written to ${intentPath} (commit ${commit.slice(0, 8)}, rollupVersion ${identity.rollupVersion}, signer ${signer}` +
			`${intent.routerOnly ? ", router-only" : ""})`,
	)
}

function requireSepoliaRpc(): string {
	const sepolia = process.env.SEPOLIA_RPC_URL
	if (!sepolia) throw new Error("SEPOLIA_RPC_URL required (source packages/bridge-core/.env)")
	return sepolia
}

/** The intent is the gate's own trust anchor (caps, signer, digests). It lives under the otherwise
 *  allowlisted lessons dir, so once it carries a recorded candidate digest — i.e. we are past the
 *  one-time recording verify and into the gating regime — it MUST be committed: an uncommitted edit
 *  weakening a cap, the signer or the digest would otherwise slip through the tree check. */
function assertIntentCommitted(intent: DeployIntent, intentPath: string): void {
	if (!intent.candidateSha256) return
	// `--literal-pathspecs` + `--`: the path is neither an option nor pathspec magic.
	const status = run("git", ["--literal-pathspecs", "status", "--porcelain", "--", intentPath], { cwd: repoRoot }).stdout.trim()
	if (status.length > 0) {
		throw new Error(`intent.json is uncommitted — the gate's own anchor must be committed before promotion:\n${status}`)
	}
}

/** Tree discipline at EVERY verify, not just at build: only allowlisted operational files may be
 *  dirty during a live arc. Committing is no escape: {@link assertNoSourceDrift} refuses the commit
 *  too, so a source change mid-arc means a new intent. */
function assertTreeDiscipline(): void {
	const dirty = run("git", ["status", "--porcelain"], { cwd: repoRoot }).stdout.split("\n").filter(Boolean).filter(isNotAllowlisted)
	if (dirty.length > 0)
		throw new Error(
			`non-allowlisted files dirty during the live arc — revert them; a committed source change voids this intent:\n${dirty.join("\n")}`,
		)
}

/** Tree discipline catches UNCOMMITTED changes, but a clean commit between build and a later verify
 *  (a deploy script, an EVM artifact) would pass it. Every path that differs between the recorded
 *  build commit and HEAD must be allowlisted. Fails closed on an intent with no build commit: such a
 *  record is evidence, never an authorisation. */
export function assertNoSourceDrift(intent: Pick<DeployIntent, "source">): void {
	if (!intent.source?.commit)
		throw new Error("intent.source.commit is empty — this intent cannot authorise a run; build a new one — STOP")
	// The intent is a type-cast JSON file: the commit is validated before it becomes a git argument.
	if (!COMMIT_SHA.test(intent.source.commit)) throw new Error("intent.source.commit is not a 40-hex commit — STOP")
	// `--no-renames`: a rename reports only its destination, so a source file moved INTO an allowlisted
	// dir would vanish from the list — as delete + add, the deleted source path is judged on its own.
	const changed = git(["diff", "--name-only", "--no-renames", "--end-of-options", intent.source.commit, "HEAD", "--"], repoRoot)
		.split("\n")
		.filter(Boolean)
		.filter((path) => !isAllowlistedPath(path))
	if (changed.length > 0) {
		throw new Error(
			`deploy-relevant files changed since the intent was built (commit ${intent.source.commit.slice(0, 12)}):\n` +
				`${changed.join("\n")}\nrebuild the intent — STOP`,
		)
	}
}

/** Identity re-validation, before EVERY broadcast group and at promotion. */
async function assertIdentityUnmoved(intent: DeployIntent): Promise<NodeIdentity> {
	const now = await probeIdentity(intent.primaryRpc)
	if (now.rollupVersion !== intent.identity.rollupVersion) {
		throw new Error(`rollupVersion MOVED mid-arc: ${now.rollupVersion} != ${intent.identity.rollupVersion} — STOP`)
	}
	if (now.l1ChainId !== intent.identity.l1ChainId) {
		throw new Error(`the node's L1 chain moved: ${now.l1ChainId} != ${intent.identity.l1ChainId} — a different network; STOP`)
	}
	if (now.nodeVersion !== intent.identity.nodeVersion) {
		throw new Error(`nodeVersion moved: ${now.nodeVersion} != ${intent.identity.nodeVersion} — STOP`)
	}
	assertL1Pins(now, intent.l1, "intent")
	return now
}

function assertSignerUnmoved(intent: DeployIntent): void {
	const pk = process.env.PRIVATE_KEY
	if (!pk) return
	const signer = signerOf(pk)
	if (signer.toLowerCase() !== intent.signer.toLowerCase()) throw new Error(`signer ${signer} != intent ${intent.signer} — STOP`)
}

/** Every artifact the intent recorded — the Noir targets and the canonical PrivateFPC alike. */
function assertArtifactDigests(intent: DeployIntent): void {
	for (const [rel, expected] of Object.entries(intent.artifacts.noirTargets)) {
		const actual = sha256(join(repoRoot, "contracts", "bridge", "aztec", rel))
		if (actual !== expected) throw new Error(`Noir artifact drifted since intent: ${rel}`)
	}
	const descriptorSha = JSON.parse(readFileSync(join(here, "..", "src", "private-fpc-canonical.json"), "utf8")).artifactSha256
	if (descriptorSha !== intent.artifacts.privateFpc.sha256) {
		throw new Error(
			`canonical PrivateFPC digest drifted since intent: ${descriptorSha} != ${intent.artifacts.privateFpc.sha256} — STOP`,
		)
	}
}

/**
 * The fee-juice pair, cross-pinned against the intent's corroborated L1 set FIRST: internal
 * consistency (portal ↔ asset readbacks) is not authentication, since a lying node at deploy time
 * can mint a self-consistent FAKE pair. The intent's values went through baseline byte-equality
 * plus eth_getCode; a candidate that disagrees sends deposits to the wrong portal, unrecoverably.
 */
function assertFeeJuicePins(m: ManifestV2, intent: DeployIntent, sepolia: string): void {
	const fee = m.feeJuice
	if (fee.portal.toLowerCase() !== intent.l1.feeJuicePortal.toLowerCase()) {
		throw new Error(`candidate feeJuice.portal ${fee.portal} != intent pin ${intent.l1.feeJuicePortal} — STOP`)
	}
	if (fee.asset.toLowerCase() !== intent.l1.feeJuice.toLowerCase()) {
		throw new Error(`candidate feeJuice.asset ${fee.asset} != intent pin ${intent.l1.feeJuice} — STOP`)
	}
	const underlying = cast(["call", fee.portal, "UNDERLYING()(address)", "--rpc-url", sepolia])
	if (underlying.toLowerCase() !== fee.asset.toLowerCase()) {
		throw new Error(`portal UNDERLYING ${underlying} != manifest asset ${fee.asset} — STOP`)
	}
	// The fee-asset handler is a testnet convenience (permissionless mint); mainnet brings its own
	// fee asset and no handler, so verify it only when the manifest declares one.
	const handler = fee.feeAssetHandler
	if (!handler) return
	if (handler.toLowerCase() !== intent.l1.feeAssetHandler.toLowerCase()) {
		throw new Error(`candidate feeJuice.feeAssetHandler ${handler} != intent pin ${intent.l1.feeAssetHandler} — STOP`)
	}
	const feeAsset = cast(["call", handler, "FEE_ASSET()(address)", "--rpc-url", sepolia])
	if (feeAsset.toLowerCase() !== fee.asset.toLowerCase()) throw new Error(`handler FEE_ASSET ${feeAsset} != manifest asset — STOP`)
}

/**
 * The hub's bindings, read off the node without a wallet: the deployed instance's initialization
 * hash and class commit to `[token_class_id, l1_factory, guardian]`, so a hub initialized with any
 * other factory or class cannot sit at the manifest address with the manifest salt.
 */
async function reportHubBindings(b: BridgeBlock, nodeUrl: string): Promise<void> {
	const node = createNode(nodeUrl)
	const instance = await node.getContract(AztecAddress.fromStringUnsafe(b.l2.hub.address))
	if (!instance) throw new Error(`no contract at the manifest hub ${b.l2.hub.address} on ${nodeUrl} — STOP`)
	const derived = await deriveHubInstance(b.l2.hub)
	const same = (label: string, got: { toString(): string }, want: { toString(): string }) => {
		if (got.toString().toLowerCase() !== want.toString().toLowerCase())
			throw new Error(`deployed hub ${label} ${got.toString()} != manifest derivation ${want.toString()} — STOP`)
	}
	same("salt", instance.salt, derived.salt)
	same("initializationHash", instance.initializationHash, derived.initializationHash)
	same("class", instance.currentContractClassId, derived.currentContractClassId)
	const tokenClass = await node.getContractClass(Fr.fromHexString(b.l2.tokenClassId))
	if (!tokenClass) throw new Error(`token class ${b.l2.tokenClassId} is not published on L2 — no token could be registered; STOP`)
	console.log("  hub initialization hash + class match the manifest's [token_class_id, l1_factory, guardian]; token class published")
}

/** The DepositRouter and its swapper, when the candidate names them: the owner, factory and swap target a
 *  lookalike would get wrong. Returns `[label, on-chain, manifest]` rows. */
async function depositRouterBindings(pub: PublicClient, b: BridgeBlock): Promise<Array<[string, unknown, string]>> {
	const { depositRouter, fuelSwapper } = b.l1
	if (!depositRouter) return []
	const router = depositRouter as Address
	const [owner, factory, swapTarget] = await Promise.all([
		pub.readContract({ address: router, abi: ROUTER_CONSTANTS_ABI, functionName: "owner" }),
		pub.readContract({ address: router, abi: DEPOSIT_ROUTER_ABI, functionName: "FACTORY" }),
		pub.readContract({ address: router, abi: DEPOSIT_ROUTER_ABI, functionName: "SWAP_TARGET" }),
	])
	const rows: Array<[string, unknown, string]> = [
		// The router's owner can only sweep donated residue; the guardian is still the only acceptable holder.
		["depositRouter owner", owner, b.l1.guardian],
		["depositRouter FACTORY", factory, b.l1.factory],
	]
	if (!fuelSwapper) return rows
	const swapperOwner = await pub.readContract({ address: fuelSwapper as Address, abi: FUEL_SWAPPER_ABI, functionName: "owner" })
	// The swapper's owner sets the price of every fueled send.
	rows.push(["depositRouter SWAP_TARGET", swapTarget, fuelSwapper], ["fuelSwapper owner", swapperOwner, b.l1.guardian])
	return rows
}

/**
 * The generation's privileged bindings, read off the chains that hold them — a digest cannot catch
 * a wrong owner, a foreign swap target, or an implementation the factory does not clone — followed
 * by the complete L1 verifier (every router/factory constant, every token, the runtime code hashes),
 * so a lookalike router that only answers `swapTarget` correctly cannot promote.
 */
async function verifyGenerationBindings(m: ManifestV2, rpcUrl: string, nodeUrl: string): Promise<void> {
	const b = requireBridge(m)
	const pub: PublicClient = createL1PublicClient({ chain: manifestL1Chain(m, rpcUrl), rpcUrl })
	for (const [label, address] of [
		["factory", b.l1.factory],
		["implementation", b.l1.implementation],
		["router", b.l1.router],
		["depositRouter", b.l1.depositRouter],
		["fuelSwapper", b.l1.fuelSwapper],
	] as const) {
		if (!address) continue
		const code = await pub.getCode({ address: address as Address })
		if (!code || code === "0x") throw new Error(`candidate ${label} ${address} has no code on L1 — STOP`)
	}
	const [factoryOwner, implementation, l2Hub, routerOwner, swapTarget] = await Promise.all([
		pub.readContract({ address: b.l1.factory as Address, abi: FACTORY_CONSTANTS_ABI, functionName: "owner" }),
		pub.readContract({ address: b.l1.factory as Address, abi: PORTAL_FACTORY_ABI, functionName: "IMPLEMENTATION" }),
		pub.readContract({ address: b.l1.factory as Address, abi: PORTAL_FACTORY_ABI, functionName: "L2_HUB" }),
		pub.readContract({ address: b.l1.router as Address, abi: ROUTER_CONSTANTS_ABI, functionName: "owner" }),
		pub.readContract({ address: b.l1.router as Address, abi: SWAP_BRIDGE_ROUTER_ABI, functionName: "swapTarget" }),
	])
	console.log(`  factory.owner ${factoryOwner} · router.owner ${routerOwner}`)
	const bindings: Array<[string, unknown, string]> = [
		["factory owner", factoryOwner, b.l1.guardian],
		// The router's owner rotates the swap target; anyone but the guardian holding it is a foreign router.
		["router owner", routerOwner, b.l1.guardian],
		["factory IMPLEMENTATION", implementation, b.l1.implementation],
		// The factory addresses every register message to this hub; a manifest naming another one
		// would ship a hub that never learns a token.
		["factory L2_HUB", l2Hub, b.l2.hub.address],
		["router swapTarget", swapTarget, b.l1.swapTarget],
		...(await depositRouterBindings(pub, b)),
	]
	for (const [label, got, want] of bindings) {
		if (String(got).toLowerCase() !== want.toLowerCase()) throw new Error(`${label} ${String(got)} != manifest ${want} — STOP`)
	}
	await reportHubBindings(b, nodeUrl)
	const failures = await verifyL1Manifest(m, rpcUrl, { strict: true })
	if (failures > 0) throw new Error(`${failures} L1 verification check(s) failed on the candidate — STOP`)
}

/** The candidate must name the network the intent was built against — the app refuses any other.
 *  Its registry is pinned too, and read on L1: every pointer the factory and portals froze is checked
 *  against that registry, so an unauthenticated one would make those checks self-referential. */
function assertCandidateIdentity(intent: DeployIntent, candidate: ManifestV2, sepolia: string): void {
	const want = intent.identity
	if (candidate.l1ChainId !== want.l1ChainId || candidate.walletChainId !== want.walletChainId) {
		throw new Error(
			`candidate chain identity (l1 ${candidate.l1ChainId}, wallet ${candidate.walletChainId}) != intent ` +
				`(l1 ${want.l1ChainId}, wallet ${want.walletChainId}) — STOP`,
		)
	}
	const registry = requireBridge(candidate).l1.registry
	if (registry.toLowerCase() !== intent.l1.registry.toLowerCase()) {
		throw new Error(`candidate registry ${registry} != intent pin ${intent.l1.registry} — STOP`)
	}
	const rollup = cast(["call", registry, "getCanonicalRollup()(address)", "--rpc-url", sepolia])
	if (rollup.toLowerCase() !== intent.l1.rollup.toLowerCase()) {
		throw new Error(`registry ${registry} resolves to rollup ${rollup}, not the intent's ${intent.l1.rollup} — STOP`)
	}
}

/** Digest-pin the candidate bytes, strict-parse them, then prove the generation they name. */
async function verifyCandidate(intent: DeployIntent, intentPath: string, candidatePath: string, sepolia: string): Promise<void> {
	const raw = readFileSync(candidatePath, "utf8")
	const digest = createHash("sha256").update(raw).digest("hex")
	if (intent.candidateSha256 && intent.candidateSha256 !== digest) {
		throw new Error(`candidate digest CHANGED since recorded: ${digest} != ${intent.candidateSha256} — never promote`)
	}
	const candidate = await assertFaucetCandidateShape(JSON.parse(raw))
	if (!intent.candidateSha256) {
		intent.candidateSha256 = digest
		writeFileSync(intentPath, `${JSON.stringify(intent, null, "\t")}\n`)
		console.log(`✓ candidate digest recorded: ${digest}`)
	}
	assertFeeJuicePins(candidate, intent, sepolia)
	assertCandidateIdentity(intent, candidate, sepolia)
	if (intent.routerOnly) assertRouterOnlyScope(intent.routerOnly, candidate)
	await verifyGenerationBindings(candidate, sepolia, intent.primaryRpc)
	console.log("✓ candidate strict-valid + privileged readbacks agree")
}

/** Balance-within-caps reconciliation — ENFORCED, not merely printed: the build recorded the
 *  pre-spend baseline, so a cumulative spend past the cap hard-stops here. */
function assertSpendWithinCaps(intent: DeployIntent, sepolia: string, rollupVersion: number): void {
	const balance = Number(cast(["balance", requireAddress(intent.signer, "intent signer"), "--rpc-url", sepolia, "--ether"]))
	if (typeof intent.startingBalanceEth !== "number" || !Number.isFinite(intent.startingBalanceEth)) {
		// An intent with no recorded baseline can only be printed against — there is no delta to enforce.
		console.log(
			`✓ verify green — rollupVersion ${rollupVersion}, signer balance ${balance} ETH (caps: ≤${intent.caps.maxTotalEthSpend} total spend; no baseline to enforce)`,
		)
		return
	}
	const spent = intent.startingBalanceEth - balance
	const cap = Number(intent.caps.maxTotalEthSpend)
	if (spent > cap) {
		throw new Error(
			`spend ${spent.toFixed(6)} ETH EXCEEDS the ${cap} ETH cap (baseline ${intent.startingBalanceEth} → now ${balance}) — STOP`,
		)
	}
	console.log(
		`✓ verify green — rollupVersion ${rollupVersion}, spend ${spent.toFixed(6)}/${cap} ETH (baseline ${intent.startingBalanceEth} → ${balance})`,
	)
}

async function verify(intentPath: string, candidatePath?: string): Promise<void> {
	const intent = JSON.parse(readFileSync(intentPath, "utf8")) as DeployIntent
	const sepolia = requireSepoliaRpc()
	assertIntentCommitted(intent, intentPath)
	assertTreeDiscipline()
	assertNoSourceDrift(intent)
	const now = await assertIdentityUnmoved(intent)
	assertSignerUnmoved(intent)
	assertArtifactDigests(intent)
	if (intent.routerOnly) assertRouterOnlyJournal(intent.routerOnly, readDeployJournal(join(repoRoot, TESTNET_JOURNAL)))
	if (candidatePath) await verifyCandidate(intent, intentPath, candidatePath, sepolia)
	assertSpendWithinCaps(intent, sepolia, now.rollupVersion)
	assertCanary(intent, sepolia)
}

interface PromotionPaths {
	bridgeCandidate: string
	bridgeLive: string
	faucetCandidate: string
	faucetLive: string
}

function promotionPaths(): PromotionPaths {
	return {
		bridgeCandidate: join(repoRoot, "apps/tools/public/testnet-bridge.candidate.json"),
		bridgeLive: join(repoRoot, "apps/tools/public/testnet-bridge.json"),
		faucetCandidate: join(repoRoot, "apps/tools/src/contracts/deployments.candidate.json"),
		faucetLive: join(repoRoot, "apps/tools/src/contracts/deployments.json"),
	}
}

/** A symlinked live target would redirect the rename and a symlinked candidate breaks the
 *  read-once contract, so every involved path is lstat'd first. A live target that does not exist
 *  yet is fine — the rename creates it — but a missing required input is not. */
function assertPromotablePaths(paths: PromotionPaths, bridgeOnly: boolean): void {
	const required = bridgeOnly ? [paths.bridgeCandidate, paths.faucetLive] : [paths.bridgeCandidate, paths.faucetCandidate]
	const involved = bridgeOnly
		? [paths.bridgeCandidate, paths.bridgeLive, paths.faucetLive]
		: [paths.bridgeCandidate, paths.faucetCandidate, paths.bridgeLive, paths.faucetLive]
	for (const p of involved) {
		let st: ReturnType<typeof lstatSync> | undefined
		try {
			st = lstatSync(p)
		} catch {
			if (required.includes(p)) throw new Error(`required file missing: ${p} — nothing to promote`)
			continue
		}
		if (st.isSymbolicLink()) throw new Error(`refusing to promote through a symlink: ${p}`)
	}
}

interface PromotionBytes {
	bridge: Buffer
	bridgeSha: string
	faucet: Buffer | null
	faucetSha: string | null
	/** Under --bridge-only, the live faucet file's digest before any write; re-asserted after. */
	faucetLivePin: string | null
}

const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** Read ONCE into buffers and pin the exact bytes that will be written: verify() read the candidate
 *  separately, and an edit between the two reads would otherwise ship bytes that skipped the digest
 *  pin and the privileged readbacks. */
function readPromotionBytes(paths: PromotionPaths, bridgeOnly: boolean, recordedSha: string): PromotionBytes {
	const bridge = readFileSync(paths.bridgeCandidate)
	const bridgeSha = sha256Of(bridge)
	if (bridgeSha !== recordedSha) {
		throw new Error(`bridge candidate bytes changed between verify and promote: ${bridgeSha} != recorded ${recordedSha} — STOP`)
	}
	const faucet = bridgeOnly ? null : readFileSync(paths.faucetCandidate)
	return {
		bridge,
		bridgeSha,
		faucet,
		faucetSha: faucet ? sha256Of(faucet) : null,
		faucetLivePin: bridgeOnly ? sha256Of(readFileSync(paths.faucetLive)) : null,
	}
}

/** Re-verify what actually landed: the bridge manifest re-parses, the faucet derivation is re-proven
 *  through the real gate, and a --bridge-only promotion must have left the faucet file untouched. */
function verifyWritten(paths: PromotionPaths, faucetLivePin: string | null): void {
	parseManifestV2(JSON.parse(readFileSync(paths.bridgeLive, "utf8")))
	run("bun", [join(repoRoot, "apps/tools/scripts/verify-deployments.ts")], { stdio: "inherit" })
	if (!faucetLivePin) return
	const after = sha256Of(readFileSync(paths.faucetLive))
	if (after !== faucetLivePin) {
		throw new Error(`--bridge-only violated: live faucet manifest changed (${after} != pinned ${faucetLivePin}) — investigate NOW`)
	}
}

/** The live manifest the interlock compares against; absent means this is the first promotion. A
 *  live file that no longer parses is a hard stop — the interlock may never be skipped silently. */
function readLiveManifest(path: string): ManifestV2 | undefined {
	if (!existsSync(path)) return undefined
	return parseManifestV2(JSON.parse(readFileSync(path, "utf8")))
}

/** Same-directory temp + rename (atomic on one filesystem), then re-hash what landed. A pre-planted
 *  tmp must not be followed or reused: it is removed, then exclusively created so a racing recreate
 *  fails loudly. */
function writeAtomic(target: string, bytes: Buffer, sha: string): void {
	mkdirSync(dirname(target), { recursive: true })
	const tmp = `${target}.promote-tmp`
	rmSync(tmp, { force: true })
	writeFileSync(tmp, bytes, { flag: "wx" })
	renameSync(tmp, target)
	const written = createHash("sha256").update(readFileSync(target)).digest("hex")
	if (written !== sha) throw new Error(`re-hash mismatch after write: ${target} ${written} != ${sha} — investigate before committing`)
}

/** The receipt lives beside the intent it settles, so each arc keeps its own record. */
function writeReceipt(intentPath: string, mode: string, bridge: unknown, faucet: unknown, firstPromotion: boolean): string {
	const receiptPath = join(dirname(resolvePath(repoRoot, intentPath)), "promotion-receipt.json")
	mkdirSync(dirname(receiptPath), { recursive: true })
	const receipt = {
		promotedAt: new Date().toISOString(),
		intent: intentPath,
		commitAtPromotion: git(["rev-parse", "HEAD"], repoRoot),
		mode,
		bridge,
		faucet,
		generation: firstPromotion
			? "first promotion: no live manifest, so the generation interlock compared nothing"
			: "existing live manifest: the generation interlock passed",
	}
	writeFileSync(receiptPath, `${JSON.stringify(receipt, null, "\t")}\n`)
	return receiptPath
}

/**
 * Crash-safe, receipted promotion of both candidates to their live paths:
 *   apps/tools/public/testnet-bridge.candidate.json      → testnet-bridge.json
 *   apps/tools/src/contracts/deployments.candidate.json  → deployments.json
 *
 * The order is load-bearing: verify → validate-in-memory → temp-write+rename → re-hash → re-verify
 * → receipt. The candidates are read ONCE into buffers and every later step operates on those exact
 * bytes. Nothing here commits, so a crash leaves only uncommitted working-tree changes, never a
 * partially-promoted committed state — and because the live paths are operationally allowlisted,
 * tree discipline does not flag a crash-interrupted pair; the recovery is to RE-RUN promote, which
 * is idempotent and converges both targets from the same pinned candidates.
 *
 * `--bridge-only` promotes a bridge generation that touches no faucet deployment: the faucet
 * candidate is not required, and the LIVE faucet file is digest-pinned before and after so the
 * promotion provably leaves it byte-identical.
 */
async function promote(intentPath: string, opts: { bridgeOnly?: boolean } = {}): Promise<void> {
	const bridgeOnly = opts.bridgeOnly === true
	const paths = promotionPaths()

	// The recorded candidate digest is REQUIRED BEFORE promote's own verify runs: verify RECORDS a
	// missing digest, so checking after it would always pass.
	const intent = JSON.parse(readFileSync(intentPath, "utf8")) as DeployIntent
	if (!intent.candidateSha256) {
		throw new Error("intent has no recorded candidateSha256 — run verify --candidate (and commit the intent) BEFORE promote — STOP")
	}
	await verify(intentPath, paths.bridgeCandidate)

	// Promotion enables the app's fuel path, which hard-uses PRIVATE_FPC_ADDRESS — an undeployed or
	// upgraded-out FPC at that address must abort the promotion.
	run("bun", [join(here, "check-fpc-version.ts"), "--mode", "require-deployed"], { stdio: "inherit" })

	assertPromotablePaths(paths, bridgeOnly)
	const bytes = readPromotionBytes(paths, bridgeOnly, intent.candidateSha256)
	const candidate = await assertFaucetCandidateShape(JSON.parse(bytes.bridge.toString("utf8")))
	// Prove the faucet candidate's derivation BEFORE any live write; otherwise a junk candidate
	// fails only after the live file was overwritten.
	if (bytes.faucet) {
		run("bun", [join(repoRoot, "apps/tools/scripts/verify-deployments.ts"), "--config", paths.faucetCandidate], { stdio: "inherit" })
	}

	const live = readLiveManifest(paths.bridgeLive)
	if (live) assertZeroSeed(candidate, live)
	else console.log("no live manifest yet — first promotion; the generation interlock has nothing to compare against")

	writeAtomic(paths.bridgeLive, bytes.bridge, bytes.bridgeSha)
	if (bytes.faucet && bytes.faucetSha) writeAtomic(paths.faucetLive, bytes.faucet, bytes.faucetSha)
	verifyWritten(paths, bytes.faucetLivePin)

	const receiptPath = writeReceipt(
		intentPath,
		bridgeOnly ? "bridge-only" : "bridge+faucet",
		{ candidateSha256: bytes.bridgeSha, live: "apps/tools/public/testnet-bridge.json" },
		bytes.faucetSha
			? { candidateSha256: bytes.faucetSha, live: "apps/tools/src/contracts/deployments.json" }
			: { unchangedSha256: bytes.faucetLivePin, live: "apps/tools/src/contracts/deployments.json" },
		live === undefined,
	)
	console.log(`✓ promoted; receipt at ${receiptPath} — commit the promoted files + receipt together`)
}

// CLI dispatch — guarded so importing this module (e.g. for PLAN_PINNED_L1_SIGNER)
// never triggers argv parsing / process.exit.
const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === resolvePath(process.argv[1]) : false
if (isMain) {
	const [, , cmd, intentPath, ...rest] = process.argv
	if (!cmd || !intentPath) {
		console.error(
			"usage: live-intent.ts build|verify|promote <intent-path> [--router-only [--pre-create <erc20>]…] [--candidate <path>] [--bridge-only]",
		)
		process.exit(1)
	}
	const candidateFlag = rest.indexOf("--candidate")
	const candidatePath = candidateFlag !== -1 ? rest[candidateFlag + 1] : undefined
	const bridgeOnly = rest.includes("--bridge-only")
	const preCreate = rest.flatMap((arg, i) => (arg === "--pre-create" && rest[i + 1] ? [rest[i + 1] as string] : []))
	const dispatch =
		cmd === "build"
			? build(intentPath, rest.includes("--router-only") ? { routerOnly: { preCreate } } : {})
			: cmd === "verify"
				? verify(intentPath, candidatePath)
				: cmd === "promote"
					? promote(intentPath, { bridgeOnly })
					: Promise.reject(new Error(`unknown command ${cmd}`))
	dispatch.catch((err) => {
		console.error(`✗ ${err instanceof Error ? err.message : err}`)
		process.exit(1)
	})
}
