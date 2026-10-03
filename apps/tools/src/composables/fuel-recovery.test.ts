import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { BridgeJournalRecord, DepositFuelBlock, DepositJournalRecord } from "@unleashed/bridge-core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

const receiptStatus = vi.fn(async (_tx: string) => "pending" as "included" | "dropped" | "pending")
const standaloneClaim = vi.fn(async () => {})
const updates: Array<{ id: string; patch: unknown }> = []
const records = ref<BridgeJournalRecord[]>([])
const wallet = ref<unknown>({})
const selectedAccount = ref<string | null>(null)

vi.mock("./deposit-flow", () => ({
	fuelReceiptStatus: (tx: string) => receiptStatus(tx),
	sendStandaloneFjClaim: (...a: unknown[]) => standaloneClaim(...(a as [])),
	// The persisted-block merge, reduced to the write it produces: the test observes the patch.
	patchFuel: (id: string, captured: object | undefined, patch: object) => {
		const live = (records.value.find((r) => r.id === id) as { fuel?: object } | undefined)?.fuel ?? captured
		if (live) updates.push({ id, patch: { fuel: { ...live, ...patch } } })
	},
}))
const runDepositClaim = vi.fn(async (_id: string, _opts?: unknown) => {})
vi.mock("./useBridgeJournal", () => ({
	useBridgeJournal: () => ({ records, runDepositClaim }),
	currentRecord: (id: string) => records.value.find((r) => r.id === id),
	updateRecord: (id: string, patch: unknown) => void updates.push({ id, patch }),
}))
vi.mock("./useBridgeWallet", () => ({ useBridgeWallet: () => ({ wallet, selectedAccount }) }))
vi.mock("./useOpsInFlight", () => ({ withOperation: <T>(fn: () => Promise<T>) => fn() }))

import {
	__resetFuelOverridesForTests,
	claimFuelStandalone,
	fuelOverrideActive,
	launchStandaloneFuelClaim,
	overrideFuelClaim,
	reconcileFuelConsumed,
} from "./fuel-recovery"

const RECIPIENT = "0x1018808f2c17794badb361c02c945582b8198b495a7e8d01154f7eeb7d719c0d"

function fueled(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 2,
		id: "0xrec",
		direction: "deposit",
		isPrivate: false,
		amount: "100",
		createdAt: 1,
		updatedAt: 1,
		chainId: 11155111,
		portal: "0xportal",
		bridge: "0xbridge",
		recipient: RECIPIENT,
		secretHashHex: "0xrec",
		completedAt: 2,
		fuel: { amount: "10", secret: "0xf", secretHashHex: "0xfh", minOutput: "9", received: "9", leafIndex: "4" },
		...over,
	}
}

beforeEach(() => {
	__resetFuelOverridesForTests()
	updates.length = 0
	receiptStatus.mockClear()
	receiptStatus.mockResolvedValue("pending")
	standaloneClaim.mockClear()
	wallet.value = {}
	selectedAccount.value = RECIPIENT
	records.value = [fueled()]
})

describe("the claim-without-fuel override", () => {
	it("is per-record and off until the user asks for it", () => {
		expect(fuelOverrideActive("0xrec")).toBe(false)
		overrideFuelClaim("0xrec")
		expect(fuelOverrideActive("0xrec")).toBe(true)
		expect(fuelOverrideActive("0xother")).toBe(false)
	})
})

describe("reconcileFuelConsumed", () => {
	it("does nothing without a prior claim attempt to probe", async () => {
		records.value = [fueled({ fuel: { amount: "10", secret: "0xf", secretHashHex: "0xfh", minOutput: "9" } })]
		await reconcileFuelConsumed("0xrec")
		expect(receiptStatus).not.toHaveBeenCalled()
		expect(updates).toHaveLength(0)
	})

	it("does nothing for a record already settled as consumed", async () => {
		records.value = [fueled({ fuel: { ...fueled().fuel, claimTxHash: "0xtx", consumed: true } as never })]
		await reconcileFuelConsumed("0xrec")
		expect(receiptStatus).not.toHaveBeenCalled()
	})

	it("persists `consumed` only on an INCLUDED receipt", async () => {
		records.value = [fueled({ fuel: { ...fueled().fuel, claimTxHash: "0xtx" } as never })]
		receiptStatus.mockResolvedValue("included")
		await reconcileFuelConsumed("0xrec")
		expect(updates).toHaveLength(1)
		expect((updates[0].patch as { fuel: { consumed: boolean } }).fuel.consumed).toBe(true)
	})

	it("leaves a dropped or still-pending attempt unsettled, so the affordance stays", async () => {
		records.value = [fueled({ fuel: { ...fueled().fuel, claimTxHash: "0xtx" } as never })]
		receiptStatus.mockResolvedValue("dropped")
		await reconcileFuelConsumed("0xrec")
		expect(updates).toHaveLength(0)
	})

	it("settles only the block that was probed: a block swapped in during the receipt read inherits nothing", async () => {
		const f = fueled().fuel as DepositFuelBlock
		records.value = [fueled({ completedAt: undefined, fuel: { ...f, claimTxHash: "0xtx1", secretHashHex: "0xf1" } })]
		receiptStatus.mockImplementation(async () => {
			records.value = [fueled({ completedAt: undefined, fuel: { ...f, secretHashHex: "0xf2" } })]
			return "included"
		})
		await reconcileFuelConsumed("0xrec")
		expect(updates).toEqual([])
	})

	it("is a no-op for an unknown id", async () => {
		await reconcileFuelConsumed("0xmissing")
		expect(updates).toHaveLength(0)
	})
})

describe("claimFuelStandalone", () => {
	it("refuses without a connected Aztec wallet", async () => {
		wallet.value = null
		await expect(claimFuelStandalone("0xrec")).rejects.toThrow(/Connect your Aztec wallet/)
	})

	it("refuses a record with no fuel to claim", async () => {
		records.value = [fueled({ fuel: undefined })]
		await expect(claimFuelStandalone("0xrec")).rejects.toThrow(/no fuel to claim/)
	})

	it("refuses a PRIVATE record — its gas is claimed inside the private bridge", async () => {
		records.value = [fueled({ isPrivate: true })]
		await expect(claimFuelStandalone("0xrec")).rejects.toThrow(/standalone recovery is unavailable/)
		expect(standaloneClaim).not.toHaveBeenCalled()
	})

	it("refuses under a different (or unknown) active account, naming the owner", async () => {
		selectedAccount.value = `0x2018${RECIPIENT.slice(6)}`
		await expect(claimFuelStandalone("0xrec")).rejects.toThrow(/Switch to that account/)
		selectedAccount.value = null
		await expect(claimFuelStandalone("0xrec")).rejects.toThrow(/Switch to that account/)
		expect(standaloneClaim).not.toHaveBeenCalled()
	})

	it("a token another submitter claimed hands its completion back to the engine once the gas is claimed", async () => {
		records.value = [fueled({ completedAt: undefined, claimedByOther: true })]
		await claimFuelStandalone("0xrec")
		expect(standaloneClaim).toHaveBeenCalledTimes(1)
		expect(runDepositClaim).toHaveBeenCalledWith("0xrec", { interactive: false })
		runDepositClaim.mockClear()
		records.value = [fueled()]
		await claimFuelStandalone("0xrec")
		expect(runDepositClaim).not.toHaveBeenCalled() // an ordinary completed record has nothing to hand back
	})

	it("claims the stranded message for the record's own recipient", async () => {
		await claimFuelStandalone("0xrec")
		expect(standaloneClaim).toHaveBeenCalledTimes(1)
		const [, recipient, fuel, id] = standaloneClaim.mock.calls[0] as unknown as [unknown, { toString(): string }, unknown, string]
		expect(recipient.toString()).toBe(RECIPIENT)
		expect(id).toBe("0xrec")
		expect(fuel).toMatchObject({ received: "9", leafIndex: "4" })
	})

	it("a second start while one is in flight joins it — one send, whichever path started it", async () => {
		let release = (): void => {}
		standaloneClaim.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
		const auto = launchStandaloneFuelClaim("0xrec", {}, AztecAddress.fromStringUnsafe(RECIPIENT), fueled().fuel as DepositFuelBlock)
		const manual = claimFuelStandalone("0xrec")
		release()
		await Promise.all([auto, manual])
		expect(standaloneClaim).toHaveBeenCalledTimes(1)
		await claimFuelStandalone("0xrec")
		expect(standaloneClaim).toHaveBeenCalledTimes(2)
	})

	it("names the owning account without the control characters a restore file can carry", async () => {
		selectedAccount.value = "0xsomeoneelse"
		records.value = [fueled({ recipient: `\u202e${RECIPIENT}` })]
		await expect(claimFuelStandalone("0xrec")).rejects.toThrow(/belongs to 0x1018…9c0d/)
	})
})
