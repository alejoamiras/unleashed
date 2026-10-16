import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { TESTIDS } from "@/lib/testids"

const l1 = vi.hoisted(() => ({ connect: vi.fn(async () => {}), switchL1Network: vi.fn(async () => {}) }))
const wallet = { isConnected: ref(false), wrongChain: ref(false), isConnecting: ref(false), error: ref<string | null>(null) }
const fee = {
	available: true,
	amountText: ref<string | null>("1000"),
	minting: ref(false),
	error: ref<string | null>(null),
	mint: vi.fn(async (): Promise<{ amount: bigint | null; txHash: string } | null> => ({ amount: 1000n * 10n ** 18n, txHash: "0xmint" })),
}

vi.mock("@/composables/useL1Wallet", () => ({ useL1Wallet: () => ({ ...wallet, ...l1 }) }))
vi.mock("@/composables/useFeeAssetMint", async () => {
	const { computed } = await import("vue")
	return {
		formatWhole: (v: bigint) => (v / 10n ** 18n).toString(),
		useFeeAssetMint: () => ({ ...fee, amountText: computed(() => fee.amountText.value) }),
	}
})
vi.mock("@/lib/network", () => ({ NETWORK: { viemChain: { name: "Sepolia" } } }))

import MintFeeAssetCard from "./MintFeeAssetCard.vue"

const sel = (t: string) => `[data-testid="${t}"]`
const button = (w: ReturnType<typeof mount>) => w.find(sel(TESTIDS.dripFeeAssetMint))
const status = (w: ReturnType<typeof mount>) => w.find(sel(TESTIDS.dripFeeAssetStatus))

beforeEach(() => {
	vi.clearAllMocks()
	wallet.isConnected.value = false
	wallet.wrongChain.value = false
	wallet.error.value = null
	fee.available = true
	fee.amountText.value = "1000"
	fee.error.value = null
})

describe("MintFeeAssetCard", () => {
	it("is absent on a network with no fee-asset handler", () => {
		fee.available = false
		expect(mount(MintFeeAssetCard).find(sel(TESTIDS.dripFeeAssetCard)).exists()).toBe(false)
	})

	it("walks the one button through connect, switch and mint", async () => {
		const w = mount(MintFeeAssetCard)
		expect(button(w).text()).toBe("Connect Ethereum wallet")
		await button(w).trigger("click")
		expect(l1.connect).toHaveBeenCalledOnce()

		wallet.isConnected.value = true
		wallet.wrongChain.value = true
		await flushPromises()
		expect(button(w).text()).toBe("Switch to Sepolia")
		await button(w).trigger("click")
		expect(l1.switchL1Network).toHaveBeenCalledOnce()

		wallet.wrongChain.value = false
		await flushPromises()
		expect(button(w).text()).toBe("+1000 AZTEC")
		await button(w).trigger("click")
		await flushPromises()
		expect(fee.mint).toHaveBeenCalledOnce()
		expect(status(w).text()).toBe("Minted 1000 AZTEC. Bridge it on Send.")
	})

	it("claims no amount the receipt did not show", async () => {
		wallet.isConnected.value = true
		fee.mint.mockResolvedValueOnce({ amount: null, txHash: "0xmint" })
		const w = mount(MintFeeAssetCard)
		await button(w).trigger("click")
		await flushPromises()
		expect(status(w).text()).toBe("Minted. Bridge it on Send.")
	})

	it("a failed mint shows its error and no success", async () => {
		wallet.isConnected.value = true
		fee.mint.mockImplementationOnce(async () => {
			fee.error.value = "Mint transaction reverted on-chain."
			return null
		})
		const w = mount(MintFeeAssetCard)
		await button(w).trigger("click")
		await flushPromises()
		expect(status(w).text()).toContain("reverted")
		expect(status(w).attributes("data-error")).toBe("true")
	})

	it("gives every interactive element a data-testid", () => {
		const w = mount(MintFeeAssetCard)
		const bare = w.findAll("button, a[href], input, [tabindex]").filter((el) => !el.attributes("data-testid"))
		expect(w.findAll("button").length).toBeGreaterThan(0)
		expect(bare).toEqual([])
	})

	it("explains a failed connect or switch, even under an earlier mint's failure", async () => {
		fee.error.value = "Mint transaction reverted on-chain."
		wallet.error.value = "No Ethereum wallet detected. Install Rabby or MetaMask."
		const w = mount(MintFeeAssetCard)
		expect(status(w).text()).toBe("No Ethereum wallet detected. Install Rabby or MetaMask.")
		wallet.isConnected.value = true
		wallet.wrongChain.value = true
		wallet.error.value = "The wallet refused the network switch."
		await flushPromises()
		expect(status(w).text()).toBe("The wallet refused the network switch.")
	})
})
