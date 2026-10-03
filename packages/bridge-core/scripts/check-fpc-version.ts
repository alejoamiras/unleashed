/**
 * Fail-closed PrivateFPC gate: reconcile the live network, the installed fee-payment artifact, and
 * the per-network canonical descriptor (`src/private-fpc-canonical.json` for testnet,
 * `src/private-fpc-canonical-mainnet.json` for Alpha/mainnet — selected by the LIVE node's identity,
 * never a flag) before ANY fund-moving private-fuel step. The FPC address is bytecode +
 * @aztec-version + salt specific — depositing real Fee Juice to an address derived from the wrong
 * artifact is an UNRECOVERABLE loss.
 *
 *   bun packages/bridge-core/scripts/check-fpc-version.ts --mode predeploy|require-deployed
 *
 * against `TESTNET_NODE_URL`, or the node `AZTEC_NODE_URL` names.
 *
 * `--mode` is REQUIRED — callers choose consciously:
 *   - `predeploy`: a clean ABSENCE of the contract is green (the deploy script creates it).
 *   - `require-deployed`: absence is RED. MANDATORY before ANY funding, canary, or promotion —
 *     those steps must never run against a not-yet-deployed pin.
 *
 * Checks (ALL must hold — exit 1 otherwise):
 *   1. Node-version COMPAT, digest-keyed + human-curated: the live nodeVersion must appear in the
 *      descriptor's `compatibleNodeVersions[<artifactSha256>]` list. A missing entry for the
 *      installed digest is RED (a new artifact requires fresh curation, never inherited compat).
 *      The installed package version must still EXACTLY equal descriptor.aztecVersion — the
 *      compat map widens only the NODE side (e.g. a 5.0.1 artifact against the live 5.0.0 node),
 *      never which artifact we pin.
 *   1b. Network identity: live l1ChainId + rollupVersion must equal the descriptor's hard pins —
 *      a gate run against any other network is a wrong-network operator error.
 *   2. Artifact digest: sha256 of the installed artifact == descriptor.artifactSha256.
 *   3. Descriptor/constants coherence: descriptor address+salt == the exported pins.
 *   4. Live class: if the pinned address is deployed, BOTH its original AND current class ids must
 *      equal the class computed from the installed artifact (a different class at our address =
 *      wrong contract; a drifted current = upgraded-out code — never deposit). An RPC failure is
 *      an ERROR (exit 1), never treated as absence.
 *
 * Read-only, no keys. The live dust canary (pre-promotion) stays the authoritative on-net proof.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolvePackageAsset } from "@alejoamiras/nulo-resolve-asset"

import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { getContractClassFromArtifact, getContractInstanceFromInstantiationParams } from "@aztec-labs/stdlib/contract"
import { Fr } from "@aztec-labs/foundation/curves/bn254"

import { PRIVATE_FPC_ADDRESS, PRIVATE_FPC_SALT } from "../src/private-fuel"
import { TESTNET_NODE_URL } from "../src/testnet-node"

const NODE_URL = process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL

export type GateMode = "predeploy" | "require-deployed"

function parseMode(argv: string[]): GateMode {
	const i = argv.indexOf("--mode")
	const value = i >= 0 ? argv[i + 1] : undefined
	if (value === "predeploy" || value === "require-deployed") return value
	console.error("\n✗ --mode predeploy|require-deployed is REQUIRED (require-deployed before any funding/canary/promotion).")
	process.exit(1)
}

function resolvePackageFile(pkg: string, file: string): string {
	return resolvePackageAsset(pkg, file, { from: import.meta.url })
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
	const res = await fetch(NODE_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	})
	if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
	const body = (await res.json()) as { jsonrpc?: string; result?: T; error?: { message: string } }
	if (body.error) throw new Error(`${method}: RPC error — ${body.error.message}`)
	// A response with NEITHER `result` nor `error` is malformed — an ERROR, never a clean absence.
	// (Use `rpcOptional` for methods whose ABSENCE the node encodes by omitting the key.)
	if (!("result" in body)) throw new Error(`${method}: malformed RPC response (no result, no error)`)
	return body.result as T
}

/**
 * Like `rpc`, but for methods where the live node encodes "not found" by OMITTING the `result`
 * key entirely (JS `undefined` doesn't serialize — observed on the v5 testnet's
 * `node_getContract`). Absence is accepted ONLY for a well-formed JSON-RPC success envelope
 * (parsed JSON, `jsonrpc` present, no `error`); truncated or non-JSON responses still throw at
 * `res.json()`, and HTTP/RPC errors throw as before — never mistaken for absence.
 */
async function rpcOptional<T>(method: string, params: unknown[]): Promise<T | undefined> {
	const res = await fetch(NODE_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	})
	if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
	const body = (await res.json()) as { jsonrpc?: string; result?: T; error?: { message: string } }
	if (body.error) throw new Error(`${method}: RPC error — ${body.error.message}`)
	if (!("result" in body)) {
		if (body.jsonrpc !== "2.0") throw new Error(`${method}: malformed RPC response (no result, no error, no jsonrpc)`)
		return undefined
	}
	return body.result ?? undefined
}

/** Throws (never exits) so importers get a catchable failure; the CLI wrapper maps it to exit 1. */
const fail = (msg: string): never => {
	throw new Error(msg)
}

/**
 * The FPC gate as an IMPORTABLE async function — throws on any RED so a fund-moving
 * script can `await runFpcGate("require-deployed")` inline BEFORE its first broadcast,
 * closing the "operator forgot the separate --mode require-deployed command" gap.
 * The CLI at the bottom wraps it.
 */
interface FpcDescriptor {
	aztecVersion: string
	salt: string
	expectedAddress: string
	artifactSha256: string
	network: { l1ChainId: number; rollupVersion: number }
	compatibleNodeVersions: Record<string, string[] | string>
}

type LiveNodeInfo = { nodeVersion: string; l1ChainId: number; rollupVersion: number }

/** Select the descriptor whose network pins match the LIVE node (testnet vs mainnet) — never a
 *  flag, so an operator pointing at the wrong node can't pick the wrong pins. No match = STOP. */
function selectDescriptor(here: string, info: LiveNodeInfo): FpcDescriptor {
	const descriptors = ["private-fpc-canonical.json", "private-fpc-canonical-mainnet.json"].map(
		(f) => JSON.parse(readFileSync(join(here, "..", "src", f), "utf8")) as FpcDescriptor,
	)
	const descriptor = descriptors.find((d) => d.network.l1ChainId === info.l1ChainId && d.network.rollupVersion === info.rollupVersion)
	if (!descriptor) {
		// Thrown directly (not via `fail`) so TS narrows the return to a found descriptor.
		throw new Error(
			`no FPC descriptor pins the live network (l1ChainId=${info.l1ChainId}, rollupVersion=${info.rollupVersion}) — ` +
				"wrong node URL, a network reset, or a network this repo has not curated. STOP.",
		)
	}
	return descriptor
}

export async function runFpcGate(mode: GateMode): Promise<void> {
	const here = fileURLToPath(new URL(".", import.meta.url))
	const pkg = JSON.parse(readFileSync(resolvePackageFile("@alejoamiras/private-fee-juice", "package.json"), "utf8"))
	const artifactBytes = readFileSync(resolvePackageFile("@alejoamiras/private-fee-juice", "target/private_contract-PrivateFPC.json"))

	const info = await rpc<LiveNodeInfo>("node_getNodeInfo", [])
	const descriptor = selectDescriptor(here, info)

	console.log("gate mode          :", mode)
	console.log("node URL           :", NODE_URL)
	console.log("network nodeVersion:", info.nodeVersion, `(l1ChainId=${info.l1ChainId}, rollupVersion=${info.rollupVersion})`)
	console.log("installed package  :", String(pkg.version), "| descriptor:", descriptor.aztecVersion)
	console.log("pinned FPC address :", PRIVATE_FPC_ADDRESS, `(salt ${PRIVATE_FPC_SALT})`)

	const digest = await assertArtifactPins(pkg, descriptor, artifactBytes)

	assertDistArtifactCoherence(artifactBytes)

	assertNetworkCompat(descriptor, info, digest)

	await assertLiveClass(artifactBytes, mode)

	console.log(`\n✓ FPC gate green (${mode}) — compat + identity + digest + live class all agree.`)
}

/** Stages 3 + 3b + 1 + 2: descriptor/constants coherence, address re-derived from the INSTALLED
 *  artifact + canonical salt + zero deployer (without this, descriptor+constant could be coherently
 *  edited to an arbitrary absent address and still pass version+digest), exact version match, and
 *  the artifact digest — checked BEFORE the compat lookup, which is keyed by it. Returns the digest. */
async function assertArtifactPins(pkg: { version?: unknown }, descriptor: FpcDescriptor, artifactBytes: Buffer): Promise<string> {
	// 3. Descriptor/constants coherence (also machine-asserted in private-fuel.test.ts).
	if (descriptor.expectedAddress !== PRIVATE_FPC_ADDRESS || descriptor.salt !== PRIVATE_FPC_SALT) {
		fail("descriptor/constants drift — private-fpc-canonical.json disagrees with the private-fuel.ts pins.")
	}
	const rederived = (
		await getContractInstanceFromInstantiationParams(loadContractArtifact(JSON.parse(artifactBytes.toString("utf8"))), {
			constructorArgs: [],
			salt: Fr.fromHexString(PRIVATE_FPC_SALT),
			deployer: AztecAddress.ZERO,
		})
	).address.toString()
	if (rederived !== PRIVATE_FPC_ADDRESS) {
		fail(`re-derived address ${rederived} (from the installed artifact + canonical salt) != pinned ${PRIVATE_FPC_ADDRESS}.`)
	}
	// 1. Installed package must EXACTLY match the descriptor (the artifact side never widens).
	if (String(pkg.version) !== descriptor.aztecVersion) {
		fail(`installed @alejoamiras/private-fee-juice ${pkg.version} != descriptor aztecVersion ${descriptor.aztecVersion}.`)
	}
	const digest = createHash("sha256").update(artifactBytes).digest("hex")
	if (digest !== descriptor.artifactSha256) {
		fail(`installed artifact sha256 ${digest} != descriptor ${descriptor.artifactSha256}.`)
	}
	return digest
}

/** 2b. The RUNTIME-imported artifact (dist/target — what `PrivateFPCContract` actually loads)
 *  must be CORE-equal to the gated target artifact. The two copies legitimately differ only in
 *  the debug `file_map`; a divergent dist copy would let the wallet derive/execute against
 *  bytes the gate never checked. */
function assertDistArtifactCoherence(artifactBytes: Buffer): void {
	const canonicalize = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonicalize)
		if (value && typeof value === "object") {
			const out: Record<string, unknown> = {}
			for (const key of Object.keys(value as Record<string, unknown>).sort()) {
				out[key] = canonicalize((value as Record<string, unknown>)[key])
			}
			return out
		}
		return value
	}
	const coreDigest = (bytes: Buffer): string => {
		const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>
		delete parsed.file_map
		return createHash("sha256")
			.update(JSON.stringify(canonicalize(parsed)))
			.digest("hex")
	}
	const distBytes = readFileSync(resolvePackageFile("@alejoamiras/private-fee-juice", "dist/target/private_contract-PrivateFPC.json"))
	if (coreDigest(distBytes) !== coreDigest(artifactBytes)) {
		fail(
			"dist/target PrivateFPC artifact diverges from the gated target artifact (beyond file_map) — the runtime would use unchecked bytes.",
		)
	}
}

/** 1 (compat) + 1b. Digest-keyed, human-curated node compat (the live nodeVersion must be in the
 *  entry for EXACTLY this artifact digest — compat is never inherited across artifact changes;
 *  missing entry = RED) plus the hard network-identity pins. */
function assertNetworkCompat(descriptor: FpcDescriptor, info: LiveNodeInfo, digest: string): void {
	const compatEntry = descriptor.compatibleNodeVersions[digest]
	if (!Array.isArray(compatEntry)) {
		fail(`no curated compatibleNodeVersions entry for artifact digest ${digest} — re-curate the descriptor before any live use.`)
	}
	const compat = compatEntry as string[]
	if (!compat.includes(info.nodeVersion)) {
		fail(
			`network nodeVersion ${info.nodeVersion} is not in the curated compat list [${compat.join(", ")}] ` +
				"for the pinned artifact — a version bump is exactly the operation that opens the unrecoverable-deposit window.",
		)
	}
	if (info.l1ChainId !== descriptor.network.l1ChainId) {
		fail(`live l1ChainId ${info.l1ChainId} != pinned ${descriptor.network.l1ChainId} — wrong network.`)
	}
	if (info.rollupVersion !== descriptor.network.rollupVersion) {
		fail(`live rollupVersion ${info.rollupVersion} != pinned ${descriptor.network.rollupVersion} — wrong rollup (reset or fork?).`)
	}
}

/** 4. Live class at the pinned address (RPC failure = error, NOT absence). BOTH class ids must
 *  equal the expected class: checking only `original` would GREEN an UPGRADED contract — its
 *  original class stays correct while `current` points at different/malicious code that actually
 *  runs, and deposits to it can be consumed or stranded (fund loss). */
async function assertLiveClass(artifactBytes: Buffer, mode: GateMode): Promise<void> {
	const expectedClassId = (await getContractClassFromArtifact(loadContractArtifact(JSON.parse(artifactBytes.toString("utf8"))))).id
	const live = await rpcOptional<{ originalContractClassId?: string; currentContractClassId?: string }>("node_getContract", [
		PRIVATE_FPC_ADDRESS,
	])
	// (RPC failure already threw above; a malformed no-result response now throws too — never absence.)
	if (!live) {
		if (mode === "require-deployed") {
			fail(
				"the pinned address is NOT deployed and --mode require-deployed was requested — " +
					"funding/canary/promotion must never run against an undeployed pin. Deploy first (predeploy mode gates that).",
			)
		}
		console.log("live contract      : absent (clean) — deploy via deploy-private-fpc-testnet.ts")
		return
	}
	const expected = expectedClassId.toString()
	const originalClass = String(live.originalContractClassId ?? "")
	const currentClass = String(live.currentContractClassId ?? "")
	if (originalClass !== expected) {
		fail(
			`the pinned address is DEPLOYED with original class ${originalClass}, but the installed artifact ` +
				`computes ${expected} — wrong contract at our address; never deposit.`,
		)
	}
	if (currentClass !== expected) {
		fail(
			`the pinned address has been UPGRADED (current class ${currentClass} != expected ${expected}) — ` +
				"the running code is not the pinned artifact; never deposit.",
		)
	}
	console.log("live contract      : DEPLOYED with the expected class (original == current ==", `${expected})`)
}

/** True only when this file is the process entrypoint (not when imported). */
const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false
if (isMain) {
	runFpcGate(parseMode(process.argv.slice(2))).catch((err) => {
		console.error("\n✗ gate errored (treat as RED — an RPC failure is never absence):", err instanceof Error ? err.message : err)
		process.exit(1)
	})
}
