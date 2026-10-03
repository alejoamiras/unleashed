import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

/*
 * The bridge integration suite: one anvil + `aztec start --local-network` booted by the global
 * setup, one generation deployed onto it, and every round trip driven as its own test on its own
 * actor. Sequential by design — the flows share one chain and one relayer. Runs only from this
 * config (`test:integration`); the everyday `test` excludes it.
 */
export default defineConfig({
	test: {
		...sharedTest,
		globals: true,
		environment: "node",
		include: ["test/integration/**/*.integration.test.ts"],
		globalSetup: ["./test/integration/global-setup.ts"],
		fileParallelism: false,
		testTimeout: 600_000,
		hookTimeout: 600_000,
		reporters: ["verbose"],
	},
})
