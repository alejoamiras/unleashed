import { lifiBook } from "@unleashed/bridge-core"
import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

const net = vi.hoisted(() => ({ mainnet: false }))
const HUB = `0x${"b".repeat(64)}`
const FACTORY = `0x${"f".repeat(40)}`
const ROUTER = `0x${"d".repeat(40)}`
const PORTAL = `0x${"e".repeat(40)}`

vi.mock("@/lib/network", async (original) => ({
	...(await original<typeof import("@/lib/network")>()),
	get IS_MAINNET() {
		return net.mainnet
	},
}))
vi.mock("@/contracts/bridge-generation", () => ({
	FUEL_PORTAL: `0x${"e".repeat(40)}`,
	GENERATION: { l1: { factory: `0x${"f".repeat(40)}`, depositRouter: `0x${"d".repeat(40)}`, router: `0x${"0".repeat(40)}` } },
	HUB: { toString: () => `0x${"b".repeat(64)}` },
	MANIFEST: {
		l1ChainId: 11155111,
		bridge: {
			routing: {
				provider: "lifi",
				sources: [{ chainId: 84532, rail: "acrossV4", tokens: [{ address: `0x${"1".repeat(40)}`, symbol: "USDC", decimals: 6 }] }],
			},
		},
	},
}))

import BridgeFooter from "./BridgeFooter.vue"

const links = (w: ReturnType<typeof mount>) => w.findAll("a").map((a) => [a.text(), a.attributes("href")])

describe("BridgeFooter", () => {
	beforeEach(() => {
		net.mainnet = false
	})

	it("on the form it is only the real-funds warning on mainnet, and nothing on testnet", () => {
		expect(mount(BridgeFooter).find("footer").exists()).toBe(false)
		net.mainnet = true
		const w = mount(BridgeFooter)
		expect(w.text()).toBe("Real funds — keep it small")
		expect(w.findAll("a")).toHaveLength(0)
	})

	it("with contracts it links each chain's contracts on that chain's explorer", () => {
		const w = mount(BridgeFooter, { props: { contracts: true } })
		expect(w.findAll(".chain").map((c) => c.text())).toEqual(["Base Sepolia:", "Ethereum · Sepolia:", "Aztec:"])
		expect(links(w)).toEqual([
			["LI.FI", `https://sepolia.basescan.org/address/${lifiBook(84532).diamond}`],
			["Portal factory", `https://sepolia.etherscan.io/address/${FACTORY}`],
			["Unleashed router", `https://sepolia.etherscan.io/address/${ROUTER}`],
			["Fee Juice portal", `https://sepolia.etherscan.io/address/${PORTAL}`],
			["Bridge hub", `https://testnet.aztecscan.xyz/contracts/instances/${HUB}`],
		])
		expect(w.text()).not.toContain("Real funds")
	})
})
