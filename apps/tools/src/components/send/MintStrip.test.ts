import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { TESTIDS } from "@/lib/testids"

const { MINTABLE, tokens } = vi.hoisted(() => {
	const MINTABLE = "0x70e0ba845a1a0f2da3359c97e0285013525ffc49"
	const CANONICAL = "0x4826533b4897376654bb4d4ad88b7fafd0c98528"
	const CAPPED = "0x0e801d84fa97b50751dbf25036d067dcf18858bf"
	const all = [
		{ erc20: MINTABLE, decimals: 6, displaySymbol: "USDC", source: "permissionless-mint", maxWholePerTx: 1000 },
		{ erc20: CANONICAL, decimals: 18, displaySymbol: "REAL", source: "canonical" },
		{ erc20: CAPPED, decimals: 18, displaySymbol: "CAP", source: "permissionless-mint", maxWholePerTx: 5 },
	]
	return { MINTABLE, tokens: { value: all, all } }
})

const writeContract = vi.fn(async () => "0xmint")
const receiptStatus = { value: "success" as "success" | "reverted" }
const address = ref<string | null>("0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d")

vi.mock("@unleashed/bridge-core", () => ({ awaitL1Receipt: async () => ({ status: receiptStatus.value }) }))
vi.mock("@/contracts/bridge-generation", () => ({
	get MANIFEST_TOKENS() {
		return tokens.value
	},
}))
vi.mock("@/composables/useL1Wallet", () => ({
	useL1Wallet: () => ({
		address,
		publicClient: {},
		ensureWalletClient: () => (address.value ? { writeContract } : null),
	}),
}))

import MintStrip from "./MintStrip.vue"

const sel = (t: string) => `[data-testid="${t}"]`

beforeEach(() => {
	writeContract.mockClear()
	writeContract.mockResolvedValue("0xmint")
	receiptStatus.value = "success"
	address.value = "0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d"
	tokens.value = tokens.all
})

describe("MintStrip", () => {
	it("renders nothing when the manifest publishes no permissionless token — a mainnet build", () => {
		tokens.value = tokens.all.filter((t) => t.source === "canonical")
		expect(mount(MintStrip).find(sel(TESTIDS.mintL1Card)).exists()).toBe(false)
	})

	it("offers one tap per permissionless token, 100 whole units or the token's own cap", () => {
		const w = mount(MintStrip)
		const buttons = w.findAll(sel(TESTIDS.mintL1))
		expect(buttons.map((b) => b.text())).toEqual(["+100 USDC", "+5 CAP"])
		expect(buttons.map((b) => b.attributes("data-symbol"))).toEqual(["USDC", "CAP"])
	})

	it("mints the whole amount in the token's own decimals, waits on every tap meanwhile, then reports", async () => {
		const w = mount(MintStrip)
		let release = (): void => {}
		writeContract.mockImplementationOnce(() => new Promise<string>((r) => (release = () => r("0xmint"))))
		await w.findAll(sel(TESTIDS.mintL1))[0]?.trigger("click")
		expect(w.findAll(sel(TESTIDS.mintL1)).map((b) => b.attributes("disabled"))).toEqual(["", ""])
		// The busy button keeps its label and shows its state in pixels and aria-busy, not in words.
		const busy = w.findAll(sel(TESTIDS.mintL1))
		expect(busy[0]?.text()).toBe("+100 USDC")
		expect(busy.map((b) => b.attributes("aria-busy"))).toEqual(["true", undefined])
		// The button is the whole status; nothing else narrates a running mint.
		expect(w.find(sel(TESTIDS.mintL1Status)).exists()).toBe(false)
		release()
		await flushPromises()
		expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ address: MINTABLE, args: [address.value, 100n * 10n ** 6n] }))
		expect(w.emitted("minted")).toEqual([[MINTABLE]])
		expect(w.findAll(sel(TESTIDS.mintL1))[0]?.attributes("disabled")).toBeUndefined()
		expect(w.findAll(sel(TESTIDS.mintL1))[0]?.attributes("aria-busy")).toBeUndefined()
		expect(w.find(sel(TESTIDS.mintL1Status)).exists()).toBe(false)
	})

	it("a mined revert is an error, not a mint", async () => {
		receiptStatus.value = "reverted"
		const w = mount(MintStrip)
		await w.findAll(sel(TESTIDS.mintL1))[1]?.trigger("click")
		await flushPromises()
		expect(w.emitted("minted")).toBeUndefined()
		expect(w.find(sel(TESTIDS.mintL1Status)).text()).toContain("reverted")
		expect(w.find(sel(TESTIDS.mintL1Status)).attributes("data-error")).toBe("true")
	})

	it("strips and caps the wallet's error", async () => {
		writeContract.mockRejectedValueOnce(new Error(`${String.fromCodePoint(0x202e)}${"x".repeat(10_000)}`))
		const w = mount(MintStrip)
		await w.findAll(sel(TESTIDS.mintL1))[0]?.trigger("click")
		await flushPromises()
		const text = w.find(sel(TESTIDS.mintL1Status)).text()
		expect(text).not.toContain(String.fromCodePoint(0x202e))
		expect(Array.from(text).length).toBeLessThanOrEqual(241)
	})

	it("without an Ethereum wallet a tap asks for one instead of minting", async () => {
		address.value = null
		const w = mount(MintStrip)
		await w.findAll(sel(TESTIDS.mintL1))[0]?.trigger("click")
		await flushPromises()
		expect(writeContract).not.toHaveBeenCalled()
		expect(w.find(sel(TESTIDS.mintL1Status)).text()).toContain("Connect your Ethereum wallet")
	})
})
