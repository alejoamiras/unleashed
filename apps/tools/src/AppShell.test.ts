import { enableAutoUnmount, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref } from "vue"
import { __resetShellForTests, useShell } from "@/composables/useShell"
import { TESTIDS } from "@/lib/testids"

const placeholder = vi.hoisted(() => ({ value: false }))
vi.mock("@/contracts/bridge-generation", () => ({
	get IS_PLACEHOLDER() {
		return placeholder.value
	},
}))

const feedCount = ref(0)
const feedInstances = vi.hoisted(() => ({ value: 0 }))
const toastOwners = vi.hoisted(() => ({ value: 0 }))
vi.mock("@/composables/useActivityFeed", () => ({
	useActivityFeed: () => {
		feedInstances.value += 1
		return { count: feedCount }
	},
}))
vi.mock("@/composables/useCompletionToasts", () => ({
	useCompletionToasts: () => {
		toastOwners.value += 1
	},
}))

/** Every service-bound child becomes a marker that echoes the props the shell chose for it. Their
 *  modules pull the wallet session and wagmi in, so they are replaced at the module level, not at
 *  mount time. The shell's own contract is which children it shows, where, under which section. */
const marker = vi.hoisted(() => (testid: string) => ({
	__esModule: true,
	default: {
		props: ["variant", "exclude"],
		template: `<div data-testid="${testid}" :data-variant="variant" :data-exclude="JSON.stringify(exclude ?? null)" />`,
	},
}))
vi.mock("./components/AztecWalletPanel.vue", () => marker("aztec-panel"))
vi.mock("./components/L1WalletPanel.vue", () => marker("l1-panel"))
vi.mock("./components/ConnectionErrorStrip.vue", () => marker("strip"))
vi.mock("./components/BridgeFooter.vue", () => marker("footer-bridge"))
vi.mock("./views/DripView.vue", () => marker("tl-drip-view"))
vi.mock("./views/SendView.vue", () => marker("tl-send-view"))
vi.mock("./views/ActivityView.vue", () => marker("tl-activity-view"))
vi.mock("./views/AddressesView.vue", () => marker("tl-addresses-view"))
vi.mock("./components/AppToastRegion.vue", () => marker("toasts"))
vi.mock("./components/WalletPickerModal.vue", () => marker("picker"))
vi.mock("./components/ChooseAccountModal.vue", () => marker("chooser"))
vi.mock("./components/ThemeToggle.vue", () => marker("theme"))
vi.mock("./components/ActivityDock.vue", () => marker("tl-dock"))

import AppShell from "./AppShell.vue"

const sel = (t: string) => `[data-testid="${t}"]`
// Attached, so jsdom recomputes `display` after a v-show toggle (detached trees read stale).
enableAutoUnmount(afterEach)
const shell = () => mount(AppShell, { attachTo: document.body })
const exclude = (w: ReturnType<typeof mount>) => JSON.parse(w.get(sel("strip")).attributes("data-exclude") ?? "null")

describe("AppShell", () => {
	beforeEach(() => {
		placeholder.value = false
		feedCount.value = 0
		feedInstances.value = 0
		toastOwners.value = 0
		__resetShellForTests()
	})

	it("lands on the bridge: Ethereum + Aztec chips in the header, both views mounted", () => {
		const w = shell()
		expect(w.get(sel(TESTIDS.app)).attributes("data-section")).toBe("send")
		const header = w.get(sel(TESTIDS.sectionHeader))
		expect(header.text()).toContain("Bridge")
		expect(header.find(sel("l1-panel")).exists()).toBe(true)
		expect(header.get(sel("aztec-panel")).attributes("data-variant")).toBe("bridge")
		expect(w.find(sel(TESTIDS.sendView)).isVisible()).toBe(true)
		expect(w.find(sel(TESTIDS.dripView)).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.dripView)).isVisible()).toBe(false)
		expect(w.find(sel(TESTIDS.activityView)).exists()).toBe(false)
	})

	it("the bridge footer shows only on Send while the wizard is on a form step", async () => {
		const w = shell()
		const footer = () => w.find(sel("footer-bridge")).exists()
		expect(footer()).toBe(false)
		useShell().bridgeForm.value = true
		await nextTick()
		expect(footer()).toBe(true)
		for (const other of ["activity", "drip"] as const) {
			useShell().goTo(other)
			await nextTick()
			expect(footer()).toBe(false)
		}
		useShell().goTo("send")
		await nextTick()
		expect(footer()).toBe(true)
		useShell().bridgeForm.value = false
		await nextTick()
		expect(footer()).toBe(false)
	})

	it("the faucet has the Aztec chip alone and no shell footer (its view mounts its own); Activity keeps the bridge chips", async () => {
		const w = shell()
		useShell().goTo("drip")
		await nextTick()
		const header = w.get(sel(TESTIDS.sectionHeader))
		expect(header.text()).toContain("Faucet")
		expect(header.get(sel("aztec-panel")).attributes("data-variant")).toBe("faucet")
		expect(header.find(sel("l1-panel")).exists()).toBe(false)
		expect(w.find(sel("footer-bridge")).exists()).toBe(false)
		expect(w.find("footer").exists()).toBe(false)
		expect(w.find(sel(TESTIDS.dripView)).isVisible()).toBe(true)
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(true)
		useShell().goTo("activity")
		await nextTick()
		expect(w.get(sel(TESTIDS.app)).attributes("data-section")).toBe("activity")
		expect(w.find(sel(TESTIDS.activityView)).exists()).toBe(true)
		await nextTick()
		expect(w.find(sel(TESTIDS.dripView)).isVisible()).toBe(false)
		expect(w.get(sel(TESTIDS.sectionHeader)).find(sel("l1-panel")).exists()).toBe(true)
		// The page is the dock: on Activity the dock is not in the tree at all.
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
	})

	it("Addresses is its own section: mounted only while open, with no footer", async () => {
		const w = shell()
		useShell().bridgeForm.value = true
		expect(w.find(sel(TESTIDS.addressesView)).exists()).toBe(false)
		useShell().goTo("addresses")
		await nextTick()
		expect(w.get(sel(TESTIDS.sectionHeader)).text()).toContain("Addresses")
		expect(w.find(sel(TESTIDS.addressesView)).exists()).toBe(true)
		expect(w.find(sel("footer-bridge")).exists()).toBe(false)
	})

	it("ONE strip; the no-wallet CTA is the faucet chip's own, so only there is it excluded", async () => {
		const w = shell()
		expect(w.findAll(sel("strip"))).toHaveLength(1)
		expect(exclude(w)).toEqual(["capability-rejected"])
		useShell().goTo("drip")
		await nextTick()
		expect(exclude(w)).toEqual(["no-wallet", "capability-rejected"])
	})

	it("owns the completion toasts and the feed once; the rail shows the feed's count", () => {
		feedCount.value = 3
		const w = shell()
		expect(toastOwners.value).toBe(1)
		expect(feedInstances.value).toBe(1)
		expect(w.get(sel(TESTIDS.tabActivity)).text()).toContain("3")
	})

	it("a phone has no dock on any section, and the rail still carries the count", async () => {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query === "(max-width: 760px)",
			media: query,
			addEventListener() {},
			removeEventListener() {},
		}))
		try {
			feedCount.value = 2
			const w = shell()
			expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
			useShell().goTo("drip")
			await nextTick()
			expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
			expect(w.get(sel(TESTIDS.tabActivity)).text()).toContain("2")
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("the brand is a home button: from any section it returns to the bridge", async () => {
		const w = shell()
		useShell().goTo("activity")
		await nextTick()
		const brand = w.get(sel(TESTIDS.brandHome))
		expect(brand.element.tagName).toBe("BUTTON")
		expect(brand.attributes("aria-label")).toBe("Unleashed home")
		await brand.trigger("click")
		expect(useShell().section.value).toBe("send")
	})

	it("landmarks: the named rail sits beside <main>, which holds the header and the views", () => {
		const w = shell()
		expect(w.get(sel(TESTIDS.app)).element.tagName).toBe("DIV")
		const main = w.get("main")
		const rail = w.get("aside")
		expect(rail.attributes("aria-label")).toBe("Unleashed")
		expect(main.element.contains(rail.element)).toBe(false)
		expect(main.find(sel(TESTIDS.tabs)).exists()).toBe(false)
		expect(main.find(sel(TESTIDS.sectionHeader)).exists()).toBe(true)
		expect(main.find(sel(TESTIDS.sendView)).exists()).toBe(true)
	})

	it("a placeholder network builds neither the toast owner nor the feed", () => {
		placeholder.value = true
		const w = shell()
		expect(toastOwners.value).toBe(0)
		expect(feedInstances.value).toBe(0)
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(w.get(sel(TESTIDS.tabActivity)).text()).toBe("Activity")
	})
})
