import type { BridgeJournalRecord, DepositFuelBlock, DepositJournalRecord } from "@unleashed/bridge-core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

const receiptStatus = vi.fn(async (_tx: string) => "pending" as "included" | "dropped" | "pending")
const gasClaim = vi.fn(async (_id: string) => {})
const lockHeld: string[] = []
const updates: Array<{ id: string; patch: unknown }> = []
const records = ref<BridgeJournalRecord[]>([])
const wallet = ref<unknown>({})
const selectedAccount = ref<string | null>(null)

vi.mock("./deposit-flow", () => ({
	fuelReceiptStatus: (tx: string) => receiptStatus(tx),
	// The persisted-block merge, reduced to the write it produces: the test observes the patch.
	patchFuel: (id: string, captured: object | undefined, patch: object) => {
		const live = (records.value.find((r) => r.id === id) as { fuel?: object } | undefined)?.fuel ?? captured
		if (live) updates.push({ id, patch: { fuel: { ...live, ...patch } } })
	},
}))
vi.mock("./useBridgeJournal", () => ({
	useBridgeJournal: () => ({ records }),
	currentRecord: (id: string) => records.value.find((r) => r.id === id),
	updateRecord: (id: string, patch: unknown) => void updates.push({ id, patch }),
	runGasClaim: (id: string) => gasClaim(id),
	// The journal lock, observed: the write happens inside it.
	underJournalLock: async <T>(fn: () => T): Promise<T> => {
		lockHeld.push("held")
		try {
			return fn()
		} finally {
			lockHeld.push("released")
		}
	},
}))
vi.mock("./useBridgeWallet", () => ({ useBridgeWallet: () => ({ wallet, selectedAccount }) }))
vi.mock("./useOpsInFlight", () => ({ withOperation: <T>(fn: () => Promise<T>) => fn() }))

import {
	__resetFuelOverridesForTests,
	claimFuelStandalone,
	fuelOverrideActive,
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
	gasClaim.mockClear()
	lockHeld.length = 0
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

	it("persists `consumed` only on an INCLUDED receipt, under the journal lock", async () => {
		records.value = [fueled({ fuel: { ...fueled().fuel, claimTxHash: "0xtx" } as never })]
		receiptStatus.mockResolvedValue("included")
		await reconcileFuelConsumed("0xrec")
		expect(updates).toHaveLength(1)
		expect((updates[0].patch as { fuel: { consumed: boolean } }).fuel.consumed).toBe(true)
		expect(lockHeld).toEqual(["held", "released"])
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
		expect(gasClaim).not.toHaveBeenCalled()
	})

	it("refuses under a different (or unknown) active account, naming the owner", async () => {
		selectedAccount.value = `0x2018${RECIPIENT.slice(6)}`
		await expect(claimFuelStandalone("0xrec")).rejects.toThrow(/Switch to that account/)
		selectedAccount.value = null
		await expect(claimFuelStandalone("0xrec")).rejects.toThrow(/Switch to that account/)
		expect(gasClaim).not.toHaveBeenCalled()
	})

	it("hands the record's own gas claim to the engine once every guard passed, and surfaces its failure", async () => {
		await claimFuelStandalone("0xrec")
		expect(gasClaim).toHaveBeenCalledWith("0xrec")
		gasClaim.mockRejectedValueOnce(new Error("The bridged gas is below the safe claim floor; the private fuel claim can't self-pay."))
		await expect(claimFuelStandalone("0xrec")).rejects.toThrow(/below the safe claim floor/)
	})

	it("names the owning account without the control characters a restore file can carry", async () => {
		selectedAccount.value = "0xsomeoneelse"
		records.value = [fueled({ recipient: `\u202e${RECIPIENT}` })]
		await expect(claimFuelStandalone("0xrec")).rejects.toThrow(/belongs to 0x1018…9c0d/)
	})
})
