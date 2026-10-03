import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AddressDisplay from "./AddressDisplay.vue"

const FULL = "0x12345678901234567890123456789012345678901234567890123456789012ab"

describe("AddressDisplay", () => {
	let writeText: ReturnType<typeof vi.fn>
	beforeEach(() => {
		writeText = vi.fn(async () => {})
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		})
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("shortens long addresses using the default head/tail split", () => {
		const w = mount(AddressDisplay, { props: { address: FULL } })
		expect(w.text()).toContain(`${FULL.slice(0, 6)}…${FULL.slice(-4)}`)
	})

	it("shows the full address as the button title and aria-label", () => {
		const w = mount(AddressDisplay, { props: { address: FULL } })
		const btn = w.get("button")
		expect(btn.attributes("title")).toBe(FULL)
		expect(btn.attributes("aria-label")).toBe(`Copy address ${FULL}`)
	})

	it("emits 'copy' with the full address when clicked", async () => {
		const w = mount(AddressDisplay, { props: { address: FULL } })
		await w.get("button").trigger("click")
		await Promise.resolve()
		expect(writeText).toHaveBeenCalledWith(FULL)
		expect(w.emitted("copy")?.[0]).toEqual([FULL])
	})

	it("renders custom head/tail lengths", () => {
		const w = mount(AddressDisplay, { props: { address: FULL, head: 4, tail: 6 } })
		expect(w.text()).toContain(`${FULL.slice(0, 4)}…${FULL.slice(-6)}`)
	})

	it("renders an em-dash for the empty string", () => {
		const w = mount(AddressDisplay, { props: { address: "" } })
		expect(w.text()).toContain("—")
	})

	it("does NOT call clipboard.writeText for an empty address", async () => {
		const w = mount(AddressDisplay, { props: { address: "" } })
		await w.get("button").trigger("click")
		await Promise.resolve()
		expect(writeText).not.toHaveBeenCalled()
	})

	it("does NOT shorten an address that's already short enough", () => {
		const short = "0x123"
		const w = mount(AddressDisplay, { props: { address: short } })
		expect(w.text()).toContain(short)
		expect(w.text()).not.toContain("…")
	})

	it("shows a transient 'Copied' confirmation after a successful copy", async () => {
		const w = mount(AddressDisplay, { props: { address: FULL } })
		await w.get("button").trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		expect(w.text()).toContain("Copied")
	})

	it("clears the 'Copied' confirmation after the 1.2s timeout", async () => {
		const w = mount(AddressDisplay, { props: { address: FULL } })
		await w.get("button").trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		expect(w.text()).toContain("Copied")
		vi.advanceTimersByTime(1500)
		await Promise.resolve()
		expect(w.text()).not.toContain("Copied")
	})

	it("uses type=button so it doesn't accidentally submit a parent form", () => {
		const w = mount(AddressDisplay, { props: { address: FULL } })
		expect(w.get("button").attributes("type")).toBe("button")
	})
})
