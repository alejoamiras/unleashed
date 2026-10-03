import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { ICONS } from "../core/icons"
import Toast from "./Toast.vue"

describe("Toast", () => {
	it("renders the text", () => {
		const wrapper = mount(Toast, { props: { text: "Dripped 1,000 USDC to public" } })
		expect(wrapper.text()).toContain("Dripped 1,000 USDC to public")
	})

	it("sets the lead in <strong>, followed by the text on the same line", () => {
		const wrapper = mount(Toast, { props: { lead: "Could not claim your gas.", text: "Try again from Activity." } })
		expect(wrapper.get("strong").text()).toBe("Could not claim your gas.")
		expect(wrapper.get(".toast__text").text()).toBe("Could not claim your gas. Try again from Activity.")
	})

	it("emits dismiss when the close button is clicked", async () => {
		const wrapper = mount(Toast, { props: { text: "x" } })
		await wrapper.get(".toast__dismiss").trigger("click")
		expect(wrapper.emitted("dismiss")).toHaveLength(1)
	})

	it("a saved toast draws the save icon and can be dismissed like the rest", async () => {
		const wrapper = mount(Toast, { props: { kind: "saved", text: "Recovery file downloaded." } })
		expect(wrapper.get(".toast").attributes("data-kind")).toBe("saved")
		expect(wrapper.get(".toast__icon path").attributes("d")).toBe(ICONS.save.d[0])
		await wrapper.get(".toast__dismiss").trigger("click")
		expect(wrapper.emitted("dismiss")).toHaveLength(1)
	})

	it("renders a link on its own line that opens in a new tab", () => {
		const wrapper = mount(Toast, {
			props: { text: "Dripped", link: { label: "View tx", href: "https://example.test/tx/0x1" } },
		})
		const a = wrapper.get(".toast__link")
		expect(a.text()).toBe("View tx")
		expect(a.attributes("href")).toBe("https://example.test/tx/0x1")
		expect(a.attributes("target")).toBe("_blank")
		expect(a.attributes("rel")).toContain("noopener")
		expect(a.element.parentElement?.classList.contains("toast__body")).toBe(true)
	})

	it("runs the countdown bar for exactly the TTL, and draws none without one", () => {
		const timed = mount(Toast, { props: { text: "x", ttlMs: 6000 } })
		const bar = timed.get(".toast__countdown")
		expect((bar.element as HTMLElement).style.getPropertyValue("--toast-ttl")).toBe("6000ms")
		expect(bar.attributes("aria-hidden")).toBe("true")
		expect(
			mount(Toast, { props: { text: "x" } })
				.find(".toast__countdown")
				.exists(),
		).toBe(false)
	})

	it("sets data-kind to match the kind prop", () => {
		const wrapper = mount(Toast, { props: { text: "x", kind: "error" } })
		expect(wrapper.get(".toast").attributes("data-kind")).toBe("error")
		expect(wrapper.get(".toast").classes()).toContain("toast--error")
	})

	it("defaults kind to 'info' when not provided", () => {
		const wrapper = mount(Toast, { props: { text: "x" } })
		expect(wrapper.get(".toast").attributes("data-kind")).toBe("info")
	})
})
