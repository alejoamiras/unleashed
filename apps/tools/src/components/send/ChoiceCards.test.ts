import { mount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GasBlock, SendIntent } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import ChoiceCards from "./ChoiceCards.vue"

const sel = (t: string) => `[data-testid="${t}"]`

type Props = {
	intent: SendIntent
	exitOnly: boolean
	feeAsset: boolean
	gasBlock: GasBlock | null
	tokenReason?: string | null
	txTarget: number
	breakdownId?: string
	breakdownOpen?: boolean
}

const NO_ROUTE = "This token can't buy Aztec gas on the way in."

function cards(over: Partial<Props> = {}) {
	return mount(ChoiceCards, {
		attachTo: document.body,
		props: { intent: "token", exitOnly: false, feeAsset: false, gasBlock: null, txTarget: 2, ...over },
	})
}

describe("ChoiceCards", () => {
	it("offers token / token+gas / gas on a deposit, as a radio group", () => {
		const w = cards()
		expect(w.find(sel(TESTIDS.sendChoiceCards)).attributes("role")).toBe("radiogroup")
		for (const id of [TESTIDS.sendChoiceToken, TESTIDS.sendChoiceTokenGas, TESTIDS.sendChoiceGas]) {
			expect(w.find(sel(id)).attributes("role")).toBe("radio")
		}
		w.unmount()
	})

	it("names each card by its label alone; its caption, or the reason it is blocked, describes it", () => {
		const w = cards({ gasBlock: "no-route" })
		const refText = (id: string, attr: "aria-labelledby" | "aria-describedby") => {
			const card = w.get(sel(id))
			return card.get(`#${card.attributes(attr)}`).text()
		}
		expect(refText(TESTIDS.sendChoiceToken, "aria-labelledby")).toBe("Token")
		expect(refText(TESTIDS.sendChoiceToken, "aria-describedby")).toBe("Only the token arrives.")
		expect(refText(TESTIDS.sendChoiceTokenGas, "aria-labelledby")).toBe("Token + gas")
		expect(refText(TESTIDS.sendChoiceTokenGas, "aria-describedby")).toBe(NO_ROUTE)
		w.unmount()
	})

	it("reduces an exit to the one outcome it has", () => {
		const w = cards({ exitOnly: true })
		expect(w.find(sel(TESTIDS.sendChoiceCards)).attributes("data-count")).toBe("1")
		expect(w.find(sel(TESTIDS.sendChoiceTokenGas)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendChoiceGas)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendChoiceToken)).text()).toContain("Ethereum")
		w.unmount()
	})

	it("emits the intent of the card that was clicked", async () => {
		const w = cards()
		await w.find(sel(TESTIDS.sendChoiceTokenGas)).trigger("click")
		expect(w.emitted("update:intent")).toEqual([["token+gas"]])
		w.unmount()
	})

	it("is ONE tab stop: the active card carries it", () => {
		const w = cards({ intent: "gas" })
		expect(w.find(sel(TESTIDS.sendChoiceToken)).attributes("tabindex")).toBe("-1")
		expect(w.find(sel(TESTIDS.sendChoiceGas)).attributes("tabindex")).toBe("0")
		expect(w.find(sel(TESTIDS.sendChoiceGas)).attributes("aria-checked")).toBe("true")
		expect(w.find(sel(TESTIDS.sendChoiceToken)).attributes("aria-checked")).toBe("false")
		w.unmount()
	})

	it("disables both gas choices when the token has no route, saying why in place of their captions", () => {
		const w = cards({ gasBlock: "no-route" })
		expect(w.find(sel(TESTIDS.sendChoiceToken)).attributes("aria-disabled")).toBeUndefined()
		for (const id of [TESTIDS.sendChoiceTokenGas, TESTIDS.sendChoiceGas]) {
			const card = w.find(sel(id))
			expect(card.attributes("aria-disabled")).toBe("true")
			expect(card.attributes("disabled")).toBeUndefined()
			expect(card.attributes("title")).toBeUndefined()
			expect(card.text()).not.toContain("arrives as gas")
			const reason = card.get(`#${card.attributes("aria-describedby")}`)
			expect(reason.text()).toBe(NO_ROUTE)
		}
		w.unmount()
	})

	it("disables the token-only choice when the account holds no gas, with its reason in place, and keeps a blocked selection the tab stop", async () => {
		const reason = "Your Aztec account holds no gas (Fee Juice) yet."
		const blocked = cards({ intent: "token", tokenReason: reason })
		expect(blocked.find(sel(TESTIDS.sendChoiceToken)).attributes("tabindex")).toBe("0")
		expect(blocked.find(sel(TESTIDS.sendChoiceToken)).attributes("aria-disabled")).toBe("true")
		blocked.unmount()

		const w = cards({ intent: "token+gas", tokenReason: reason })
		const token = w.find(sel(TESTIDS.sendChoiceToken))
		expect(token.attributes("aria-disabled")).toBe("true")
		expect(token.attributes("title")).toBeUndefined()
		expect(token.get(`#${token.attributes("aria-describedby")}`).text()).toBe(reason)
		expect(w.find(sel(TESTIDS.sendChoiceTokenGas)).attributes("aria-disabled")).toBeUndefined()
		expect(w.find(sel(TESTIDS.sendChoiceGas)).attributes("aria-disabled")).toBeUndefined()
		await token.trigger("click")
		expect(w.emitted("update:intent")).toBeUndefined()
		// ← from the second choice skips the greyed-out token and lands on GAS.
		await w.find(sel(TESTIDS.sendChoiceTokenGas)).trigger("keydown", { key: "ArrowLeft" })
		expect(document.activeElement).toBe(w.find(sel(TESTIDS.sendChoiceGas)).element)
		expect(w.emitted("update:intent")).toEqual([["gas"]])
		w.unmount()
	})

	it("a disabled choice emits nothing when clicked or pressed", async () => {
		const w = cards({ gasBlock: "unavailable" })
		const gas = w.find(sel(TESTIDS.sendChoiceGas))
		expect(gas.text()).toContain("Gas options can't be checked right now.")
		await gas.trigger("click")
		await gas.trigger("keydown", { key: "Enter" })
		expect(w.emitted("update:intent")).toBeUndefined()
		w.unmount()
	})

	it("→ moves focus to the next choice and switches to it", async () => {
		const w = cards()
		await w.find(sel(TESTIDS.sendChoiceToken)).trigger("keydown", { key: "ArrowRight" })
		expect(document.activeElement).toBe(w.find(sel(TESTIDS.sendChoiceTokenGas)).element)
		expect(w.emitted("update:intent")).toEqual([["token+gas"]])
		w.unmount()
	})

	it("→ from the last choice wraps to the first", async () => {
		const w = cards({ intent: "gas" })
		await w.find(sel(TESTIDS.sendChoiceGas)).trigger("keydown", { key: "ArrowRight" })
		expect(document.activeElement).toBe(w.find(sel(TESTIDS.sendChoiceToken)).element)
		expect(w.emitted("update:intent")).toEqual([["token"]])
		w.unmount()
	})

	it("arrow keys skip a disabled choice rather than stranding focus on it", async () => {
		const w = cards({ gasBlock: "no-route" })
		await w.find(sel(TESTIDS.sendChoiceToken)).trigger("keydown", { key: "ArrowRight" })
		expect(document.activeElement).toBe(w.find(sel(TESTIDS.sendChoiceToken)).element)
		expect(w.emitted("update:intent")).toEqual([["token"]])
		w.unmount()
	})

	it("↓ and ↑ step like → and ←, as a radio group's arrows do", async () => {
		const w = cards({ intent: "token+gas" })
		await w.find(sel(TESTIDS.sendChoiceTokenGas)).trigger("keydown", { key: "ArrowDown" })
		expect(document.activeElement).toBe(w.find(sel(TESTIDS.sendChoiceGas)).element)
		await w.find(sel(TESTIDS.sendChoiceTokenGas)).trigger("keydown", { key: "ArrowUp" })
		expect(document.activeElement).toBe(w.find(sel(TESTIDS.sendChoiceToken)).element)
		expect(w.emitted("update:intent")).toEqual([["gas"], ["token"]])
		w.unmount()
	})

	it("← walks backwards", async () => {
		const w = cards({ intent: "token+gas" })
		await w.find(sel(TESTIDS.sendChoiceTokenGas)).trigger("keydown", { key: "ArrowLeft" })
		expect(document.activeElement).toBe(w.find(sel(TESTIDS.sendChoiceToken)).element)
		expect(w.emitted("update:intent")).toEqual([["token"]])
		w.unmount()
	})

	it("says the gas conversion is one for one when the token IS the gas asset", () => {
		const w = cards({ feeAsset: true })
		expect(w.find(sel(TESTIDS.sendChoiceTokenGas)).text()).toContain("One for one")
		expect(w.find(sel(TESTIDS.sendChoiceGas)).text()).toContain("One for one")
		w.unmount()
	})

	it("Enter and Space activate the focused choice", async () => {
		const w = cards()
		await w.find(sel(TESTIDS.sendChoiceGas)).trigger("keydown", { key: "Enter" })
		await w.find(sel(TESTIDS.sendChoiceTokenGas)).trigger("keydown", { key: " " })
		expect(w.emitted("update:intent")).toEqual([["gas"], ["token+gas"]])
		w.unmount()
	})
	it("is one radio group named by its heading, three radios with no control inside any of them", () => {
		const w = cards()
		const group = w.get('[role="radiogroup"]')
		expect(w.get(`#${group.attributes("aria-labelledby")}`).text()).toBe("What arrives")
		const radios = w.findAll('[role="radio"]')
		expect(radios).toHaveLength(3)
		for (const radio of radios) expect(radio.find("button").exists()).toBe(false)
		w.unmount()
	})

	describe("at phone width", () => {
		afterEach(() => vi.unstubAllGlobals())

		function phoneCards(over: Partial<Props> = {}) {
			vi.stubGlobal("matchMedia", (query: string) => ({
				matches: query === "(max-width: 760px)",
				media: query,
				addEventListener() {},
				removeEventListener() {},
			}))
			return cards({ intent: "token+gas", breakdownId: "gas-breakdown", breakdownOpen: false, ...over })
		}

		it("the selected gas row's hint is a button beside its radio that opens the breakdown and selects nothing", async () => {
			const w = phoneCards()
			const hint = w.get(sel(TESTIDS.sendGasDisclosure))
			expect(hint.element.closest('[role="radio"]')).toBeNull()
			expect(hint.element.parentElement).toBe(w.get(sel(TESTIDS.sendChoiceTokenGas)).element.parentElement)
			expect(hint.attributes("aria-controls")).toBe("gas-breakdown")
			expect(hint.attributes("aria-expanded")).toBe("false")
			expect(hint.text()).toBe("gas for 2 transactions, gas breakdown")
			await hint.trigger("click")
			expect(w.emitted("toggle-gas")).toHaveLength(1)
			expect(w.emitted("update:intent")).toBeUndefined()
			expect(w.findAll(sel(TESTIDS.sendGasDisclosure))).toHaveLength(1)
			w.unmount()
		})

		it("the arrow keys walk only the radios; the hint button is the tab stop right after the selected one", async () => {
			const w = phoneCards()
			const hint = w.get(sel(TESTIDS.sendGasDisclosure))
			await hint.trigger("keydown", { key: "ArrowRight" })
			expect(w.emitted("update:intent")).toBeUndefined()
			const tabbable = [...document.querySelectorAll<HTMLElement>("button")].filter((b) => b.tabIndex >= 0)
			const radio = w.get(sel(TESTIDS.sendChoiceTokenGas)).element
			expect(tabbable[tabbable.indexOf(hint.element as HTMLElement) - 1]).toBe(radio)
			expect(tabbable).toHaveLength(2)
			await w.get(sel(TESTIDS.sendChoiceTokenGas)).trigger("keydown", { key: "ArrowRight" })
			expect(document.activeElement).toBe(w.get(sel(TESTIDS.sendChoiceGas)).element)
			expect(w.emitted("update:intent")).toEqual([["gas"]])
			w.unmount()
		})

		it("no hint button on the token row, on a blocked gas row, nor without a breakdown to open", () => {
			for (const over of [{ intent: "token" as const }, { breakdownId: undefined }, { gasBlock: "unavailable" as const }]) {
				const w = phoneCards(over)
				expect(w.find(sel(TESTIDS.sendGasDisclosure)).exists()).toBe(false)
				w.unmount()
			}
		})
	})

	it("renders no hint button on a desktop", () => {
		const w = cards({ intent: "token+gas", breakdownId: "gas-breakdown" })
		expect(w.find(sel(TESTIDS.sendGasDisclosure)).exists()).toBe(false)
		w.unmount()
	})
})
