/**
 * The one process primitive for bridge-core's operator scripts: argv arrays only (never a shell
 * string), utf8 text, throw-by-default with `check: false` for callers that interpret failure
 * themselves. It adds nothing from argv to a failure — `cast` receives the deployer key as an
 * argument; Node's own spawn error carries argv as an enumerable `spawnargs`, and its synchronous
 * ERR_INVALID_ARG_VALUE throw (a NUL byte in an argument) echoes the offending value. Outside that
 * guarantee: the child's own stdout/stderr are kept verbatim, argv is visible to `ps` while the
 * child runs, and the environment is inherited.
 */

import { type SpawnSyncOptions, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

export interface RunOptions {
	cwd?: string
	env?: NodeJS.ProcessEnv
	stdio?: SpawnSyncOptions["stdio"]
	maxBuffer?: number
	/** `false` returns the result for any outcome; the default throws `RunError` on anything but exit 0. */
	check?: boolean
}

export interface RunResult {
	exitCode: number | null
	signal: NodeJS.Signals | null
	stdout: string
	stderr: string
	/** The spawn error's code (`ENOENT`, `ENOBUFS`, …) when the process could not run to completion. */
	code?: string
}

const STDERR_TAIL = 4000
/** Reason for a synchronous `spawnSync` throw (argument validation); the thrown error is discarded. */
const INVALID_ARGUMENT = "EINVAL_ARG"

export class RunError extends Error {
	readonly bin: string
	readonly argc: number
	readonly exitCode: number | null
	readonly signal: NodeJS.Signals | null
	readonly stdout: string
	readonly stderr: string
	readonly code?: string

	constructor(bin: string, argc: number, result: RunResult) {
		const reason =
			result.code === INVALID_ARGUMENT
				? "invalid argument"
				: result.code
					? `spawn error ${result.code}`
					: result.signal
						? `signal ${result.signal}`
						: `exit ${result.exitCode}`
		const stderr = result.stderr.trim()
		const tail = stderr.length > STDERR_TAIL ? `…${stderr.slice(-STDERR_TAIL)}` : stderr
		super(`${bin} failed (${reason})${tail ? `: ${tail}` : ""}`)
		this.name = "RunError"
		this.bin = bin
		this.argc = argc
		this.exitCode = result.exitCode
		this.signal = result.signal
		this.stdout = result.stdout
		this.stderr = result.stderr
		if (result.code !== undefined) this.code = result.code
	}
}

export function run(bin: string, args: readonly string[], opts: RunOptions = {}): RunResult {
	const { check = true, ...spawnOpts } = opts
	let result: RunResult
	try {
		const res = spawnSync(bin, [...args], { ...spawnOpts, encoding: "utf8" })
		const code = (res.error as NodeJS.ErrnoException | undefined)?.code
		result = {
			exitCode: res.status,
			signal: res.signal,
			stdout: res.stdout ?? "",
			stderr: res.stderr ?? "",
			...(res.error ? { code: code ?? res.error.name } : {}),
		}
	} catch {
		result = { exitCode: null, signal: null, stdout: "", stderr: "", code: INVALID_ARGUMENT }
	}
	if (check && (result.code !== undefined || result.signal !== null || result.exitCode !== 0)) {
		throw new RunError(bin, args.length, result)
	}
	return result
}

export interface ResolveBinOptions {
	/** Environment variable whose value, when set, is used verbatim. */
	envVar: string
	/** Absolute paths tried with `existsSync`, in order. */
	candidates: readonly string[]
	/** Whether the PATH probe (`<name> --version`) runs before or after the candidates. */
	prefer: "path" | "candidates"
}

/** Locate an external binary; the winning form is returned as given (a path or the bare name). */
export function resolveBin(name: string, opts: ResolveBinOptions): string {
	const override = process.env[opts.envVar]
	if (override) return override
	const onPath = () => run(name, ["--version"], { check: false, stdio: "ignore" }).exitCode === 0
	if (opts.prefer === "path" && onPath()) return name
	const candidate = opts.candidates.find((p) => existsSync(p))
	if (candidate) return candidate
	if (opts.prefer === "candidates" && onPath()) return name
	throw new Error(`${name} not found — set ${opts.envVar}, install it on PATH, or provide one of: ${opts.candidates.join(", ")}`)
}

export function git(args: readonly string[], cwd: string): string {
	return run("git", args, { cwd }).stdout.trim()
}
