import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

const status = ref("idle")
const error = ref<{ category: string; message: string; raw: unknown } | null>(null)

vi.mock("@/composables/useWalletConnection", () => ({
	useWalletConnection: () => ({ status, error }),
}))

import { TESTIDS } from "@/lib/testids"
import ConnectionErrorStrip from "./ConnectionErrorStrip.vue"

const sel = (t: string) => `[data-testid="${t}"]`

describe("ConnectionErrorStrip", () => {
	beforeEach(() => {
		status.value = "idle"
		error.value = null
	})

	it("hidden while there is no error", () => {
		const w = mount(ConnectionErrorStrip)
		expect(w.find(sel(TESTIDS.errorStrip)).exists()).toBe(false)
	})

	it("shows the message with role=alert on a generic error", async () => {
		const w = mount(ConnectionErrorStrip)
		status.value = "error"
		error.value = { category: "network", message: "Alpha-testnet is not responding. Try again.", raw: null }
		await w.vm.$nextTick()
		const strip = w.get(sel(TESTIDS.errorStrip))
		expect(strip.attributes("role")).toBe("alert")
		expect(strip.text()).toContain("Alpha-testnet is not responding")
	})

	it("stays hidden for excluded categories (state owns a dedicated UI)", async () => {
		const w = mount(ConnectionErrorStrip, { props: { exclude: ["no-wallet", "capability-rejected"] } })
		status.value = "error"
		error.value = { category: "capability-rejected", message: "x", raw: null }
		await w.vm.$nextTick()
		expect(w.find(sel(TESTIDS.errorStrip)).exists()).toBe(false)

		error.value = { category: "no-wallet", message: "x", raw: null }
		await w.vm.$nextTick()
		expect(w.find(sel(TESTIDS.errorStrip)).exists()).toBe(false)
	})

	it("dismiss hides it; a NEW error un-dismisses", async () => {
		const w = mount(ConnectionErrorStrip)
		status.value = "error"
		error.value = { category: "network", message: "first", raw: null }
		await w.vm.$nextTick()
		await w.get(sel(TESTIDS.errorStripDismiss)).trigger("click")
		expect(w.find(sel(TESTIDS.errorStrip)).exists()).toBe(false)

		error.value = { category: "network", message: "second", raw: null }
		await w.vm.$nextTick()
		expect(w.get(sel(TESTIDS.errorStrip)).text()).toContain("second")
	})

	it("disappears when the session leaves the error state", async () => {
		const w = mount(ConnectionErrorStrip)
		status.value = "error"
		error.value = { category: "network", message: "x", raw: null }
		await w.vm.$nextTick()
		expect(w.find(sel(TESTIDS.errorStrip)).exists()).toBe(true)

		status.value = "discovering"
		await w.vm.$nextTick()
		expect(w.find(sel(TESTIDS.errorStrip)).exists()).toBe(false)
	})
})
