import { enableAutoUnmount, mount } from "@vue/test-utils"
import { afterEach, describe, expect, test, vi } from "vitest"
import { defineComponent, h, nextTick, ref } from "vue"
import { isTabbable, useFocusTrap } from "./useFocusTrap"

const PANEL = `
	<button id="b1">one</button>
	<button disabled>disabled</button>
	<a id="a1" href="#x">link</a>
	<a href="#y" tabindex="-1">skipped link</a>
	<input id="i1" />
	<input tabindex="-1" />
	<button tabindex="0" disabled>disabled with tabindex</button>
	<select id="s1"><option>x</option></select>
	<div style="display: none"><button>display none</button></div>
	<div hidden><button>hidden</button></div>
	<div inert><button>inert</button></div>
	<textarea id="t1"></textarea>
	<span id="z1" tabindex="0">zero</span>
`
const ORDER = ["b1", "a1", "i1", "s1", "t1", "z1"]

function harness(opts: { enabled?: boolean; shouldYield?: () => boolean } = {}) {
	const enabled = ref(opts.enabled ?? true)
	const onEscape = vi.fn()
	const Host = defineComponent({
		setup() {
			const panel = ref<HTMLElement | null>(null)
			useFocusTrap(panel, { enabled, onEscape, shouldYield: opts.shouldYield })
			return () => h("div", { ref: panel, tabindex: -1, innerHTML: PANEL })
		},
	})
	const outside = document.createElement("button")
	document.body.append(outside)
	outside.focus()
	const wrapper = mount(Host, { attachTo: document.body })
	return { enabled, onEscape, wrapper, outside }
}

function press(key: string, shiftKey = false): KeyboardEvent {
	const e = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
	;(document.activeElement ?? document.body).dispatchEvent(e)
	return e
}

enableAutoUnmount(afterEach)
afterEach(() => {
	document.body.innerHTML = ""
})

describe("useFocusTrap", () => {
	test("Tab and Shift+Tab wrap over the tabbable set and skip every counterexample", async () => {
		harness()
		await nextTick()
		const forward: string[] = []
		for (let i = 0; i < ORDER.length + 1; i++) {
			press("Tab")
			forward.push(document.activeElement?.id ?? "")
		}
		expect(forward).toEqual([...ORDER, ORDER[0]])
		const backward: string[] = []
		for (let i = 0; i < 2; i++) {
			press("Tab", true)
			backward.push(document.activeElement?.id ?? "")
		}
		expect(backward).toEqual([ORDER[ORDER.length - 1], ORDER[ORDER.length - 2]])
	})

	test("a detached node is not tabbable", () => {
		const b = document.createElement("button")
		expect(isTabbable(b)).toBe(false)
		document.body.append(b)
		expect(isTabbable(b)).toBe(true)
	})

	test("focuses the panel on open, Escape calls onEscape, and disabling removes the listener and restores focus", async () => {
		const { enabled, onEscape, wrapper, outside } = harness()
		await nextTick()
		expect(document.activeElement).toBe(wrapper.element)
		expect(press("Escape").defaultPrevented).toBe(true)
		expect(onEscape).toHaveBeenCalledTimes(1)
		enabled.value = false
		await nextTick()
		expect(document.activeElement).toBe(outside)
		press("Escape")
		expect(press("Tab").defaultPrevented).toBe(false)
		expect(onEscape).toHaveBeenCalledTimes(1)
	})

	test("unmounting before the queued focus runs focuses nothing and throws nothing", async () => {
		const { wrapper, outside } = harness()
		wrapper.unmount()
		await expect(nextTick()).resolves.toBeUndefined()
		expect(document.activeElement).toBe(outside)
		press("Escape")
	})

	test("shouldYield leaves Escape and Tab to the other modal", async () => {
		const other = document.createElement("div")
		other.setAttribute("aria-modal", "true")
		const { onEscape } = harness({ shouldYield: () => other.isConnected })
		document.body.append(other)
		await nextTick()
		expect(press("Escape").defaultPrevented).toBe(false)
		expect(press("Tab").defaultPrevented).toBe(false)
		expect(onEscape).not.toHaveBeenCalled()
		other.remove()
		press("Escape")
		expect(onEscape).toHaveBeenCalledTimes(1)
	})
})
