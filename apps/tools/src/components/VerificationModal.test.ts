import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { nextTick } from "vue"
import { TESTIDS } from "@/lib/testids"
import VerificationModal from "./VerificationModal.vue"

const NINE = "🟢🔵🟡🟣🔴⚪⚫🟠🟤"

describe("VerificationModal", () => {
	it("renders when emojis is non-null", () => {
		const w = mount(VerificationModal, {
			props: { emojis: NINE },
			attachTo: document.body,
		})
		expect(document.querySelector(`[data-testid="${TESTIDS.verificationModal}"]`)).not.toBeNull()
		w.unmount()
	})

	it("does NOT render when emojis is null", () => {
		mount(VerificationModal, { props: { emojis: null }, attachTo: document.body })
		expect(document.querySelector(`[data-testid="${TESTIDS.verificationModal}"]`)).toBeNull()
	})

	it("renders the title and body copy", () => {
		const w = mount(VerificationModal, {
			props: { emojis: NINE },
			attachTo: document.body,
		})
		expect(document.body.textContent).toContain("Verify the grid")
		expect(document.body.textContent).toContain("Match this grid")
		w.unmount()
	})

	it("emits 'confirm' when the They Match button is clicked", async () => {
		const w = mount(VerificationModal, {
			props: { emojis: NINE },
			attachTo: document.body,
		})
		const btn = document.querySelector(`[data-testid="${TESTIDS.btnVerifyConfirm}"]`) as HTMLElement
		btn.click()
		await Promise.resolve()
		expect(w.emitted("confirm")).toHaveLength(1)
		w.unmount()
	})

	it("takes focus inside its dialog from a button outside, and Escape cancels", async () => {
		const opener = document.createElement("button")
		document.body.append(opener)
		opener.focus()
		const w = mount(VerificationModal, { props: { emojis: null }, attachTo: document.body })
		await w.setProps({ emojis: NINE })
		await nextTick()
		const panel = document.querySelector(`[data-testid="${TESTIDS.verificationModal}"] [role="dialog"]`)
		expect(panel?.contains(document.activeElement)).toBe(true)
		document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
		expect(w.emitted("cancel")).toHaveLength(1)
		w.unmount()
		opener.remove()
	})

	it("emits 'cancel' when the Cancel button is clicked", async () => {
		const w = mount(VerificationModal, {
			props: { emojis: NINE },
			attachTo: document.body,
		})
		const btn = document.querySelector(`[data-testid="${TESTIDS.btnVerifyCancel}"]`) as HTMLElement
		btn.click()
		await Promise.resolve()
		expect(w.emitted("cancel")).toHaveLength(1)
		w.unmount()
	})
})
