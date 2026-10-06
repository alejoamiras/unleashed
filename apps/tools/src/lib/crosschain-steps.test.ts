import type { CrossChainDepositRecord, CrossChainRoute } from "@unleashed/bridge-core"
import { describe, expect, it } from "vitest"
import type { RecordRuntime } from "@/composables/useBridgeJournal"
import { XC_CREATED, XC_SOURCE, XC_SRC_TX, xcRecord } from "@/test/crosschain-record"
import { type BridgePhase, compactPhases, overallProgress, stepLogLines, stepperPhases } from "./bridge-steps"
import { bridgingLate, crossChainLogFacts, crossChainStalled, crossChainUnconfirmed } from "./crosschain-steps"

const TRANSPORT: CrossChainRoute["transport"] = {
	kind: "across",
	originChainId: XC_SOURCE,
	depositId: "1",
	relayHash: `0x${"4e".repeat(32)}`,
}
const DEPOSIT_TX = `0x${"dd".repeat(32)}`
const FJ_230 = "230000000000000000000"

/** The source send is proven: the rail has it. */
const bridging = (route: Partial<CrossChainRoute> = {}) => xcRecord({}, { transport: TRANSPORT, ...route })
/** Nothing sent is known yet. */
const unsent = () => xcRecord({}, { srcTxHash: undefined })
/** The router's `Deposited` was read on Ethereum, with 230 FJ bought by the gas slice. */
function deposited(over: Partial<CrossChainDepositRecord> = {}): CrossChainDepositRecord {
	const base = xcRecord()
	const fuel = base.fuel && { ...base.fuel, received: FJ_230, leafIndex: "8" }
	return xcRecord({ leafIndex: "7", depositTxHash: DEPOSIT_TX, fuel, ...over }, { transport: TRANSPORT })
}
const byKey = (rec: CrossChainDepositRecord, rt: RecordRuntime = {}): Record<string, BridgePhase> =>
	Object.fromEntries(stepperPhases(rec, rt).map((p) => [p.key, p]))
const states = (rec: CrossChainDepositRecord, rt: RecordRuntime = {}) => stepperPhases(rec, rt).map((p) => `${p.key}:${p.state}`)

describe("stepperPhases - a cross-chain send", () => {
	it("names each phase by its chains, holds Send until the source event is proven, then shows the rail", () => {
		const sent = stepperPhases(xcRecord())
		expect(sent.map((p) => p.label)).toEqual([
			"Send on Base Sepolia",
			"Bridge to Ethereum · Sepolia",
			"Deposit on Ethereum · Sepolia",
			"Cross to Aztec",
			"Claim on Aztec",
			"Done",
		])
		expect(sent[0]).toMatchObject({ state: "active", detail: "Waiting for Base Sepolia to confirm the send…" })

		const p = byKey(bridging())
		expect(p["src-send"]).toMatchObject({
			state: "done",
			link: { href: `https://sepolia.basescan.org/tx/${XC_SRC_TX}`, text: "0x5757…5757" },
		})
		expect(p.bridge).toMatchObject({
			state: "active",
			detail: "Across is moving your USDC to Ethereum · Sepolia. Nothing for you to do; usually 2–4 min.",
			lifi: true,
			link: { href: `https://scan.li.fi/tx/${XC_SRC_TX}`, lead: "Track on LI.FI" },
		})
		expect(p.deposit).toMatchObject({ state: "pending", estimate: "~1 min", note: "+ 0.49 USDC swapped into gas on Aztec" })
		expect(p.claim).toMatchObject({ state: "pending", estimate: "your signature", signs: true })
	})

	it("shows Approve only while this run approves, and says what the send moves", () => {
		const approving = stepperPhases(unsent(), { step: "approving-source" })
		expect(approving[0]).toMatchObject({
			key: "src-approve",
			label: "Approve on Base Sepolia",
			state: "active",
			detail: "Approve exactly 5.00 USDC in your wallet. No funds move yet.",
		})
		expect(stepperPhases(unsent(), { step: "sending-source" }).map((p) => p.key)).not.toContain("src-approve")
		const sending = byKey(unsent(), { step: "sending-source", approveOutcome: "done" })
		expect(sending["src-approve"].state).toBe("done")
		expect(sending["src-send"]).toMatchObject({ state: "active", detail: "Confirm the send in your wallet. It moves 5.00 USDC." })
	})

	it("deposited: the gas the slice became, then a claim the user starts only while nothing runs it", () => {
		const p = byKey(deposited(), { claimable: true })
		expect(p.deposit).toMatchObject({ state: "done", note: "0.49 USDC became ≈ 230 FJ of gas" })
		expect(p.deposit.link?.href).toMatch(new RegExp(`/tx/${DEPOSIT_TX}$`))
		const prompt = "Confirm in your Aztec wallet. One transaction claims your 4.41 USDC and your gas; the gas pays for it."
		expect(p.claim).toMatchObject({ state: "active", needsYou: true, claimAction: true, detail: prompt })
		const running = byKey(deposited(), {
			claimable: true,
			busy: true,
			step: "sending",
			stepDetail: "confirm in your Aztec wallet",
		}).claim
		expect(running.detail).toBe(prompt)
		expect(running.claimAction).toBeUndefined()

		const crossing = byKey(deposited({ depositL2Block: 100 }), { step: "syncing", syncBlock: 102 }).sync
		expect(crossing).toMatchObject({ state: "active", meter: "block", progress: { current: 2, target: 3 } })
	})

	it("an outcome stops the rail at the phase that decided it, live with 'finalizing' until that chain finalizes", () => {
		const delivered = xcRecord({ completedAt: 9 }, { transport: TRANSPORT, outcome: "delivered-to-wallet" })
		expect(states(delivered)).toEqual([
			"src-send:done",
			"bridge:done",
			"deposit:stopped",
			"sync:pending",
			"claim:pending",
			"confirm:pending",
		])
		expect(byKey(delivered).deposit.suffix).toBe("to your wallet")
		expect(byKey(delivered).sync.estimate).toBeUndefined()
		expect(overallProgress(stepperPhases(delivered)).state).toBe("ended")
		expect(byKey(xcRecord({ completedAt: 9 }, { transport: TRANSPORT, outcome: "expired-on-source" })).bridge).toMatchObject({
			state: "ended",
			suffix: "expired",
		})
		expect(byKey(xcRecord({ completedAt: 9 }, { outcome: "not-sent" }))["src-send"]).toMatchObject({
			state: "failed",
			word: "reverted",
		})

		const provisional = (outcome: CrossChainRoute["outcome"], key: string) =>
			byKey(xcRecord({}, { transport: TRANSPORT, outcome }))[key]
		expect(provisional("delivered-to-wallet", "deposit")).toMatchObject({
			state: "active",
			suffix: "finalizing",
			detail: "Delivered to your Ethereum wallet, waiting for Ethereum · Sepolia to finalize.",
		})
		expect(provisional("expired-on-source", "bridge").detail).toBe(
			"Expired on Base Sepolia, waiting for Ethereum · Sepolia to finalize.",
		)
		expect(provisional("not-sent", "src-send").detail).toBe("Reverted on Base Sepolia, waiting for Base Sepolia to finalize.")
	})

	it("a send the wallet never answered is waiting, not lost; a watcher that gave up is a failure", () => {
		expect(byKey(unsent(), { step: "sending-source" })["src-send"].state).toBe("active")
		const flagged: RecordRuntime = { step: "sending-source", attention: "error", note: "Request timed out" }
		for (const rt of [{}, flagged]) {
			expect(byKey(unsent(), rt)["src-send"]).toMatchObject({ state: "waiting", suffix: "waiting", unconfirmed: true })
			expect(byKey(unsent(), rt)["src-send"].detail).toBeUndefined()
			expect(crossChainUnconfirmed(unsent(), rt)).toBe(true)
		}
		const gaveUp = "This transfer can't be checked from here right now. Nothing was deleted; reload to try again."
		expect(byKey(unsent(), { attention: "error", note: gaveUp })["src-send"]).toMatchObject({ state: "failed", detail: gaveUp })
		expect(crossChainUnconfirmed(bridging())).toBe(false)
	})

	it("a rail past its usual time is waiting, striped, still trackable", () => {
		expect(bridgingLate(bridging(), XC_CREATED + 5 * 60_000)).toBe(false)
		expect(bridgingLate(bridging(), XC_CREATED + 5 * 60_000 + 1)).toBe(true)
		expect(byKey(bridging(), { step: "bridging-late" }).bridge).toMatchObject({ state: "waiting", suffix: "waiting", lifi: true })
		expect(crossChainStalled(bridging(), { step: "bridging-late" })).toBe(true)
		expect(crossChainStalled(bridging())).toBe(false)
	})

	it("a send on fixed terms waits for its manual fill until the deadline, and is never late", () => {
		const fixed = bridging({ terms: "fixed", etaSeconds: 7_200 })
		expect(bridgingLate(fixed, XC_CREATED + 24 * 3_600_000)).toBe(false)
		expect(byKey(fixed).bridge).toMatchObject({
			state: "active",
			detail: "Across holds your USDC until a manual fill on Ethereum · Sepolia. Nothing for you to do; unfilled after 2 hours, it is refunded on Base Sepolia.",
			eta: "manual fill, up to 2 hours",
		})
	})

	it("the card's segments: no approve, the drawn weights, a registration inside the claim's segment", () => {
		const cells = compactPhases(stepperPhases(unsent(), { step: "approving-source" }))
		expect(cells.map((c) => [c.compact?.label, c.compact?.weight])).toEqual([
			["Send", 1],
			["Bridge", 1.6],
			["Deposit", 1],
			["Cross", 1],
			["Claim", 1],
			["Done", 0.7],
		])
		const registering = compactPhases(stepperPhases(deposited({ isPrivate: true, registers: true }), { claimable: true }))
		expect(registering.find((c) => c.key === "claim")?.state).toBe("active")
	})
})

describe("the session log - a cross-chain send", () => {
	it("phrases its steps in its own words", () => {
		const rec = bridging()
		expect(
			(["approving-source", "sending-source", "bridging", "bridging-late", "preparing-source", "sending"] as const).map((s) =>
				stepLogLines(s, rec),
			),
		).toEqual([
			["approving 5.00 USDC on Base Sepolia"],
			["sending on Base Sepolia through LI.FI"],
			["waiting for Across to deliver on Ethereum · Sepolia"],
			["still in Across, longer than usual"],
			[],
			["Aztec included it · ready to claim", "waiting for your Aztec wallet"],
		])
	})

	it("says confirmed only of what discovery proved: the source event, then the deposit", () => {
		expect(crossChainLogFacts(xcRecord())).toEqual([])
		expect(crossChainLogFacts(deposited()).flatMap((f) => f.lines)).toEqual([
			"Base Sepolia confirmed 0x5757…5757",
			"LI.FI handed it to Across",
			"Across delivered 4.90 USDC on Ethereum · Sepolia",
			"LI.FI called the deposit · 0.49 USDC into gas",
			"Ethereum · Sepolia confirmed 0xdddd…dddd",
		])
	})
})
