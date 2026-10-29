// @vitest-environment node
/**
 * The wiring of the SDK's claim fee ladder into the app: every stop reaches the user in the app's own
 * words, the ladder's reads and writes go through the journal, and its balance reads through the
 * wallet. The ladder's logic itself is pinned in the SDK (`fee-ladder.test.ts`).
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
import type { DepositJournalRecord, SendDepositRecord } from "@unleashed/bridge-core"
import { encodeAbiParameters, keccak256, toHex } from "viem"
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

import { buildFeeJuiceClaimDep, patchFuel, recoverDepositLeg, resolveHubClaimSendOpts, sendStandaloneFjClaim } from "./deposit-flow"

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

/** A schema-3 send record, as the hub claim and the recovery read it. */
const sendRec = (over: Record<string, unknown> = {}) =>
	mkRec({ schema: 3, intent: "token", depositTxHash: `0x${"0".repeat(64)}`, ...over } as never) as unknown as SendDepositRecord

const journalWrites = () =>
	h.calls.filter(([n]) => n === "updateRecord").map(([, d]) => d as { id: string; patch: Record<string, unknown> })

beforeEach(() => {
	h.calls.length = 0
	h.persisted = undefined
	h.privateFj = undefined
	h.publicFj = undefined
	vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
})

describe("the ladder's stops reach the user in the app's words", () => {
	test("a gas-only claim's stops, the ladder's and the builder's, from both simulate and send", async () => {
		const claimed = await buildFeeJuiceClaimDep(mkRec({ fuel: { ...FUEL, consumed: true } }), "0xs", undefined, {})
		const already = "The gas claim was already included on Aztec — there is nothing left to claim for this bridge."
		await expect(claimed.simulate()).rejects.toThrow(new Error(already))
		await expect(claimed.send()).rejects.toThrow(new Error(already))
		const empty = await buildFeeJuiceClaimDep(mkRec(), "0xs", undefined, {})
		await expect(empty.simulate()).rejects.toThrow(new Error("This Fuel bridge has no claimable Fee Juice."))
	})

	test("a stop the standalone claim throws", async () => {
		// A wallet that simulates but cannot report its gas settings cannot price the claim.
		const aztec = { simulateTx: async () => ({}) }
		await expect(sendStandaloneFjClaim(aztec, recipient, { ...FUEL, received: "5000", leafIndex: "3" }, "0xspec1")).rejects.toThrow(
			new Error("Your wallet could not price this transaction's fee ceiling just now — please try again in a moment."),
		)
	})

	test("a hub claim's stop, with the shorter send sentence where the wait stop has one", async () => {
		const resolve = (rec: SendDepositRecord) =>
			resolveHubClaimSendOpts({ rec, recipientAddr: recipient, aztec: {}, userOverride: false })
		const pending = sendRec({ intent: "token+gas", fuel: { ...FUEL, received: "5000", leafIndex: "3", claimAttempt: true } })
		expect(await resolve(pending)).toEqual({
			kind: "stop",
			why: "fuel claim attempt pending — waiting for its receipt before retrying",
			sendWhy: "fuel claim attempt pending",
		})
		const incomplete = sendRec({ intent: "token+gas", isPrivate: true, fuel: { ...FUEL, received: "5000" } })
		expect(await resolve(incomplete)).toEqual({
			kind: "stop",
			why: "This private bridge is missing the data needed to claim its gas privately (an older or partially restored record). Only its backup file can restore that — the public gas recovery is deliberately unavailable for private bridges.",
		})
	})

	test("the deposit-leg recovery's refusals", async () => {
		const client = (status: string) => ({ readContract: async () => 0n, getTransactionReceipt: async () => ({ status, logs: [] }) })
		await expect(recoverDepositLeg(mkRec(), client("success"))).rejects.toThrow(
			new Error("This record predates the current bridge — its Ethereum leg cannot be recovered here."),
		)
		await expect(recoverDepositLeg(sendRec(), client("reverted"))).rejects.toThrow(
			new Error("The Ethereum deposit transaction reverted — there is nothing to claim. You can discard this record."),
		)
		await expect(recoverDepositLeg(sendRec(), client("success"))).rejects.toThrow(new Error("This network has no bridge."))
	})
})

describe("the ladder reads and writes the journal", () => {
	test("a fuel patch guards against, and merges into, the PERSISTED block", () => {
		h.persisted = mkRec({ fuel: { ...FUEL, secretHashHex: "0xanother-deposit" } })
		expect(patchFuel("0xspec1", FUEL, { consumed: true })).toBe(false)
		expect(journalWrites()).toHaveLength(0)
		h.persisted = mkRec({ fuel: { ...FUEL, leafIndex: "7" } })
		expect(patchFuel("0xspec1", FUEL, { consumed: true }, { leafIndex: "7" })).toBe(true)
		expect(journalWrites()).toEqual([{ id: "0xspec1", patch: { leafIndex: "7", fuel: { ...FUEL, leafIndex: "7", consumed: true } } }])
	})

	test("a hub claim's latches write the journal first", async () => {
		const rec = sendRec({ intent: "token+gas", fuel: { ...FUEL, received: "5000", leafIndex: "3" } })
		const fee = await resolveHubClaimSendOpts({ rec, recipientAddr: recipient, aztec: {}, userOverride: false })
		expect(fee.kind).toBe("opts")
		fee.onAttempt?.()
		fee.onTxHash?.("0xtx")
		expect(journalWrites().map((w) => w.patch.fuel)).toEqual([
			expect.objectContaining({ claimAttempt: true, claimAttemptAt: 1_700_000_000_000 }),
			expect.objectContaining({ claimAttempt: true, claimTxHash: "0xtx" }),
		])
	})

	test("a recovered deposit leg writes its leaves to the record", async () => {
		const ROUTER = "0x1111111111111111111111111111111111111111" as const
		const zero32 = `0x${"0".repeat(64)}` as const
		const bridgeLog = {
			address: ROUTER,
			logIndex: 0,
			topics: [keccak256(toHex("Bridge(bytes32,bytes32,uint256,uint256,bytes32,bool)")), zero32],
			data: encodeAbiParameters(
				[{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bool" }],
				[`0x${"b".repeat(64)}`, 41n, 5n, zero32, false],
			),
		}
		const client = { readContract: async () => 0n, getTransactionReceipt: async () => ({ status: "success", logs: [bridgeLog] }) }
		await expect(recoverDepositLeg(sendRec({ id: "send-1", fuel: undefined }), client, undefined, [ROUTER])).resolves.toBe("recovered")
		expect(journalWrites()).toEqual([{ id: "send-1", patch: { leafIndex: "41", messageHash: `0x${"b".repeat(64)}` } }])
	})
})

describe("the ladder reads the account's Fee Juice through the wallet", () => {
	const noFuel = sendRec({ fuel: undefined })
	const resolve = (aztec: unknown) => resolveHubClaimSendOpts({ rec: noFuel, recipientAddr: recipient, aztec, userOverride: false })

	test("public Fee Juice on a wallet that routes it, private credit at the FPC otherwise", async () => {
		// Fees 10/20: a public claim's ceiling 3M·20 + 100k·10 = 61M.
		h.publicFj = 61_000_000n
		h.privateFj = 0n
		const selfPay = await resolve({ getWalletFeatures: async () => ["dapp-self-pay"] })
		expect(selfPay).toMatchObject({
			kind: "opts",
			opts: { fee: { gasSettings: { maxFeesPerGas: { feePerDaGas: 10n, feePerL2Gas: 20n } } } },
		})
		expect(h.calls.filter(([n]) => n === "readBalance").map(([, fn]) => fn)).toEqual(
			expect.arrayContaining(["balance_of_public", "balance_of"]),
		)

		h.calls.length = 0
		h.privateFj = 61_000_000n
		const credit = await resolve({})
		expect(credit).toMatchObject({ kind: "opts", opts: { fee: { gasSettings: { gasLimits: expect.anything() } } } })
		expect(h.calls.filter(([n]) => n === "readBalance").map(([, fn]) => fn)).toEqual(["balance_of"])
	})
})
