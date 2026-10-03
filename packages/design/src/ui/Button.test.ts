import { mount } from "@vue/test-utils"
import { describe, expect, test } from "vitest"
import Button from "./Button.vue"

describe("Button", () => {
	test("renders its slot in a non-submitting button", () => {
		const w = mount(Button, { slots: { default: "Connect" } })
		expect(w.element.tagName).toBe("BUTTON")
		expect(w.attributes("type")).toBe("button")
		expect(w.text()).toBe("Connect")
	})

	test("disabled disables the native button", () => {
		expect(mount(Button, { props: { disabled: true } }).attributes("disabled")).toBeDefined()
		expect(mount(Button).attributes("disabled")).toBeUndefined()
	})

	test("loading puts the busy pixels after the label and marks the button busy", () => {
		const w = mount(Button, { props: { loading: true }, slots: { default: "Sending" } })
		const status = w.get('[role="status"]')
		const label = [...w.element.childNodes].find((n) => n.textContent === "Sending")
		expect(label?.compareDocumentPosition(status.element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
		expect(status.attributes("aria-hidden")).toBe("true")
		expect(w.find("svg").exists()).toBe(false)
		expect(w.attributes("aria-busy")).toBe("true")
		const idle = mount(Button)
		expect(idle.attributes("aria-busy")).toBeUndefined()
		expect(idle.find('[role="status"]').exists()).toBe(false)
	})

	test("a loading button suppresses repeated clicks, and emits again once loading clears", async () => {
		const w = mount(Button, { props: { loading: true } })
		await w.trigger("click")
		await w.trigger("click")
		expect(w.emitted("click")).toBeUndefined()
		await w.setProps({ loading: false })
		await w.trigger("click")
		expect(w.emitted("click")).toHaveLength(1)
	})

	test("size and variant select their classes, with medium primary by default", () => {
		const cls = (props = {}) => mount(Button, { props }).attributes("class") ?? ""
		expect(cls()).toMatch(/medium/)
		expect(cls()).toMatch(/primary/)
		expect(cls({ size: "large", variant: "secondary" })).toMatch(/large.*secondary/)
		expect(cls({ variant: "quiet" })).toMatch(/quiet/)
		expect(cls({ variant: "destructive" })).toMatch(/destructive/)
	})

	test("shows its reason slot only while disabled, on the button itself", () => {
		const slots = { default: "Sign and send", reason: "Confirm the request in your wallet." }
		const off = mount(Button, { props: { disabled: true }, slots })
		expect(off.text()).toBe("Sign and sendConfirm the request in your wallet.")
		expect(mount(Button, { slots }).text()).toBe("Sign and send")
	})

	test("a caller's class, test id and click handler reach the button", async () => {
		let clicks = 0
		const w = mount(Button, { attrs: { class: "caret", "data-testid": "b", onClick: () => clicks++ } })
		expect(w.classes()).toContain("caret")
		expect(w.attributes("data-testid")).toBe("b")
		await w.trigger("click")
		expect(clicks).toBe(1)
	})
})
