/**
 * Component tests for the wallet picker modal — the provider-supplied-content
 * hardening (name capping, icon protocol allowlist) and the interaction
 * contract (per-row connect by key, Escape/backdrop cancel, collision strip,
 * scanning hint).
 */

import { mount } from "@vue/test-utils"
import { clickScrim } from "@unleashed/design/testing"
import { ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TESTIDS } from "@/lib/testids"
import type { ConnectStatus, DiscoveredWallet } from "@/composables/useWalletConnection"

const status = ref<ConnectStatus>("choosing")
const discoveredWallets = ref<DiscoveredWallet[]>([])
const scanning = ref(true)
const pickerOpen = ref(true)
const selectWallet = vi.fn()
const cancelChoice = vi.fn()

vi.mock("@/composables/useWalletConnection", () => ({
	useWalletConnection: () => ({ status, discoveredWallets, scanning, pickerOpen, selectWallet, cancelChoice }),
}))

import WalletPickerModal from "./WalletPickerModal.vue"

function row(over: Partial<DiscoveredWallet> = {}): DiscoveredWallet {
	return {
		key: over.key ?? 0,
		id: over.id ?? "test-wallet",
		name: over.name ?? "Test Wallet",
		type: over.type ?? "extension",
		icon: over.icon,
	}
}

function mountModal() {
	// Teleport target is document.body — query through document, not the wrapper.
	return mount(WalletPickerModal, { attachTo: document.body })
}

function q(testid: string): HTMLElement | null {
	return document.querySelector(`[data-testid="${testid}"]`)
}
function qa(testid: string): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)]
}

let wrapper: ReturnType<typeof mountModal> | null = null

beforeEach(() => {
	status.value = "choosing"
	discoveredWallets.value = []
	scanning.value = true
	pickerOpen.value = true
	selectWallet.mockReset()
	cancelChoice.mockReset()
})
afterEach(() => {
	vi.useRealTimers()
	wrapper?.unmount()
	wrapper = null
	document.body.innerHTML = ""
})

describe("WalletPickerModal", () => {
	it("visibility follows the session's pickerOpen; rows append progressively", async () => {
		pickerOpen.value = false
		wrapper = mountModal()
		expect(q(TESTIDS.walletPicker)).toBeNull()

		// Opens EMPTY (fresh connect, nothing answered yet): waiting hint shows.
		pickerOpen.value = true
		await wrapper.vm.$nextTick()
		expect(q(TESTIDS.walletPicker)).not.toBeNull()
		expect(q(TESTIDS.walletPickerWaiting)).not.toBeNull()
		expect(qa(TESTIDS.walletPickerRow)).toHaveLength(0)

		discoveredWallets.value = [row({ key: 1 })]
		await wrapper.vm.$nextTick()
		expect(q(TESTIDS.walletPickerWaiting)).toBeNull()
		expect(qa(TESTIDS.walletPickerRow)).toHaveLength(1)

		discoveredWallets.value = [...discoveredWallets.value, row({ key: 2, id: "acme", name: "Acme", type: "web" })]
		await wrapper.vm.$nextTick()
		expect(qa(TESTIDS.walletPickerRow)).toHaveLength(2)
	})

	it("per-row Connect emits the announcement KEY (not an index or claimed id)", async () => {
		vi.useFakeTimers()
		discoveredWallets.value = [row({ key: 7 }), row({ key: 9, id: "acme", name: "Acme" })]
		wrapper = mountModal()
		await wrapper.vm.$nextTick()
		vi.advanceTimersByTime(500)
		qa(TESTIDS.walletPickerConnect)[1].click()
		expect(selectWallet).toHaveBeenCalledWith(9)
	})

	it("the whole row is the connect button, named with the type chip's label", async () => {
		discoveredWallets.value = [row({ key: 1, id: "7c1e9f00a4f0", name: "Acme" })]
		wrapper = mountModal()
		await wrapper.vm.$nextTick()
		const button = q(TESTIDS.walletPickerRow)?.querySelector("button")
		expect(button?.getAttribute("data-testid")).toBe(TESTIDS.walletPickerConnect)
		expect(button?.getAttribute("aria-label")).toBe("Connect Acme (Extension)")
		expect(button?.textContent).toContain("id 7c1e…a4f0")
	})

	it("two rows claiming one name and type are described apart by their id lines", async () => {
		discoveredWallets.value = [row({ key: 1, id: "7c1e9f00a4f0", name: "Acme" }), row({ key: 2, id: "0bad9f00beef", name: "Acme" })]
		wrapper = mountModal()
		await wrapper.vm.$nextTick()
		const descriptions = qa(TESTIDS.walletPickerConnect).map((button) => {
			const ref = button.getAttribute("aria-describedby") ?? ""
			return document.getElementById(ref)?.textContent
		})
		expect(descriptions).toEqual(["id 7c1e…a4f0", "id 0bad…beef"])
	})

	it("a claimed type other than extension or web never reaches the chip's text", async () => {
		discoveredWallets.value = [row({ key: 1, name: "Acme", type: "Verified wallet" as DiscoveredWallet["type"] })]
		wrapper = mountModal()
		await wrapper.vm.$nextTick()
		const rowEl = q(TESTIDS.walletPickerRow)
		expect(rowEl?.textContent).toContain("Unknown type")
		expect(rowEl?.textContent).not.toContain("Verified")
		expect(rowEl?.querySelector("button")?.getAttribute("aria-label")).toBe("Connect Acme (Unknown type)")
		expect(rowEl?.querySelector("[title]")?.getAttribute("title")).toBe("Self-reported: Verified wallet")
	})

	it("ignores a row click for 500 ms after a wallet answers or the collision strip appears", async () => {
		vi.useFakeTimers()
		discoveredWallets.value = [row({ key: 1 })]
		wrapper = mountModal()
		await wrapper.vm.$nextTick()
		vi.advanceTimersByTime(500)

		discoveredWallets.value = [...discoveredWallets.value, row({ key: 2, id: "acme", name: "Acme" })]
		await wrapper.vm.$nextTick()
		vi.advanceTimersByTime(499)
		qa(TESTIDS.walletPickerConnect)[0].click()
		expect(selectWallet).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		qa(TESTIDS.walletPickerConnect)[0].click()
		expect(selectWallet).toHaveBeenCalledWith(1)

		discoveredWallets.value = [...discoveredWallets.value, row({ key: 3 })]
		await wrapper.vm.$nextTick()
		expect(q(TESTIDS.walletPickerWarning)).not.toBeNull()
		qa(TESTIDS.walletPickerConnect)[2].click()
		expect(selectWallet).toHaveBeenCalledTimes(1)
		vi.advanceTimersByTime(500)
		qa(TESTIDS.walletPickerConnect)[2].click()
		expect(selectWallet).toHaveBeenLastCalledWith(3)
	})

	it("renders an HTML-bearing name inert and caps its length by string", async () => {
		const evil = `<img src=x onerror=alert(1)>${"A".repeat(80)}`
		discoveredWallets.value = [row({ key: 1, name: evil })]
		wrapper = mountModal()
		await wrapper.vm.$nextTick()
		const rowEl = q(TESTIDS.walletPickerRow)
		expect(rowEl?.querySelector("img[src='x']")).toBeNull() // interpolated, not parsed
		const nameText = rowEl?.querySelector(".name")?.textContent ?? ""
		expect(nameText.length).toBeLessThanOrEqual(49) // 48 + ellipsis
	})

	it("icon protocol allowlist: https/chrome-extension/data:image pass, others fall back", async () => {
		discoveredWallets.value = [
			row({ key: 1, icon: "https://a.example/icon.png" }),
			row({ key: 2, id: "b", icon: "chrome-extension://abc/icon.png" }),
			row({ key: 3, id: "c", icon: "data:image/png;base64,AAAA" }),
			row({ key: 4, id: "d", icon: "javascript:alert(1)" }),
			row({ key: 5, id: "e", icon: "http://a.example/icon.png" }),
			row({ key: 6, id: "f", icon: `data:image/png;base64,${"A".repeat(5000)}` }), // over the source cap
		]
		wrapper = mountModal()
		await wrapper.vm.$nextTick()
		const rows = qa(TESTIDS.walletPickerRow)
		expect(rows[0].querySelector("img")).not.toBeNull()
		expect(rows[1].querySelector("img")).not.toBeNull()
		expect(rows[2].querySelector("img")).not.toBeNull()
		for (const rejected of rows.slice(3)) {
			expect(rejected.querySelector("img")).toBeNull()
			expect(rejected.querySelector(".fallback svg")).not.toBeNull()
		}
	})

	it("shows the collision warning only when two rows claim one id", async () => {
		discoveredWallets.value = [row({ key: 1 }), row({ key: 2, id: "acme", name: "Acme" })]
		wrapper = mountModal()
		await wrapper.vm.$nextTick()
		expect(q(TESTIDS.walletPickerWarning)).toBeNull()

		discoveredWallets.value = [...discoveredWallets.value, row({ key: 3, id: "test-wallet", name: "Test Wallet" })]
		await wrapper.vm.$nextTick()
		expect(q(TESTIDS.walletPickerWarning)?.textContent?.trim()).toBe(
			"Multiple wallets claim the same identity. Names and icons are self-reported — pick deliberately. The emoji check on the next step verifies only the connection to the wallet you select.",
		)
	})

	it("scanning hint tracks discovery liveness", async () => {
		discoveredWallets.value = [row({ key: 1 })]
		wrapper = mountModal()
		await wrapper.vm.$nextTick()
		expect(q(TESTIDS.walletPickerScanning)).not.toBeNull()
		scanning.value = false
		await wrapper.vm.$nextTick()
		expect(q(TESTIDS.walletPickerScanning)).toBeNull()
	})

	it("Escape and backdrop click cancel; the Cancel button cancels", async () => {
		discoveredWallets.value = [row({ key: 1 })]
		wrapper = mountModal()
		await wrapper.vm.$nextTick()

		q(TESTIDS.walletPickerCancel)?.click()
		expect(cancelChoice).toHaveBeenCalledTimes(1)

		document
			.querySelector<HTMLElement>('[role="dialog"]')
			?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
		expect(cancelChoice).toHaveBeenCalledTimes(2)

		clickScrim(q(TESTIDS.walletPicker) as HTMLElement)
		expect(cancelChoice).toHaveBeenCalledTimes(3)
	})

	it("moves focus into the dialog on open", async () => {
		wrapper = mountModal()
		discoveredWallets.value = [row({ key: 1 })]
		pickerOpen.value = false
		await wrapper.vm.$nextTick()
		pickerOpen.value = true
		await wrapper.vm.$nextTick()
		await wrapper.vm.$nextTick()
		expect(document.activeElement?.getAttribute("role")).toBe("dialog")
	})
})
