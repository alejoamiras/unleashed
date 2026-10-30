import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TESTNET_MANIFEST } from "@unleashed/sdk/networks"
import { KEPT_HUB_ARTIFACT, keptEvmArtifact, parseManifestV2 } from "@unleashed/sdk/protocol"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { GENERATION_PATHS, workingTreeRecord } from "./generation-paths"
import { buildOf, composeRecord, redactEndpoints, writeRecord } from "./generation-record"
import { git } from "./run"

const scratch = mkdtempSync(join(tmpdir(), "generation-record-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A runtime solc could have written: code, an INVALID guard, a CBOR metadata map and its length. */
const runtime = (seed: number) =>
	`0x${"60".concat(seed.toString(16).padStart(2, "0")).repeat(20)}fea264697066735822${"22".repeat(34)}64736f6c634300081c0033`

describe("composeRecord", () => {
	it("carries every live entry byte for byte, build included, and takes only a moved router from the build", async () => {
		const baseline = workingTreeRecord(GENERATION_PATHS.testnet.liveRecord)
		if (!baseline) throw new Error("the testnet record is committed")
		const candidate = structuredClone(TESTNET_MANIFEST) as { bridge: { l1: { depositRouter: string } } }
		candidate.bridge.l1.depositRouter = `0x${"d0".repeat(20)}`
		const out = join(scratch, "out")
		mkdirSync(join(out, "DepositRouter.sol"), { recursive: true })
		writeFileSync(
			join(out, "DepositRouter.sol", "DepositRouter.json"),
			JSON.stringify({
				abi: [],
				bytecode: { object: "0x6080" },
				deployedBytecode: { object: runtime(7) },
				metadata: { sources: "/x" },
			}),
		)
		const build = vi.fn(() => ({ commit: "c".repeat(40), tag: null }))
		const hubTarget = vi.fn(() => Buffer.from("{}"))
		const { record, files } = await composeRecord(parseManifestV2(candidate), { baseline, forgeOut: out, hubTarget, build })

		for (const c of ["PortalFactory", "TokenPortalImpl", "TestnetFuelSwapper"] as const) {
			expect(record.evm[c]).toEqual(baseline.record.evm[c])
			expect(files.get(keptEvmArtifact(c))?.equals(baseline.read(keptEvmArtifact(c)))).toBe(true)
		}
		expect(record.aztec).toEqual(baseline.record.aztec)
		expect(files.get(KEPT_HUB_ARTIFACT)?.equals(baseline.read(KEPT_HUB_ARTIFACT))).toBe(true)
		expect(record.evm.DepositRouter).toMatchObject({ address: `0x${"d0".repeat(20)}`, build: { commit: "c".repeat(40), tag: null } })
		expect(files.get(keptEvmArtifact("DepositRouter"))?.toString()).not.toContain("metadata")
		expect(build.mock.calls).toEqual([["evm"]])
		expect(hubTarget).not.toHaveBeenCalled()
	})
})

describe("a new entry's build commit", () => {
	const origin = join(scratch, "origin.git")
	const repo = join(scratch, "repo")
	const env = { ...process.env }
	const g = (...args: string[]) => git(args, repo)
	const commitAll = (message: string) => {
		g("add", "-A")
		g("commit", "-q", "-m", message)
		return g("rev-parse", "HEAD")
	}

	beforeAll(() => {
		// A host's global config may sign every commit; the fixture repository needs none of it.
		writeFileSync(join(scratch, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n")
		Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" })
		git(["init", "-q", "--bare", origin], scratch)
		git(["init", "-q", "-b", "main", repo], scratch)
		mkdirSync(join(repo, "contracts/bridge/evm/src"), { recursive: true })
		writeFileSync(join(repo, "contracts/bridge/evm/src/R.sol"), "contract R {}\n")
		commitAll("init")
		g("remote", "add", "origin", origin)
		g("push", "-q", "origin", "main")
		g("checkout", "-q", "-b", "arc")
	})
	afterAll(() => {
		process.env = env
	})

	it("is the merge base while the inputs are unchanged, and needs an owner tag on HEAD and origin once they move", () => {
		const base = g("rev-parse", "origin/main")
		writeFileSync(join(repo, "notes.md"), "not an input\n")
		commitAll("docs")
		expect(buildOf("evm", repo, undefined)).toEqual({ commit: base, tag: null })

		writeFileSync(join(repo, "contracts/bridge/evm/src/R.sol"), "contract R { uint x; }\n")
		expect(() => buildOf("evm", repo, undefined)).toThrow(/uncommitted changes/)
		const head = commitAll("source edit")
		expect(() => buildOf("evm", repo, undefined)).toThrow(/push an owner tag/)
		g("tag", "-a", "-m", "release", "gen-test")
		expect(() => buildOf("evm", repo, "gen-test")).toThrow(/not on origin/)
		g("push", "-q", "origin", "gen-test")
		expect(buildOf("evm", repo, "gen-test")).toEqual({ commit: head, tag: "gen-test" })
		expect(() => buildOf("evm", repo, "--upload-pack=x")).toThrow(/not a tag name/)
	})
})

describe("writeRecord --first", () => {
	it("refuses a live directory that already holds a record", async () => {
		const root = join(scratch, "bootstrapped")
		mkdirSync(join(root, GENERATION_PATHS.testnet.liveRecord), { recursive: true })
		writeFileSync(join(root, GENERATION_PATHS.testnet.liveRecord, "record.json"), "{}")
		await expect(writeRecord("testnet", { first: true, root })).rejects.toThrow(/already holds a record/)
	})
})

describe("check's printed failures", () => {
	it("never name an endpoint passed on the command line", () => {
		const args = ["check", "testnet", "--rpc", "https://rpc.example/key-1", "--node", "https://node.example/key-2"]
		const printed = redactEndpoints(args, "HTTP request failed. URL: https://rpc.example/key-1 then https://node.example/key-2")
		expect(printed).toBe("HTTP request failed. URL: <endpoint 1> then <endpoint 2>")
		const prefixed = ["check", "testnet", "--rpc", "https://rpc.example", "--rpc", "https://rpc.example/key-1"]
		expect(redactEndpoints(prefixed, "URL: https://rpc.example/key-1")).toBe("URL: <endpoint 2>")
	})
})
