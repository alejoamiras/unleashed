import { fileURLToPath, URL } from "node:url"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"
import { componentsPlugin } from "./scripts/components-plugin"

export default defineConfig({
	plugins: [vue(), componentsPlugin({ dts: false })],
	resolve: {
		alias: [{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) }],
	},
	test: {
		...sharedTest,
		globals: true,
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		// The jsdom smoke lives under tests/e2e/ and runs from a separate
		// vitest.e2e.config.ts; exclude here so `bun run test` stays fast.
		exclude: ["node_modules", "dist", "tests/e2e/**", "tests/browser/**"],
	},
})
