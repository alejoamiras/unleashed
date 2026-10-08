import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { TESTIDS } from "@/lib/testids"
import WrongChainNotice from "./WrongChainNotice.vue"

describe("WrongChainNotice", () => {
	it("names the wallet's chain and the send's, and asks for the switch", async () => {
		const w = mount(WrongChainNotice, { props: { walletChainId: 42161, needChainId: 84532 } })
		const notice = w.get(`[data-testid="${TESTIDS.sendWrongChain}"]`)
		expect(notice.attributes("role")).toBe("status")
		expect(notice.text()).toContain("Your wallet is on Arbitrum.")
		expect(notice.text()).toContain("This send starts on Base Sepolia.")
		const action = w.get(`[data-testid="${TESTIDS.sendWrongChainSwitch}"]`)
		expect(action.text()).toBe("Switch to Base Sepolia")
		await action.trigger("click")
		expect(w.emitted("switch")).toHaveLength(1)
		w.unmount()
	})
})
