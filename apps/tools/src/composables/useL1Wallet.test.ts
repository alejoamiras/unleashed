import { afterEach, describe, expect, it, vi } from "vitest"
import { readChainOf } from "@/lib/network"
import { useL1Wallet } from "./useL1Wallet"

const BASE_SEPOLIA = 84532

/** An injected wallet that answers the first switch with `firstSwitch`, then accepts everything. */
function wallet(firstSwitch: { code: number; message: string }) {
	const methods: string[] = []
	const request = vi.fn(async ({ method }: { method: string; params?: unknown }) => {
		methods.push(method)
		if (methods.length === 1) throw Object.assign(new Error(firstSwitch.message), { code: firstSwitch.code })
		return null
	})
	vi.stubGlobal("ethereum", { request, on: vi.fn(), removeListener: vi.fn() })
	return { methods, request }
}

afterEach(() => {
	vi.unstubAllGlobals()
	useL1Wallet().error.value = null
})

describe("useL1Wallet.switchChain", () => {
	it("adds a chain the wallet does not know, with the build's own RPCs, then switches to it", async () => {
		const { methods, request } = wallet({ code: 4902, message: "Unrecognized chain ID" })
		await expect(useL1Wallet().switchChain(BASE_SEPOLIA)).resolves.toBe(true)
		expect(methods).toEqual(["wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain"])
		expect(request.mock.calls[1]?.[0].params).toEqual([
			expect.objectContaining({
				chainId: "0x14a34",
				chainName: "Base Sepolia",
				rpcUrls: [...(readChainOf(BASE_SEPOLIA)?.rpcUrls ?? [])],
			}),
		])
	})

	it("takes a refusal as the answer: no chain is added and the reason is kept", async () => {
		const { methods } = wallet({ code: 4001, message: "User rejected the request." })
		await expect(useL1Wallet().switchChain(BASE_SEPOLIA)).resolves.toBe(false)
		expect(methods).toEqual(["wallet_switchEthereumChain"])
		expect(useL1Wallet().error.value).toBe("User rejected the request.")
	})
})
