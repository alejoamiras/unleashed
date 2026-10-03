import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

export default defineConfig({
	test: {
		...sharedTest,
		globals: true,
		environment: "node",
		setupFiles: ["./src/test/setup.ts"],
		// The integration suite boots a live sandbox; it runs from vitest.integration.config.ts only.
		exclude: ["node_modules", "test/integration/**"],
	},
})
