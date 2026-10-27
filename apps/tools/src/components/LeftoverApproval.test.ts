import { lifiBook } from "@unleashed/bridge-core"
import { flushPromises, mount } from "@vue/test-utils"
import { encodeFunctionData, erc20Abi } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { XC_SENDER, XC_SOURCE, xcRecord } from "@/test/crosschain-record"

let allowance = 500_000_000n
const reader = {
	readContract: vi.fn(async () => allowance),
	waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
}
vi.mock("@/composables/useEthereumReader", () => ({ readClientFor: (id: number) => (id === XC_SOURCE ? reader : undefined) }))
const sendTransaction = vi.fn(async () => {
	allowance = 0n
	return `0x${"ab".repeat(32)}`
})
const wallet = { address: ref<string | null>(XC_SENDER), chainId: ref(11155111), switchChain: vi.fn(async () => true) }
vi.mock("@/composables/useL1Wallet", () => ({ useL1Wallet: () => ({ ...wallet, ensureWalletClient: () => ({ sendTransaction }) }) }))
vi.mock("@/composables/useBridgeJournal", () => ({ runOnLane: (_lane: string, fn: () => Promise<unknown>) => fn() }))

import { TESTIDS } from "@/lib/testids"
import LeftoverApproval from "./LeftoverApproval.vue"

const notSent = () => xcRecord({ completedAt: 2 }, { outcome: "not-sent" })

describe("LeftoverApproval", () => {
	beforeEach(() => {
		allowance = 500_000_000n
		wallet.address.value = XC_SENDER
		vi.clearAllMocks()
	})

	it("offers the revoke while the Diamond can spend, and sends exactly approve(diamond, 0) on the source chain", async () => {
		const rec = notSent()
		const w = mount(LeftoverApproval, { props: { record: rec } })
		await flushPromises()
		expect(w.text()).toContain("LI.FI’s contract can still spend 500.00 USDC from your wallet on Base Sepolia.")
		await w.get(`[data-testid="${TESTIDS.journalXcRevoke}"]`).trigger("click")
		await flushPromises()
		const diamond = lifiBook(XC_SOURCE).diamond
		expect(wallet.switchChain).toHaveBeenCalledWith(XC_SOURCE)
		expect(sendTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				account: XC_SENDER,
				to: rec.route.srcToken,
				value: 0n,
				data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [diamond, 0n] }),
				chain: expect.objectContaining({ id: XC_SOURCE }),
			}),
		)
		expect(w.find(`[data-testid="${TESTIDS.journalXcRevoke}"]`).exists()).toBe(false)
	})

	it("refuses another account's wallet before any prompt", async () => {
		wallet.address.value = `0x${"9".repeat(40)}`
		const w = mount(LeftoverApproval, { props: { record: notSent() } })
		await flushPromises()
		await w.get(`[data-testid="${TESTIDS.journalXcRevoke}"]`).trigger("click")
		await flushPromises()
		expect(w.get("[role='alert']").text()).toBe("Switch your wallet to 0x3fA8…c41d to revoke.")
		expect(wallet.switchChain).not.toHaveBeenCalled()
		expect(sendTransaction).not.toHaveBeenCalled()
	})
})
