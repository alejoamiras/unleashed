import type { DepositJournalRecord, WithdrawJournalRecord } from "@unleashed/bridge-core"
import { Button, Icon } from "@unleashed/design"
import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { RecordRuntime } from "@/composables/useBridgeJournal"

const runtime = ref<Record<string, RecordRuntime>>({})
const runDepositClaim = vi.fn(async () => {})
const runWithdrawConsume = vi.fn(async () => {})

vi.mock("@/composables/useBridgeJournal", () => ({
	useBridgeJournal: () => ({ runtime, runDepositClaim, runWithdrawConsume }),
}))

// The shared app clock is driven by hand (fake timers do not reach the module interval).
const mockNow = ref(200_000)
vi.mock("@/lib/clock", () => ({
	useNow: () => mockNow,
}))

import { TESTIDS } from "@/lib/testids"
import { xcRecord } from "@/test/crosschain-record"
import BridgeStepper from "./BridgeStepper.vue"

const sel = (t: string) => `[data-testid="${t}"]`
const DEPLOY = { chainId: 11155111, portal: "0xp", bridge: "0xb" }

function dep(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id: "0xd",
		direction: "deposit",
		isPrivate: true,
		amount: "100000000",
		createdAt: 1,
		updatedAt: 1,
		recipient: "0xa",
		secretHashHex: "0xd",
		...DEPLOY,
		...over,
	}
}

describe("BridgeStepper", () => {
	beforeEach(() => {
		runtime.value = {}
		runDepositClaim.mockClear()
		runWithdrawConsume.mockClear()
	})

	it("renders the phase rail with data-phase/data-state from the mapper", () => {
		runtime.value = { "0xd": { step: "sealing" } }
		const w = mount(BridgeStepper, { props: { record: dep() } })
		const phases = w.findAll(sel(TESTIDS.stepperPhase))
		expect(phases.map((p) => p.attributes("data-phase"))).toEqual(["seal", "sign", "deposit", "sync", "claim", "confirm"])
		expect(phases[0].attributes("data-state")).toBe("active")
		expect(phases[0].text()).toMatch(/encrypts this bridge's recovery secret/i)
	})

	it("unneeded APPROVE is not rendered at all; it appears only while a real approval runs (fuel-only)", () => {
		const fuelRec = dep({
			assetKind: "fee-juice",
			fuel: { amount: "1", secret: "0x1", secretHashHex: "0x2", minOutput: "0" },
			isPrivate: false,
			depositTxHash: "0xt",
		})
		// Sufficient allowance (no runtime signal) - the step a user doesn't need never shows.
		runtime.value = { "0xd": {} }
		let w = mount(BridgeStepper, { props: { record: fuelRec } })
		expect(w.findAll(sel(TESTIDS.stepperPhase)).some((p) => p.attributes("data-phase") === "approve")).toBe(false)
		// A real approval in flight - the step materializes as the active phase.
		runtime.value = { "0xd": { step: "approving" } }
		w = mount(BridgeStepper, { props: { record: dep({ ...fuelRec, depositTxHash: undefined }) } })
		const approve = w.findAll(sel(TESTIDS.stepperPhase)).find((p) => p.attributes("data-phase") === "approve")
		expect(approve?.attributes("data-state")).toBe("active")
	})

	it("RETRY shows only for engine-drivable failed phases and routes to the engine action", async () => {
		// Failed SYNC (engine phase) ⇒ RETRY visible, routes to runDepositClaim.
		runtime.value = { "0xd": { attention: "error", note: "boom" } }
		const w = mount(BridgeStepper, { props: { record: dep({ depositTxHash: "0xt", leafIndex: "7" }) } })
		const retry = w.findAllComponents(Button).find((b) => b.attributes("data-testid") === TESTIDS.stepperRetry)
		// A way back, not a destructive act: secondary with the reload glyph.
		expect(retry?.props("variant")).toBe("secondary")
		expect(retry?.text()).toBe("Retry")
		expect(retry?.findComponent(Icon).props("name")).toBe("reload")
		await retry?.trigger("click")
		expect(runDepositClaim).toHaveBeenCalledWith("0xd")

		// Failed DEPOSIT leg (flow phase, post-tx-less) ⇒ NO retry button.
		const w2 = mount(BridgeStepper, { props: { record: dep() } })
		expect(w2.find(sel(TESTIDS.stepperRetry)).exists()).toBe(false)
	})

	it("a blocked record's failed phase offers no RETRY: it never runs again", () => {
		runtime.value = {}
		const w = mount(BridgeStepper, { props: { record: dep({ depositTxHash: "0xt", leafIndex: "7", blocked: "stopped" }) } })
		expect(w.findAll(sel(TESTIDS.stepperPhase)).some((p) => p.attributes("data-state") === "failed")).toBe(true)
		expect(w.find(sel(TESTIDS.stepperRetry)).exists()).toBe(false)
	})

	it("the heading is an h2 that names the section", () => {
		const w = mount(BridgeStepper, { props: { record: dep() } })
		const h2 = w.get("h2")
		expect(h2.text()).toBe("Bridging")
		expect(w.get(sel(TESTIDS.stepper)).attributes("aria-labelledby")).toBe(h2.attributes("id"))
	})

	it("the bar and its caption name the live phase and its place, or its failure; the clock counts from startedAt and stops at completion", () => {
		const read = (w: ReturnType<typeof mount>) => {
			const bar = w.get(sel(TESTIDS.stepperProgress))
			return {
				bar: [bar.attributes("role"), bar.attributes("aria-label"), bar.attributes("aria-valuenow"), bar.attributes("data-tone")],
				valuetext: bar.attributes("aria-valuetext"),
				caption: w.findAll(".caption span").map((s) => s.text()),
			}
		}
		runtime.value = { "0xd": { step: "sealing" } }
		expect(read(mount(BridgeStepper, { props: { record: dep(), startedAt: 40_000 } }))).toEqual({
			bar: ["progressbar", "Bridge progress", "0", "signal"],
			valuetext: "0 percent, Seal",
			caption: ["Seal · phase 1 of 6", "2:40 elapsed"],
		})

		// Three phases done: the bar stands at Crossing's start whatever its meter reads.
		runtime.value = { "0xd": { step: "syncing", syncBlock: 102 } }
		const crossing = mount(BridgeStepper, { props: { record: dep({ depositTxHash: "0xt", leafIndex: "7", depositL2Block: 100 }) } })
		expect(read(crossing).bar[2]).toBe("50")
		expect(read(crossing).caption[0]).toBe("Crossing · phase 4 of 6")

		runtime.value = { "0xd": { attention: "error", note: "boom" } }
		const failed = mount(BridgeStepper, { props: { record: dep({ depositTxHash: "0xt", leafIndex: "7", createdAt: 186_000 }) } })
		expect(read(failed)).toEqual({
			bar: ["progressbar", "Bridge progress", "50", "lost"],
			valuetext: "50 percent, Crossing failed",
			caption: ["Crossing failed · phase 4 of 6", "0:14 elapsed"],
		})

		const done = mount(BridgeStepper, { props: { record: dep({ claimTxHash: "0xc", completedAt: 65_000 }), startedAt: 5_000 } })
		expect(read(done)).toEqual({
			bar: ["progressbar", "Bridge progress", "100", "carrier"],
			valuetext: "100 percent, Done",
			caption: ["Done · phase 6 of 6", "1:00 elapsed"],
		})
	})

	it("the locked row shows the record's direction selected and disabled, and none of the wizard's selectors", () => {
		const selected = (record: DepositJournalRecord | WithdrawJournalRecord) => {
			const w = mount(BridgeStepper, { props: { record } })
			const segment = w.get(sel(TESTIDS.stepperDirection))
			const tabs = segment.findAll("[role='tab']")
			expect(tabs.map((t) => t.attributes("disabled"))).toEqual(["", ""])
			expect(w.find(sel(TESTIDS.sendDirection)).exists()).toBe(false)
			expect(w.get(`[id="${segment.attributes("aria-describedby")}"]`).text()).toBe("Direction is locked while this send runs")
			return tabs.find((t) => t.attributes("aria-selected") === "true")?.text()
		}
		const exit: WithdrawJournalRecord = {
			schema: 1,
			id: "0xw",
			direction: "withdraw",
			isPrivate: false,
			amount: "40000000",
			createdAt: 1,
			updatedAt: 1,
			recipientL1: "0xe",
			exitTxHash: "0xw",
			...DEPLOY,
		}
		expect(selected(dep())).toBe("Into Aztec")
		expect(selected(exit)).toBe("Out to Ethereum")
	})

	it("the session log shows its latest 8 rows as m:ss from the run's start, as text only; the permission prompt has none", () => {
		const log = Array.from({ length: 10 }, (_, i) => ({ seq: i, at: 40_000 + i * 15_000, text: `row ${i}` }))
		log[9] = { seq: 9, at: 175_000, text: "approving the <img src=x onerror=alert(1)> spend" }
		runtime.value = { "0xd": { step: "sealing", log } }
		const well = mount(BridgeStepper, { props: { record: dep(), startedAt: 40_000 } }).get(sel(TESTIDS.stepperLog))
		expect(well.attributes("role")).toBe("log")
		const rows = well.findAll(".row")
		expect(rows.map((r) => r.get(".at").text())).toEqual(["0:30", "0:45", "1:00", "1:15", "1:30", "1:45", "2:00", "2:15"])
		expect(rows[0].get(".text").text()).toBe("row 2")
		expect(well.find("img").exists()).toBe(false)
		expect(rows[7].get(".text").text()).toBe("approving the <img src=x onerror=alert(1)> spend_")
		expect(well.findAll(".cursor").map((c) => c.attributes("aria-hidden"))).toEqual(["true"])

		// The permission prompt keeps its full-width list: the split is only for a stepper with a log.
		const permit = mount(BridgeStepper, { props: { record: dep(), runtime: { step: "granting" }, canBackground: false } })
		expect(permit.find(sel(TESTIDS.stepperLog)).exists()).toBe(false)
		expect(permit.get(".split").classes()).not.toContain("with-log")
	})

	it("no footer band while there is nothing to background", () => {
		const w = mount(BridgeStepper, { props: { record: dep(), runtime: { step: "granting" }, canBackground: false } })
		expect(w.find(".band").exists()).toBe(false)
		expect(w.find(sel(TESTIDS.stepperBackground)).exists()).toBe(false)
	})

	it("the ⤓ export icon emits backup with the record (sealed private records only)", async () => {
		const w = mount(BridgeStepper, { props: { record: dep({ sealedEnvelope: "blob" }) } })
		expect(w.getComponent(Button).findComponent(Icon).props("name")).toBe("save")
		await w.find(sel(TESTIDS.stepperBackup)).trigger("click")
		expect(w.emitted("backup")?.[0]?.[0]).toMatchObject({ id: "0xd" })
	})

	it("the ⤓ hides for a private deposit whose envelope isn't sealed yet (no false recovery promise)", () => {
		const w = mount(BridgeStepper, { props: { record: dep() } }) // isPrivate, no sealedEnvelope.
		expect(w.find(sel(TESTIDS.stepperBackup)).exists()).toBe(false)
	})

	it("the ⤓ hides for provisional withdraws (nothing restorable pre-exit)", () => {
		const prov: WithdrawJournalRecord = {
			schema: 1,
			id: "wd-pending-x9",
			direction: "withdraw",
			isPrivate: false,
			amount: "1000000",
			createdAt: 1,
			updatedAt: 1,
			recipientL1: "0xe",
			...DEPLOY,
		}
		const w = mount(BridgeStepper, { props: { record: prov } })
		expect(w.find(sel(TESTIDS.stepperBackup)).exists()).toBe(false)
	})

	it("background emits", async () => {
		const w = mount(BridgeStepper, { props: { record: dep() } })
		await w.find(sel(TESTIDS.stepperBackground)).trigger("click")
		expect(w.emitted("background")).toHaveLength(1)
	})

	it("withdraw rail renders the countdown detail on PROVE", () => {
		const rec: WithdrawJournalRecord = {
			schema: 1,
			id: "0xw",
			direction: "withdraw",
			isPrivate: false,
			amount: "40000000",
			createdAt: 1,
			updatedAt: 1,
			recipientL1: "0xe",
			exitTxHash: "0xw",
			...DEPLOY,
		}
		runtime.value = { "0xw": { provenBlock: 5, targetBlock: 9 } }
		const w = mount(BridgeStepper, { props: { record: rec } })
		const prove = w.findAll(sel(TESTIDS.stepperPhase)).find((p) => p.attributes("data-phase") === "prove")
		expect(prove?.attributes("data-state")).toBe("active")
		expect(prove?.text()).toContain("Proven block 5 of 9")
	})

	it("a send's headline names the record's OWN token, not the deployment's", () => {
		const send = {
			...dep({ amount: "150000000" }),
			schema: 3,
			intent: "token",
			token: { erc20: "0xe", portal: "0xp", l2Token: "0xl2", nameWord: "0xn", symbolWord: "0xs", decimals: 8, displaySymbol: "WBTC" },
		} as never
		const headline = mount(BridgeStepper, { props: { record: send } }).get(".headline")
		expect(headline.text()).toBe("Ethereum → Aztec · 1.50 WBTC · private")
		expect(headline.get(".amount").text()).toBe("1.50 WBTC")
	})

	it("a gas-only send's headline reads the Fee Juice it bought, never the token it paid", () => {
		const gasOnly = {
			...dep({ amount: "5000000", isPrivate: false }),
			schema: 3,
			intent: "gas",
			fuel: { amount: "5000000", secret: "0x1", secretHashHex: "0x2", minOutput: "2000000000000000000" },
		} as unknown as DepositJournalRecord
		const text = mount(BridgeStepper, { props: { record: gasOnly, runtime: { step: "signing" } } }).text()
		expect(text).toContain("≥ 2.00 FJ before claim fees · public")
		expect(text).not.toContain("5.00")
	})

	it("a cross-chain send: headed by its source and what it sends; a waiting claim needs you and starts from here", async () => {
		const rec = xcRecord(
			{ leafIndex: "7" },
			{ transport: { kind: "across", originChainId: 84532, depositId: "1", relayHash: `0x${"4e".repeat(32)}` } },
		)
		runtime.value = { [rec.id]: { claimable: true } }
		const w = mount(BridgeStepper, { props: { record: rec } })
		expect(w.get(".headline").text()).toBe("Base Sepolia → Aztec · 5.00 USDC · public")
		expect(w.get(".caption span").text()).toBe("Claim on Aztec · phase 5 of 6 · needs you")
		await w.get(sel(TESTIDS.stepperXcClaim)).trigger("click")
		expect(runDepositClaim).toHaveBeenCalledWith(rec.id)

		const unsent = mount(BridgeStepper, { props: { record: xcRecord({}, { srcTxHash: undefined }) } })
		await unsent.get(sel(TESTIDS.stepperXcNewSend)).trigger("click")
		expect(unsent.emitted("new-send")).toHaveLength(1)
	})

	it("the headline renders a hostile stored symbol and an impossible amount as text it can vouch for", () => {
		const rec = {
			...dep({ amount: "1".repeat(120) }),
			schema: 3,
			intent: "token",
			token: { displaySymbol: "US\u202eDC", decimals: 6 },
		} as unknown as DepositJournalRecord
		const text = mount(BridgeStepper, { props: { record: rec, runtime: { step: "granting" } } }).text()
		expect(text).toContain("— USDC")
		expect(text).toContain("USDC")
		expect(text).not.toContain("\u202e")
	})
})
