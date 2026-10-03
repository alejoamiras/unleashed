/**
 * Field-level rejection table for `validateBackupRecord`, complementing `backup.test.ts` (which
 * covers the fuel-block contradictions, the assetKind/extras and the junk shapes). Pinned before the
 * validator is split per direction: EVERY mutation below must keep rejecting with the one message,
 * and the two fully-populated shapes must keep validating unchanged. The validator is strict on
 * SHAPE only (empty required strings pass, numbers are type-checked) — that acceptance set is part
 * of the pin, not something to tighten in passing.
 */

import { describe, expect, it } from "vitest"
import { validateBackupRecord } from "./backup"
import type { DepositJournalRecord, WithdrawJournalRecord } from "./journal"

const REJECT = /not a valid bridge record/

const fuel = {
	amount: "250000000000000000",
	secret: "0xf00d",
	secretHashHex: "0xfeed",
	minOutput: "0",
	leafIndex: "7",
	received: "487000000000000000000",
	claimAttempt: true,
	claimTxHash: "0xclaim",
	consumed: false,
	standaloneClaimed: false,
	bridgeSecretSalt: "0x5a17",
	fpc: "0xfpc",
	setupInsufficiency: false,
}

const fullDeposit: DepositJournalRecord = {
	schema: 2,
	id: "0xdep",
	direction: "deposit",
	isPrivate: true,
	amount: "100000000",
	createdAt: 1,
	updatedAt: 2,
	completedAt: 3,
	chainId: 11155111,
	portal: "0xportal",
	bridge: "0xbridge",
	recipient: "0xrecipient",
	secretHashHex: "0xdep",
	secret: undefined,
	sealedEnvelope: "blob",
	sealerL1: "0xsealer",
	sender: "0xsender",
	depositTxHash: "0xtx",
	leafIndex: "7",
	claimTxHash: "0xclaim",
	depositL2Block: 42,
	assetKind: "fee-juice",
	fuel,
} as DepositJournalRecord

const fullWithdraw: WithdrawJournalRecord = {
	schema: 1,
	id: "0xexit",
	direction: "withdraw",
	isPrivate: false,
	amount: "40000000",
	createdAt: 1,
	updatedAt: 2,
	completedAt: 3,
	chainId: 11155111,
	portal: "0xportal",
	bridge: "0xbridge",
	recipientL1: "0xsealer",
	exitTxHash: "0xexit",
	exitBlock: 9,
	consumeTxHash: "0xconsume",
	sender: "0xaztecsender",
} as WithdrawJournalRecord

const mutate = (base: object, patch: Record<string, unknown>) => ({ ...base, ...patch })
const mutateFuel = (patch: Record<string, unknown>) => mutate(fullDeposit, { fuel: { ...fuel, ...patch } })

describe("validateBackupRecord — field-level rejection table", () => {
	it("accepts the fully-populated deposit and withdraw shapes unchanged (and empty required strings)", () => {
		expect(validateBackupRecord(fullDeposit)).toEqual(fullDeposit)
		expect(validateBackupRecord(fullWithdraw)).toEqual(fullWithdraw)
		const emptyStrings = mutate(fullDeposit, { portal: "", bridge: "", recipient: "", secretHashHex: "" })
		expect(validateBackupRecord(emptyStrings)).toEqual(emptyStrings)
	})

	it.each<[string, unknown]>([
		["null", null],
		["a string", "record"],
		["schema 3", mutate(fullDeposit, { schema: 3 })],
		["empty id", mutate(fullDeposit, { id: "" })],
		["numeric id", mutate(fullDeposit, { id: 7 })],
		["isPrivate string", mutate(fullDeposit, { isPrivate: "true" })],
		["amount with decimals", mutate(fullDeposit, { amount: "1.5" })],
		["amount number", mutate(fullDeposit, { amount: 100 })],
		["createdAt string", mutate(fullDeposit, { createdAt: "1" })],
		["updatedAt missing", mutate(fullDeposit, { updatedAt: undefined })],
		["completedAt string", mutate(fullDeposit, { completedAt: "3" })],
		["chainId string", mutate(fullDeposit, { chainId: "11155111" })],
		["portal missing", mutate(fullDeposit, { portal: undefined })],
		["bridge number", mutate(fullDeposit, { bridge: 1 })],
		["unknown direction", mutate(fullDeposit, { direction: "swap" })],
	])("common shape: %s rejects", (_label, rec) => {
		expect(() => validateBackupRecord(rec)).toThrow(REJECT)
	})

	it.each<[string, unknown]>([
		["recipient missing", mutate(fullDeposit, { recipient: undefined })],
		["secretHashHex number", mutate(fullDeposit, { secretHashHex: 1 })],
		["secret number", mutate(fullDeposit, { secret: 1 })],
		["sealedEnvelope object", mutate(fullDeposit, { sealedEnvelope: {} })],
		["sealerL1 number", mutate(fullDeposit, { sealerL1: 1 })],
		["sender number", mutate(fullDeposit, { sender: 1 })],
		["depositTxHash number", mutate(fullDeposit, { depositTxHash: 1 })],
		["leafIndex number", mutate(fullDeposit, { leafIndex: 7 })],
		["claimTxHash boolean", mutate(fullDeposit, { claimTxHash: true })],
		["depositL2Block string", mutate(fullDeposit, { depositL2Block: "42" })],
		["fuel null on schema 2", mutate(fullDeposit, { fuel: null })],
		["fuel amount missing", mutateFuel({ amount: undefined })],
		["fuel secret number", mutateFuel({ secret: 1 })],
		["fuel secretHashHex missing", mutateFuel({ secretHashHex: undefined })],
		["fuel minOutput missing", mutateFuel({ minOutput: undefined })],
		["fuel minOutput hex", mutateFuel({ minOutput: "0x10" })],
		["fuel leafIndex non-decimal", mutateFuel({ leafIndex: "7x" })],
		["fuel received non-decimal", mutateFuel({ received: "1e18" })],
		["fuel claimAttempt string", mutateFuel({ claimAttempt: "yes" })],
		["fuel claimTxHash number", mutateFuel({ claimTxHash: 1 })],
		["fuel consumed string", mutateFuel({ consumed: "no" })],
		["fuel standaloneClaimed number", mutateFuel({ standaloneClaimed: 0 })],
	])("deposit: %s rejects", (_label, rec) => {
		expect(() => validateBackupRecord(rec)).toThrow(REJECT)
	})

	it.each<[string, unknown]>([
		["recipientL1 number", mutate(fullWithdraw, { recipientL1: 1 })],
		["exitTxHash number", mutate(fullWithdraw, { exitTxHash: 1 })],
		["exitBlock string", mutate(fullWithdraw, { exitBlock: "9" })],
		["consumeTxHash boolean", mutate(fullWithdraw, { consumeTxHash: false })],
		["sender number", mutate(fullWithdraw, { sender: 1 })],
		["provisional (half-started) id", mutate(fullWithdraw, { id: "wd-pending-abc12345", exitTxHash: undefined })],
	])("withdraw: %s rejects", (_label, rec) => {
		expect(() => validateBackupRecord(rec)).toThrow(REJECT)
	})
})
