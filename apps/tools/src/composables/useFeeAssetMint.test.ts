import { flushPromises } from "@vue/test-utils"
import { type Address, encodeAbiParameters, encodeEventTopics, erc20Abi, type Log, zeroAddress } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { effectScope, ref } from "vue"

const { ASSET, HANDLER, OWNER } = vi.hoisted(() => ({
	ASSET: "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6" as const,
	HANDLER: "0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9" as const,
	OWNER: "0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d" as const,
}))

const chain = { live: 11155111 }
const reads = { feeAsset: ASSET as string, mintAmount: 1000n * 10n ** 18n, failAmount: false }
const receipt = { status: "success" as "success" | "reverted", logs: [] as Log[], confirmed: true }
const writeContract = vi.fn(async () => "0xmint" as const)
const address = ref<string | null>(OWNER)
const isConnected = ref(true)
const wrongChain = ref(false)
const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
	if (functionName === "FEE_ASSET") return reads.feeAsset
	if (reads.failAmount) throw new Error("no provider")
	return reads.mintAmount
})

// Shaped like the real wait: a revert and an exhausted wait both throw.
vi.mock("@unleashed/bridge-core", () => ({
	awaitL1Receipt: async () => {
		if (!receipt.confirmed) throw new Error("The Ethereum transaction 0xmint was not confirmed after 2 rounds of waiting.")
		if (receipt.status === "reverted") throw new Error("The Ethereum transaction 0xmint reverted on-chain.")
		return receipt
	},
}))
vi.mock("@/contracts/bridge-generation", () => ({ FUEL_ASSET: ASSET, FUEL_ASSET_HANDLER: HANDLER }))
vi.mock("@/lib/network", () => ({ NETWORK: { l1ChainId: 11155111, viemChain: { id: 11155111 } } }))
vi.mock("./useSend", () => ({
	assertL1Chain: async () => {
		if (chain.live !== 11155111) throw new Error(`Your Ethereum wallet is on chain ${chain.live}`)
	},
}))
vi.mock("./useL1Wallet", () => ({
	useL1Wallet: () => ({
		address,
		isConnected,
		wrongChain,
		publicClient: { readContract, getChainId: async () => chain.live },
		ensureWalletClient: () => (address.value ? { writeContract } : null),
	}),
}))

import { __resetFeeAssetMintForTests, feeAssetMinted, formatWhole, useFeeAssetMint } from "./useFeeAssetMint"

function transfer(from: Address, to: Address, value: bigint, emitter: string = ASSET): Log {
	return {
		address: emitter,
		topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
		data: encodeAbiParameters([{ type: "uint256" }], [value]),
	} as unknown as Log
}

function mounted() {
	const scope = effectScope()
	const handle = scope.run(() => useFeeAssetMint())
	if (!handle) throw new Error("no handle")
	return handle
}

beforeEach(() => {
	__resetFeeAssetMintForTests()
	writeContract.mockClear()
	readContract.mockClear()
	chain.live = 11155111
	reads.feeAsset = ASSET
	reads.mintAmount = 1000n * 10n ** 18n
	reads.failAmount = false
	receipt.status = "success"
	receipt.confirmed = true
	receipt.logs = [transfer(zeroAddress, OWNER, 1000n * 10n ** 18n)]
	address.value = OWNER
	isConnected.value = true
	wrongChain.value = false
})

describe("useFeeAssetMint", () => {
	it("reads the per-call amount once connected, and again after a failed read on the next connect", async () => {
		reads.failAmount = true
		const m = mounted()
		await flushPromises()
		expect(m.amountText.value).toBeNull()
		reads.failAmount = false
		isConnected.value = false
		await flushPromises()
		isConnected.value = true
		await flushPromises()
		expect(m.amountText.value).toBe("1,000")
	})

	it("words an amount with every digit and its thousands grouped", () => {
		expect([formatWhole(1_000n * 10n ** 18n), formatWhole(1_234_500n * 10n ** 15n), formatWhole(5n * 10n ** 17n)]).toEqual([
			"1,000",
			"1,234.5",
			"0.5",
		])
	})

	it("a read still in flight from before a disconnect never overwrites the reconnect's amount", async () => {
		let drop = (): void => {}
		readContract.mockImplementationOnce(() => new Promise((_, reject) => (drop = () => reject(new Error("stale provider")))))
		const m = mounted()
		await flushPromises()
		isConnected.value = false
		await flushPromises()
		isConnected.value = true
		await flushPromises()
		drop()
		await flushPromises()
		expect(m.amountText.value).toBe("1,000")
	})

	it("mints to the connected account and reports the amount the Transfer log credited", async () => {
		reads.mintAmount = 5n * 10n ** 18n
		receipt.logs = [
			transfer(zeroAddress, "0x00000000000000000000000000000000000000aa", 9n),
			transfer(zeroAddress, OWNER, 7n * 10n ** 18n),
		]
		const m = mounted()
		const minted = await m.mint()
		expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ address: HANDLER, functionName: "mint", args: [OWNER] }))
		expect(minted?.amount).toBe(7n * 10n ** 18n)
		expect(feeAssetMinted.value).toEqual(minted)
	})

	it("a receipt with no credit to the minter reports no amount rather than an assumed one", async () => {
		receipt.logs = [transfer(zeroAddress, OWNER, 1n, "0x0000000000000000000000000000000000000bad")]
		const minted = await mounted().mint()
		expect(minted).not.toBeNull()
		expect(minted?.amount).toBeNull()
	})

	it("refuses a handler that mints another asset before anything is signed", async () => {
		reads.feeAsset = "0x0000000000000000000000000000000000000bad"
		const m = mounted()
		expect(await m.mint()).toBeNull()
		expect(writeContract).not.toHaveBeenCalled()
		expect(m.error.value).toContain("does not mint")
	})

	it("refuses on the wrong chain", async () => {
		chain.live = 1
		const m = mounted()
		expect(await m.mint()).toBeNull()
		expect(writeContract).not.toHaveBeenCalled()
		expect(m.error.value).toContain("chain 1")
	})

	it("a mined revert is an error, not a mint", async () => {
		receipt.status = "reverted"
		const m = mounted()
		expect(await m.mint()).toBeNull()
		expect(m.error.value).toContain("reverted")
		expect(feeAssetMinted.value).toBeNull()
	})

	it("a sent mint whose receipt cannot be read names its hash and frees the lock", async () => {
		receipt.confirmed = false
		const m = mounted()
		expect(await m.mint()).toBeNull()
		expect(m.error.value).toContain("0xmint was sent but not confirmed")
		expect(m.minting.value).toBe(false)
	})

	it("without an Ethereum wallet asks for one", async () => {
		address.value = null
		const m = mounted()
		expect(await m.mint()).toBeNull()
		expect(m.error.value).toContain("Connect your Ethereum wallet")
	})

	it("one mint at a time across surfaces, and a failure stays on the surface that had it", async () => {
		let release = (): void => {}
		writeContract.mockImplementationOnce(() => new Promise((r) => (release = () => r("0xmint"))))
		const strip = mounted()
		const card = mounted()
		const first = strip.mint()
		await flushPromises()
		expect(card.minting.value).toBe(true)
		expect(await card.mint()).toBeNull()
		expect(writeContract).toHaveBeenCalledTimes(1)
		release()
		await first
		receipt.status = "reverted"
		await card.mint()
		expect(card.error.value).toContain("reverted")
		expect(strip.error.value).toBeNull()
	})
})
