import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { crossChainLogLinks } from "@/lib/crosschain-steps"
import { XC_CREATED, XC_SRC_TX, xcRecord } from "@/test/crosschain-record"
import BridgeLog from "./BridgeLog.vue"

describe("BridgeLog", () => {
	it("keeps every short hash whole, and links the ones its caller names", () => {
		const rows = [
			{ seq: 1, at: XC_CREATED + 42_000, text: "Base Sepolia confirmed 0x5757…5757" },
			{ seq: 2, at: XC_CREATED + 50_000, text: "Approval hash observed · 0x000000…0001" },
		]
		const w = mount(BridgeLog, { props: { rows, startedAt: XC_CREATED, links: crossChainLogLinks(xcRecord()) } })
		const link = w.get("a.hash")
		expect([link.text(), link.attributes("href")]).toEqual(["0x5757…5757", `https://sepolia.basescan.org/tx/${XC_SRC_TX}`])
		expect(w.findAll(".hash").map((h) => h.text())).toEqual(["0x5757…5757", "0x000000…0001"])
		expect(w.findAll(".row").map((r) => r.text())).toEqual([
			"0:42Base Sepolia confirmed 0x5757…5757",
			"0:50Approval hash observed · 0x000000…0001_",
		])
	})
})
