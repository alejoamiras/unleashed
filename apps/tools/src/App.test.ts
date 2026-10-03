import { flushPromises, mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import { TESTIDS } from "@/lib/testids"

const mainnet = vi.hoisted(() => ({ value: false }))
/** Flipped the ONE time the shell's module is evaluated. Evaluating it is what constructs the
 *  wallet-session singleton, so the mainnet build must never get that far. */
const shellLoaded = vi.hoisted(() => ({ value: false }))

vi.mock("@/lib/network", () => ({
	get IS_MAINNET() {
		return mainnet.value
	},
}))
vi.mock("./AppShell.vue", () => {
	shellLoaded.value = true
	// `__esModule` is what tells Vue's async-component loader to unwrap `default` instead of handing
	// the namespace object itself to the renderer.
	return { __esModule: true, default: { name: "AppShell", template: `<div data-testid="${TESTIDS.app}" />` } }
})

import App from "./App.vue"

const sel = (t: string) => `[data-testid="${t}"]`

async function app() {
	const w = mount(App)
	await flushPromises()
	return w
}

// The first two cases read a ONE-SHOT module-evaluation flag, so they must run before any case that
// mounts the shell. Everything after them is order-independent.
describe("App", () => {
	it("mainnet never loads the shell module, so no wallet session is constructed", async () => {
		mainnet.value = true
		await app()
		expect(shellLoaded.value).toBe(false)
	})

	it("testnet loads the shell module", async () => {
		mainnet.value = false
		await app()
		expect(shellLoaded.value).toBe(true)
	})

	it("testnet renders the tabbed shell", async () => {
		mainnet.value = false
		const w = await app()
		expect(w.find(sel(TESTIDS.app)).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.mainnetPlaceholder)).exists()).toBe(false)
	})

	it("mainnet renders the placeholder and nothing else", async () => {
		mainnet.value = true
		const w = await app()
		expect(w.find(sel(TESTIDS.mainnetPlaceholder)).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.app)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.tabs)).exists()).toBe(false)
	})

	it("the mainnet placeholder offers its three links", async () => {
		mainnet.value = true
		const w = await app()
		expect(w.findAll(sel(TESTIDS.mainnetPlaceholderLink))).toHaveLength(3)
	})
})
