/**
 * Writes and checks a live network's generation record: the code its manifest's contracts run, taken from the
 * artifacts the generation deployed, which are kept beside the record.
 *
 *   bun packages/bridge-core/scripts/generation-record.ts write <network> [--first] [--tag <name>]
 *   bun packages/bridge-core/scripts/generation-record.ts check <network> [--candidate] [--rpc <url>]… [--node <url>] [--build-out <dir>]
 *
 * `write` records the candidate manifest in `<network>.candidate/`. An entry at an address the live record holds, as
 * committed at the merge base with origin/main, is carried byte for byte, its build included; a new one is taken from
 * `contracts/bridge/evm/out`, the build the conductor deployed, or from the committed hub target. `--first` records the
 * live manifest into a live directory that holds no record yet. A new entry's build is the merge base when every build
 * input is unchanged since it and clean; otherwise only an owner tag on HEAD, pushed to origin, names a durable commit.
 *
 * `check` holds a record to its kept artifacts (digests, pins, solc's mask shape, the hub's class) and to its
 * manifest's addresses; with `--rpc`, every deployed runtime to its pin on each endpoint; with `--node`, the hub
 * instance's class; with `--build-out`, reports which entries that build reproduces. Every read is keyless.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { loadContractArtifact } from "@aztec-labs/aztec.js/abi"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { getContractClassFromArtifact } from "@aztec-labs/aztec.js/contracts"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import {
	assertRecordBinds,
	assertRecordIntegrity,
	deployedHash,
	type GenerationRecord,
	type ImmutableSpan,
	KEPT_HUB_ARTIFACT,
	keptEvmArtifact,
	type ManifestV2,
	type PinnedContract,
	parseGenerationRecord,
	parseManifestV2,
	pinnedContractsOf,
	pinOfBuild,
	type RecordBuild,
	type RecordedContract,
	samePin,
} from "@unleashed/sdk/protocol"
import { createPublicClient, type Hex, hexToBytes, http, sha256 } from "viem"
import {
	assertRealPath,
	BUILD_INPUTS,
	GENERATION_PATHS,
	type LiveNetwork,
	liveBaseline,
	RECORD_FILE,
	RECORD_FILES,
	REPO_ROOT,
	type RecordSource,
	workingTreeRecord,
} from "./generation-paths"
import { git, run } from "./run"

export const HUB_TARGET = "contracts/bridge/aztec/token_bridge_hub/target/token_bridge_hub_contract-TokenBridgeHub.json"
const FORGE_OUT = "contracts/bridge/evm/out"

interface ForgeJson {
	abi?: unknown
	bytecode?: { object?: string }
	deployedBytecode?: { object?: string; immutableReferences?: Record<string, ImmutableSpan[]> }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const digestOf = (bytes: Uint8Array) => sha256(bytes).slice(2)
const jsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, "\t")}\n`)

/** A forge artifact without its compiler metadata, which embeds the compiler input and the checkout's paths. */
export function trimForgeArtifact(json: ForgeJson, contract: string): Buffer {
	const runtime = json.deployedBytecode
	if (!runtime?.object || runtime.object === "0x" || !json.bytecode?.object || !Array.isArray(json.abi))
		throw new Error(`${contract}: the forge artifact carries no abi, creation code or runtime — STOP`)
	const immutables = runtime.immutableReferences ? { immutableReferences: runtime.immutableReferences } : {}
	return jsonBytes({
		abi: json.abi,
		bytecode: { object: json.bytecode.object },
		deployedBytecode: { object: runtime.object, ...immutables },
	})
}

/** The pin of a kept or forge artifact's runtime. */
export function pinOfArtifact(bytes: Uint8Array) {
	const runtime = (JSON.parse(Buffer.from(bytes).toString("utf8")) as ForgeJson).deployedBytecode
	if (!runtime?.object) throw new Error("the artifact carries no runtime")
	return pinOfBuild(hexToBytes(runtime.object as Hex), runtime.immutableReferences)
}

/** What a record is composed from: the live record it carries from, the build it takes new code from, and how a new
 *  entry's build is named (asked only when one exists). */
export interface RecordInputs {
	baseline?: RecordSource
	forgeOut: string
	hubTarget: () => Buffer
	build: (side: keyof typeof BUILD_INPUTS) => RecordBuild
}

/** The record of `m` and its directory's files; the result binds `m` and derives from its files, or this throws. */
export async function composeRecord(
	m: ManifestV2,
	inputs: RecordInputs,
): Promise<{ record: GenerationRecord; files: Map<string, Buffer> }> {
	const files = new Map<string, Buffer>()
	const evm: Partial<Record<PinnedContract, RecordedContract>> = {}
	for (const [contract, address] of pinnedContractsOf(m)) {
		const kept = keptEvmArtifact(contract)
		const carried = inputs.baseline?.record.evm[contract]
		if (inputs.baseline && carried && same(carried.address, address)) {
			evm[contract] = carried
			files.set(kept, inputs.baseline.read(kept))
			continue
		}
		const forgeJson = JSON.parse(readFileSync(join(inputs.forgeOut, `${contract}.sol`, `${contract}.json`), "utf8")) as ForgeJson
		const bytes = trimForgeArtifact(forgeJson, contract)
		evm[contract] = {
			address: address.toLowerCase(),
			artifactSha256: digestOf(bytes),
			pin: pinOfArtifact(bytes),
			build: inputs.build("evm"),
		}
		files.set(kept, bytes)
	}
	let aztec: GenerationRecord["aztec"]
	if (m.bridge) {
		const address = m.bridge.l2.hub.address.toLowerCase()
		const carried = inputs.baseline?.record.aztec?.TokenBridgeHub
		if (inputs.baseline && carried && same(carried.address, address)) {
			aztec = { TokenBridgeHub: carried }
			files.set(KEPT_HUB_ARTIFACT, inputs.baseline.read(KEPT_HUB_ARTIFACT))
		} else {
			const bytes = inputs.hubTarget()
			const classId = (await getContractClassFromArtifact(loadContractArtifact(JSON.parse(bytes.toString("utf8"))))).id.toString()
			aztec = { TokenBridgeHub: { address, classId, artifactSha256: digestOf(bytes), build: inputs.build("hub") } }
			files.set(KEPT_HUB_ARTIFACT, bytes)
		}
	}
	const record = parseGenerationRecord({ schema: 1, network: m.network, l1ChainId: m.l1ChainId, evm, ...(aztec ? { aztec } : {}) })
	assertRecordBinds(record, m)
	await assertRecordIntegrity(record, (relative) => {
		const bytes = files.get(relative)
		if (!bytes) throw new Error(`${relative} was not composed`)
		return bytes
	})
	return { record, files }
}

const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** Throws unless tag `name` peels to `head` here and on origin: a tag only origin lacks keeps nothing reachable. */
export function assertTagOnHead(name: string, head: string, root: string): void {
	if (!TAG_NAME.test(name) || name.includes("..")) throw new Error(`--tag ${JSON.stringify(name)} is not a tag name — STOP`)
	const local = run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${name}^{commit}`], { cwd: root, check: false }).stdout.trim()
	if (local !== head) throw new Error(`tag ${name} does not peel to HEAD ${head.slice(0, 12)} here — STOP`)
	const lines = git(["ls-remote", "origin", `refs/tags/${name}`, `refs/tags/${name}^{}`], root)
		.split("\n")
		.map((line) => line.split("\t"))
	// An annotated tag peels through its `^{}` line; a lightweight one names the commit itself.
	const peeled = (lines.find(([, ref]) => ref === `refs/tags/${name}^{}`) ?? lines.find(([, ref]) => ref === `refs/tags/${name}`))?.[0]
	if (peeled !== head) throw new Error(`tag ${name} is not on origin at HEAD ${head.slice(0, 12)}: push it first — STOP`)
}

/**
 * The commit that names a new entry's build: the merge base with origin/main, which survives the squash merge, when
 * every build input of `side` is unchanged between it and HEAD and clean in the working tree; else HEAD, kept
 * reachable by the owner tag `tag`. Never a branch commit and never none.
 */
export function buildOf(side: keyof typeof BUILD_INPUTS, root: string, tag: string | undefined): RecordBuild {
	const inputs = BUILD_INPUTS[side]
	const dirty = git(["status", "--porcelain", "--", ...inputs], root)
	if (dirty) throw new Error(`the ${side} build inputs have uncommitted changes:\n${dirty}\n— STOP`)
	const base = git(["merge-base", "HEAD", "origin/main"], root)
	const moved = run("git", ["diff", "--quiet", base, "HEAD", "--", ...inputs], { cwd: root, check: false }).exitCode !== 0
	if (!moved) return { commit: base, tag: null }
	const head = git(["rev-parse", "HEAD"], root)
	if (!tag)
		throw new Error(
			`the ${side} build inputs moved since the merge base ${base.slice(0, 12)}: push an owner tag on HEAD and pass --tag — STOP`,
		)
	assertTagOnHead(tag, head, root)
	return { commit: head, tag }
}

/** Rewrites record directory `dir` (repo-relative): only the closed file set is removed, then the record's files are
 *  written. */
export function writeRecordDir(root: string, dir: string, record: GenerationRecord, files: ReadonlyMap<string, Buffer>): void {
	for (const relative of RECORD_FILES) {
		assertRealPath(root, `${dir}/${relative}`)
		rmSync(join(root, dir, relative), { force: true })
	}
	for (const [relative, bytes] of [...files, [RECORD_FILE, jsonBytes(record)] as const]) {
		if (!RECORD_FILES.includes(relative)) throw new Error(`${relative} is not a record file — STOP`)
		mkdirSync(dirname(join(root, dir, relative)), { recursive: true })
		writeFileSync(join(root, dir, relative), bytes)
	}
}

export interface WriteOptions {
	first?: boolean
	tag?: string
	root?: string
}

/** Writes the candidate record of `network`, or with `first` its live record when it has none. Returns the directory. */
export async function writeRecord(network: LiveNetwork, opts: WriteOptions = {}): Promise<string> {
	const root = opts.root ?? REPO_ROOT
	const paths = GENERATION_PATHS[network]
	const dir = opts.first ? paths.liveRecord : paths.candidateRecord
	if (opts.first && existsSync(join(root, paths.liveRecord, RECORD_FILE)))
		throw new Error(`${paths.liveRecord} already holds a record: --first bootstraps an empty one only — STOP`)
	const manifestPath = opts.first ? paths.liveManifest : paths.candidateManifest
	const m = parseManifestV2(JSON.parse(readFileSync(join(root, manifestPath), "utf8")))
	const base = git(["merge-base", "HEAD", "origin/main"], root)
	const { record, files } = await composeRecord(m, {
		baseline: opts.first ? undefined : liveBaseline(network, base, root),
		forgeOut: join(root, FORGE_OUT),
		hubTarget: () => readFileSync(join(root, HUB_TARGET)),
		build: (side) => buildOf(side, root, opts.tag),
	})
	writeRecordDir(root, dir, record, files)
	return dir
}

export interface CheckOptions {
	candidate?: boolean
	rpcs?: readonly string[]
	node?: string
	buildOut?: string
	root?: string
}

/** Each deployed runtime against its pin through one endpoint, which must serve the record's chain. Never prints the URL. */
async function deployedFailures(record: GenerationRecord, url: string, label: string): Promise<string[]> {
	const pub = createPublicClient({ transport: http(url) })
	const chainId = await pub.getChainId()
	if (chainId !== record.l1ChainId) return [`${label} serves chain ${chainId}, not ${record.l1ChainId}`]
	const failures: string[] = []
	for (const [contract, entry] of Object.entries(record.evm) as Array<[PinnedContract, RecordedContract]>) {
		const code = hexToBytes((await pub.getCode({ address: entry.address as Hex })) ?? "0x")
		if (deployedHash(code, entry.pin) === entry.pin.hash) console.log(`✓ ${contract} at ${entry.address} runs its pin on ${label}`)
		else failures.push(`${contract} at ${entry.address} does not run its pin on ${label} (${code.length} bytes)`)
	}
	return failures
}

async function hubFailures(record: GenerationRecord, url: string): Promise<string[]> {
	const hub = record.aztec?.TokenBridgeHub
	if (!hub) return []
	const node = createAztecNodeClient(url)
	const info = await node.getNodeInfo()
	if (info.l1ChainId !== record.l1ChainId) return [`the node runs on chain ${info.l1ChainId}, not ${record.l1ChainId}`]
	const instance = await node.getContract(AztecAddress.fromStringUnsafe(hub.address))
	const classId = instance?.currentContractClassId.toString()
	if (classId && same(classId, hub.classId)) {
		console.log(`✓ TokenBridgeHub at ${hub.address} runs class ${hub.classId}`)
		return []
	}
	return [`the hub at ${hub.address} runs class ${classId ?? "(no instance)"}, not ${hub.classId}`]
}

/** Which entries `out` (a forge build) and the committed hub target reproduce; informational, since a carried entry
 *  rebuilds only at its own build commit. */
function reportBuild(record: GenerationRecord, out: string, root: string): void {
	for (const [contract, entry] of Object.entries(record.evm) as Array<[PinnedContract, RecordedContract]>) {
		const path = join(out, `${contract}.sol`, `${contract}.json`)
		const equal = existsSync(path) && samePin(pinOfArtifact(readFileSync(path)), entry.pin)
		console.log(equal ? `✓ ${contract} equals this build` : `— ${contract} differs from this build: rebuild at ${entry.build.commit}`)
	}
	const hub = record.aztec?.TokenBridgeHub
	if (!hub) return
	const equal = digestOf(readFileSync(join(root, HUB_TARGET))) === hub.artifactSha256
	console.log(
		equal ? "✓ TokenBridgeHub equals the hub target" : `— TokenBridgeHub differs from the hub target: rebuild at ${hub.build.commit}`,
	)
}

/** Every check `opts` asks for over the network's live or candidate record; returns the failures, each already named. */
export async function checkRecord(network: LiveNetwork, opts: CheckOptions = {}): Promise<string[]> {
	const root = opts.root ?? REPO_ROOT
	const paths = GENERATION_PATHS[network]
	const source = workingTreeRecord(opts.candidate ? paths.candidateRecord : paths.liveRecord, root)
	if (!source) return [`${opts.candidate ? paths.candidateRecord : paths.liveRecord} holds no record`]
	const m = parseManifestV2(JSON.parse(readFileSync(join(root, opts.candidate ? paths.candidateManifest : paths.liveManifest), "utf8")))
	try {
		await assertRecordIntegrity(source.record, source.read)
		assertRecordBinds(source.record, m)
	} catch (e) {
		return [e instanceof Error ? e.message : String(e)]
	}
	console.log(`✓ ${source.dir}: intact, solc-shaped, and bound to ${m.network}'s manifest`)
	const failures: string[] = []
	for (const [i, url] of (opts.rpcs ?? []).entries()) failures.push(...(await deployedFailures(source.record, url, `rpc ${i + 1}`)))
	if (opts.node) failures.push(...(await hubFailures(source.record, opts.node)))
	if (opts.buildOut) reportBuild(source.record, opts.buildOut, root)
	return failures
}

const flagValue = (args: readonly string[], flag: string) => {
	const i = args.indexOf(flag)
	return i === -1 ? undefined : args[i + 1]
}

async function main(args: readonly string[]): Promise<number> {
	const [cmd, network, ...rest] = args
	if ((cmd !== "write" && cmd !== "check") || (network !== "testnet" && network !== "mainnet")) {
		console.error(
			"usage: generation-record.ts write|check testnet|mainnet [--first] [--tag <name>] [--candidate] [--rpc <url>]… [--node <url>] [--build-out <dir>]",
		)
		return 1
	}
	if (cmd === "write") {
		const dir = await writeRecord(network, { first: rest.includes("--first"), tag: flagValue(rest, "--tag") })
		console.log(`✓ wrote ${dir}/${RECORD_FILE}: commit it with its artifacts`)
		return 0
	}
	const failures = await checkRecord(network, {
		candidate: rest.includes("--candidate"),
		rpcs: rest.flatMap((arg, i) => (arg === "--rpc" && rest[i + 1] ? [rest[i + 1] as string] : [])),
		node: flagValue(rest, "--node"),
		buildOut: flagValue(rest, "--build-out"),
	})
	for (const f of failures) console.error(`✗ ${f}`)
	return failures.length === 0 ? 0 : 1
}

if (import.meta.main)
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e) => {
			console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
			process.exit(1)
		},
	)
