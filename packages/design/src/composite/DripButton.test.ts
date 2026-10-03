import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import DripButton from "./DripButton.vue"

describe("DripButton", () => {
	it("shows the label prop verbatim regardless of loading state", () => {
		const idle = mount(DripButton, { props: { label: "Get USDC (public)" } })
		const loading = mount(DripButton, {
			props: { label: "Get USDC (public)", loading: true },
		})
		expect(idle.text()).toBe("Get USDC (public)")
		expect(loading.text()).toBe("Get USDC (public)")
	})

	it("uses the ariaLabel prop when provided; falls back to label otherwise", () => {
		const withAria = mount(DripButton, {
			props: { label: "Get USDC (public)", ariaLabel: "Get 1,000 USDC into your public balance" },
		})
		expect(withAria.get("button").attributes("aria-label")).toBe("Get 1,000 USDC into your public balance")
		const withoutAria = mount(DripButton, { props: { label: "Get USDC (public)" } })
		expect(withoutAria.get("button").attributes("aria-label")).toBe("Get USDC (public)")
	})

	it("emits click when clicked in the idle state", async () => {
		const w = mount(DripButton, { props: { label: "Drip" } })
		await w.get("button").trigger("click")
		expect(w.emitted("click")).toHaveLength(1)
	})

	it("renders a spinner and is aria-busy while loading", () => {
		const w = mount(DripButton, { props: { label: "Drip", loading: true } })
		expect(w.find('[role="status"]').exists()).toBe(true)
		expect(w.get("button").attributes("aria-busy")).toBe("true")
	})

	it("does NOT emit click while loading", async () => {
		const w = mount(DripButton, { props: { label: "Drip", loading: true } })
		await w.get("button").trigger("click")
		expect(w.emitted("click")).toBeUndefined()
	})

	it("does NOT emit click when explicit disabled is true", async () => {
		const w = mount(DripButton, { props: { label: "Drip", disabled: true } })
		await w.get("button").trigger("click")
		expect(w.emitted("click")).toBeUndefined()
	})

	it("propagates data-loading on the button for e2e probes", () => {
		const w = mount(DripButton, { props: { label: "Drip", loading: true } })
		expect(w.get("button").attributes("data-loading")).toBe("true")
	})

	it("takes the primary variant when asked", () => {
		const w = mount(DripButton, { props: { label: "Get", variant: "primary" } })
		expect(w.get("button").classes().join(" ")).toMatch(/primary/)
	})

	it("uses the secondary variant of Button", () => {
		const w = mount(DripButton, { props: { label: "Drip" } })
		// Button uses CSS modules → the hashed class contains the variant name.
		expect(w.get("button").classes().join(" ")).toMatch(/secondary/)
	})

	it("re-enables when loading transitions back to false", async () => {
		const w = mount(DripButton, { props: { label: "Drip", loading: true } })
		expect(w.get("button").attributes("disabled")).toBeDefined()
		await w.setProps({ loading: false })
		expect(w.get("button").attributes("disabled")).toBeUndefined()
	})

	it("button label is stable across all states (no Sent / Failed text override)", () => {
		const w = mount(DripButton, { props: { label: "Get ETH (private)" } })
		expect(w.text()).toBe("Get ETH (private)")
	})

	it("is large, with its 24px icon while idle and none while loading", () => {
		const idle = mount(DripButton, { props: { label: "Drip", icon: "eye" } })
		expect(idle.get("button").classes().join(" ")).toMatch(/large/)
		expect(idle.get("button > svg").attributes("width")).toBe("24")
		const loading = mount(DripButton, { props: { label: "Drip", icon: "eye", loading: true } })
		expect(loading.find("button > svg").exists()).toBe(false)
		expect(loading.text()).toBe("Drip")
	})

	it("idle button does not show a spinner", () => {
		const w = mount(DripButton, { props: { label: "Drip" } })
		expect(w.find('[role="status"]').exists()).toBe(false)
	})
})
