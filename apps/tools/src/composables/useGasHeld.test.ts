import { flushPromises } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { useGasHeld } from "./useGasHeld"

const h = vi.hoisted(() => ({ priv: vi.fn<() => Promise<bigint>>(), pub: vi.fn<() => Promise<bigint>>(), selfPay: false }))

vi.mock("./deposit-flow", () => ({
	readPrivateFeeJuiceBalance: () => h.priv(),
	readPublicFeeJuiceBalance: () => h.pub(),
	readFeeJuiceOrNull: async (_label: string, read: () => Promise<bigint>) => {
		try {
			return await read()
		} catch {
			return null
		}
	},
}))
vi.mock("@/lib/wallet-features", () => ({
	DAPP_SELF_PAY_FEATURE: "dapp-self-pay",
	walletSupports: async () => h.selfPay,
}))

const ACCOUNT = `0x${"10".repeat(32)}`

function harness(account: string | null = ACCOUNT, aztec: unknown = {}) {
	const who = ref<string | undefined>(account ?? undefined)
	const wallet = ref(aztec)
	return { who, wallet, handle: useGasHeld({ aztec: () => wallet.value, account: () => who.value }) }
}

describe("useGasHeld", () => {
	beforeEach(() => {
		h.priv.mockReset().mockResolvedValue(0n)
		h.pub.mockReset().mockResolvedValue(0n)
		h.selfPay = false
	})

	it("is unknown without an Aztec account", async () => {
		const { handle } = harness(null)
		await flushPromises()
		expect(handle.credit.value).toBeNull()
		expect(handle.publicFeeJuice.value).toBeNull()
		expect(h.priv).not.toHaveBeenCalled()
	})

	it("reports the private balance at the fee contract, a zero included", async () => {
		h.priv.mockResolvedValue(5n)
		const { handle } = harness()
		await flushPromises()
		expect(handle.credit.value).toBe(5n)
		h.priv.mockResolvedValue(0n)
		await handle.refresh()
		expect(handle.credit.value).toBe(0n)
	})

	it("reads the public balance only on a wallet that routes a dApp-named payer; elsewhere it is nothing to pay with", async () => {
		h.pub.mockResolvedValue(7n)
		const { handle } = harness()
		await flushPromises()
		expect(handle.selfPay.value).toBe(false)
		expect(handle.publicFeeJuice.value).toBe(0n)
		expect(h.pub).not.toHaveBeenCalled()
		h.selfPay = true
		await handle.refresh()
		expect(handle.selfPay.value).toBe(true)
		expect(handle.publicFeeJuice.value).toBe(7n)
	})

	it("an unreadable balance leaves the answer open rather than claiming an empty account", async () => {
		h.priv.mockRejectedValue(new Error("rpc"))
		const { handle } = harness()
		await flushPromises()
		expect(handle.credit.value).toBeNull()
	})

	it("re-reads when the account changes, and a stale read never lands", async () => {
		let release = (): void => {}
		h.priv.mockImplementationOnce(() => new Promise((r) => (release = () => r(9n))))
		const { who, handle } = harness()
		await flushPromises()
		who.value = `0x${"20".repeat(32)}`
		await flushPromises()
		release()
		await flushPromises()
		expect(handle.credit.value).toBe(0n)
		expect(h.priv).toHaveBeenCalledTimes(2)
	})
})
