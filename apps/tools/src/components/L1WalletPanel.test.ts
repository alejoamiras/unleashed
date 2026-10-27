import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

const address = ref<string | null>(null)
const chainId = ref<number | null>(null)
const isConnected = ref(false)
const isConnecting = ref(false)
const connect = vi.fn()
const disconnect = vi.fn()
const switchL1Network = vi.fn()
const sourceChains = vi.hoisted(() => ({ ids: [] as number[] }))

vi.mock("@/composables/useL1Wallet", () => ({
	useL1Wallet: () => ({ address, chainId, isConnected, isConnecting, connect, disconnect, switchL1Network }),
}))
vi.mock("@/composables/useSourceChain", () => ({
	appSources: () => sourceChains.ids.map((id) => ({ chainId: id })),
	sourceChainIds: (sources: { chainId: number }[]) => [...new Set(sources.map((s) => s.chainId))],
}))

import { NETWORK } from "@/lib/network"
import { TESTIDS } from "@/lib/testids"
import L1WalletPanel from "./L1WalletPanel.vue"

const sel = (t: string) => `[data-testid="${t}"]`
const BASE_SEPOLIA = 84532

function connected(on: number) {
	isConnected.value = true
	address.value = `0x${"b".repeat(40)}`
	chainId.value = on
}

describe("L1WalletPanel", () => {
	beforeEach(() => {
		address.value = null
		chainId.value = null
		isConnected.value = false
		isConnecting.value = false
		sourceChains.ids = []
		connect.mockClear()
		disconnect.mockClear()
		switchL1Network.mockClear()
	})

	it("disconnected: shows the connect button as the secondary one, no account chip", () => {
		const w = mount(L1WalletPanel)
		expect(w.get(sel(TESTIDS.l1Connect)).classes().join(" ")).toMatch(/secondary/)
		expect(w.find(sel(TESTIDS.l1Account)).exists()).toBe(false)
	})

	it("connected + wrong chain: shows account, switch, disconnect; wires their handlers", async () => {
		connected(1)
		const w = mount(L1WalletPanel)
		expect(w.find(sel(TESTIDS.l1Account)).exists()).toBe(true)
		expect(w.text()).toContain("Ethereum wallet")
		expect(w.find(sel(TESTIDS.l1Networks)).exists()).toBe(false)
		await w.find(sel(TESTIDS.l1SwitchChain)).trigger("click")
		expect(switchL1Network).toHaveBeenCalled()
		const off = w.get(sel(TESTIDS.l1Disconnect))
		expect(off.attributes("aria-label")).toBe("Disconnect Ethereum wallet")
		expect(off.attributes("title")).toBe("Disconnect")
		await off.trigger("click")
		expect(disconnect).toHaveBeenCalled()
	})

	it("connected on the right chain: no switch-chain button", () => {
		connected(NETWORK.l1ChainId)
		const w = mount(L1WalletPanel)
		expect(w.find(sel(TESTIDS.l1SwitchChain)).exists()).toBe(false)
	})

	it("with source chains: counts the networks the account signs on, and a source chain is never the wrong one", () => {
		sourceChains.ids = [BASE_SEPOLIA]
		connected(BASE_SEPOLIA)
		const w = mount(L1WalletPanel)
		expect(w.get(sel(TESTIDS.l1Networks)).text()).toBe("· 2 networks")
		expect(w.find(sel(TESTIDS.l1SwitchChain)).exists()).toBe(false)
	})
})
