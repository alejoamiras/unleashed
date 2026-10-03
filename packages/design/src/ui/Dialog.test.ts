import { enableAutoUnmount, mount } from "@vue/test-utils"
import { afterEach, describe, expect, test, vi } from "vitest"
import { defineComponent, h, nextTick, ref } from "vue"
import { clickScrim } from "../testing"
import Dialog from "./Dialog.vue"

function panelOf(testid: string): HTMLElement | null {
	return document.querySelector(`[data-testid="${testid}"] [role="dialog"]`)
}

function mountDialog(open = true) {
	const onCancel = vi.fn()
	const wrapper = mount(Dialog, {
		props: { open, title: "Verify the grid", overlayTestid: "ov", closeTestid: "x", onCancel },
		slots: { default: () => h("p", "body"), footer: () => h("button", { id: "ok" }, "OK") },
		attachTo: document.body,
	})
	return { wrapper, onCancel }
}

function pressEscape(): void {
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
}

enableAutoUnmount(afterEach)
afterEach(() => {
	document.body.innerHTML = ""
})

describe("Dialog", () => {
	test("the panel is the named modal and takes focus on open", async () => {
		mountDialog()
		await nextTick()
		const panel = panelOf("ov")
		expect(panel?.getAttribute("aria-modal")).toBe("true")
		const title = panel?.querySelector("h2")
		expect(title?.textContent).toBe("Verify the grid")
		expect(panel?.getAttribute("aria-labelledby")).toBe(title?.id)
		expect(document.activeElement).toBe(panel)
		expect(panel?.querySelector("footer #ok")).not.toBeNull()
	})

	test("Escape, × and the backdrop each emit cancel once", async () => {
		const { onCancel } = mountDialog()
		await nextTick()
		pressEscape()
		expect(onCancel).toHaveBeenCalledTimes(1)
		document.querySelector<HTMLElement>('[data-testid="x"]')?.click()
		expect(onCancel).toHaveBeenCalledTimes(2)
		clickScrim(document.querySelector('[data-testid="ov"]') as Element)
		expect(onCancel).toHaveBeenCalledTimes(3)
		panelOf("ov")?.click()
		expect(onCancel).toHaveBeenCalledTimes(3)
	})

	test("a gesture that starts or ends inside the panel never cancels, though its click lands on the scrim", async () => {
		const { onCancel } = mountDialog()
		await nextTick()
		const scrim = document.querySelector('[data-testid="ov"]') as Element
		const panel = panelOf("ov") as Element
		const gesture = (down: Element, up: Element) => {
			down.dispatchEvent(new Event("pointerdown", { bubbles: true }))
			up.dispatchEvent(new Event("pointerup", { bubbles: true }))
			scrim.dispatchEvent(new MouseEvent("click", { bubbles: true }))
		}
		gesture(panel, scrim)
		gesture(scrim, panel)
		expect(onCancel).not.toHaveBeenCalled()
		gesture(scrim, scrim)
		expect(onCancel).toHaveBeenCalledTimes(1)
	})

	test("a press on the scrim releases implicit touch capture so the release reports where it lands", async () => {
		mountDialog()
		await nextTick()
		const scrim = document.querySelector('[data-testid="ov"]') as Element
		const released: number[] = []
		Object.assign(scrim, { hasPointerCapture: () => true, releasePointerCapture: (id: number) => released.push(id) })
		scrim.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { pointerId: 7 }))
		panelOf("ov")?.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { pointerId: 8 }))
		expect(released).toEqual([7])
	})

	test("closing removes the Escape listener and never restores focus to a detached element", async () => {
		const opener = document.createElement("button")
		document.body.append(opener)
		opener.focus()
		const focus = vi.spyOn(opener, "focus")
		const { wrapper, onCancel } = mountDialog()
		await nextTick()
		opener.remove()
		await wrapper.setProps({ open: false })
		expect(panelOf("ov")).toBeNull()
		expect(focus).not.toHaveBeenCalled()
		pressEscape()
		expect(onCancel).not.toHaveBeenCalled()
	})

	// Watchers run in component order, so the closing dialog's restore may run before or after the
	// opening one records where focus was; both orders must end inside the opening dialog.
	test.each([["picker first"], ["verification first"]])(
		"a picker → verification handoff in one flush ends with focus inside the verification panel (%s)",
		async (order) => {
			const pickerOpen = ref(true)
			const verifyOpen = ref(false)
			const Host = defineComponent({
				setup: () => () => {
					const picker = h(Dialog, { open: pickerOpen.value, title: "Choose a wallet", overlayTestid: "picker" }, () =>
						h("button", { id: "row" }, "Row"),
					)
					const verify = h(Dialog, { open: verifyOpen.value, title: "Verify the grid", overlayTestid: "verify" })
					return [h("button", { id: "connect" }, "Connect"), ...(order === "picker first" ? [picker, verify] : [verify, picker])]
				},
			})
			mount(Host, { attachTo: document.body })
			document.getElementById("connect")?.focus()
			await nextTick()
			document.getElementById("row")?.focus()
			pickerOpen.value = false
			verifyOpen.value = true
			await nextTick()
			await nextTick()
			expect(panelOf("picker")).toBeNull()
			expect(document.activeElement).toBe(panelOf("verify"))
		},
	)

	test("initial focus goes to a data-autofocus target", async () => {
		mount(Dialog, {
			props: { open: true, title: "Choose main account" },
			slots: { default: () => [h("button", "a"), h("button", { id: "picked", "data-autofocus": "" }, "b")] },
			attachTo: document.body,
		})
		await nextTick()
		await nextTick()
		expect(document.activeElement?.id).toBe("picked")
	})
})
