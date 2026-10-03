import type { DepositJournalRecord, WithdrawJournalRecord } from "@unleashed/bridge-core"
import { describe, expect, it } from "vitest"
import type { RecordRuntime } from "@/composables/useBridgeJournal"
import { accountOf, recordState, type WalletView } from "./record-policy"

const DEPLOY = { chainId: 11155111, portal: "0xportal", bridge: "0xbridge" }
const HASH = `0x${"ab".repeat(32)}`

function dep(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id: "0xd",
		direction: "deposit",
		isPrivate: false,
		amount: "100",
		createdAt: 1,
		updatedAt: 1,
		recipient: "0xAztec",
		secretHashHex: "0x1",
		...DEPLOY,
		...over,
	}
}
function wd(over: Partial<WithdrawJournalRecord> = {}): WithdrawJournalRecord {
	return {
		schema: 1,
		id: "0xw",
		direction: "withdraw",
		isPrivate: false,
		amount: "40",
		createdAt: 1,
		updatedAt: 1,
		recipientL1: "0xe",
		...DEPLOY,
		...over,
	}
}
const connected: WalletView = { status: "connected", selectedAccount: "0xaztec", accounts: [{ address: "0xaztec", alias: "Main" }] }
const state = (rec: DepositJournalRecord | WithdrawJournalRecord, rt: RecordRuntime = {}, wallet: WalletView = connected) =>
	recordState(rec, rt, wallet)

describe("recordState — the gates the card and the dock share", () => {
	it("an idle deposit with a leaf is claimable (the card's leafIndex default), so CLAIM shows", () => {
		const s = state(dep({ leafIndex: "1" }))
		expect(s.stage).toBe("claimable")
		expect(s.showClaim).toBe(true)
		expect(s.retry).toBe(false)
	})

	it("a pre-send deposit hides CLAIM; the stranded L1-timeout shape (deposit hash, no leaf) offers it", () => {
		expect(state(dep()).showClaim).toBe(false)
		const stranded = state(dep({ depositTxHash: HASH }))
		expect(stranded.depositLegRecoverable).toBe(true)
		expect(stranded.showClaim).toBe(true)
	})

	it("a hash-less send exit offers FINISH (Aztec is searched); a schema-1 one does not", () => {
		const sendExit = {
			schema: 3,
			intent: "token",
			token: { erc20: "0xerc20" },
			exitTxHash: undefined,
		} as unknown as Partial<WithdrawJournalRecord>
		expect(state(wd(sendExit)).exitAttachable).toBe(true)
		expect(state(wd(sendExit)).showFinish).toBe(true)
		expect(state(wd({ exitTxHash: undefined })).exitAttachable).toBe(false)
		expect(state(wd({ exitTxHash: undefined })).showFinish).toBe(false)
		expect(state(wd()).exitAttachable).toBe(false)
	})

	it("a hash-less hub token send offers CLAIM (Ethereum is searched); a gas-only or schema-1 one does not", () => {
		const hubSend = { schema: 3, intent: "token", token: { erc20: "0xerc20" } } as unknown as Partial<DepositJournalRecord>
		expect(state(dep(hubSend)).depositLegRecoverable).toBe(true)
		expect(state(dep(hubSend)).showClaim).toBe(true)
		const gasOnly = { schema: 3, intent: "gas" } as unknown as Partial<DepositJournalRecord>
		expect(state(dep(gasOnly)).depositLegRecoverable).toBe(false)
		expect(state(dep()).depositLegRecoverable).toBe(false)
	})

	it("a token claimed by another submitter offers CLAIM only as the verification that finishes it", () => {
		const fuel = { amount: "10", secret: "0xs", secretHashHex: "0xf", minOutput: "9", leafIndex: "8", received: "5" }
		const open = state(dep({ schema: 2, leafIndex: "1", messageHash: "0xm", claimedByOther: true, fuel }))
		expect(open.claimedByOther).toBe(true)
		// Open fuel, public or private: the click still verifies — a false marker must not hide the claim
		// behind a gas recovery that may never succeed.
		expect(state(dep({ schema: 2, isPrivate: true, leafIndex: "1", messageHash: "0xm", claimedByOther: true, fuel })).showClaim).toBe(
			true,
		)
		expect(state(dep({ schema: 2, leafIndex: "1", messageHash: "0xm", claimedByOther: true, fuel })).showClaim).toBe(true)
		// A marker on a shape the completion never writes it on (no leaf, or a claim of its own) is ignored.
		expect(state(dep({ claimedByOther: true })).claimedByOther).toBe(false)
		expect(state(dep({ leafIndex: "1", messageHash: "0xm", claimTxHash: "0xc", claimedByOther: true })).claimedByOther).toBe(false)
		// Fuel settled but the record not completed (a marker that could not be verified yet) ⇒ CLAIM verifies.
		expect(
			state(dep({ schema: 2, leafIndex: "1", messageHash: "0xm", claimedByOther: true, fuel: { ...fuel, consumed: true } }))
				.showClaim,
		).toBe(true)
		expect(state(dep({ leafIndex: "1", messageHash: "0xm", claimedByOther: true })).showClaim).toBe(true)
		expect(state(dep({ leafIndex: "1", messageHash: "0xm", claimedByOther: true, completedAt: 1 })).showClaim).toBe(false)
		expect(state(dep({ leafIndex: "1" })).claimedByOther).toBe(false)
	})

	it("busy hides every button; completion ends the stage", () => {
		expect(state(dep({ leafIndex: "1" }), { busy: true }).showClaim).toBe(false)
		expect(state(dep({ leafIndex: "1", completedAt: 5 })).stage).toBe("done")
	})

	it("blocked and terminal attentions are not actionable; a plain error is a retry", () => {
		expect(state(dep({ leafIndex: "1", blocked: "stopped" })).actionable).toBe(false)
		expect(state(dep({ leafIndex: "1" }), { attention: "receipt-mismatch" }).actionable).toBe(false)
		const err = state(dep({ leafIndex: "1" }), { attention: "error" })
		expect(err.actionable).toBe(true)
		expect(err.retry).toBe(true)
	})

	it("withdraws: FINISH from proving on, never while exiting; no account tag ever", () => {
		expect(state(wd()).showFinish).toBe(false)
		expect(state(wd({ exitTxHash: HASH })).showFinish).toBe(true)
		expect(accountOf(wd({ exitTxHash: HASH }), connected)).toBeNull()
	})

	it("ownedByOther needs a CONNECTED session and a recipient that is another GRANTED account", () => {
		const other: WalletView = {
			status: "connected",
			selectedAccount: "0xother",
			accounts: [{ address: "0xaztec" }, { address: "0xother" }],
		}
		const s = state(dep({ leafIndex: "1" }), {}, other)
		expect(s.ownedByOther).toBe(true)
		expect(s.switchTarget).toBe("0xaztec")
		expect(state(dep({ leafIndex: "1" }), {}, { ...other, status: "setting-up" }).ownedByOther).toBe(false)
		// Outside the grant: the engine's guard explains; no switch is offered.
		expect(state(dep({ leafIndex: "1", recipient: "0xstranger" }), {}, other).ownedByOther).toBe(false)
	})

	it("a tampered non-string recipient yields no account and never throws", () => {
		expect(accountOf(dep({ recipient: 42 as unknown as string }), connected)).toBeNull()
	})

	it("fuel recovery is offered only on a completed public fueled deposit whose gas never settled", () => {
		const fueled = dep({
			schema: 2,
			leafIndex: "1",
			completedAt: 5,
			fuel: { received: "10", leafIndex: "2" } as DepositJournalRecord["fuel"],
		})
		expect(state(fueled).fuelRecoverable).toBe(true)
		expect(state({ ...fueled, completedAt: undefined }).fuelRecoverable).toBe(false)
	})

	it("CLAIM WITHOUT FUEL: a stuck fueled claim that is not itself a fee-juice record", () => {
		const fueled = dep({ schema: 2, leafIndex: "1", fuel: { received: "10" } as DepositJournalRecord["fuel"] })
		expect(state(fueled, { attention: "error" }).showClaimWithoutFuel).toBe(true)
		expect(state({ ...fueled, assetKind: "fee-juice" }, { attention: "error" }).showClaimWithoutFuel).toBe(false)
		expect(state(fueled).showClaimWithoutFuel).toBe(false)
		// A blocked record offers no token-claim path at all, the override included.
		expect(state({ ...fueled, blocked: "stopped" }, { attention: "error" }).showClaimWithoutFuel).toBe(false)
	})
})
