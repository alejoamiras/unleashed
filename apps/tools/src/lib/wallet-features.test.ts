import { describe, expect, it } from "vitest"
import { DAPP_SELF_PAY_FEATURE, walletSupports } from "./wallet-features"

describe("walletSupports", () => {
	it("is true only when the wallet lists the feature", async () => {
		expect(await walletSupports({ getWalletFeatures: async () => [DAPP_SELF_PAY_FEATURE] }, DAPP_SELF_PAY_FEATURE)).toBe(true)
		expect(await walletSupports({ getWalletFeatures: async () => ["something-else"] }, DAPP_SELF_PAY_FEATURE)).toBe(false)
	})

	it("fails closed: an older build, a rejected call or a malformed answer all read as unsupported", async () => {
		expect(await walletSupports({}, DAPP_SELF_PAY_FEATURE)).toBe(false)
		expect(await walletSupports(undefined, DAPP_SELF_PAY_FEATURE)).toBe(false)
		expect(
			await walletSupports(
				{
					getWalletFeatures: async () => {
						throw new Error("Unsupported wallet method: getWalletFeatures")
					},
				},
				DAPP_SELF_PAY_FEATURE,
			),
		).toBe(false)
		expect(await walletSupports({ getWalletFeatures: async () => "dapp-self-pay" }, DAPP_SELF_PAY_FEATURE)).toBe(false)
	})
})
