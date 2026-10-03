import { fileURLToPath, URL } from "node:url"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"
import { componentsPlugin } from "./scripts/components-plugin"

/*
 * jsdom smoke config (mock wallet, no browser). Separate from the unit/component config because:
 *   1. Smokes don't run in `bun run test` (the everyday loop) — they
 *      run via `bun run test:e2e`.
 *   2. The smoke mounts App.vue and exercises the page end-to-end with
 *      a fake wallet provider. No browser, no aztec network — jsdom is
 *      enough.
 *   3. Each smoke spec takes longer than a unit test; isolating the
 *      config keeps the fast loop fast.
 */
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
		include: ["tests/e2e/**/*.test.ts"],
		// Smokes can be slower than unit tests — bump the per-test timeout.
		testTimeout: 30_000,
	},
})
