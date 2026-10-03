import { beforeEach, describe, expect, it, vi } from "vitest"
import { effectScope, nextTick, ref } from "vue"
import type { DisplayAmount } from "@/lib/asset-label"

const lastCompleted = ref<{
	id: string
	direction: "deposit" | "withdraw"
	display: DisplayAmount
	isPrivate: boolean
	assetKind?: "bridge-token" | "fee-juice"
	txHash?: string
	foreground?: boolean
} | null>(null)
const push = vi.fn()

vi.mock("@/composables/useBridgeJournal", () => ({ useBridgeJournal: () => ({ lastCompleted }) }))
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ push }) }))

import { useCompletionToasts } from "./useCompletionToasts"

const UNIT = 10n ** 18n
const shown = (raw: bigint, symbol: string, decimals = 18, atLeast = false, gross = false): DisplayAmount => ({
	raw: raw.toString(),
	decimals,
	atLeast,
	symbol,
	gross,
})
const GOOD_HASH = `0x${"ab".repeat(32)}`

describe("useCompletionToasts", () => {
	beforeEach(() => {
		lastCompleted.value = null
		push.mockClear()
	})

	// Each call registers a watcher on the module-shared ref; scope it so earlier cases cannot fire later.
	function mountOnce() {
		const scope = effectScope()
		scope.run(() => useCompletionToasts())
		return scope
	}

	it("a FOREGROUND completion does not toast (the receipt already announced it)", async () => {
		const scope = mountOnce()
		lastCompleted.value = {
			id: "0xfg",
			direction: "deposit",
			display: shown(100n * UNIT, "USDC", 18),
			isPrivate: false,
			txHash: GOOD_HASH,
			foreground: true,
		}
		await nextTick()
		expect(push).not.toHaveBeenCalled()
		scope.stop()
	})

	it("a deposit completion toasts with the explorer link", async () => {
		const scope = mountOnce()
		lastCompleted.value = {
			id: "0xa",
			direction: "deposit",
			display: shown(100_000_000n, "USDC", 6),
			isPrivate: false,
			txHash: GOOD_HASH,
		}
		await nextTick()
		expect(push).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "ok",
				// The record's own symbol at its own decimals: a 6-decimal send is not "TOKEN" at 18.
				lead: expect.stringContaining("Bridged 100.00 USDC to Aztec"),
				link: expect.objectContaining({ href: expect.stringContaining(GOOD_HASH) }),
			}),
		)
		expect(push.mock.calls[0]?.[0]).not.toHaveProperty("text")
		scope.stop()
	})

	it("a withdraw completion uses the Ethereum wording and the etherscan link", async () => {
		const scope = mountOnce()
		lastCompleted.value = { id: "0xb", direction: "withdraw", display: shown(40n * UNIT, "WETH"), isPrivate: true, txHash: GOOD_HASH }
		await nextTick()
		expect(push).toHaveBeenCalledWith(
			expect.objectContaining({
				lead: expect.stringContaining("Released 40.00 WETH to Ethereum"),
				link: expect.objectContaining({ href: `https://sepolia.etherscan.io/tx/${GOOD_HASH}` }),
			}),
		)
		scope.stop()
	})

	it("a fee-juice completion toasts as Fee Juice, not the token (private → Private FJ)", async () => {
		const scope = mountOnce()
		lastCompleted.value = {
			id: "0xfj",
			direction: "deposit",
			display: shown(15n * UNIT, "Private FJ"),
			isPrivate: true,
			assetKind: "fee-juice",
			txHash: GOOD_HASH,
		}
		await nextTick()
		expect(push).toHaveBeenCalledWith(expect.objectContaining({ lead: expect.stringContaining("Fueled Aztec with 15.00 Private FJ") }))
		scope.stop()
	})

	it("a gas-only completion toasts its gross Fee Juice as before claim fees (at least its floor before its event)", async () => {
		const scope = mountOnce()
		lastCompleted.value = {
			id: "0xgas",
			direction: "deposit",
			display: shown(2n * UNIT, "FJ", 18, true, true),
			isPrivate: false,
			assetKind: "fee-juice",
		}
		await nextTick()
		expect(push).toHaveBeenCalledWith(expect.objectContaining({ lead: "Fueled Aztec with ≥ 2.00 FJ", text: "before claim fees" }))
		scope.stop()
	})

	it("one owner: two calls would double the toast, so the shell calls it once", async () => {
		const a = mountOnce()
		const b = mountOnce()
		lastCompleted.value = { id: "0xc", direction: "deposit", display: shown(UNIT, "USDC"), isPrivate: false }
		await nextTick()
		expect(push).toHaveBeenCalledTimes(2)
		a.stop()
		b.stop()
	})
})
