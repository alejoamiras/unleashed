import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

type DripResult = { kind: "txHash"; value: string } | { kind: "error"; value: string }
const refreshFn = vi.fn(async () => {})
const dripFn = vi.fn<(_t: unknown, _a: unknown, target: "public" | "private") => Promise<DripResult>>(async (_t, _a, target) => ({
	kind: "txHash",
	value: target === "public" ? "0xpublic" : "0xprivate",
}))

// Real Vue ref so the component's reactive `dripping` computed actually
// re-runs when tests mutate inflight state. The existing mock object
// shape `{ value: … }` doesn't trigger reactivity.
const inflightRef = ref<{ tokenSymbol: string; target: string; startedAt?: number } | null>(null)

vi.mock("@/composables/useTokenBalance", () => ({
	useTokenBalance: () => ({
		publicBalance: { value: 1_000_000n },
		privateBalance: { value: 2_000_000n },
		loading: { value: false },
		error: { value: null },
		refresh: refreshFn,
		dispose: vi.fn(),
	}),
}))

vi.mock("@/composables/useDrip", () => {
	const lastRecord: Record<string, { kind: string; value: string }> = {}
	return {
		useDrip: () => ({
			inflight: inflightRef,
			last: lastRecord,
			isActive: (sym: string, tgt: string) => inflightRef.value?.tokenSymbol === sym && inflightRef.value.target === tgt,
			drip: dripFn,
		}),
	}
})

// Track returned toast ids so we can assert `dismiss(prevId)` on re-drip.
let nextToastId = 1
const pushFn = vi.fn<(toast: { kind: string; text: string; link?: { label: string; href: string } }) => number>(() => nextToastId++)
const dismissFn = vi.fn<(id: number) => void>()
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ push: pushFn, dismiss: dismissFn, toasts: { value: [] } }),
}))

vi.mock("@/lib/explorer", () => ({
	explorerTxUrl: (hash: string) => `https://explorer.test/tx/${hash}`,
}))

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { TESTIDS } from "@/lib/testids"
import TokenCard from "./TokenCard.vue"

const SIGNAL = { symbol: "SIGNAL", decimals: 6, displayAmount: "1,000", onchainAmount: 1_000_000_000n } as const
const SIGNAL_ADDR = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000002")
const ACCOUNT = AztecAddress.fromStringUnsafe("0x000000000000000000000000000000000000000000000000000000000000000a")
// biome-ignore lint/suspicious/noExplicitAny: minimal wallet stub for component mount
const WALLET = {} as any

describe("TokenCard", () => {
	beforeEach(() => {
		refreshFn.mockClear()
		dripFn.mockReset()
		dripFn.mockImplementation(async (_t, _a, target) => ({
			kind: "txHash" as const,
			value: target === "public" ? "0xpublic" : "0xprivate",
		}))
		pushFn.mockClear()
		dismissFn.mockClear()
		nextToastId = 1
		inflightRef.value = null
	})
	afterEach(() => {
		vi.clearAllMocks()
	})

	function makeCard() {
		return mount(TokenCard, {
			props: { token: SIGNAL, tokenAddress: SIGNAL_ADDR, wallet: WALLET, account: ACCOUNT },
		})
	}

	it("renders the symbol header and the fixed-amount subline", () => {
		const w = makeCard()
		expect(w.text()).toContain("SIGNAL")
		expect(w.text()).toContain("Fixed drip: 1,000 SIGNAL")
	})

	it("is an article named by its h2", () => {
		const card = makeCard().get(`[data-testid="${TESTIDS.tokenCard}"]`)
		const h2 = card.get("h2")
		expect(card.element.tagName).toBe("ARTICLE")
		expect(h2.text()).toBe("SIGNAL")
		expect(h2.attributes("id")).toBeTruthy()
		expect(card.attributes("aria-labelledby")).toBe(h2.attributes("id"))
	})

	it("renders the disclaimer chip", () => {
		const w = makeCard()
		expect(w.text()).toContain("Test token · no real value")
	})

	it("renders both drip buttons with the new 'Get …' copy (no amount)", () => {
		const w = makeCard()
		const pub = w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`)
		const priv = w.get(`[data-testid="${TESTIDS.btnDripPrivate}"]`)
		expect(pub.text()).toBe("Get SIGNAL (public)")
		expect(priv.text()).toBe("Get SIGNAL (private)")
	})

	it("drip buttons carry an aria-label that names the amount + target balance", () => {
		const w = makeCard()
		const pub = w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`)
		const priv = w.get(`[data-testid="${TESTIDS.btnDripPrivate}"]`)
		expect(pub.attributes("aria-label")).toBe("Get 1,000 SIGNAL into your public balance")
		expect(priv.attributes("aria-label")).toBe("Get 1,000 SIGNAL into your private balance")
	})

	it("renders the balance row with public + private values", () => {
		const w = makeCard()
		expect(w.get(`[data-testid="${TESTIDS.balancePublic}"]`).text()).toBe("1.00")
		expect(w.get(`[data-testid="${TESTIDS.balancePrivate}"]`).text()).toBe("2.00")
	})

	it("status row is absent when no drip has happened yet", () => {
		const w = makeCard()
		expect(w.find(`[data-testid="${TESTIDS.dripStatus}"]`).exists()).toBe(false)
	})

	it("clicking 'Get SIGNAL (public)' calls drip() with target=public and refreshes balance", async () => {
		const w = makeCard()
		await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		expect(dripFn).toHaveBeenCalledTimes(1)
		expect(dripFn.mock.calls[0][2]).toBe("public")
		expect(refreshFn).toHaveBeenCalled()
	})

	it("clicking 'Get SIGNAL (private)' calls drip() with target=private", async () => {
		const w = makeCard()
		await w.get(`[data-testid="${TESTIDS.btnDripPrivate}"]`).trigger("click")
		await Promise.resolve()
		expect(dripFn.mock.calls[0][2]).toBe("private")
	})

	it("on a successful drip, pushes a toast with the explorer link", async () => {
		const w = makeCard()
		await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		expect(pushFn).toHaveBeenCalledTimes(1)
		const arg = pushFn.mock.calls[0][0] as { kind: string; link?: { href: string } }
		expect(arg.kind).toBe("ok")
		expect(arg.link?.href).toBe("https://explorer.test/tx/0xpublic")
	})

	it("after a successful drip, the card status row appears with data-drip-status='ok'", async () => {
		const w = makeCard()
		await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		const row = w.find(`[data-testid="${TESTIDS.dripStatus}"]`)
		expect(row.exists()).toBe(true)
		expect(row.attributes("role")).toBe("status")
		expect(row.attributes("data-drip-status")).toBe("ok")
		expect(row.attributes("data-emphasized")).toBe("true")
		expect(row.get(".status-text").text()).toBe("Sent 1,000 SIGNAL to public")
		expect(row.find("a").attributes("href")).toBe("https://explorer.test/tx/0xpublic")
	})

	it("after a drip error, the card status row shows the error message and no tx link", async () => {
		dripFn.mockImplementationOnce(async () => ({ kind: "error" as const, value: "Rejected in wallet." }))
		const w = makeCard()
		await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		const row = w.find(`[data-testid="${TESTIDS.dripStatus}"]`)
		expect(row.attributes("data-drip-status")).toBe("error")
		expect(row.text()).toContain("Rejected in wallet.")
		expect(row.find("a").exists()).toBe(false)
		expect(refreshFn).not.toHaveBeenCalled()
	})

	it("recency: a later private drip overrides an earlier public drip in the status row", async () => {
		dripFn
			.mockImplementationOnce(async () => ({ kind: "txHash" as const, value: "0xpublic" }))
			.mockImplementationOnce(async () => ({ kind: "error" as const, value: "Reverted" }))
		const w = makeCard()
		await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		await w.get(`[data-testid="${TESTIDS.btnDripPrivate}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		const row = w.find(`[data-testid="${TESTIDS.dripStatus}"]`)
		expect(row.attributes("data-drip-status")).toBe("error")
		expect(row.text()).toContain("Reverted")
	})

	it("ok emphasis persists past 3s - no auto-decay timer (user-noticed-confirmation fix)", async () => {
		vi.useFakeTimers()
		const w = makeCard()
		await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		expect(w.find(`[data-testid="${TESTIDS.dripStatus}"]`).attributes("data-emphasized")).toBe("true")
		await vi.advanceTimersByTimeAsync(10_000)
		expect(w.find(`[data-testid="${TESTIDS.dripStatus}"]`).attributes("data-emphasized")).toBe("true")
		vi.useRealTimers()
	})

	it("error emphasis persists past 3s: bright red stays until next click", async () => {
		vi.useFakeTimers()
		dripFn.mockImplementationOnce(async () => ({ kind: "error" as const, value: "Reverted" }))
		const w = makeCard()
		await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		expect(w.find(`[data-testid="${TESTIDS.dripStatus}"]`).attributes("data-emphasized")).toBe("true")
		await vi.advanceTimersByTimeAsync(10_000)
		expect(w.find(`[data-testid="${TESTIDS.dripStatus}"]`).attributes("data-emphasized")).toBe("true")
		vi.useRealTimers()
	})

	it("during inflight: the status-link from the previous drip is suppressed", async () => {
		// Step 1: complete a successful drip to populate lastDrip with txUrl.
		const w = makeCard()
		await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		// Sanity: link is present now.
		expect(w.find(`[data-testid="${TESTIDS.dripStatus}"] a`).exists()).toBe(true)

		// Step 2: force inflight state on the SAME card via the shared ref. Vue's
		// computed `dripping` reads `inflightRef.value` so this triggers the
		// statusKind transition without us needing a deferred mock promise.
		inflightRef.value = { tokenSymbol: "SIGNAL", target: "private", startedAt: Date.now() - 14_000 }
		await w.vm.$nextTick()

		// Step 3: status-link should be GONE; the proving panel takes the row.
		const row = w.find(`[data-testid="${TESTIDS.dripStatus}"]`)
		expect(row.attributes("data-drip-status")).toBe("dripping")
		expect(row.find("a").exists()).toBe(false)
		expect(row.text()).toContain("Proving private")
		const bar = row.get('[role="progressbar"]')
		expect(bar.attributes("aria-valuenow")).toBeUndefined()
		expect(row.text()).toContain("waiting for your wallet to prove and send")
		expect(row.text()).not.toMatch(/on this device|%/)
		expect(row.get(".clock").attributes("aria-hidden")).toBe("true")
		expect(row.get(".clock").text()).toMatch(/^\d+:\d\d$/)
	})

	it("re-drip dismisses the prior success toast so its stale 'view tx' link can't be clicked mid-flight", async () => {
		const w = makeCard()
		// First drip → push() returns id=1, stored as lastTxToastId.
		await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		expect(dismissFn).not.toHaveBeenCalled()

		// Second drip → handler dismisses lastTxToastId (1) before awaiting drip.
		await w.get(`[data-testid="${TESTIDS.btnDripPrivate}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		expect(dismissFn).toHaveBeenCalledWith(1)
	})

	it("error → success transition: the status row fully swaps text + reveals the new tx link", async () => {
		dripFn
			.mockImplementationOnce(async () => ({ kind: "error" as const, value: "Reverted" }))
			.mockImplementationOnce(async () => ({ kind: "txHash" as const, value: "0xprivate" }))
		const w = makeCard()
		await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		let row = w.find(`[data-testid="${TESTIDS.dripStatus}"]`)
		expect(row.attributes("data-drip-status")).toBe("error")
		expect(row.find("a").exists()).toBe(false)

		await w.get(`[data-testid="${TESTIDS.btnDripPrivate}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		row = w.find(`[data-testid="${TESTIDS.dripStatus}"]`)
		expect(row.attributes("data-drip-status")).toBe("ok")
		expect(row.text()).not.toContain("Reverted")
		expect(row.find("a").attributes("href")).toBe("https://explorer.test/tx/0xprivate")
	})

	it("success → error transition: the tx link is removed and the error message takes over", async () => {
		dripFn
			.mockImplementationOnce(async () => ({ kind: "txHash" as const, value: "0xpublic" }))
			.mockImplementationOnce(async () => ({ kind: "error" as const, value: "Insufficient gas" }))
		const w = makeCard()
		await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		await w.get(`[data-testid="${TESTIDS.btnDripPrivate}"]`).trigger("click")
		await Promise.resolve()
		await Promise.resolve()
		const row = w.find(`[data-testid="${TESTIDS.dripStatus}"]`)
		expect(row.attributes("data-drip-status")).toBe("error")
		expect(row.text()).toContain("Insufficient gas")
		expect(row.find("a").exists()).toBe(false)
	})

	it("while the other card's drip runs, names it and points both buttons at the reason", async () => {
		const w = makeCard()
		const buttons = [TESTIDS.btnDripPrivate, TESTIDS.btnDripPublic].map((id) => w.get(`[data-testid="${id}"]`))
		expect(w.find(`[data-testid="${TESTIDS.dripLockReason}"]`).exists()).toBe(false)
		for (const b of buttons) expect(b.attributes("aria-describedby")).toBeUndefined()

		inflightRef.value = { tokenSymbol: "NOISE", target: "public" }
		await w.vm.$nextTick()
		const reason = w.get(`[data-testid="${TESTIDS.dripLockReason}"]`)
		expect(reason.text()).toBe("One drip at a time: the NOISE drip is still running.")
		for (const b of buttons) {
			expect(b.attributes("disabled")).toBeDefined()
			expect(b.attributes("aria-describedby")).toBe(reason.attributes("id"))
		}

		inflightRef.value = { tokenSymbol: "SIGNAL", target: "public" }
		await w.vm.$nextTick()
		expect(w.find(`[data-testid="${TESTIDS.dripLockReason}"]`).exists()).toBe(false)
		for (const b of buttons) expect(b.attributes("aria-describedby")).toBeUndefined()
	})

	it("carries the stable testid + data-symbol on the card root", () => {
		const w = makeCard()
		const card = w.get(`[data-testid="${TESTIDS.tokenCard}"]`)
		expect(card.attributes("data-symbol")).toBe("SIGNAL")
	})

	it("the actions row renders both drip buttons", () => {
		const w = makeCard()
		const card = w.get(`[data-testid="${TESTIDS.tokenCard}"]`)
		const dripButtons = card.findAll(`[data-testid^="tl-btn-drip-"]`)
		expect(dripButtons).toHaveLength(2)
	})

	describe("disconnected variant (no wallet, no account)", () => {
		function makeDisconnectedCard() {
			return mount(TokenCard, {
				props: { token: SIGNAL, tokenAddress: SIGNAL_ADDR },
			})
		}

		it("renders the symbol + buttons even with no wallet", () => {
			const w = makeDisconnectedCard()
			expect(w.text()).toContain("SIGNAL")
			expect(w.text()).toContain("Fixed drip: 1,000 SIGNAL")
			expect(w.find(`[data-testid="${TESTIDS.btnDripPublic}"]`).exists()).toBe(true)
			expect(w.find(`[data-testid="${TESTIDS.btnDripPrivate}"]`).exists()).toBe(true)
		})

		it("drip buttons are disabled", () => {
			const w = makeDisconnectedCard()
			expect(w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).attributes("disabled")).toBeDefined()
			expect(w.get(`[data-testid="${TESTIDS.btnDripPrivate}"]`).attributes("disabled")).toBeDefined()
		})

		it("clicking a disabled drip button is a no-op", async () => {
			const w = makeDisconnectedCard()
			await w.get(`[data-testid="${TESTIDS.btnDripPublic}"]`).trigger("click")
			expect(dripFn).not.toHaveBeenCalled()
		})

		it("shows the 'Connect a wallet to drip' hint instead of the status row", () => {
			const w = makeDisconnectedCard()
			expect(w.text()).toContain("Connect a wallet to drip")
			expect(w.find(`[data-testid="${TESTIDS.dripStatus}"]`).exists()).toBe(false)
		})

		it("balance row renders em-dash placeholders (no live data)", () => {
			const w = makeDisconnectedCard()
			expect(w.get(`[data-testid="${TESTIDS.balancePublic}"]`).text()).toBe("-")
			expect(w.get(`[data-testid="${TESTIDS.balancePrivate}"]`).text()).toBe("-")
		})

		it("carries data-connected=undefined on the card root", () => {
			const w = makeDisconnectedCard()
			expect(w.get(`[data-testid="${TESTIDS.tokenCard}"]`).attributes("data-connected")).toBeUndefined()
		})
	})
})
