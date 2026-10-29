import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import type { EIP1193Provider, Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TESTIDS } from "@/lib/testids"
import { ACCEPTANCE_KEY, acceptanceMessage, DIGESTS } from "./acceptance"
import MainnetRoot from "./MainnetRoot.vue"
import { GATE_TESTIDS } from "./testids"

const sel = (t: string) => `[data-testid="${t}"]`
const alice = privateKeyToAccount(`0x${"11".repeat(32)}`)

async function storeRecord(terms: Hex = DIGESTS.terms) {
	const signature = await alice.signMessage({ message: acceptanceMessage(window.location.origin, alice.address) })
	localStorage.setItem(ACCEPTANCE_KEY, JSON.stringify({ v: 1, account: alice.address, signature, terms, privacy: DIGESTS.privacy }))
}

function installWallet() {
	const provider = {
		request: async ({ method, params }: { method: string; params?: unknown }) =>
			method === "eth_requestAccounts" ? [alice.address] : alice.signMessage({ message: { raw: (params as [Hex])[0] } }),
	} as unknown as EIP1193Provider
	Object.defineProperty(window, "ethereum", { value: provider, configurable: true })
}

async function root() {
	const w = mount(MainnetRoot, { attachTo: document.body })
	await flushPromises()
	return w
}

const shows = (w: Awaited<ReturnType<typeof root>>) => ({
	gate: w.find(sel(GATE_TESTIDS.gate)).exists(),
	placeholder: w.find(sel(TESTIDS.mainnetPlaceholder)).exists(),
})

enableAutoUnmount(afterEach)
beforeEach(() => localStorage.clear())
afterEach(() => {
	Reflect.deleteProperty(window, "ethereum")
	vi.restoreAllMocks()
})

describe("MainnetRoot", () => {
	it("shows the gate to a new browser, and the placeholder once this browser holds a valid acceptance", async () => {
		expect(shows(await root())).toEqual({ gate: true, placeholder: false })
		await storeRecord()
		expect(shows(await root())).toEqual({ gate: false, placeholder: true })
	})

	it("asks again, with the re-ask heading, when a document changed", async () => {
		await storeRecord(`0x${"ab".repeat(32)}`)
		const w = await root()
		expect(shows(w)).toEqual({ gate: true, placeholder: false })
		expect(w.find("h1").text()).toBe("The Terms or the Privacy Policy changed")
	})

	it("renders nothing until the stored record is checked", async () => {
		await storeRecord()
		const w = mount(MainnetRoot, { attachTo: document.body })
		expect(w.html()).toBe("<!--v-if-->")
		await flushPromises()
		expect(shows(w)).toEqual({ gate: false, placeholder: true })
	})

	it("opens the placeholder after signing, and keeps it for the page even when storage cannot write", async () => {
		installWallet()
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceededError")
		})
		const w = await root()
		await w.find(sel(GATE_TESTIDS.sign)).trigger("click")
		await flushPromises()
		expect(shows(w)).toEqual({ gate: false, placeholder: true })
		w.unmount()
		expect(shows(await root())).toEqual({ gate: true, placeholder: false })
	})
})
