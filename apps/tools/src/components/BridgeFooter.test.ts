import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

const net = vi.hoisted(() => ({ mainnet: false, generation: true as boolean }))

vi.mock("@/lib/network", () => ({
	get IS_MAINNET() {
		return net.mainnet
	},
	NETWORK: { viemChain: { name: "Sepolia" } },
}))
vi.mock("@/contracts/bridge-generation", () => ({
	get GENERATION() {
		return net.generation ? { l1: { factory: "0xfactory", router: "0xrouter" } } : null
	},
	get HUB() {
		return net.generation ? { toString: () => "0xhub" } : undefined
	},
	FUEL_PORTAL: "0xfeejuice",
}))
vi.mock("@/lib/explorer", () => ({
	etherscanAddressUrl: (a: string) => (a ? `https://l1.example/address/${a}` : ""),
	explorerAddressUrl: (a: string) => (a ? `https://l2.example/${a}` : ""),
}))

import BridgeFooter from "./BridgeFooter.vue"

describe("BridgeFooter", () => {
	beforeEach(() => {
		net.mainnet = false
		net.generation = true
	})

	it("on testnet is one row of contract links, with no separators and no tagline", () => {
		const w = mount(BridgeFooter)
		expect(w.findAll("p")).toHaveLength(1)
		expect(w.text()).not.toContain("·")
		expect(w.text()).not.toMatch(/Testnet only|Real funds/)
		expect(w.findAll("a").map((a) => a.text())).toEqual(["Portal factory", "Router", "Fee Juice portal", "Bridge hub"])
		expect(w.findAll("a").every((a) => a.attributes("rel") === "noopener noreferrer")).toBe(true)
	})

	it("on mainnet keeps the real-funds warning as its second line", () => {
		net.mainnet = true
		const w = mount(BridgeFooter)
		const lines = w.findAll("p")
		expect(lines).toHaveLength(2)
		expect(lines[1]?.text()).toBe("Real funds — keep it small")
	})

	it("names the contracts as plain labels when there is no generation to link", () => {
		net.generation = false
		const w = mount(BridgeFooter)
		expect(w.findAll("a").map((a) => a.text())).toEqual(["Fee Juice portal"])
		expect(w.text()).toContain("Portal factory")
		expect(w.text()).toContain("Bridge hub")
	})
})
