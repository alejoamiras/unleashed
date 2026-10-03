import { defineConfig, devices } from "@playwright/test"
import { runEnv } from "./env"
import { PROFILES } from "./test-wallet/profile"

const env = runEnv()
const here = new URL(".", import.meta.url).pathname
const appRoot = new URL("../../", import.meta.url).pathname

/**
 * One sandbox, one browser, one worker: every spec file owns a context, every test a fresh actor,
 * and parallelism is `--shard` (each shard is its own `agent.sh` run with its own sandbox).
 */
export default defineConfig({
	testDir: `${here}specs`,
	globalSetup: `${here}global-setup.ts`,
	workers: 1,
	fullyParallel: false,
	retries: Number(process.env.UNLEASHED_E2E_RETRIES ?? 0),
	timeout: 10 * 60_000,
	expect: { timeout: 60_000 },
	reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: `${env.stateDir}/playwright-report` }]] : "list",
	outputDir: `${env.stateDir}/test-results`,
	use: {
		...devices["Desktop Chrome"],
		baseURL: env.toolsOrigin,
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
		video: "off",
		// The suite never leaves the machine; a slow sandbox block is the only thing worth waiting for.
		actionTimeout: 60_000,
		navigationTimeout: 60_000,
	},
	projects: [{ name: "chromium", use: { channel: undefined } }],
	webServer: [
		{
			// The PRODUCTION-mode local build, served at the exact host its integrity check names.
			command: `bun run --cwd ${appRoot} vite preview --config vite.local.config.mts --outDir ${env.toolsDist} --host 127.0.0.1 --port ${env.toolsPort} --strictPort`,
			url: `${env.toolsOrigin}/build.json`,
			reuseExistingServer: false,
			timeout: 60_000,
			env: {
				UNLEASHED_SANDBOX_ARTIFACTS: env.artifactsDir,
				UNLEASHED_TOOLS_WEB_WALLETS: process.env.UNLEASHED_TOOLS_WEB_WALLETS ?? "",
			},
		},
		// The one wallet build, served once per profile so each has its own origin.
		...PROFILES.map((profile) => ({
			command: `bun run --cwd ${appRoot} vite preview --config tests/browser/test-wallet/vite.config.mts --outDir ${env.testWalletDist} --host 127.0.0.1 --port ${new URL(env.testWalletOrigins[profile]).port} --strictPort`,
			url: `${env.testWalletOrigins[profile]}/`,
			reuseExistingServer: false,
			timeout: 60_000,
			env: { UNLEASHED_SANDBOX_ARTIFACTS: env.artifactsDir, UNLEASHED_TOOLS_ORIGIN: env.toolsOrigin },
		})),
	],
})
