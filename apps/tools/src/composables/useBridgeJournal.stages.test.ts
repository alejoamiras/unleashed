/**
 * Ordering + narration pins for the journal claim engine, driven over the same injected-deps style
 * as useBridgeJournal.test.ts (scaffolding duplicated — no vi.mock sharing across files).
 */
import type { DepositJournalRecord, KV, SendDepositRecord, SendWithdrawRecord } from "@unleashed/bridge-core"
import type { JournalTokenBlock } from "@unleashed/sdk"
import { feeJuiceAddress, predictPortal } from "@unleashed/sdk/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/contracts/bridge-generation", () => ({ FUEL_PORTAL: "0xfd05ee8687d4ca828ba3d26ef04b80dd1348e5bd" }))

import {
	__resetJournalForTests,
	addRecord,
	connectJournalDeps,
	discard,
	resumeSessionWork,
	runDepositClaim,
	runWithdrawConsume,
	useBridgeJournal,
} from "./useBridgeJournal"
import { bridgeError, CLAIM_TX, type ClaimScript, failsWith, fakeClaimSdk, type ScriptedCall, sendsClaim } from "./test/fake-claim-sdk"

function memKV(): KV {
	const store = new Map<string, string>()
	return {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => void store.set(k, v),
		removeItem: (k) => void store.delete(k),
	}
}

const FACTORY = "0x5eb3bc0a489c5a8288765d2336659ebca68fcd00"
const IMPLEMENTATION = "0xc95ff0608561b6ba084c78d14f09e9826190f968"
const ERC20 = "0x70e0ba845a1a0f2da3359c97e0285013525ffc49"
const HUB = `0x${"b".repeat(64)}`
const FJ_PORTAL = "0xfd05ee8687d4ca828ba3d26ef04b80dd1348e5bd"
const CLONE = predictPortal(FACTORY, IMPLEMENTATION, ERC20)

const TOKEN_BLOCK: JournalTokenBlock = {
	erc20: ERC20,
	portal: CLONE,
	l2Token: `0x${"c".repeat(64)}`,
	nameWord: `0x${"1".repeat(64)}`,
	symbolWord: `0x${"2".repeat(64)}`,
	decimals: 6,
	displaySymbol: "USDC",
	registerIndex: "3",
}

// The base fixture is a direct Fee Juice bridge; `mkSend` turns it into the hub send every claim pin runs on.
const DEPLOY = { chainId: 11155111, portal: FJ_PORTAL, bridge: feeJuiceAddress.toString() }
const SEALER = "0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d"
const RECIPIENT = "0x1018808f2c17794badb361c02c945582b8198b495a7e8d01154f7eeb7d719c0d"
const SIG = `0x${"a".repeat(130)}`

function mkDeposit(id: string, over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id,
		direction: "deposit",
		isPrivate: false,
		assetKind: "fee-juice",
		amount: "100000000",
		createdAt: 1,
		updatedAt: 1,
		recipient: RECIPIENT,
		secret: "0xpublicsecret",
		secretHashHex: id,
		leafIndex: "7",
		...DEPLOY,
		...over,
	}
}

function mkWithdraw(id: string, over: Partial<SendWithdrawRecord> = {}): SendWithdrawRecord {
	return {
		schema: 3,
		id,
		direction: "withdraw",
		isPrivate: false,
		intent: "token",
		token: TOKEN_BLOCK,
		amount: "40000000",
		createdAt: 1,
		updatedAt: 1,
		recipientL1: SEALER,
		exitTxHash: id,
		chainId: 11155111,
		portal: CLONE,
		bridge: HUB,
		...over,
	}
}

function baseDeps(kv: KV) {
	return {
		kv,
		now: () => 999,
		waitMs: async () => {},
		connectedL1: () => SEALER,
		connectedAztec: () => RECIPIENT,
		signL1: vi.fn(async () => SIG),
		waitConsumeReceipt: vi.fn(async () => true),
		sendBinding: () => ({ factory: FACTORY, implementation: IMPLEMENTATION, hub: HUB, feeJuicePortal: FJ_PORTAL }),
		validateTokenBlock: vi.fn(async () => null as string | null),
		ensureTokenGrant: vi.fn(async () => "granted" as const),
		verifyConsumeIdentitySend: vi.fn(async () => true),
		consumeSend: vi.fn(async () => ({ consumeTxHash: "0x0015000000000000000000000000000000000000000000636f6e73756d657478" })),
	}
}

/** A sent claim whose receipt never lands, logging each read's poll. */
const pollsInto =
	(reads: number[]): ClaimScript =>
	async (c) => {
		for (let poll = 1; poll <= 100; poll++) {
			reads.push(poll)
			c.emit({ type: "claim-waiting", leg: "token", txHash: CLAIM_TX, poll, unreachable: 0 })
		}
		throw new Error("the round never ended")
	}

const SOFT_CAP = /Still confirming after ~30 minutes/

describe("journal engine — stage pins", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	it("(c) a record a call found claimable starts its next call pre-gated: the arrival reads as the quick re-check", async () => {
		const sdk = fakeClaimSdk()
		const steps: (string | undefined)[] = []
		const arrives = (c: ScriptedCall) => {
			c.emit({ type: "arrival", stage: "counting", checkpointsLeft: 2 })
			steps.push(useBridgeJournal().runtime.value[c.record.id]?.step)
		}
		sdk.script(
			"token",
			async (c) => {
				arrives(c)
				c.emit({ type: "claimable" })
				throw bridgeError("user-rejected")
			},
			async (c) => {
				arrives(c)
				return sendsClaim(c)
			},
		)
		connectJournalDeps({ ...baseDeps(kv), ...sdk.deps })
		addRecord(mkSend("0xpregate"))
		await runDepositClaim("0xpregate")
		await runDepositClaim("0xpregate")
		expect(steps).toEqual(["syncing", "sending"])
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xpregate")?.completedAt).toBeDefined()
	})

	it("(e) a malformed persisted claim hash is a terminal record fault: named on the first resume, never handed to the SDK", async () => {
		const sdk = fakeClaimSdk()
		connectJournalDeps({ ...baseDeps(kv), ...sdk.deps })
		addRecord(mkSend("0xbadhash", { claimTxHash: "0xnot-a-tx-hash" }))
		// A persisted hash makes the record a prompt-free receipt wait, which resume picks up without a click.
		resumeSessionWork()
		const { records, runtime } = useBridgeJournal()
		await vi.waitFor(() => expect(runtime.value["0xbadhash"]?.attention).toBe("malformed-record"))
		expect(runtime.value["0xbadhash"]?.note).toMatch(/malformed/)
		resumeSessionWork()
		await runDepositClaim("0xbadhash")
		expect(sdk.deps.claimContext).not.toHaveBeenCalled()
		expect(sdk.calls).toHaveLength(0)
		// Only a restore or a discard changes the record.
		expect((records.value.find((r) => r.id === "0xbadhash") as SendDepositRecord | undefined)?.claimTxHash).toBe("0xnot-a-tx-hash")
	})

	it("(f) round accounting: a round ends at a hash's 46th read; ten rounds keep the run's watchOnly, then the soft cap re-arms RETRY", async () => {
		const sdk = fakeClaimSdk()
		const reads: number[] = []
		sdk.script("token", pollsInto(reads))
		connectJournalDeps({ ...baseDeps(kv), ...sdk.deps })
		const { records, runtime } = useBridgeJournal()
		addRecord(mkSend("0xrounds", { claimTxHash: CLAIM_TX }))
		await runDepositClaim("0xrounds", { interactive: false })
		// Rounds 2-10 chain detached between lock releases; waitMs is a no-op so they finish fast.
		await vi.waitFor(() => expect(runtime.value["0xrounds"]?.note).toMatch(SOFT_CAP))
		await new Promise((r) => setTimeout(r, 30))
		expect(sdk.calls.map((c) => c.run.watchOnly)).toEqual(Array(10).fill(true))
		expect([reads.length, Math.max(...reads)]).toEqual([460, 46])
		expect(runtime.value["0xrounds"]?.attention).toBeUndefined()
		expect(records.value.find((r) => r.id === "0xrounds")?.completedAt).toBeUndefined()
	})

	it("(f) a reverted claim is told so, and its next receipt wait starts a fresh round budget", async () => {
		const sdk = fakeClaimSdk()
		const reads: number[] = []
		const rounds = Array<ClaimScript>(9).fill(pollsInto(reads))
		sdk.script("token", ...rounds, failsWith(bridgeError("claim-reverted")), pollsInto(reads))
		connectJournalDeps({ ...baseDeps(kv), ...sdk.deps })
		const { runtime } = useBridgeJournal()
		addRecord(mkSend("0xrevrounds", { claimTxHash: CLAIM_TX }))
		await runDepositClaim("0xrevrounds", { interactive: false })
		await vi.waitFor(() => expect(runtime.value["0xrevrounds"]?.note).toMatch(/reverted on Aztec/))
		await runDepositClaim("0xrevrounds")
		await vi.waitFor(() => expect(runtime.value["0xrevrounds"]?.note).toMatch(SOFT_CAP))
		// The click's ten rounds, every re-entry keeping the click's mode.
		expect(sdk.calls.slice(10).map((c) => c.run.watchOnly)).toEqual(Array(10).fill(false))
	})

	it("(g) the recipient guard fails CLOSED before anything runs: another account, none, or an empty recipient", async () => {
		const sdk = fakeClaimSdk()
		const deps = baseDeps(kv)
		const { runtime } = useBridgeJournal()
		const cases: [string, Record<string, unknown>, string | null][] = [
			["0xpublic", {}, "0xanotheraccount"],
			["0xprivate", { isPrivate: true, secret: undefined, sealedEnvelope: "blob" }, "0xanotheraccount"],
			["0xnoacct", {}, null],
			["0xemptyrec", { recipient: "" }, RECIPIENT],
		]
		for (const [id, over, account] of cases) {
			connectJournalDeps({ ...deps, ...sdk.deps, connectedAztec: () => account })
			addRecord(mkSend(id, over))
			await runDepositClaim(id)
			expect(runtime.value[id]?.attention).toBe("mismatch")
		}
		expect(sdk.deps.claimContext).not.toHaveBeenCalled()
		expect(deps.signL1).not.toHaveBeenCalled()
	})

	it("(h) withdraw latch: the fresh consumeTxHash is journaled BEFORE the receipt wait; a failed wait clears with its copy", async () => {
		const deps = baseDeps(kv)
		const { records, runtime } = useBridgeJournal()
		let hashAtWait: string | undefined
		deps.waitConsumeReceipt.mockImplementation(async () => {
			hashAtWait = (records.value.find((r) => r.id === "0xwd") as SendWithdrawRecord | undefined)?.consumeTxHash
			return false
		})
		connectJournalDeps(deps)
		addRecord(mkWithdraw("0xwd"))
		await runWithdrawConsume("0xwd")
		expect(hashAtWait).toBe("0x0015000000000000000000000000000000000000000000636f6e73756d657478")
		expect((records.value.find((r) => r.id === "0xwd") as SendWithdrawRecord | undefined)?.consumeTxHash).toBeUndefined()
		expect(runtime.value["0xwd"]?.note).toMatch(/The finish transaction failed/)
	})

	it("(h) prior-hash receipt failure clears the hash with the PRIOR copy; a fresh consume success completes", async () => {
		const deps = baseDeps(kv)
		const { records, runtime } = useBridgeJournal()
		deps.waitConsumeReceipt.mockResolvedValue(false)
		connectJournalDeps(deps)
		addRecord(mkWithdraw("0xwprior", { consumeTxHash: "0x001700000000000000000000000000000000000000006f6c64636f6e73756d65" }))
		await runWithdrawConsume("0xwprior")
		expect((records.value.find((r) => r.id === "0xwprior") as SendWithdrawRecord | undefined)?.consumeTxHash).toBeUndefined()
		expect(runtime.value["0xwprior"]?.note).toMatch(/The prior finish transaction failed/)

		// Fresh consume success: hash journaled, receipt ok, completion from the post-wait reread.
		deps.waitConsumeReceipt.mockResolvedValue(true)
		connectJournalDeps(deps)
		addRecord(mkWithdraw("0xwfresh"))
		await runWithdrawConsume("0xwfresh")
		const fresh = records.value.find((r) => r.id === "0xwfresh") as SendWithdrawRecord | undefined
		expect(fresh?.completedAt).toBe(999)
		expect(fresh?.consumeTxHash).toBe("0x0015000000000000000000000000000000000000000000636f6e73756d657478")
	})

	it("(h) completion uses the POST-WAIT reread: a record discarded during the receipt wait is not resurrected", async () => {
		const deps = baseDeps(kv)
		const { records } = useBridgeJournal()
		deps.waitConsumeReceipt.mockImplementation(async () => {
			discard("0xwgone")
			return true
		})
		connectJournalDeps(deps)
		addRecord(mkWithdraw("0xwgone"))
		await runWithdrawConsume("0xwgone")
		// The success path rereads the journal; the discarded record must not come back completed.
		expect(records.value.find((r) => r.id === "0xwgone")).toBeUndefined()
	})

	it("(h) absent verifier defaults open (?? true) on a rediscovered consume; progress ?? fallbacks derive proven", async () => {
		const deps = baseDeps(kv)
		const { runtime } = useBridgeJournal()
		const noVerify = { ...deps } as Record<string, unknown>
		noVerify.verifyConsumeIdentitySend = undefined
		deps.consumeSend.mockImplementation((async (_rec: unknown, onProgress: (p: Record<string, number>) => void) => {
			onProgress({ targetBlock: 10 })
			onProgress({ provenBlock: 10 })
			return { consumeTxHash: "0x0013000000000000000000000000000000000000000000000000000000006332" }
		}) as never)
		connectJournalDeps(noVerify as never)
		addRecord(mkWithdraw("0xwd2", { consumeTxHash: "0x00190000000000000000000000000000000000007265646973636f7665726564" }))
		await runWithdrawConsume("0xwd2")
		// ?? true: the prior hash completes without a verifier.
		const { records } = useBridgeJournal()
		expect(records.value.find((r) => r.id === "0xwd2")?.completedAt).toBe(999)

		connectJournalDeps(deps)
		addRecord(mkWithdraw("0xwd3"))
		await runWithdrawConsume("0xwd3")
		// The second progress call lacked targetBlock — the ?? fallback against runtime derives proven=true.
		expect(runtime.value["0xwd3"]?.proven).toBe(true)
	})

	it("(h) PROVE's share is anchored on the first proven block seen once the exit's block is known", async () => {
		const deps = baseDeps(kv)
		const { runtime } = useBridgeJournal()
		const anchors: Array<number | undefined> = []
		deps.consumeSend.mockImplementation((async (_rec: unknown, onProgress: (p: Record<string, number>) => void) => {
			onProgress({ provenBlock: 49_900 })
			anchors.push(runtime.value["0xwd4"]?.provenFrom)
			onProgress({ targetBlock: 50_000 })
			for (const provenBlock of [49_920, 49_960, 50_000]) {
				onProgress({ provenBlock })
				anchors.push(runtime.value["0xwd4"]?.provenFrom)
			}
			return { consumeTxHash: "0x0013000000000000000000000000000000000000000000000000000000006333" }
		}) as never)
		connectJournalDeps(deps)
		addRecord(mkWithdraw("0xwd4"))
		await runWithdrawConsume("0xwd4")
		expect(anchors).toEqual([undefined, 49_920, 49_920, 49_920])
	})
})

function mkSend(id: string, over: Record<string, unknown> = {}): SendDepositRecord {
	return {
		...mkDeposit(id),
		schema: 3,
		intent: "token",
		token: TOKEN_BLOCK,
		portal: CLONE,
		bridge: HUB,
		...over,
	} as SendDepositRecord
}

describe("journal engine — send-lane ordering pins", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	it("the block check precedes the grant, which precedes the claim call", async () => {
		const order: string[] = []
		const sdk = fakeClaimSdk()
		sdk.script("token", async (c) => {
			order.push("claim")
			return sendsClaim(c)
		})
		const lane = {
			validateTokenBlock: vi.fn(async () => {
				order.push("validate")
				return null as string | null
			}),
			ensureTokenGrant: vi.fn(async () => {
				order.push("grant")
				return "granted" as const
			}),
		}
		connectJournalDeps({ ...baseDeps(kv), ...lane, ...sdk.deps })
		addRecord(mkSend("0xorder"))
		await runDepositClaim("0xorder")
		expect(order).toEqual(["validate", "grant", "claim"])
	})
})
