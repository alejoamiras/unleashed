import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import { TESTIDS } from "@/lib/testids"

const placeholder = vi.hoisted(() => ({ value: false }))

vi.mock("@/contracts/bridge-generation", () => ({
	get IS_PLACEHOLDER() {
		return placeholder.value
	},
}))

import SendView from "./SendView.vue"

const sel = (t: string) => `[data-testid="${t}"]`
// The wizard owns the composables; the switch under test must decide whether it is ever created.
// The wallet chips and the journal are the shell's now (AppShell.test.ts, shell-smoke.test.ts).
const stubs = { SendWizard: { name: "SendWizard", template: "<div />" } }

const view = () => mount(SendView, { global: { stubs } })

describe("SendView", () => {
	it("renders the wizard on a network with a bridge", () => {
		placeholder.value = false
		const w = view()
		expect(w.find(sel(TESTIDS.sendView)).exists()).toBe(true)
		expect(w.findComponent({ name: "SendWizard" }).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.sendUnavailable)).exists()).toBe(false)
	})

	it("a network with no bridge block shows the upgrade notice instead", () => {
		placeholder.value = true
		const w = view()
		expect(w.find(sel(TESTIDS.sendUnavailable)).exists()).toBe(true)
		expect(w.text()).toContain("Bridging is being upgraded")
	})

	it("never instantiates the wizard without a bridge to send through", () => {
		placeholder.value = true
		expect(view().findComponent({ name: "SendWizard" }).exists()).toBe(false)
	})

	it("tells the user the faucet still works while the bridge is away", () => {
		placeholder.value = true
		expect(view().text()).toContain("faucet keeps working")
	})
})
