import { flushPromises } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"

const receipt = { value: {} as Record<string, unknown> }
vi.mock("./useEthereumReader", () => ({
	readClientFor: () => ({ getTransactionReceipt: async () => receipt.value }),
}))

import { useAttemptFee } from "./useAttemptFee"

const tx = { chainId: 84532, hash: `0x${"57".repeat(32)}` }
const gas = { gasUsed: 41_000n, effectiveGasPrice: 1_000_000_000n }

async function feeOf(r: Record<string, unknown>): Promise<string | undefined> {
	receipt.value = r
	const fee = useAttemptFee(() => tx)
	await flushPromises()
	return fee.value
}

describe("useAttemptFee", () => {
	it("adds the OP-stack L1 fee to the execution gas, and states no figure when that fee is missing", async () => {
		expect(await feeOf({ ...gas, l1Fee: 2_000_000_000_000n })).toBe("0.000043")
		expect(await feeOf({ ...gas, l1Fee: null })).toBeUndefined()
		expect(await feeOf(gas)).toBe("0.000041")
	})
})
