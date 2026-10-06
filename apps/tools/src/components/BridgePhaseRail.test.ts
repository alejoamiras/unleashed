import type { DepositJournalRecord } from "@unleashed/bridge-core"
import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { RecordRuntime } from "@/composables/useBridgeJournal"
import { __resetPhaseClockForTests } from "@/lib/phase-clock"

const runtime = ref<Record<string, RecordRuntime>>({})

vi.mock("@/composables/useBridgeJournal", () => ({
	useBridgeJournal: () => ({ runtime }),
}))

// The shared app clock is driven manually here (fake timers don't reach the module interval).
const mockNow = ref(10_000)
vi.mock("@/lib/clock", () => ({
	useNow: () => mockNow,
}))

import { TESTIDS } from "@/lib/testids"
import { XC_SRC_TX, xcRecord } from "@/test/crosschain-record"
import BridgePhaseRail from "./BridgePhaseRail.vue"

const sel = (t: string) => `[data-testid="${t}"]`
/** Every element carrying a class name the rail's retired motion used. */
const animated = (w: ReturnType<typeof mount>) => w.findAll("*").filter((n) => /pulse|stamp|spin|blink/.test(n.classes().join(" ")))
const DEPLOY = { chainId: 11155111, portal: "0xp", bridge: "0xb" }

function dep(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id: "0xrail",
		direction: "deposit",
		isPrivate: true,
		amount: "100000000",
		createdAt: 1,
		updatedAt: 1,
		recipient: "0xa",
		secretHashHex: "0xrail",
		...DEPLOY,
		...over,
	}
}

describe("BridgePhaseRail", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000)
		mockNow.value = 10_000
		runtime.value = {}
		__resetPhaseClockForTests()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("full rail: a named list; the live phase is the current step and ticks m:ss, with no per-phase bar", async () => {
		runtime.value = { "0xt1": { step: "syncing", syncBlock: 102 } }
		const w = mount(BridgePhaseRail, {
			props: { record: dep({ id: "0xt1", depositTxHash: "0xt", leafIndex: "7", depositL2Block: 100 }) },
		})
		mockNow.value = 15_000
		await w.vm.$nextTick()
		expect(w.get("ol").attributes("aria-label")).toBe("Phases")
		const sync = w.get(`${sel(TESTIDS.stepperPhase)}[data-phase="sync"]`)
		expect(sync.attributes("aria-current")).toBe("step")
		expect(w.findAll('[aria-current="step"]')).toHaveLength(1)
		expect(sync.get(".time").text()).toBe("0:05")
		expect(sync.text()).not.toMatch(/usually 1-4 min/)
		expect(w.find('[role="progressbar"]').exists()).toBe(false)
		expect(w.text()).not.toContain("102 / 103")
		// Pending phases that wait on the chain show their short estimate.
		expect(w.get(`${sel(TESTIDS.stepperPhase)}[data-phase="confirm"] .time`).text()).toBe("~1–2 min")
		expect(w.find(`${sel(TESTIDS.stepperPhase)}[data-phase="claim"] .time`).exists()).toBe(false)
		w.unmount()
	})

	it("full rail: a failed phase is the current step and keeps its note", () => {
		runtime.value = { "0xt8": { attention: "error", note: "the claim reverted" } }
		const w = mount(BridgePhaseRail, { props: { record: dep({ id: "0xt8", depositTxHash: "0xt", leafIndex: "7" }) } })
		const failed = w.get('[aria-current="step"]')
		expect(failed.attributes("data-state")).toBe("failed")
		expect(failed.text()).toContain("the claim reverted")
		w.unmount()
	})

	it("full rail: a completed phase keeps its duration (labor record) after the transition", async () => {
		runtime.value = { "0xt2": { step: "sealing" } }
		const w = mount(BridgePhaseRail, { props: { record: dep({ id: "0xt2", secretHashHex: "0xt2" }) } })
		vi.setSystemTime(24_000) // stamps read the real (faked) clock; mockNow only drives renders.
		mockNow.value = 24_000
		runtime.value = { "0xt2": { step: "signing" } } // bridge-only private: seal → sign (no approve)
		await w.vm.$nextTick()
		const seal = w.findAll(sel(TESTIDS.stepperPhase)).find((p) => p.attributes("data-phase") === "seal")
		expect(seal?.attributes("data-state")).toBe("done")
		await w.vm.$nextTick()
		expect(seal?.get(".time").text()).toBe("0:14")
		w.unmount()
	})

	it("compact rail: glyph strip + the live detail under the journalStep testid", () => {
		runtime.value = { "0xt3": { step: "confirming", stepDetail: "check 12 - the claim is processing on Aztec" } }
		const w = mount(BridgePhaseRail, {
			props: { record: dep({ id: "0xt3", depositTxHash: "0xt", leafIndex: "7", claimTxHash: "0xc" }), compact: true },
		})
		expect(w.find(sel(TESTIDS.journalRail)).exists()).toBe(true)
		expect(w.findAll(sel(TESTIDS.journalPhase))).toHaveLength(6)
		expect(w.find(sel(TESTIDS.journalStep)).text()).toContain("check 12")
		w.unmount()
	})

	it("compact rail: done and failed cells carry a mark, so state never rests on hue alone", () => {
		runtime.value = { "0xt5": { claimable: true, attention: "error", note: "the prompt timed out" } }
		const w = mount(BridgePhaseRail, { props: { record: dep({ id: "0xt5", depositTxHash: "0xt", leafIndex: "7" }), compact: true } })
		const marked = w.findAll(sel(TESTIDS.journalPhase)).map((c) => [c.attributes("data-state"), c.find("svg").exists()])
		expect(marked).toContainEqual(["failed", true])
		expect(marked).toContainEqual(["done", true])
		expect(marked).toContainEqual(["pending", false])
		w.unmount()
	})

	it("compact rail: the live segment fills to its progress, which its label carries; no clock", async () => {
		runtime.value = { "0xt4": { step: "syncing", syncBlock: 11 } }
		const w = mount(BridgePhaseRail, {
			props: { record: dep({ id: "0xt4", depositTxHash: "0xt", leafIndex: "7", depositL2Block: 10 }), compact: true },
		})
		mockNow.value = 73_000
		await w.vm.$nextTick()
		expect(w.text()).toContain("Crossing")
		expect(w.text()).not.toMatch(/1m 03s/)
		const live = w.get(`${sel(TESTIDS.journalPhase)}[data-state="active"]`)
		expect(live.attributes("aria-label")).toBe("Crossing, in progress, 11 of 13")
		expect(live.get(".seg-fill").attributes("style")).toContain("width: 33%")
		// The fill replaces the separate bar and count.
		expect(w.find('[role="progressbar"]').exists()).toBe(false)
		w.unmount()
	})

	it("compact rail: a loaded blocked record fails its live phase with no runtime attention; milestones stay done", () => {
		runtime.value = { "0xt7": { note: "Still confirming after ~30 minutes — slow testnet." } }
		const w = mount(BridgePhaseRail, {
			props: { record: dep({ id: "0xt7", depositTxHash: "0xt", leafIndex: "7", blocked: "stopped" }), compact: true },
		})
		const states = w.findAll(sel(TESTIDS.journalPhase)).map((c) => c.attributes("data-state"))
		expect(states).toEqual(["done", "done", "done", "failed", "pending", "pending"])
		const failed = w.get(`${sel(TESTIDS.journalPhase)}[data-state="failed"]`)
		expect(failed.attributes("aria-label")).toBe("Crossing, failed")
		expect(w.find('[aria-label$="in progress"]').exists()).toBe(false)
		// The card states the block's reason; a stale soft note never narrates the failure.
		expect(w.find(sel(TESTIDS.journalStep)).exists()).toBe(false)
		w.unmount()
	})

	it("a failed phase shows the lost glyph, not the dismiss cross", () => {
		runtime.value = { "0xt6": { claimable: true, attention: "error", note: "declined" } }
		const w = mount(BridgePhaseRail, { props: { record: dep({ id: "0xt6", depositTxHash: "0xt", leafIndex: "7" }), compact: true } })
		const failed = w.get(`${sel(TESTIDS.journalPhase)}[data-state="failed"] svg path`).attributes("d")
		expect(failed).toBe("M4 2h16v2H4zm0 18h16v2H4zM20 4h2v16h-2zM2 4h2v16H2zm9 2h2v8h-2zm0 10h2v2h-2z")
		w.unmount()
	})

	it("full rail: the live phase is a still square, which a landed CONFIRM recolours (quiet flip)", () => {
		runtime.value = { "0xrail": { confirmLandedTxHash: "0xc" } }
		const w = mount(BridgePhaseRail, { props: { record: dep({ claimTxHash: "0xc" }) } })
		const square = w.find('[data-phase="confirm"][data-state="active"] .square')
		expect(square.exists()).toBe(true)
		expect(square.classes()).toContain("landed")
		expect(w.get('[data-phase="confirm"] .glyph').text()).toBe("in progress")
		expect(animated(w)).toHaveLength(0)
		w.unmount()
	})

	it("compact rail: the landed active cell carries the landed class, and no element has an animation class", () => {
		runtime.value = { "0xrail": { confirmLandedTxHash: "0xc" } }
		const w = mount(BridgePhaseRail, { props: { record: dep({ claimTxHash: "0xc" }), compact: true } })
		const cell = w.find('[data-phase="confirm"][data-state="active"]')
		expect(cell.exists()).toBe(true)
		expect(cell.classes()).toContain("landed")
		expect(animated(w)).toHaveLength(0)
		w.unmount()
	})

	// A first-time PRIVATE send registers the token in a transaction of its own; that phase is the
	// only one the wizard's e2e selects separately, so it carries its own id.
	it("full rail: a send's REGISTER phase carries the send id, and no other phase does", () => {
		const send = {
			...dep({ id: "0xsend", depositTxHash: "0xt", leafIndex: "7" }),
			schema: 3,
			intent: "token",
			token: { erc20: "0xe", portal: "0xp", l2Token: "0xl2", nameWord: "0xn", symbolWord: "0xs", decimals: 8, displaySymbol: "WBTC" },
			registerTxHash: "0xreg",
		} as never
		const w = mount(BridgePhaseRail, { props: { record: send } })
		expect(w.find(sel(TESTIDS.sendStepperRegister)).attributes("data-phase")).toBe("register")
		expect(w.findAll(sel(TESTIDS.stepperPhase)).some((p) => p.attributes("data-phase") === "register")).toBe(false)
		w.unmount()
	})

	it("full rail: a record with no register step emits no send-register id", () => {
		const w = mount(BridgePhaseRail, { props: { record: dep({ depositTxHash: "0xt", leafIndex: "7" }) } })
		expect(w.find(sel(TESTIDS.sendStepperRegister)).exists()).toBe(false)
		w.unmount()
	})
})

describe("BridgePhaseRail - a cross-chain send", () => {
	const TRANSPORT = { kind: "across", originChainId: 84532, depositId: "1", relayHash: `0x${"4e".repeat(32)}` } as const

	beforeEach(() => {
		runtime.value = {}
		__resetPhaseClockForTests()
	})

	it("compact: six weighted segments, an outcome's words after its label and in its spoken state", () => {
		const expired = xcRecord({ completedAt: 9 }, { transport: TRANSPORT, outcome: "expired-on-source" })
		const w = mount(BridgePhaseRail, { props: { record: expired, compact: true } })
		const cells = w.findAll(sel(TESTIDS.journalPhase))
		expect(cells.map((c) => c.find(".seg-label").text())).toEqual(["Send", "Bridge · expired", "Deposit", "Cross", "Claim", "Done"])
		expect(cells[1].attributes()).toMatchObject({ "aria-label": "Bridge, expired", "data-state": "ended" })
		expect(cells[1].attributes("style")).toContain("--weight: 1.6")
		expect(cells[0].find("svg").exists()).toBe(false)
		w.unmount()
		const finalizing = mount(BridgePhaseRail, {
			props: { record: xcRecord({}, { transport: TRANSPORT, outcome: "delivered-to-wallet" }), compact: true },
		})
		expect(finalizing.find('[data-phase="deposit"]').attributes("aria-label")).toBe("Deposit, finalizing")
		expect(finalizing.find('[data-phase="deposit"] .seg-label').text()).toBe("Deposit · finalizing")
		finalizing.unmount()
	})

	it("full: the bridging phase is powered by LI.FI and tracked there; the done send links its source transaction", () => {
		const w = mount(BridgePhaseRail, { props: { record: xcRecord({}, { transport: TRANSPORT }) } })
		expect(w.find(sel(TESTIDS.stepperXcLifi)).attributes()).toMatchObject({ href: "https://li.fi", rel: "noopener noreferrer" })
		expect(w.findAll(sel(TESTIDS.stepperXcLink)).map((a) => [a.text(), a.attributes("href")])).toEqual([
			["0x5757…5757", `https://sepolia.basescan.org/tx/${XC_SRC_TX}`],
			["Track on LI.FI0x5757…5757", `https://scan.li.fi/tx/${XC_SRC_TX}`],
		])
		w.unmount()
	})

	it("full: a send not found yet says so on its phase and offers a new send; an idle claim offers the claim", async () => {
		const w = mount(BridgePhaseRail, { props: { record: xcRecord({}, { srcTxHash: undefined }) } })
		const box = w.find(sel(TESTIDS.stepperXcNotFound))
		expect(box.attributes("role")).toBe("status")
		expect(box.text()).toContain("We haven’t found your send on Base Sepolia yet.")
		expect(box.text()).toContain("Your wallet didn’t confirm it, so we keep looking. Sending again may move your funds twice.")
		await w.find(sel(TESTIDS.stepperXcNewSend)).trigger("click")
		expect(w.emitted("new-send")).toHaveLength(1)
		w.unmount()

		const deposited = xcRecord({ leafIndex: "7" }, { transport: TRANSPORT })
		runtime.value = { [deposited.id]: { claimable: true } }
		const claim = mount(BridgePhaseRail, { props: { record: deposited } })
		expect(claim.find('[data-phase="claim"] .sr-only').text()).toBe("needs you")
		await claim.find(sel(TESTIDS.stepperXcClaim)).trigger("click")
		expect(claim.emitted("claim")).toHaveLength(1)
		claim.unmount()
	})
})
