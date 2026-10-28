import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

/*
 * The relayer on two local chains: one anvil per side, Across's pool and USDC placed at their real testnet
 * addresses, so `relayOnce` runs on the production route unchanged. Sequential: the scenarios share both chains.
 * Runs only from this config (`test:integration`); the everyday `test` never boots a chain.
 */
export default defineConfig({
	test: {
		...sharedTest,
		environment: "node",
		include: ["test/integration/**/*.integration.test.ts"],
		fileParallelism: false,
		testTimeout: 120_000,
		hookTimeout: 120_000,
		reporters: ["verbose"],
	},
})
