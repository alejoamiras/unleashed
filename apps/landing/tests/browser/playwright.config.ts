import { defineConfig, devices } from "@playwright/test"

const here = new URL(".", import.meta.url).pathname

/**
 * The landing's browser smoke. Without LANDING_URL it serves the local dist/ (build first); with it,
 * it checks that live host and adds the live-only cases. LANDING_WEBKIT=1 adds WebKit at phone width,
 * which CI does not install.
 */
export default defineConfig({
	testDir: here,
	globalSetup: `${here}global-setup.ts`,
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	timeout: 30_000,
	expect: { timeout: 5_000 },
	reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: `${here}../../playwright-report` }]] : "list",
	outputDir: `${here}../../test-results`,
	use: { trace: "retain-on-failure", video: "off" },
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
		...(process.env.LANDING_WEBKIT
			? [{ name: "webkit-phone", use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } } }]
			: []),
	],
})
