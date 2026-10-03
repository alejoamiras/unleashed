import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { git, resolveBin, run, RunError } from "./run"

// The engine running this test is the scripted child, so every case runs under Node and under Bun.
const engine = process.execPath
const SECRET = "0xSENTINEL-PRIVATE-KEY-deadbeef"

function capture(fn: () => unknown): RunError {
	try {
		fn()
	} catch (e) {
		if (e instanceof RunError) return e
		throw e
	}
	throw new Error("expected a RunError")
}

function assertNoSecret(err: RunError): void {
	for (const surface of [err.message, err.stack ?? "", inspect(err), JSON.stringify(err)]) {
		expect(surface).not.toContain(SECRET)
	}
}

describe("run", () => {
	test("captures stdout/stderr and exit 0", () => {
		const res = run(engine, ["-e", "process.stdout.write('out'); process.stderr.write('err')"])
		expect(res).toEqual({ exitCode: 0, signal: null, stdout: "out", stderr: "err" })
	})

	test("throws RunError with the exit code and the stderr tail on a non-zero exit", () => {
		const err = capture(() => run(engine, ["-e", "process.stderr.write('boom'); process.exit(3)"]))
		expect(err.exitCode).toBe(3)
		expect(err.stderr).toBe("boom")
		expect(err.message).toContain("failed (exit 3): boom")
	})

	test("check: false returns the failing result instead of throwing", () => {
		expect(run(engine, ["-e", "process.exit(7)"], { check: false })).toEqual({ exitCode: 7, signal: null, stdout: "", stderr: "" })
	})

	test("names the binary and the code on a spawn failure", () => {
		const err = capture(() => run("definitely-not-a-binary-xyz", ["--version"]))
		expect(err.message).toBe("definitely-not-a-binary-xyz failed (spawn error ENOENT)")
		expect(err.code).toBe("ENOENT")
		expect(run("definitely-not-a-binary-xyz", [], { check: false }).code).toBe("ENOENT")
	})

	test("reports signal death", () => {
		const err = capture(() => run(engine, ["-e", "process.kill(process.pid, 'SIGKILL')"]))
		expect(err.signal).toBe("SIGKILL")
		expect(err.message).toContain("failed (signal SIGKILL)")
	})

	test("maxBuffer overflow is a failure", () => {
		const err = capture(() => run(engine, ["-e", "process.stdout.write('x'.repeat(100000))"], { maxBuffer: 1024 }))
		expect(err.code).toBe("ENOBUFS")
	})

	test("never formats or retains argv: non-zero child", () => {
		const err = capture(() => run(engine, ["-e", "process.exit(2)", "--private-key", SECRET]))
		expect(err.argc).toBe(4)
		assertNoSecret(err)
	})

	test("never formats or retains argv: spawn failure", () => {
		const err = capture(() => run("definitely-not-a-binary-xyz", ["--private-key", SECRET]))
		expect(err.code).toBe("ENOENT")
		assertNoSecret(err)
	})

	test("never formats or retains argv: the check: false result carries only status and child text", () => {
		const res = run("definitely-not-a-binary-xyz", ["--private-key", SECRET], { check: false })
		expect(Object.keys(res).sort()).toEqual(["code", "exitCode", "signal", "stderr", "stdout"])
		for (const surface of [inspect(res), JSON.stringify(res)]) expect(surface).not.toContain(SECRET)
	})

	test("never formats or retains argv: an argument the spawn call rejects synchronously", () => {
		// A NUL byte makes the spawn call throw ERR_INVALID_ARG_VALUE, whose message echoes the value.
		const err = capture(() => run(engine, ["-e", "process.exit(0)", `${SECRET}${String.fromCharCode(0)}x`]))
		expect(err.message).toBe(`${engine} failed (invalid argument)`)
		expect(err.code).toBe("EINVAL_ARG")
		assertNoSecret(err)
	})
})

describe("resolveBin", () => {
	const dir = mkdtempSync(join(tmpdir(), "run-test-"))
	// The ambient environment must not steer these cases: both variables are cleared for the block
	// and restored afterwards.
	const saved = { RUN_TEST_BIN: process.env.RUN_TEST_BIN, RUN_TEST_UNSET: process.env.RUN_TEST_UNSET }
	beforeAll(() => {
		delete process.env.RUN_TEST_BIN
		delete process.env.RUN_TEST_UNSET
	})
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true })
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	})

	test("the env override wins verbatim", () => {
		process.env.RUN_TEST_BIN = "/opt/somewhere/tool"
		try {
			expect(resolveBin("git", { envVar: "RUN_TEST_BIN", candidates: [], prefer: "path" })).toBe("/opt/somewhere/tool")
		} finally {
			delete process.env.RUN_TEST_BIN
		}
	})

	test("prefer: candidates picks the first existing candidate before PATH", () => {
		const fake = join(dir, "git")
		writeFileSync(fake, "#!/bin/sh\nexit 0\n")
		chmodSync(fake, 0o755)
		expect(resolveBin("git", { envVar: "RUN_TEST_UNSET", candidates: [join(dir, "missing"), fake], prefer: "candidates" })).toBe(fake)
	})

	test("prefer: path returns the bare name when the PATH probe succeeds", () => {
		expect(resolveBin("git", { envVar: "RUN_TEST_UNSET", candidates: [join(dir, "missing")], prefer: "path" })).toBe("git")
	})

	test("falls back to PATH after the candidates, and fails loudly when nothing resolves", () => {
		expect(resolveBin("git", { envVar: "RUN_TEST_UNSET", candidates: [join(dir, "missing")], prefer: "candidates" })).toBe("git")
		expect(() =>
			resolveBin("no-such-tool-xyz", { envVar: "RUN_TEST_UNSET", candidates: [join(dir, "missing")], prefer: "candidates" }),
		).toThrow(/no-such-tool-xyz not found — set RUN_TEST_UNSET/)
	})
})

describe("git", () => {
	test("returns trimmed stdout and honours --end-of-options", () => {
		expect(git(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], process.cwd())).toMatch(/^[0-9a-f]{40}$/)
	})
})
