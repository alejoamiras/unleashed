// @vitest-environment node
/**
 * The app's journal-bound fuel helpers and its Fee Juice balance reads through the wallet. The claims themselves run
 * in the SDK; the card's words for their stops are pinned in `claim-narration.test.ts`.
 */

const storageBacking = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
	getItem: (k: string) => storageBacking.get(k) ?? null,
	setItem: (k: string, v: string) => void storageBacking.set(k, String(v)),
	removeItem: (k: string) => void storageBacking.delete(k),
	clear: () => void storageBacking.clear(),
	key: (i: number) => [...storageBacking.keys()][i] ?? null,
	get length() {
		return storageBacking.size
	},
}

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { GasFees } from "@aztec-labs/stdlib/gas"
import type { DepositJournalRecord } from "@unleashed/bridge-core"
import { beforeEach, describe, expect, test, vi } from "vitest"

const h = vi.hoisted(() => {
	const calls: Array<[string, unknown]> = []
	return {
		calls,
		t: (n: string, d?: unknown) => void calls.push([n, d]),
		/** The PERSISTED record `currentRecord` answers with; undefined = nothing in the journal. */
		persisted: undefined as unknown,
		/** The account's private Fee Juice credit at the FPC; undefined = the read fails. */
		privateFj: undefined as bigint | undefined,
		/** The account's public Fee Juice; undefined = the read fails. */
		publicFj: undefined as bigint | undefined,
	}
})

vi.mock("@/contracts/bridge-generation", () => ({
	FUEL_MIN_FJ: 1000n,
	FUEL: undefined,
	LEGACY_ROUTERS: [],
}))

// The Fee Juice balances as the wallet's reads answer them; a throw = unreadable.
vi.mock("./useTokenBalance", () => ({
	readBalance: async (_aztec: unknown, _contract: unknown, fn: string) => {
		h.t("readBalance", fn)
		const balance = fn === "balance_of_public" ? h.publicFj : h.privateFj
		if (balance === undefined) throw new Error(`${fn} failed`)
		return balance
	},
}))
vi.mock("@unleashed/sdk/private-fpc-artifact", () => ({ PrivateFPCContractArtifact: {} }))
vi.mock("@aztec-labs/aztec.js/contracts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@aztec-labs/aztec.js/contracts")>()),
	Contract: { at: async () => ({}) },
}))

vi.mock("./useBridgeJournal", async (importOriginal) => {
	const real = (await importOriginal()) as typeof import("./useBridgeJournal")
	return {
		...real,
		updateRecord: (id: string, patch: unknown) => h.t("updateRecord", { id, patch }),
		currentRecord: () => h.persisted,
		updateRecordWhen: (id: string, when: (r: unknown) => boolean, patch: unknown) => {
			// A missing fixture stands for a record without a fuel block, so the captured fallback is exercised.
			const live = h.persisted ?? { id }
			if (!when(live)) return undefined
			const fields = typeof patch === "function" ? patch(live) : patch
			h.t("updateRecord", { id, patch: fields })
			return { ...(live as object), ...(fields as object) }
		},
	}
})

vi.mock("@aztec-labs/aztec.js/node", () => ({
	createAztecNodeClient: () => ({
		getCurrentMinFees: async () => GasFees.from({ feePerDaGas: 10n, feePerL2Gas: 20n }),
		getTxReceipt: async () => {
			throw new Error("node unreachable")
		},
	}),
}))

import { patchFuel, readFeeJuiceOrNull, readPrivateFeeJuiceBalance, readPublicFeeJuiceBalance } from "./deposit-flow"

const RECIPIENT = "0x1018808f2c17794badb361c02c945582b8198b495a7e8d01154f7eeb7d719c0d"
const recipient = AztecAddress.fromStringUnsafe(RECIPIENT)
const FUEL = { amount: "10", secret: "0xf", secretHashHex: "0xfh", minOutput: "9" }

function mkRec(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id: "0xspec1",
		direction: "deposit",
		isPrivate: false,
		amount: "900",
		createdAt: 1,
		updatedAt: 1,
		chainId: 11155111,
		portal: "0x00000000000000000000000000000000000000bb",
		bridge: "0x2018808f2c17794badb361c02c945582b8198b495a7e8d01154f7eeb7d719c0d",
		recipient: RECIPIENT,
		secret: "0xsecret",
		secretHashHex: "0xspec1",
		fuel: FUEL,
		...over,
	} as DepositJournalRecord
}

const journalWrites = () =>
	h.calls.filter(([n]) => n === "updateRecord").map(([, d]) => d as { id: string; patch: Record<string, unknown> })

beforeEach(() => {
	h.calls.length = 0
	h.persisted = undefined
	h.privateFj = undefined
	h.publicFj = undefined
	vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
})

describe("the journal's fuel helpers", () => {
	test("a fuel patch guards against, and merges into, the PERSISTED block", () => {
		h.persisted = mkRec({ fuel: { ...FUEL, secretHashHex: "0xanother-deposit" } })
		expect(patchFuel("0xspec1", FUEL, { consumed: true })).toBe(false)
		expect(journalWrites()).toHaveLength(0)
		h.persisted = mkRec({ fuel: { ...FUEL, leafIndex: "7" } })
		expect(patchFuel("0xspec1", FUEL, { consumed: true }, { leafIndex: "7" })).toBe(true)
		expect(journalWrites()).toEqual([{ id: "0xspec1", patch: { leafIndex: "7", fuel: { ...FUEL, leafIndex: "7", consumed: true } } }])
	})
})

describe("the account's Fee Juice, read through the wallet", () => {
	test("public Fee Juice from the Fee Juice contract, private credit at the FPC, a failed read as null", async () => {
		h.publicFj = 61_000_000n
		h.privateFj = 7n
		expect(await readPublicFeeJuiceBalance({}, recipient)).toBe(61_000_000n)
		expect(await readPrivateFeeJuiceBalance({}, recipient)).toBe(7n)
		expect(h.calls.filter(([n]) => n === "readBalance").map(([, fn]) => fn)).toEqual(["balance_of_public", "balance_of"])
		h.privateFj = undefined
		expect(await readFeeJuiceOrNull("private FJ", () => readPrivateFeeJuiceBalance({}, recipient))).toBeNull()
	})
})
