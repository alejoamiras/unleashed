/**
 * Where each live network's bridge manifests and generation records live, and how a record is read: from the working
 * tree for the manifest that names it, or from git at a revision for a baseline nothing uncommitted can move. A
 * sandbox chain runs the sources at hand, so its code is this checkout's pins and hub target; a live chain's code is
 * only ever its committed record's.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ContractArtifact, loadContractArtifact } from "@aztec-labs/aztec.js/abi"
import { tokenBridgeHubArtifact } from "@unleashed/sdk/artifacts"
import {
	assertRecordBinds,
	CODE_PINS,
	type CodePin,
	type GenerationRecord,
	KEPT_HUB_ARTIFACT,
	keptEvmArtifact,
	type ManifestV2,
	type PinnedContract,
	parseGenerationRecord,
	pinsOf,
	SANDBOX_LIFI_CHAIN_IDS,
} from "@unleashed/sdk/protocol"
import { run } from "./run"

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(here, "..", "..", "..")

export type LiveNetwork = "testnet" | "mainnet"

/** One live network's L1 chain and the repo-relative paths of its manifest pair and record pair. */
export interface GenerationPaths {
	l1ChainId: number
	liveManifest: string
	candidateManifest: string
	liveRecord: string
	candidateRecord: string
}

export const GENERATION_PATHS: Readonly<Record<LiveNetwork, GenerationPaths>> = {
	testnet: {
		l1ChainId: 11155111,
		liveManifest: "apps/tools/public/testnet-bridge.json",
		candidateManifest: "apps/tools/public/testnet-bridge.candidate.json",
		liveRecord: "contracts/bridge/generations/testnet",
		candidateRecord: "contracts/bridge/generations/testnet.candidate",
	},
	mainnet: {
		l1ChainId: 1,
		liveManifest: "apps/tools/public/mainnet-bridge.json",
		candidateManifest: "apps/tools/public/mainnet-bridge.candidate.json",
		liveRecord: "contracts/bridge/generations/mainnet",
		candidateRecord: "contracts/bridge/generations/mainnet.candidate",
	},
}

export const RECORD_FILE = "record.json"

const PINNED: readonly PinnedContract[] = ["DepositRouter", "PortalFactory", "TokenPortalImpl", "FuelOnlyGate", "TestnetFuelSwapper"]

/** Every file a record directory may hold, relative to it; promotion writes and deletes nothing else. */
export const RECORD_FILES: readonly string[] = [RECORD_FILE, ...PINNED.map(keptEvmArtifact), KEPT_HUB_ARTIFACT]

/**
 * The inputs whose bytes decide a build, by side: what `setup-forge` digests for its cache key minus the tests, and
 * the Noir sources minus the TXE server. An entry's build commit stands for a deployment only while these match it.
 */
export const BUILD_INPUTS: Readonly<Record<"evm" | "hub", readonly string[]>> = {
	evm: [
		"contracts/bridge/evm/src",
		"contracts/bridge/evm/lifi-build",
		"contracts/bridge/evm/foundry.toml",
		".github/actions/setup-forge/action.yml",
		"bun.lock",
		"packages/bridge-core/scripts/gen-remappings.ts",
	],
	hub: ["contracts/bridge/aztec", ":(exclude)contracts/bridge/aztec/txe-server"],
}

/** A record and its directory's files, read from one place: the working tree or one git revision. */
export interface RecordSource {
	/** Repo-relative. */
	dir: string
	record: GenerationRecord
	read(relative: string): Buffer
}

/** The live network a chain belongs to, or undefined off the chains this release records. */
export function liveNetworkOf(l1ChainId: number): LiveNetwork | undefined {
	return (Object.keys(GENERATION_PATHS) as LiveNetwork[]).find((n) => GENERATION_PATHS[n].l1ChainId === l1ChainId)
}

/** Refuses a symlink at `relative` or any directory on the way to it from `root`: one would redirect a record's
 *  reads and its atomic renames outside the tree. A component that does not exist yet passes. */
export function assertRealPath(root: string, relative: string): void {
	let path = root
	for (const part of relative.split("/")) {
		path = join(path, part)
		if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`refusing a symlinked record path: ${path} — STOP`)
	}
}

/** The record in working-tree directory `dir` (repo-relative), or undefined when it holds none. */
export function workingTreeRecord(dir: string, root = REPO_ROOT): RecordSource | undefined {
	assertRealPath(root, `${dir}/${RECORD_FILE}`)
	if (!existsSync(join(root, dir, RECORD_FILE))) return undefined
	const read = (relative: string) => {
		assertRealPath(root, `${dir}/${relative}`)
		return readFileSync(join(root, dir, relative))
	}
	return { dir, record: parseGenerationRecord(JSON.parse(read(RECORD_FILE).toString("utf8"))), read }
}

/** A blob at `rev`, byte for byte; undefined when the path is absent there. */
function blobAt(rev: string, path: string, root: string): Buffer | undefined {
	const object = `${rev}:${path}`
	if (run("git", ["cat-file", "-e", object], { cwd: root, check: false }).exitCode !== 0) return undefined
	// The hub artifact is megabytes; spawnSync's default buffer is one.
	return Buffer.from(run("git", ["cat-file", "blob", object], { cwd: root, maxBuffer: 64 << 20 }).stdout, "utf8")
}

/** The live record of `network` as committed at `rev`, or undefined when none was. A baseline is never read from the
 *  working tree: the live directory is an operational path a run may have rewritten. */
export function liveBaseline(network: LiveNetwork, rev: string, root = REPO_ROOT): RecordSource | undefined {
	const dir = GENERATION_PATHS[network].liveRecord
	const raw = blobAt(rev, `${dir}/${RECORD_FILE}`, root)
	if (!raw) return undefined
	const read = (relative: string) => {
		const blob = blobAt(rev, `${dir}/${relative}`, root)
		if (!blob) throw new Error(`${dir}/${relative} is not committed at ${rev} — STOP`)
		return blob
	}
	return { dir, record: parseGenerationRecord(JSON.parse(raw.toString("utf8"))), read }
}

/** The working-tree record that binds `m`: the live one for the live manifest, the candidate one for a candidate.
 *  Throws, naming each directory's reason, when none does. */
export function recordFor(m: ManifestV2, root = REPO_ROOT): RecordSource {
	const network = liveNetworkOf(m.l1ChainId)
	if (!network) throw new Error(`chain ${m.l1ChainId} has no committed generation record — STOP`)
	const why: string[] = []
	for (const dir of [GENERATION_PATHS[network].liveRecord, GENERATION_PATHS[network].candidateRecord]) {
		const source = workingTreeRecord(dir, root)
		if (!source) {
			why.push(`${dir}: no record`)
			continue
		}
		try {
			assertRecordBinds(source.record, m)
			return source
		} catch (e) {
			why.push(`${dir}: ${e instanceof Error ? e.message : String(e)}`)
		}
	}
	throw new Error(`no generation record binds the ${m.network} manifest — ${why.join("; ")} — STOP`)
}

/** What a manifest's generation runs, as the tooling checks and derives with it. */
export interface GenerationCodeOnDisk {
	pins: Readonly<Partial<Record<PinnedContract, CodePin>>>
	/** Absent on a sandbox chain. */
	source?: RecordSource
	/** The hub artifact the generation deployed; throws for a generation with no hub. */
	hubArtifact(): ContractArtifact
}

/** A live chain's record from the working tree, or this checkout's pins and hub target on a sandbox chain; refuses a
 *  live chain no record binds and any other chain. */
export function codeFor(m: ManifestV2, root = REPO_ROOT): GenerationCodeOnDisk {
	if (liveNetworkOf(m.l1ChainId)) {
		const source = recordFor(m, root)
		let hub: ContractArtifact | undefined
		return {
			pins: pinsOf(source.record),
			source,
			hubArtifact: () => {
				if (!source.record.aztec) throw new Error(`the ${m.network} generation has no hub — STOP`)
				hub ??= loadContractArtifact(JSON.parse(source.read(KEPT_HUB_ARTIFACT).toString("utf8")))
				return hub
			},
		}
	}
	if (SANDBOX_LIFI_CHAIN_IDS.includes(m.l1ChainId)) return { pins: CODE_PINS, hubArtifact: () => tokenBridgeHubArtifact }
	throw new Error(`chain ${m.l1ChainId} is neither a live network nor a sandbox — STOP`)
}

/**
 * The artifact `m`'s hub was deployed from, for registering it with a wallet: the kept artifact of the live or
 * candidate record that names that hub, else (a sandbox chain, or a hub this arc deploys before its record is
 * written) this checkout's hub target. The hub's address commits to its class, so a caller that derives the address
 * from the artifact refuses a wrong one.
 */
export function hubArtifactFor(m: ManifestV2, root = REPO_ROOT): ContractArtifact {
	const hub = m.bridge?.l2.hub.address
	if (!hub) throw new Error(`the ${m.network} manifest has no hub — STOP`)
	const network = liveNetworkOf(m.l1ChainId)
	const dirs = network ? [GENERATION_PATHS[network].liveRecord, GENERATION_PATHS[network].candidateRecord] : []
	for (const dir of dirs) {
		const source = workingTreeRecord(dir, root)
		const kept = source?.record.aztec?.TokenBridgeHub
		if (source && kept && kept.address === hub.toLowerCase())
			return loadContractArtifact(JSON.parse(source.read(KEPT_HUB_ARTIFACT).toString("utf8")))
	}
	return tokenBridgeHubArtifact
}
