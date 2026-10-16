import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

export default defineConfig({
	test: {
		...sharedTest,
		environment: "node",
		include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "tests/server/**/*.test.ts", "*.test.ts"],
	},
})
