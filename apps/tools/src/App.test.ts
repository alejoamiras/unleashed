import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TESTIDS } from "@/lib/testids"

/** How many times each root module was evaluated. Evaluating the shell constructs the wallet-session
 *  singleton, so the mainnet build must never get that far; the mainnet root must never load elsewhere. */
const loaded = vi.hoisted(() => ({ shell: 0, mainnetRoot: 0 }))
const MAINNET_ROOT = "test-mainnet-root"

// `__esModule` is what tells Vue's async-component loader to unwrap `default` instead of handing the
// namespace object itself to the renderer. What the mainnet root renders is MainnetRoot.test.ts's job.
vi.mock("./AppShell.vue", () => {
	loaded.shell++
	return { __esModule: true, default: { name: "AppShell", template: `<div data-testid="${TESTIDS.app}" />` } }
})
vi.mock("./legal/MainnetRoot.vue", () => {
	loaded.mainnetRoot++
	return { __esModule: true, default: { name: "MainnetRoot", template: `<main data-testid="${MAINNET_ROOT}" />` } }
})

const sel = (t: string) => `[data-testid="${t}"]`

/** Mounts a fresh `App.vue` built for `target` (no define means testnet, as in a bare build). */
async function app(target?: "mainnet") {
	if (target) vi.stubEnv("VITE_TOOLS_TARGET", target)
	vi.resetModules()
	loaded.shell = 0
	loaded.mainnetRoot = 0
	const { default: App } = await import("./App.vue")
	const w = mount(App)
	await flushPromises()
	return w
}

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("App", () => {
	it("mainnet loads the mainnet root and never the shell module, so no wallet session is constructed", async () => {
		await app("mainnet")
		expect(loaded.mainnetRoot).toBe(1)
		expect(loaded.shell).toBe(0)
	})

	it("testnet loads the shell module and never the mainnet root", async () => {
		await app()
		expect(loaded.shell).toBe(1)
		expect(loaded.mainnetRoot).toBe(0)
	})

	it("testnet renders the tabbed shell", async () => {
		const w = await app()
		expect(w.find(sel(TESTIDS.app)).exists()).toBe(true)
		expect(w.find(sel(MAINNET_ROOT)).exists()).toBe(false)
	})

	it("mainnet renders the mainnet root and nothing else", async () => {
		const w = await app("mainnet")
		expect(w.find(sel(MAINNET_ROOT)).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.app)).exists()).toBe(false)
	})
})
