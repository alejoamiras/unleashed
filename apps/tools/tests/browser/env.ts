/**
 * One run's coordinates, resolved by `scripts/e2e/agent.sh` and read here by the config, the global
 * setup and the fixtures. Nothing boots in-process: the sandbox is the CLI's, the servers are
 * Playwright's `webServer`s over builds the runner produced.
 */
import { join } from "node:path"
import { PROFILES, type TestWalletProfile } from "./test-wallet/profile"

export interface RunEnv {
	/** `handle.json`, `manifest.json`, `deployments.json` — written by `sandbox:up`. */
	artifactsDir: string
	toolsPort: number
	toolsDist: string
	toolsOrigin: string
	testWalletDist: string
	/** One loopback origin per profile — the SDK's discovery probe tells wallet frames apart by
	 *  origin alone, so same-origin profiles would answer each other's probe. */
	testWalletOrigins: Record<TestWalletProfile, string>
	/** Where a run keeps its own state (ports, owned pids, traces). */
	stateDir: string
}

function required(name: string): string {
	const v = process.env[name]
	if (!v) throw new Error(`tools browser suite: ${name} is not set — run it through scripts/e2e/agent.sh`)
	return v
}

export function runEnv(): RunEnv {
	const artifactsDir = required("UNLEASHED_SANDBOX_ARTIFACTS")
	const toolsPort = Number(required("UNLEASHED_TOOLS_PORT"))
	const walletPort = (p: TestWalletProfile) => Number(required(`UNLEASHED_TEST_WALLET_PORT_${p.toUpperCase()}`))
	return {
		artifactsDir,
		toolsPort,
		toolsDist: required("UNLEASHED_TOOLS_DIST"),
		toolsOrigin: `http://127.0.0.1:${toolsPort}`,
		testWalletDist: required("UNLEASHED_TEST_WALLET_DIST"),
		testWalletOrigins: Object.fromEntries(PROFILES.map((p) => [p, `http://127.0.0.1:${walletPort(p)}`])) as Record<
			TestWalletProfile,
			string
		>,
		stateDir: process.env.UNLEASHED_E2E_STATE_DIR ?? join(artifactsDir, ".."),
	}
}

/** The wallet URLs the local tools build lists, one per profile — the strings baked into its bundle. */
export function webWalletUrls(env: Pick<RunEnv, "testWalletOrigins">): string[] {
	return PROFILES.map((p) => `${env.testWalletOrigins[p]}/?profile=${p}`)
}
