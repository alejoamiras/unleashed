import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { tokenBridgeHubArtifact } from "@unleashed/sdk/artifacts"
import { TESTNET_MANIFEST } from "@unleashed/sdk/networks"
import { parseManifestV2 } from "@unleashed/sdk/protocol"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { assertFaucetCandidateShape } from "../src/promotion"
import { GENERATION_PATHS, hubArtifactFor, liveBaseline, RECORD_FILES, REPO_ROOT, workingTreeRecord } from "./generation-paths"
import { assertCarried, candidateOf, writeLiveRecord } from "./live-intent"
import { git } from "./run"

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>()
	return { ...real, renameSync: vi.fn(real.renameSync), rmSync: vi.fn(real.rmSync) }
})
// This checkout's hub sources moved since the live generation deployed: its target has another class.
vi.mock("@unleashed/sdk/artifacts", async (importOriginal) => {
	const real = (await importOriginal<typeof import("@unleashed/sdk/artifacts")>()).tokenBridgeHubArtifact
	return { tokenBridgeHubArtifact: { ...real, name: `${real.name}Edited` } }
})
// mockReset restores the real implementation each vi.fn wraps.
afterEach(() => {
	vi.mocked(renameSync).mockReset()
	vi.mocked(rmSync).mockReset()
})

const scratch = mkdtempSync(join(tmpdir(), "live-intent-record-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const LIVE = GENERATION_PATHS.testnet.liveRecord
const CANDIDATE = GENERATION_PATHS.testnet.candidateRecord
const at = (root: string, dir: string, file: string) => join(root, dir, file)
const editJson = (path: string, edit: (json: Record<string, Record<string, Record<string, unknown>>>) => void) => {
	const json = JSON.parse(readFileSync(path, "utf8"))
	edit(json)
	writeFileSync(path, `${JSON.stringify(json, null, "\t")}\n`)
}

describe("the carry rule's baseline", () => {
	const repo = join(scratch, "repo")
	const env = { ...process.env }
	let beforeRecord = ""
	let build = ""

	beforeAll(() => {
		writeFileSync(join(scratch, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n")
		Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" })
		git(["init", "-q", "-b", "main", repo], scratch)
		writeFileSync(join(repo, "README"), "x\n")
		git(["add", "-A"], repo)
		git(["commit", "-q", "-m", "init"], repo)
		beforeRecord = git(["rev-parse", "HEAD"], repo)
		cpSync(join(REPO_ROOT, LIVE), join(repo, LIVE), { recursive: true })
		git(["add", "-A"], repo)
		git(["commit", "-q", "-m", "record"], repo)
		build = git(["rev-parse", "HEAD"], repo)
		// After the build: a candidate that exists only in the working tree, and an interrupted run that already
		// rewrote part of the live directory.
		cpSync(join(repo, LIVE), join(repo, CANDIDATE), { recursive: true })
		editJson(at(repo, CANDIDATE, "record.json"), (r) => {
			r.evm.DepositRouter = { ...r.evm.DepositRouter, address: `0x${"d0".repeat(20)}`, build: { commit: "c".repeat(40), tag: null } }
		})
		editJson(at(repo, LIVE, "record.json"), (r) => {
			r.evm.PortalFactory = { ...r.evm.PortalFactory, build: { commit: "e".repeat(40), tag: null } }
		})
		writeFileSync(at(repo, LIVE, "evm/TokenPortalImpl.sol/TokenPortalImpl.json"), "{}")
	})
	afterAll(() => {
		process.env = env
	})

	const candidate = () => workingTreeRecord(CANDIDATE, repo) as NonNullable<ReturnType<typeof workingTreeRecord>>

	it("is the live record committed at the build, whatever the working tree's live files now hold", () => {
		expect(() => assertCarried(candidate(), liveBaseline("testnet", build, repo))).not.toThrow()
		expect(liveBaseline("testnet", beforeRecord, repo)).toBeUndefined()
	})

	it("refuses a candidate that copies the rewritten live entry, and one whose carried artifact moved by a byte", () => {
		editJson(at(repo, CANDIDATE, "record.json"), (r) => {
			r.evm.PortalFactory = { ...r.evm.PortalFactory, build: { commit: "e".repeat(40), tag: null } }
		})
		expect(() => assertCarried(candidate(), liveBaseline("testnet", build, repo))).toThrow(
			/PortalFactory .* is not the live record's entry/,
		)
		writeFileSync(at(repo, CANDIDATE, "record.json"), liveBaseline("testnet", build, repo)?.read("record.json") ?? "")
		const kept = at(repo, CANDIDATE, "evm/TestnetFuelSwapper.sol/TestnetFuelSwapper.json")
		writeFileSync(kept, `${readFileSync(kept, "utf8")} `)
		expect(() => assertCarried(candidate(), liveBaseline("testnet", build, repo))).toThrow(
			/TestnetFuelSwapper .* is not the live record's entry/,
		)
	})
})

describe("a router-only candidate whose carried hub this checkout no longer builds", () => {
	it("derives its tokens from the record's kept hub artifact; this checkout's target refuses them", async () => {
		const record = workingTreeRecord(LIVE)
		if (!record) throw new Error("the testnet record is committed")
		const raw = structuredClone(TESTNET_MANIFEST) as { bridge: { l1: { depositRouter: string } } }
		raw.bridge.l1.depositRouter = `0x${"d0".repeat(20)}`
		const m = await candidateOf({}, JSON.stringify(raw), record)
		expect(m.bridge?.l1.depositRouter).toBe(`0x${"d0".repeat(20)}`)
		expect(hubArtifactFor(parseManifestV2(raw)).name).toBe("TokenBridgeHub")
		expect(tokenBridgeHubArtifact.name).toBe("TokenBridgeHubEdited")
		await expect(assertFaucetCandidateShape(raw, tokenBridgeHubArtifact)).rejects.toThrow(/not the instantiation of its own record/)
	})
})

describe("promote's record write", () => {
	const DIR = "generations/testnet"
	const OLD: Record<string, string> = {
		"record.json": "old record",
		"evm/DepositRouter.sol/DepositRouter.json": "old router",
		"evm/TokenPortalImpl.sol/TokenPortalImpl.json": "old impl",
		"aztec/TokenBridgeHub.json": "old hub",
		"NOTES.md": "not a record file",
	}
	const NEW = new Map(
		Object.entries({
			"evm/DepositRouter.sol/DepositRouter.json": "new router",
			"evm/PortalFactory.sol/PortalFactory.json": "new factory",
			"record.json": "new record",
		}).map(([f, s]) => [f, Buffer.from(s)]),
	)
	const rootWithOld = (name: string) => {
		const root = join(scratch, name)
		for (const [f, s] of Object.entries(OLD)) {
			mkdirSync(join(root, DIR, f, ".."), { recursive: true })
			writeFileSync(join(root, DIR, f), s)
		}
		return root
	}
	const files = (root: string): Record<string, string> => {
		const out: Record<string, string> = {}
		const walk = (d: string) => {
			for (const e of readdirSync(d, { withFileTypes: true }))
				if (e.isDirectory()) walk(join(d, e.name))
				else out[relative(join(root, DIR), join(d, e.name))] = readFileSync(join(d, e.name), "utf8")
		}
		walk(join(root, DIR))
		return out
	}
	const expected = { ...Object.fromEntries([...NEW].map(([f, b]) => [f, b.toString()])), "NOTES.md": "not a record file" }

	it("lands the candidate's set exactly, record.json after every artifact and stale files after it", () => {
		const root = rootWithOld("clean")
		writeLiveRecord(DIR, NEW, root)
		expect(files(root)).toEqual(expected)
		const rename = vi.mocked(renameSync).mock
		expect(relative(join(root, DIR), String(rename.calls.at(-1)?.[1]))).toBe("record.json")
		const rm = vi.mocked(rmSync).mock
		const deletions = rm.invocationCallOrder.filter((_, i) => !String(rm.calls[i]?.[0]).endsWith(".promote-tmp"))
		expect(deletions).toHaveLength(RECORD_FILES.length - NEW.size)
		expect(Math.min(...deletions)).toBeGreaterThan(rename.invocationCallOrder.at(-1) as number)
	})

	it("re-run after an interrupted artifact write converges, and the interrupted run never moved record.json", () => {
		const root = rootWithOld("artifact")
		const real = vi.mocked(renameSync).getMockImplementation() as typeof renameSync
		vi.mocked(renameSync)
			.mockImplementationOnce(real)
			.mockImplementationOnce(() => {
				throw new Error("killed")
			})
		expect(() => writeLiveRecord(DIR, NEW, root)).toThrow("killed")
		expect(readFileSync(join(root, DIR, "record.json"), "utf8")).toBe("old record")
		writeLiveRecord(DIR, NEW, root)
		expect(files(root)).toEqual(expected)
	})

	it("re-run after an interrupted deletion converges", () => {
		const root = rootWithOld("deletion")
		const real = vi.mocked(rmSync).getMockImplementation() as typeof rmSync
		vi.mocked(rmSync).mockImplementation((path, opts) => {
			if (String(path).endsWith("aztec/TokenBridgeHub.json")) throw new Error("killed")
			real(path, opts)
		})
		expect(() => writeLiveRecord(DIR, NEW, root)).toThrow("killed")
		expect(readFileSync(join(root, DIR, "record.json"), "utf8")).toBe("new record")
		expect(existsSync(join(root, DIR, "aztec/TokenBridgeHub.json"))).toBe(true)
		vi.mocked(rmSync).mockReset()
		writeLiveRecord(DIR, NEW, root)
		expect(files(root)).toEqual(expected)
	})
})
