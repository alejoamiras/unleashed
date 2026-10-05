import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

const net = vi.hoisted(() => ({ mainnet: false }))

vi.mock("@/lib/network", () => ({
	get IS_MAINNET() {
		return net.mainnet
	},
}))

import BridgeFooter from "./BridgeFooter.vue"

describe("BridgeFooter", () => {
	beforeEach(() => {
		net.mainnet = false
	})

	it("is only the real-funds warning on mainnet, and nothing on testnet", () => {
		expect(mount(BridgeFooter).find("footer").exists()).toBe(false)
		net.mainnet = true
		const w = mount(BridgeFooter)
		expect(w.text()).toBe("Real funds — keep it small")
		expect(w.findAll("a")).toHaveLength(0)
	})
})
