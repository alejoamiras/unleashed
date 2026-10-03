import {
	type DepositEnvelopeV2,
	type DepositJournalRecord,
	JOURNAL_KEY,
	type JournalTokenBlock,
	type KV,
	type SendDepositRecord,
	type SendWithdrawRecord,
	type WithdrawJournalRecord,
	feeJuiceAddress,
	isSealTrusted,
	loadJournal,
	markSealTrusted,
	removeRecord,
	predictPortal,
	recoveryKeyFromSignature,
	rekeyRecord,
	sealDepositEnvelope,
	upsertRecord,
} from "@unleashed/bridge-core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GrantOutcome } from "@/lib/send-model"
import { stepperPhases } from "@/lib/bridge-steps"
import { memoryJournalLocks } from "@/lib/journal-locks"
import { recordState } from "@/lib/record-policy"
import type { DepositSearch } from "./deposit-reconcile"
import type { ExitSearch } from "./exit-attach"

vi.mock("@/contracts/bridge-generation", () => ({ FUEL_PORTAL: "0xfd05ee8687d4ca828ba3d26ef04b80dd1348e5bd" }))

import {
	__resetJournalForTests,
	activeFlowId,
	addRecord,
	addRecordVerified,
	cacheSecret,
	claimForeground,
	connectJournalDeps,
	currentRecord,
	deploymentMatches,
	discard,
	isMsgConsumed,
	isMsgNotReady,
	markApproveOutcome,
	markSessionLive,
	rekeyJournalRecord,
	releaseForeground,
	resumeSessionWork,
	attachAndConsume,
	runDepositClaim,
	runOnLane,
	runWithdrawConsume,
	sendTokenBlocks,
	setRecordStep,
	updateRecord,
	updateRecordWhen,
	useBridgeJournal,
} from "./useBridgeJournal"

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
	registerKey: `0x${"4".repeat(64)}`,
	registerIndex: "3",
}

// The deposit fixtures are direct Fee Juice bridges: the one pre-generation shape whose binding
// (the canonical portal + the L2 Fee Juice address) still resolves, so the engine's shape-agnostic
// machinery can be exercised on a record that is genuinely runnable today.
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
		amount: "100000000",
		createdAt: 1,
		updatedAt: 1,
		assetKind: "fee-juice",
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

/** A claim fake: simulate succeeds until send fires, then reverts msg-not-found (consumed). */
function smartClaimFake() {
	let sent = false
	const claim = vi.fn(async () => ({
		simulate: async () => {
			if (sent) throw new Error("No L1 to L2 message found for message hash 0xdead")
			return {}
		},
		send: async () => {
			sent = true
			return { txHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }
		},
	}))
	return claim
}

function baseDeps(kv: KV) {
	return {
		kv,
		now: () => 999,
		waitMs: async () => {},
		connectedL1: () => SEALER,
		connectedAztec: () => RECIPIENT,
		signL1: vi.fn(async () => SIG),
		claimReceiptStatus: vi.fn<() => Promise<"success" | "dropped" | "reverted" | "pending" | "unreachable">>(async () => "success"),
		waitConsumeReceipt: vi.fn(async () => true),
		sendBinding: () => ({ factory: FACTORY, implementation: IMPLEMENTATION, hub: HUB, feeJuicePortal: FJ_PORTAL }),
		validateTokenBlock: vi.fn(async () => null as string | null),
		ensureTokenGrant: vi.fn(async () => "granted" as GrantOutcome),
		verifyConsumeIdentitySend: vi.fn(async () => true),
		consumeSend: vi.fn(async () => ({ consumeTxHash: "0x0015000000000000000000000000000000000000000000636f6e73756d657478" })),
	}
}

async function sealEnvelopeFor(
	rec: DepositJournalRecord | SendDepositRecord,
	over: Partial<{ recipient: string; amount: string; sealerL1: string }> = {},
) {
	const key = await recoveryKeyFromSignature(SIG)
	return sealDepositEnvelope(key, {
		secret: "0xprivatesecret",
		recipient: over.recipient ?? rec.recipient,
		amount: over.amount ?? rec.amount,
		sealerL1: over.sealerL1 ?? SEALER,
		leafIndex: rec.leafIndex,
	})
}

describe("useBridgeJournal engine", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	it("② rediscovered claimable deposit NEVER auto-claims - zero claim/sign calls", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0x00190000000000000000000000000000000000007265646973636f7665726564"))
		resumeSessionWork()
		await new Promise((r) => setTimeout(r, 10))
		expect(claim).not.toHaveBeenCalled()
		expect(deps.signL1).not.toHaveBeenCalled()
	})

	it("L1-timeout stranding: no leafIndex + a recorded depositTxHash recovers the leg, then claims to done", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		const recoverDepositLeg = vi.fn(async (rec: DepositJournalRecord) => {
			// Mirrors the production dep: patch the record from the mined L1 receipt.
			updateRecord(rec.id, { leafIndex: "42" })
			return "recovered" as const
		})
		connectJournalDeps({ ...deps, claim, recoverDepositLeg })
		addRecord(mkDeposit("0xstranded", { leafIndex: undefined, depositTxHash: "0xdeadbeef" }))
		await runDepositClaim("0xstranded")
		expect(recoverDepositLeg).toHaveBeenCalledTimes(1)
		expect(claim).toHaveBeenCalled()
		const { records } = useBridgeJournal()
		expect(records.value.find((r) => r.id === "0xstranded")?.completedAt).toBe(999)
	})

	it("a guarded update lands in storage AND this tab's reactive copy; a rejected guard touches neither", () => {
		connectJournalDeps(baseDeps(kv))
		addRecord(mkDeposit("0xguarded", { leafIndex: undefined }))
		const written = updateRecordWhen(
			"0xguarded",
			(live) => (live as DepositJournalRecord).leafIndex === undefined,
			(live) => ({ leafIndex: `${live.id.length}` }),
		)
		expect((written as DepositJournalRecord | undefined)?.leafIndex).toBe("9")
		const { records } = useBridgeJournal()
		expect((currentRecord("0xguarded") as DepositJournalRecord).leafIndex).toBe("9")
		expect((records.value.find((r) => r.id === "0xguarded") as DepositJournalRecord).leafIndex).toBe("9")
		expect(updateRecordWhen("0xguarded", () => false, { leafIndex: "no" })).toBeUndefined()
		expect((records.value.find((r) => r.id === "0xguarded") as DepositJournalRecord).leafIndex).toBe("9")
	})

	it("recovery 'pending' (L1 not mined yet) bails softly with a retry note - no claim attempt", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		const recoverDepositLeg = vi.fn(async () => "pending" as const)
		connectJournalDeps({ ...deps, claim, recoverDepositLeg })
		addRecord(mkDeposit("0xunmined", { leafIndex: undefined, depositTxHash: "0xdeadbeef" }))
		await runDepositClaim("0xunmined")
		expect(claim).not.toHaveBeenCalled()
		const { runtime } = useBridgeJournal()
		expect(runtime.value["0xunmined"]?.note).toMatch(/isn't confirmed yet/)
	})

	it("recovery throw (reverted deposit) lands as an error note - no claim attempt", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		const recoverDepositLeg = vi.fn(async () => {
			throw new Error("The Ethereum deposit transaction reverted")
		})
		connectJournalDeps({ ...deps, claim, recoverDepositLeg })
		addRecord(
			mkDeposit("0x001c000000000000000000000000000000000000000000007265766572746564", {
				leafIndex: undefined,
				depositTxHash: "0xdeadbeef",
			}),
		)
		await runDepositClaim("0x001c000000000000000000000000000000000000000000007265766572746564")
		expect(claim).not.toHaveBeenCalled()
		const { runtime } = useBridgeJournal()
		expect(runtime.value["0x001c000000000000000000000000000000000000000000007265766572746564"]?.attention).toBe("error")
		expect(runtime.value["0x001c000000000000000000000000000000000000000000007265766572746564"]?.note).toMatch(/reverted/)
	})

	it("no depositTxHash keeps the old bail (the flow is genuinely pre-send) - recovery never fires", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		const recoverDepositLeg = vi.fn(async () => "recovered" as const)
		connectJournalDeps({ ...deps, claim, recoverDepositLeg })
		addRecord(mkDeposit("0xpresend", { leafIndex: undefined }))
		await runDepositClaim("0xpresend")
		expect(recoverDepositLeg).not.toHaveBeenCalled()
		expect(claim).not.toHaveBeenCalled()
	})

	it("③ sessionLive deposit auto-continues through gate → send → receipt → done", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xlive"))
		markSessionLive("0xlive")
		resumeSessionWork()
		await vi.waitFor(() => {
			const { records } = useBridgeJournal()
			expect(records.value.find((r) => r.id === "0xlive")?.completedAt).toBe(999)
		})
		expect(claim).toHaveBeenCalled()
	})

	it("5.0 checkpoint gate: waits until the anchor checkpoint reaches the message's before claiming", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		// The node anchor sits BELOW the message's checkpoint for the first polls, then catches up — the
		// gate must not let the claim simulate until anchor >= checkpoint (else "No L1 to L2 message found").
		const messageReadiness = vi.fn(async (_hash: string) => {
			const n = messageReadiness.mock.calls.length
			return n < 3 ? { checkpoint: 10, anchor: 7 } : { checkpoint: 10, anchor: 10 }
		})
		connectJournalDeps({ ...deps, claim, messageReadiness })
		addRecord(mkDeposit("0xgate", { messageHash: "0xMSG" }))
		markSessionLive("0xgate")
		resumeSessionWork()
		await vi.waitFor(() => {
			const { records } = useBridgeJournal()
			expect(records.value.find((r) => r.id === "0xgate")?.completedAt).toBe(999)
		})
		// Polled the REAL inbox key until the anchor caught up, THEN claimed.
		expect(messageReadiness).toHaveBeenCalledWith("0xMSG")
		expect(messageReadiness.mock.calls.length).toBeGreaterThanOrEqual(3)
		expect(claim).toHaveBeenCalled()
	})

	it("④ same-id double invocation runs once; ⑭ two records' sends serialize on the aztec lane", async () => {
		const deps = baseDeps(kv)
		const order: string[] = []
		let release: () => void = () => {}
		const gate = new Promise<void>((r) => {
			release = r
		})
		const claim = vi.fn(async (rec: DepositJournalRecord) => {
			let sent = false
			return {
				simulate: async () => {
					if (sent) throw new Error("No L1 to L2 message found")
					return {}
				},
				send: async () => {
					order.push(`start:${rec.id}`)
					if (rec.id === "0xa") await gate
					sent = true
					order.push(`end:${rec.id}`)
					return { txHash: `0xtx-${rec.id}` }
				},
			}
		})
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xa"))
		addRecord(mkDeposit("0xb"))

		const first = runDepositClaim("0xa")
		const dup = runDepositClaim("0xa")
		const second = runDepositClaim("0xb")
		await new Promise((r) => setTimeout(r, 20))
		// The duplicate did not build a second interaction for 0xa; 0xb's send waits on the lane.
		expect(order).toEqual(["start:0xa"])
		release()
		await Promise.all([first, dup, second])
		expect(order).toEqual(["start:0xa", "end:0xa", "start:0xb", "end:0xb"])
		expect(claim.mock.calls.filter((c) => (c[0] as DepositJournalRecord).id === "0xa").length).toBeLessThanOrEqual(2)
	})

	it("⑤ a single transient dropped read does NOT clear claimTxHash; three consecutive do", async () => {
		const deps = baseDeps(kv)
		// The claim was already consumed (simulate reverts message-gone) - the probe verifies true.
		const claim = vi.fn(async () => ({
			simulate: async () => {
				throw new Error("No L1 to L2 message found for message hash 0xdead")
			},
			send: async () => ({ txHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }),
		}))
		const statuses = ["dropped", "success"] as const
		let i = 0
		deps.claimReceiptStatus = vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)])
		connectJournalDeps({ ...deps, claim, connectedAztec: () => RECIPIENT })
		addRecord(mkDeposit("0xdebounce", { claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }))
		resumeSessionWork()
		await vi.waitFor(() => {
			const { records } = useBridgeJournal()
			expect(records.value.find((r) => r.id === "0xdebounce")?.completedAt).toBe(999)
		})

		__resetJournalForTests()
		kv = memKV()
		const deps2 = baseDeps(kv)
		deps2.claimReceiptStatus = vi.fn(async () => "dropped" as const)
		connectJournalDeps({ ...deps2, claim: smartClaimFake() })
		addRecord(
			mkDeposit("0xdropped", {
				claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478",
				secret: undefined,
			}),
		)
		resumeSessionWork()
		await vi.waitFor(() => {
			const { records, runtime } = useBridgeJournal()
			expect((records.value.find((r) => r.id === "0xdropped") as DepositJournalRecord).claimTxHash).toBeUndefined()
			expect(runtime.value["0xdropped"]?.attention).toBe("error")
		})
	})

	it("sync countdown: blocks tick down WITHOUT touching the PXE; the simulate gate stays the authority after arrival", async () => {
		const deps = baseDeps(kv)
		const order: string[] = []
		const heights = [100, 101, 102, 103]
		let h = 0
		const l2BlockNumber = vi.fn(async () => {
			order.push("block")
			const v = heights[Math.min(h, heights.length - 1)] ?? 103
			h++
			return v
		})
		const claim = vi.fn(async () => ({
			simulate: async () => {
				order.push("simulate")
				return {}
			},
			send: async () => ({ txHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }),
		}))
		connectJournalDeps({ ...deps, claim, l2BlockNumber })
		addRecord(mkDeposit("0xcountdown", { depositL2Block: 100 }))
		await runDepositClaim("0xcountdown")
		// Heights 100..102 are below target 103 (snapshot + 3): three countdown polls, ZERO simulates.
		expect(order.slice(0, 4)).toEqual(["block", "block", "block", "block"])
		expect(order.indexOf("simulate")).toBeGreaterThan(3)
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xcountdown")?.completedAt).toBe(999)
	})

	it("sync countdown: no depositL2Block snapshot ⇒ straight to the simulate gate (no block polling)", async () => {
		const deps = baseDeps(kv)
		const l2BlockNumber = vi.fn(async () => 100)
		const claim = vi.fn(async () => ({
			simulate: async () => ({}),
			send: async () => ({ txHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }),
		}))
		connectJournalDeps({ ...deps, claim, l2BlockNumber })
		addRecord(mkDeposit("0xnosnap"))
		await runDepositClaim("0xnosnap")
		expect(l2BlockNumber).not.toHaveBeenCalled()
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xnosnap")?.completedAt).toBe(999)
	})

	it("a preGated record (same-session retry, gate already passed) narrates CLAIM from the first probe", async () => {
		const deps = baseDeps(kv)
		const sampledSteps: (string | undefined)[] = []
		const claim = vi.fn(async () => ({
			simulate: async () => {
				sampledSteps.push(useBridgeJournal().runtime.value["0xpg"]?.step)
			},
			send: async () => ({ txHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }),
		}))
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xpg", { depositL2Block: 100 }))
		// A retry within the same session keeps the prior gate's claimable flag - stay on CLAIM.
		const { runtime } = useBridgeJournal()
		runtime.value = { ...runtime.value, "0xpg": { claimable: true } }
		await runDepositClaim("0xpg")
		expect(sampledSteps[0]).toBe("sending") // known-claimable: optimistic CLAIM, never CROSSING.
	})

	it("a fresh (not preGated) claim stays on CROSSING through a not-ready probe - never flashes CLAIM then back", async () => {
		const deps = baseDeps(kv)
		const sampledSteps: (string | undefined)[] = []
		let calls = 0
		const claim = vi.fn(async () => ({
			simulate: async () => {
				sampledSteps.push(useBridgeJournal().runtime.value["0xun"]?.step)
				if (calls++ === 0) throw new Error("No L1 to L2 message found")
			},
			send: async () => ({ txHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }),
		}))
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xun"))
		await runDepositClaim("0xun")
		// The reported bug: CLAIM ("sending") flashed first, then regressed to CROSSING on not-ready.
		// A fresh claim now narrates CROSSING from the very first probe and never moves backward.
		expect(sampledSteps[0]).toBe("syncing")
		expect(sampledSteps.includes("sending")).toBe(false)
	})

	it("a fresh PRIVATE claim (secret cached) stays on CROSSING - no UNSEALING/CLAIM flash before the gate", async () => {
		const deps = baseDeps(kv)
		// The claim is built AFTER the (private) unseal step and BEFORE the sync gate. A fresh in-session
		// deposit has its secret CACHED, so the unseal is instant - a stray UNSEALING step here is the
		// "instant green then rollback" flash (the rail maps UNSEALING → CLAIM). Sample the step there.
		const stepWhenClaimBuilt: (string | undefined)[] = []
		const sampledSteps: (string | undefined)[] = []
		const claim = vi.fn(async () => {
			stepWhenClaimBuilt.push(useBridgeJournal().runtime.value["0xfreshpriv"]?.step)
			return {
				simulate: async () => {
					sampledSteps.push(useBridgeJournal().runtime.value["0xfreshpriv"]?.step)
				},
				send: async () => ({ txHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }),
			}
		})
		cacheSecret("0xfreshpriv", "0xprivatesecret", {
			secret: "0xprivatesecret",
			recipient: RECIPIENT,
			amount: "100000000",
			sealerL1: SEALER,
			leafIndex: "7",
			v: 2,
		} as unknown as DepositEnvelopeV2)
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xfreshpriv", { isPrivate: true }))
		await runDepositClaim("0xfreshpriv")
		expect(stepWhenClaimBuilt).not.toContain("unsealing") // cached unseal is silent - no CLAIM flash
		expect(sampledSteps[0]).toBe("syncing") // the rail stayed on CROSSING through the gate
	})

	it("⑰ a claim THIS process sent completes on the checkpointed receipt - the lagging PXE cannot block it", async () => {
		const deps = baseDeps(kv)
		// simulate keeps succeeding (PXE lag right after checkpoint) - local provenance wins anyway.
		const claim = vi.fn(async () => ({
			simulate: async () => ({}),
			send: async () => ({ txHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }),
		}))
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xlocal"))
		await runDepositClaim("0xlocal")
		const { records, runtime } = useBridgeJournal()
		expect(records.value.find((r) => r.id === "0xlocal")?.completedAt).toBe(999)
		expect(runtime.value["0xlocal"]?.attention).toBeUndefined()
	})

	it("⑰a a REDISCOVERED record whose message is visibly still claimable keeps polling - no completion, no dead-end", async () => {
		const deps = baseDeps(kv)
		// No provenance (claimTxHash preset), public record so the probe runs prompt-free; the PXE
		// keeps showing the message ⇒ completion is DELAYED, never dead-ended into attention.
		const claim = vi.fn(async () => ({ simulate: async () => ({}), send: async () => ({ txHash: "0x" }) }))
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xlagging", { claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }))
		await runDepositClaim("0xlagging")
		// Rounds 2..cap run via detached re-entry; the soft cap ends with the gentle note.
		await vi.waitFor(() => {
			expect(useBridgeJournal().runtime.value["0xlagging"]?.note).toMatch(/still confirming/i)
		})
		const { records, runtime } = useBridgeJournal()
		expect(records.value.find((r) => r.id === "0xlagging")?.completedAt).toBeUndefined()
		expect(runtime.value["0xlagging"]?.attention).toBeUndefined()
	})

	it("⑰b a rediscovered private record with a checkpointed receipt completes prompt-free (owner policy: the node's word wins)", async () => {
		const deps = baseDeps(kv)
		// The sweep can't unseal (no signature prompt-free), so the probe is unverifiable (null) -
		// the checkpointed receipt completes the record anyway. Residual risk accepted: planting a
		// forged-but-checkpointed claimTxHash needs localStorage write, which already owns the journal.
		const claim = vi.fn(async () => ({ simulate: async () => ({}), send: async () => ({ txHash: "0x" }) }))
		connectJournalDeps({ ...deps, claim })
		const rec = mkDeposit("0xresumed", {
			isPrivate: true,
			secret: undefined,
			sealerL1: SEALER,
			claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478",
		})
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		addRecord(rec)
		resumeSessionWork()
		await vi.waitFor(() => {
			expect(useBridgeJournal().records.value.find((r) => r.id === "0xresumed")?.completedAt).toBe(999)
		})
		expect(deps.signL1).not.toHaveBeenCalled()
	})

	it("⑰c an explicit CLAIM on that record verifies with ONE signature and completes", async () => {
		const deps = baseDeps(kv)
		// The genuine case: the message is consumed, so the probe's simulate reverts message-gone.
		const claim = vi.fn(async () => ({
			simulate: async () => {
				throw new Error("No L1 to L2 message found")
			},
			send: async () => ({ txHash: "0x" }),
		}))
		connectJournalDeps({ ...deps, claim })
		const rec = mkDeposit("0xverify", {
			isPrivate: true,
			secret: undefined,
			sealerL1: SEALER,
			claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478",
		})
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		addRecord(rec)
		await runDepositClaim("0xverify")
		expect(deps.signL1).toHaveBeenCalledTimes(1)
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xverify")?.completedAt).toBe(999)
	})

	it("⑥ tampered plaintext recipient on a private record: no send, display resynced from the envelope", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		const rec = mkDeposit("0xtamper", { isPrivate: true, secret: undefined, recipient: "0xevil", sealerL1: SEALER })
		rec.sealedEnvelope = await sealEnvelopeFor(rec, { recipient: RECIPIENT })
		connectJournalDeps({ ...deps, claim, connectedAztec: () => "0xevil" })
		addRecord(rec)
		await runDepositClaim("0xtamper")
		const { records, runtime } = useBridgeJournal()
		expect(claim).not.toHaveBeenCalled()
		expect(runtime.value["0xtamper"]?.attention).toBe("tampered")
		expect((records.value.find((r) => r.id === "0xtamper") as DepositJournalRecord).recipient).toBe(RECIPIENT)
	})

	it("⑦ unseal failure revokes trust ONLY for the sealer account and keeps the record", async () => {
		const deps = baseDeps(kv)
		markSealTrusted(kv, DEPLOY.chainId, SEALER, "rabby")
		const rec = mkDeposit("0xfail", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		// The wallet now signs DIFFERENTLY than at seal time ⇒ wrong key ⇒ GCM failure.
		connectJournalDeps({ ...deps, claim: smartClaimFake(), signL1: vi.fn(async () => `0x${"b".repeat(130)}`) })
		addRecord(rec)
		await runDepositClaim("0xfail")
		const { records, runtime } = useBridgeJournal()
		expect(runtime.value["0xfail"]?.attention).toBe("unseal-failed")
		expect(isSealTrusted(kv, DEPLOY.chainId, SEALER, "rabby")).toBe(false)
		expect(records.value.find((r) => r.id === "0xfail")).toBeDefined()
	})

	it("⑧ wrong connected L1 account ⇒ pre-unseal mismatch, NO signature, trust intact", async () => {
		const deps = baseDeps(kv)
		markSealTrusted(kv, DEPLOY.chainId, SEALER, "rabby")
		const rec = mkDeposit("0xwrongl1", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		const signL1 = vi.fn(async () => SIG)
		connectJournalDeps({ ...deps, claim: smartClaimFake(), signL1, connectedL1: () => "0xsomeoneelse" })
		addRecord(rec)
		await runDepositClaim("0xwrongl1")
		const { runtime } = useBridgeJournal()
		expect(runtime.value["0xwrongl1"]?.attention).toBe("mismatch")
		expect(signL1).not.toHaveBeenCalled()
		expect(isSealTrusted(kv, DEPLOY.chainId, SEALER, "rabby")).toBe(true)
	})

	it("⑧b a sealer string carrying bidi controls is named in the note without them", async () => {
		const deps = baseDeps(kv)
		const hostile = `\u202e${SEALER}`
		const rec = mkDeposit("0xbidi", { isPrivate: true, secret: undefined, sealerL1: hostile })
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		connectJournalDeps({ ...deps, claim: smartClaimFake(), signL1: vi.fn(async () => SIG), connectedL1: () => "0xsomeoneelse" })
		addRecord(rec)
		await runDepositClaim("0xbidi")
		const note = useBridgeJournal().runtime.value["0xbidi"]?.note ?? ""
		expect(note).toContain(SEALER)
		expect(note).not.toContain("\u202e")
	})

	it("⑧d a tampered non-string recipient never loads as a record at all, so nothing can be claimed for it", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xtampered", { isPrivate: false, recipient: 42 as unknown as string }))
		await runDepositClaim("0xtampered")
		expect(useBridgeJournal().records.value).toHaveLength(0)
		expect(claim).not.toHaveBeenCalled()
	})

	it("⑧c wrong connected AZTEC account blocks PUBLIC claims too", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		connectJournalDeps({ ...deps, claim, connectedAztec: () => "0xanotheraccount" })
		addRecord(mkDeposit("0xpublicmismatch", { isPrivate: false }))
		await runDepositClaim("0xpublicmismatch")
		const { runtime } = useBridgeJournal()
		expect(runtime.value["0xpublicmismatch"]?.attention).toBe("mismatch")
		expect(claim).not.toHaveBeenCalled()
	})

	it("⑧b wrong connected AZTEC account ⇒ mismatch before anything runs", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		connectJournalDeps({ ...deps, claim, connectedAztec: () => "0xanotheraccount" })
		addRecord(mkDeposit("0xaztecmismatch", { isPrivate: true, secret: undefined, sealedEnvelope: "blob" }))
		await runDepositClaim("0xaztecmismatch")
		const { runtime } = useBridgeJournal()
		expect(runtime.value["0xaztecmismatch"]?.attention).toBe("mismatch")
		expect(claim).not.toHaveBeenCalled()
	})

	it("⑨ same-session cached secret claims with ZERO L1 signatures; rediscovered uses exactly one", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		const rec = mkDeposit("0xsigcount", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		connectJournalDeps({ ...deps, claim })
		addRecord(rec)
		cacheSecret("0xsigcount", "0xprivatesecret", {
			v: 2,
			secret: "0xprivatesecret",
			recipient: rec.recipient,
			amount: rec.amount,
			sealerL1: SEALER,
			leafIndex: rec.leafIndex,
		})
		await runDepositClaim("0xsigcount")
		expect(deps.signL1).not.toHaveBeenCalled()
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xsigcount")?.completedAt).toBe(999)

		__resetJournalForTests()
		kv = memKV()
		const deps2 = baseDeps(kv)
		const rec2 = mkDeposit("0xresume", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		rec2.sealedEnvelope = await sealEnvelopeFor(rec2)
		connectJournalDeps({ ...deps2, claim: smartClaimFake() })
		addRecord(rec2)
		await runDepositClaim("0xresume")
		expect(deps2.signL1).toHaveBeenCalledTimes(1)
	})

	it("⑩ rediscovered consumeTxHash waits on the receipt - consume() never re-prompts", async () => {
		const deps = baseDeps(kv)
		connectJournalDeps(deps)
		addRecord(mkWithdraw("0xexit", { consumeTxHash: "0x0018000000000000000000000000000000000000000000000000007072696f72" }))
		await runWithdrawConsume("0xexit")
		expect(deps.consumeSend).not.toHaveBeenCalled()
		expect(deps.waitConsumeReceipt).toHaveBeenCalledWith("0x0018000000000000000000000000000000000000000000000000007072696f72")
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xexit")?.completedAt).toBe(999)
	})

	it("⑩b a consume tx that fails identity verification ⇒ unknown-outcome, never done", async () => {
		const deps = baseDeps(kv)
		deps.verifyConsumeIdentitySend = vi.fn(async () => false)
		connectJournalDeps(deps)
		addRecord(mkWithdraw("0xforged", { consumeTxHash: "0x0020000000000000000000000000000000000000000000756e72656c61746564" }))
		await runWithdrawConsume("0xforged")
		const { records, runtime } = useBridgeJournal()
		expect(runtime.value["0xforged"]?.attention).toBe("unknown-outcome")
		expect(records.value.find((r) => r.id === "0xforged")?.completedAt).toBeUndefined()
		expect(deps.waitConsumeReceipt).not.toHaveBeenCalled()
	})

	it("withdraw happy path: consume once, consumeTxHash persisted, receipt ⇒ done", async () => {
		const deps = baseDeps(kv)
		connectJournalDeps(deps)
		addRecord(mkWithdraw("0xfresh"))
		await runWithdrawConsume("0xfresh")
		expect(deps.consumeSend).toHaveBeenCalledTimes(1)
		const rec = useBridgeJournal().records.value.find((r) => r.id === "0xfresh") as WithdrawJournalRecord
		expect(rec.consumeTxHash).toBe("0x0015000000000000000000000000000000000000000000636f6e73756d657478")
		expect(rec.completedAt).toBe(999)
	})

	it("⑮ provisional withdraw (no exitTxHash) ⇒ unknown-outcome, nothing runs", async () => {
		const deps = baseDeps(kv)
		connectJournalDeps(deps)
		addRecord(mkWithdraw("wd-pending-abc", { exitTxHash: undefined }))
		await runWithdrawConsume("wd-pending-abc")
		expect(useBridgeJournal().runtime.value["wd-pending-abc"]?.attention).toBe("unknown-outcome")
		expect(deps.consumeSend).not.toHaveBeenCalled()
	})

	it("⑪ stale-deployment record refuses to run (distinct attention)", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xstale", { portal: "0xOLDPORTAL" }))
		await runDepositClaim("0xstale")
		expect(useBridgeJournal().runtime.value["0xstale"]?.attention).toBe("stale-deployment")
		expect(claim).not.toHaveBeenCalled()
	})

	it("write-and-verify aborts when storage drops the record", async () => {
		const blackhole: KV = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
		connectJournalDeps({ ...baseDeps(blackhole), kv: blackhole })
		expect(() => addRecordVerified(mkDeposit("0xlost"))).toThrow(/persist/i)
	})

	it("a claim on a record with NO leafIndex bails without building the interaction (mid-deposit race pin)", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xmidflight", { leafIndex: undefined }))
		await runDepositClaim("0xmidflight")
		expect(claim).not.toHaveBeenCalled()
		expect(useBridgeJournal().runtime.value["0xmidflight"]?.attention).toBeUndefined()
	})

	it("resumeSessionWork skips mid-flight sessionLive records (no-leaf deposit, provisional withdraw)", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xnoleaf", { leafIndex: undefined }))
		addRecord(mkWithdraw("wd-pending-live", { exitTxHash: undefined }))
		markSessionLive("0xnoleaf")
		markSessionLive("wd-pending-live")
		resumeSessionWork()
		await new Promise((r) => setTimeout(r, 10))
		expect(claim).not.toHaveBeenCalled()
		expect(deps.consumeSend).not.toHaveBeenCalled()
		// The live provisional record is NOT tagged unknown-outcome by the sweep.
		expect(useBridgeJournal().runtime.value["wd-pending-live"]?.attention).toBeUndefined()
	})

	it("the engine narrates - steps observable during the flow, cleared at exit", async () => {
		const deps = baseDeps(kv)
		const seen: (string | undefined)[] = []
		let sent = false
		let gateProbes = 0
		const claim = vi.fn(async () => ({
			simulate: async () => {
				seen.push(useBridgeJournal().runtime.value["0xnarrate"]?.step)
				// A not-ready round then a ready one: CROSSING narrates while waiting, CLAIM once consumable.
				if (gateProbes++ === 0) throw new Error("No L1 to L2 message found")
				if (sent) throw new Error("No L1 to L2 message found")
				return {}
			},
			send: async () => {
				seen.push(useBridgeJournal().runtime.value["0xnarrate"]?.step)
				sent = true
				return { txHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }
			},
		}))
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xnarrate"))
		await runDepositClaim("0xnarrate")
		expect(seen).toContain("syncing")
		expect(seen).toContain("sending")
		const rt = useBridgeJournal().runtime.value["0xnarrate"]
		expect(rt?.step).toBeUndefined()
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xnarrate")?.completedAt).toBe(999)
	})

	it("pending-forever NEVER dead-ends into unknown-outcome - soft note after the round cap", async () => {
		const deps = baseDeps(kv)
		deps.claimReceiptStatus = vi.fn(async () => "pending" as const)
		connectJournalDeps({ ...deps, claim: smartClaimFake() })
		addRecord(
			mkDeposit("0x001d0000000000000000000000000000000000000000000000000000736c6f77", {
				claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478",
			}),
		)
		await runDepositClaim("0x001d0000000000000000000000000000000000000000000000000000736c6f77", { interactive: false })
		await vi.waitFor(() => {
			const rt = useBridgeJournal().runtime.value["0x001d0000000000000000000000000000000000000000000000000000736c6f77"]
			expect(rt?.note).toMatch(/still confirming/i)
		})
		const rt = useBridgeJournal().runtime.value["0x001d0000000000000000000000000000000000000000000000000000736c6f77"]
		expect(rt?.attention).toBeUndefined()
		expect(
			(
				useBridgeJournal().records.value.find(
					(r) => r.id === "0x001d0000000000000000000000000000000000000000000000000000736c6f77",
				) as DepositJournalRecord
			).claimTxHash,
		).toBe("0x00140000000000000000000000000000000000000000000000636c61696d7478")
	})

	it("transport failures narrate as unreachable, never pending, never an attention", async () => {
		const deps = baseDeps(kv)
		const details: (string | undefined)[] = []
		deps.claimReceiptStatus = vi.fn(async () => "unreachable" as const)
		// The unreachable narration is set right before the inter-poll wait - sample it there.
		const waitMs = async () => {
			details.push(useBridgeJournal().runtime.value["0xdeadrpc"]?.stepDetail)
		}
		connectJournalDeps({ ...deps, claim: smartClaimFake(), waitMs })
		addRecord(mkDeposit("0xdeadrpc", { claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }))
		await runDepositClaim("0xdeadrpc", { interactive: false })
		await vi.waitFor(() => expect(useBridgeJournal().runtime.value["0xdeadrpc"]?.note).toMatch(/still confirming/i))
		expect(details.some((d) => d?.includes("node unreachable"))).toBe(true)
		expect(useBridgeJournal().runtime.value["0xdeadrpc"]?.attention).toBeUndefined()
	})

	it("discard mid-wait bumps the generation - the chain dies, nothing resurrects", async () => {
		const deps = baseDeps(kv)
		let polls = 0
		deps.claimReceiptStatus = vi.fn(async () => {
			polls++
			if (polls === 3) discard("0xkilled")
			return "pending" as const
		})
		connectJournalDeps({ ...deps, claim: smartClaimFake() })
		addRecord(mkDeposit("0xkilled", { claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }))
		await runDepositClaim("0xkilled", { interactive: false })
		await new Promise((r) => setTimeout(r, 20))
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xkilled")).toBeUndefined()
		expect(useBridgeJournal().runtime.value["0xkilled"]).toBeUndefined()
		expect(polls).toBeLessThan(10)
	})

	it("completed cards STAY visible in the journal - history is permanent until the user discards", async () => {
		const deps = baseDeps(kv)
		connectJournalDeps({ ...deps, claim: smartClaimFake() })
		addRecord(mkDeposit("0xhide"))
		await runDepositClaim("0xhide")
		const { records: recs } = useBridgeJournal()
		expect(recs.value.find((r) => r.id === "0xhide")?.completedAt).toBe(999)
		expect(useBridgeJournal().visibleRecords.value.some((r) => r.id === "0xhide")).toBe(true)
		expect(useBridgeJournal().lastCompleted.value?.id).toBe("0xhide")
	})

	it("a REDISCOVERED completion stays visible with its ✓ card", async () => {
		const deps = baseDeps(kv)
		const claim = vi.fn(async () => ({
			simulate: async () => {
				throw new Error("No L1 to L2 message found")
			},
			send: async () => ({ txHash: "0x" }),
		}))
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xredisc", { claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }))
		await runDepositClaim("0xredisc")
		await new Promise((r) => setTimeout(r, 20))
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xredisc")?.completedAt).toBe(999)
		expect(useBridgeJournal().visibleRecords.value.some((r) => r.id === "0xredisc")).toBe(true)
	})

	it("code-review pin: a stale soft note never survives a successful completion", async () => {
		const deps = baseDeps(kv)
		const claim = vi.fn(async () => ({
			simulate: async () => {
				throw new Error("No L1 to L2 message found")
			},
			send: async () => ({ txHash: "0x" }),
		}))
		connectJournalDeps({ ...deps, claim })
		const rec = mkDeposit("0xstale-note", { claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" })
		addRecord(rec)
		// Simulate the 30-min soft-cap note left by an earlier chain.
		connectJournalDeps({ ...deps, claim })
		const { runtime } = useBridgeJournal()
		runtime.value = { "0xstale-note": { note: "Still confirming after ~30 minutes — slow testnet." } }
		await runDepositClaim("0xstale-note")
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xstale-note")?.completedAt).toBe(999)
		expect(useBridgeJournal().runtime.value["0xstale-note"]?.note).toBeUndefined()
	})

	it("withdraw completions stay visible and feed the toast hook", async () => {
		const deps = baseDeps(kv)
		connectJournalDeps(deps)
		addRecord(mkWithdraw("0xwdhide"))
		await runWithdrawConsume("0xwdhide")
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xwdhide")?.completedAt).toBe(999)
		expect(useBridgeJournal().visibleRecords.value.some((r) => r.id === "0xwdhide")).toBe(true)
		expect(useBridgeJournal().lastCompleted.value).toMatchObject({
			id: "0xwdhide",
			direction: "withdraw",
			txHash: "0x0015000000000000000000000000000000000000000000636f6e73756d657478",
		})
	})

	it("a throwing claim SURFACES on the record (UI call sites void the promise) and clears the step", async () => {
		const deps = baseDeps(kv)
		const claim = vi.fn(async () => ({
			simulate: async () => {
				throw new Error("boom - not a sync revert")
			},
			send: async () => ({ txHash: "0x" }),
		}))
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xboom"))
		await runDepositClaim("0xboom") // resolves - the failure lands on the record instead.
		const rt = useBridgeJournal().runtime.value["0xboom"]
		expect(rt?.attention).toBe("error")
		expect(rt?.note).toMatch(/boom.*funds are not lost/i)
		expect(rt?.step).toBeUndefined()
		expect(rt?.busy).toBe(false)
	})

	it("cross-tab pin: a REMOTE discard mid-round neither crashes nor completes the stale runner", async () => {
		const deps = baseDeps(kv)
		let polls = 0
		deps.claimReceiptStatus = vi.fn(async () => {
			polls++
			if (polls === 2) {
				// Another tab removed the record: simulate via direct storage write + storage-event reload
				// (NOT discard(), which would bump the tab-local generation).
				kv.setItem("unleashed-bridge:journal:v1", JSON.stringify({ schema: 1, records: [] }))
				window.dispatchEvent(new StorageEvent("storage", { key: "unleashed-bridge:journal:v1" }))
			}
			return polls < 2 ? ("pending" as const) : ("success" as const)
		})
		connectJournalDeps({ ...deps, claim: smartClaimFake() })
		const { records: recs } = useBridgeJournal()
		addRecord(mkDeposit("0xremote", { claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }))
		await expect(runDepositClaim("0xremote", { interactive: false })).resolves.toBeUndefined()
		await new Promise((r) => setTimeout(r, 20))
		expect(recs.value.find((r) => r.id === "0xremote")).toBeUndefined()
		expect(useBridgeJournal().lastCompleted.value).toBeNull()
	})

	it("cross-tab pin: a REMOTE completion makes the local finisher an idempotent no-op (no double toast)", async () => {
		const deps = baseDeps(kv)
		deps.claimReceiptStatus = vi.fn(async () => {
			// Another tab completed the record while we polled.
			const remote = {
				...mkDeposit("0xracedone", { claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }),
				completedAt: 12345,
			}
			kv.setItem("unleashed-bridge:journal:v1", JSON.stringify({ schema: 1, records: [remote] }))
			window.dispatchEvent(new StorageEvent("storage", { key: "unleashed-bridge:journal:v1" }))
			return "success" as const
		})
		const claim = vi.fn(async () => ({
			simulate: async () => {
				throw new Error("No L1 to L2 message found")
			},
			send: async () => ({ txHash: "0x" }),
		}))
		connectJournalDeps({ ...deps, claim })
		useBridgeJournal() // ensure the storage listener is registered for the remote write
		addRecord(mkDeposit("0xracedone", { claimTxHash: "0x00140000000000000000000000000000000000000000000000636c61696d7478" }))
		await runDepositClaim("0xracedone")
		const rec = useBridgeJournal().records.value.find((r) => r.id === "0xracedone")
		expect(rec?.completedAt).toBe(12345) // The remote completion stands; ours never overwrote it.
		expect(useBridgeJournal().lastCompleted.value).toBeNull() // No local toast for a remote win.
	})

	it("foreground CAS - claim suppresses the card; stale release no-ops; takeover works", async () => {
		const deps = baseDeps(kv)
		connectJournalDeps(deps)
		addRecord(mkDeposit("0xfg"))
		addRecord(mkDeposit("0xother"))
		claimForeground("0xfg")
		expect(useBridgeJournal().visibleRecords.value.map((r) => r.id)).toEqual(["0xother"])
		// A stale owner (already superseded) cannot release the new one.
		claimForeground("0xother")
		releaseForeground("0xfg")
		expect(activeFlowId.value).toBe("0xother")
		releaseForeground("0xother")
		expect(activeFlowId.value).toBeNull()
		expect(useBridgeJournal().visibleRecords.value).toHaveLength(2)
	})

	it("a reload-equivalent reset clears foreground (structural fail-open)", async () => {
		const deps = baseDeps(kv)
		connectJournalDeps(deps)
		addRecord(mkDeposit("0xfo"))
		claimForeground("0xfo")
		__resetJournalForTests()
		expect(activeFlowId.value).toBeNull()
	})

	it("the provisional→exit rekey transfers foreground ownership", async () => {
		const deps = baseDeps(kv)
		connectJournalDeps(deps)
		addRecord(mkWithdraw("wd-pending-z", { exitTxHash: undefined }))
		claimForeground("wd-pending-z")
		rekeyJournalRecord("wd-pending-z", mkWithdraw("0xexitZ"))
		expect(activeFlowId.value).toBe("0xexitZ")
		expect(useBridgeJournal().visibleRecords.value.some((r) => r.id === "0xexitZ")).toBe(false)
	})

	it("setRecordStep + markApproveOutcome land in the per-record runtime", async () => {
		const deps = baseDeps(kv)
		connectJournalDeps(deps)
		addRecord(mkDeposit("0xnarr"))
		setRecordStep("0xnarr", "approving", "confirm the allowance")
		markApproveOutcome("0xnarr", "done")
		const rt = useBridgeJournal().runtime.value["0xnarr"]
		expect(rt?.step).toBe("approving")
		expect(rt?.approveOutcome).toBe("done")
	})

	it("setRecordStep refuses an empty id: a step nothing can render is a caller bug, not a no-op", () => {
		connectJournalDeps(baseDeps(kv))
		expect(() => setRecordStep("", "approving", "confirm the allowance")).toThrow(/before the record exists/)
		expect(useBridgeJournal().runtime.value[""]).toBeUndefined()
	})

	it("runOnLane serializes one lane and leaves the other free", async () => {
		const order: string[] = []
		let releaseA: () => void = () => {}
		const gateA = new Promise<void>((r) => {
			releaseA = r
		})
		const a = runOnLane("l1", async () => {
			order.push("a-start")
			await gateA
			order.push("a-end")
		})
		const b = runOnLane("l1", async () => {
			order.push("b-start")
		})
		const c = runOnLane("aztec", async () => {
			order.push("c-start")
		})
		await c
		expect(order).toContain("c-start")
		expect(order).not.toContain("b-start")
		releaseA()
		await Promise.all([a, b])
		expect(order).toEqual(["a-start", "c-start", "a-end", "b-start"])
	})
})

describe("isMsgNotReady / isMsgConsumed — the 5.0.0 L1→L2 message-state split", () => {
	// The two upstream (@aztec-labs/stdlib) shapes must map to OPPOSITE conditions: not-anchored keeps
	// polling; nullified settles. Conflating them strands funds either way.
	const NOT_READY = "No L1 to L2 message found for message hash 0xabc"
	const CONSUMED = "No non-nullified L1 to L2 message found for message hash 0xabc"

	it("not-ready shape ⇒ isMsgNotReady only", () => {
		expect(isMsgNotReady(NOT_READY)).toBe(true)
		expect(isMsgConsumed(NOT_READY)).toBe(false)
	})
	it("consumed (nullified) shape ⇒ isMsgConsumed only (NOT isMsgNotReady)", () => {
		expect(isMsgConsumed(CONSUMED)).toBe(true)
		expect(isMsgNotReady(CONSUMED)).toBe(false)
	})
	it("kernel/pxe not-ready wordings stay in isMsgNotReady", () => {
		expect(isMsgNotReady("l1_to_l2_msg_exists returned false")).toBe(true)
		expect(isMsgNotReady("message not in state")).toBe(true)
		expect(isMsgConsumed("l1_to_l2_msg_exists returned false")).toBe(false)
	})
})

describe("deploymentMatches — pre-generation records", () => {
	const dep = (over: Partial<DepositJournalRecord>): DepositJournalRecord => mkDeposit("0xdm", over)

	it("fee-juice record matches the FeeJuicePortal + L2 Fee Juice address", () => {
		expect(deploymentMatches(dep({}))).toBe(true)
	})

	it("a fee-juice record carrying some other binding is NOT a match (quarantine, never misroute)", () => {
		expect(deploymentMatches(dep({ portal: "0xportal", bridge: "0xbridge" }))).toBe(false)
	})

	it("a token record from the retired single-token bridge never matches", () => {
		expect(deploymentMatches(dep({ assetKind: "bridge-token" }))).toBe(false)
		expect(deploymentMatches(dep({ assetKind: "bridge-token", portal: "0xportal", bridge: "0xbridge" }))).toBe(false)
	})

	it("wrong chain never matches", () => {
		expect(deploymentMatches(dep({ chainId: 1 }))).toBe(false)
	})
})

describe("confirm quiet flip - proposed receipt surfaces as confirmLanded", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	it("a proposed receipt sets confirmLanded, and the claim still completes on the checkpointed one", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		const statuses: Array<"proposed" | "success"> = ["proposed", "proposed", "success"]
		deps.claimReceiptStatus = vi.fn(async () => statuses.shift() ?? "success") as never
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xflip"))
		markSessionLive("0xflip")
		resumeSessionWork()
		await vi.waitFor(() => {
			const { runtime } = useBridgeJournal()
			expect(runtime.value["0xflip"]?.confirmLandedTxHash).toBe("0x00140000000000000000000000000000000000000000000000636c61696d7478")
		})
		await vi.waitFor(() => {
			const { records } = useBridgeJournal()
			expect(records.value.find((r) => r.id === "0xflip")?.completedAt).toBe(999)
		})
		// Proposed never completed anything: all three receipt polls ran to the checkpointed one.
		expect(deps.claimReceiptStatus).toHaveBeenCalledTimes(3)
	})

	it("a drop after proposed clears the flag with the hash - no stale mint dot on a dead claim", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		let landedMidFlight: string | undefined
		let calls = 0
		deps.claimReceiptStatus = vi.fn(async () => {
			calls++
			if (calls <= 1) return "proposed"
			// Snapshot the runtime as the drop streak starts - the flag must be live here.
			if (calls === 2) landedMidFlight = useBridgeJournal().runtime.value["0xdrop"]?.confirmLandedTxHash
			return "dropped"
		}) as never
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xdrop"))
		markSessionLive("0xdrop")
		resumeSessionWork()
		// The whole send → drop-streak arc completes between waitFor polls (waitMs is a no-op
		// fake), so wait for the drop path's TERMINAL state; the mid-flight snapshot inside the
		// receipt mock is what proves the flag was live while the hash existed.
		await vi.waitFor(() => {
			expect(useBridgeJournal().runtime.value["0xdrop"]?.attention).toBe("error")
		})
		expect(landedMidFlight).toBe("0x00140000000000000000000000000000000000000000000000636c61696d7478")
		const { runtime, records } = useBridgeJournal()
		const dropped = records.value.find((r) => r.id === "0xdrop") as DepositJournalRecord | undefined
		expect(dropped?.claimTxHash).toBeUndefined()
		// Hash-scoped: the stale flag (if any) can no longer light a hash-less record.
		const confirm = stepperPhases(dropped as DepositJournalRecord, runtime.value["0xdrop"]).find((ph) => ph.key === "confirm")
		expect(confirm?.landed).toBeUndefined()
	})

	it("a terminal revert clears the flag - RETRY's recheck window shows no mint dot", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		const statuses: Array<"proposed" | "reverted"> = ["proposed", "reverted"]
		deps.claimReceiptStatus = vi.fn(async () => statuses.shift() ?? "reverted") as never
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xrevflip"))
		markSessionLive("0xrevflip")
		resumeSessionWork()
		await vi.waitFor(() => {
			expect(useBridgeJournal().runtime.value["0xrevflip"]?.attention).toBe("error")
		})
		expect(useBridgeJournal().runtime.value["0xrevflip"]?.confirmLandedTxHash).toBeUndefined()
	})
})

function mkSend(id: string, over: Record<string, unknown> = {}): SendDepositRecord {
	return {
		schema: 3,
		id,
		direction: "deposit",
		isPrivate: false,
		intent: "token",
		token: TOKEN_BLOCK,
		amount: "100000000",
		createdAt: 1,
		updatedAt: 1,
		recipient: RECIPIENT,
		secret: "0xpublicsecret",
		secretHashHex: id,
		leafIndex: "7",
		messageHash: `0x00${"7d".repeat(31)}`,
		chainId: 11155111,
		portal: CLONE,
		bridge: HUB,
		...over,
	} as SendDepositRecord
}

/** A gas-only send: no token block, bound to the Fee Juice portal, and its claim secret lives in
 *  the fuel block - the only place the deposit ever committed it. */
function mkGasOnly(id: string, over: Record<string, unknown> = {}): SendDepositRecord {
	return mkSend(id, {
		intent: "gas",
		token: undefined,
		portal: FJ_PORTAL,
		bridge: feeJuiceAddress.toString(),
		secret: undefined,
		fuel: { amount: "10", secret: "0xfuelsecret", secretHashHex: id, minOutput: "9", leafIndex: "7", received: "5" },
		...over,
	})
}

function mkSendExit(id: string, over: Record<string, unknown> = {}): SendWithdrawRecord {
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
	} as SendWithdrawRecord
}

function sendDeps() {
	return {
		sendBinding: () => ({ factory: FACTORY, implementation: IMPLEMENTATION, hub: HUB, feeJuicePortal: FJ_PORTAL }),
		validateTokenBlock: vi.fn(async () => null as string | null),
		ensureTokenGrant: vi.fn(async () => "granted" as GrantOutcome),
		claimSend: vi.fn(async () => ({
			simulate: async () => ({}),
			send: async () => ({ txHash: "0xhubclaim", registerTxHash: "0xregister" }),
		})),
		consumeSend: vi.fn(async () => ({ consumeTxHash: "0xhubconsume" })),
		verifyConsumeIdentitySend: vi.fn(async () => true),
	}
}

describe("useBridgeJournal - send (schema 3) records", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	describe("deploymentMatches", () => {
		it("accepts a record whose clone is the factory's CREATE2 and whose bridge is the hub", () => {
			connectJournalDeps({ ...baseDeps(kv), ...sendDeps() })
			expect(deploymentMatches(mkSend("0xs"))).toBe(true)
		})

		it("refuses a clone the factory would never derive for that ERC-20", () => {
			connectJournalDeps({ ...baseDeps(kv), ...sendDeps() })
			const forged = { ...TOKEN_BLOCK, portal: "0x00000000000000000000000000000000deadbeef" }
			expect(deploymentMatches(mkSend("0xs", { token: forged, portal: forged.portal }))).toBe(false)
		})

		it("refuses a record naming another hub, and refuses every send record without a binding", () => {
			const send = sendDeps()
			connectJournalDeps({ ...baseDeps(kv), ...send })
			expect(deploymentMatches(mkSend("0xs", { bridge: `0x${"9".repeat(64)}` }))).toBe(false)
			connectJournalDeps({ ...baseDeps(kv), ...send, sendBinding: () => undefined })
			expect(deploymentMatches(mkSend("0xs"))).toBe(false)
		})

		it("binds a gas-only send to the generation's Fee Juice portal, not to a token clone", () => {
			connectJournalDeps({ ...baseDeps(kv), ...sendDeps() })
			const gas = { intent: "gas", token: undefined, portal: FJ_PORTAL, bridge: feeJuiceAddress.toString() }
			expect(deploymentMatches(mkSend("0xg", gas))).toBe(true)
			expect(deploymentMatches(mkSend("0xg", { ...gas, portal: CLONE }))).toBe(false)
		})
	})

	describe("resume validation + grant", () => {
		it("a token block the factory contradicts is a hard stop: blocked persisted, nothing granted or claimed", async () => {
			const send = sendDeps()
			send.validateTokenBlock = vi.fn(async () => "This bridge's token details changed on Ethereum." as string | null)
			connectJournalDeps({ ...baseDeps(kv), ...send })
			addRecord(mkSend("0xbad"))
			await runDepositClaim("0xbad")
			const { records, runtime } = useBridgeJournal()
			expect(records.value.find((r) => r.id === "0xbad")?.blocked).toBe("This bridge's token details changed on Ethereum.")
			expect(runtime.value["0xbad"]?.attention).toBe("stale-deployment")
			expect(send.ensureTokenGrant).not.toHaveBeenCalled()
			expect(send.claimSend).not.toHaveBeenCalled()
		})

		it("a blocked record never runs again - not even the validation re-runs", async () => {
			const send = sendDeps()
			connectJournalDeps({ ...baseDeps(kv), ...send })
			addRecord(mkSend("0xblocked", { blocked: "The factory no longer agrees with this record." }))
			await runDepositClaim("0xblocked")
			expect(send.validateTokenBlock).not.toHaveBeenCalled()
			expect(useBridgeJournal().runtime.value["0xblocked"]?.note).toBe("The factory no longer agrees with this record.")
		})

		it("a declined grant stops the lane before the claim is ever built", async () => {
			const send = sendDeps()
			send.ensureTokenGrant = vi.fn(async () => "declined" as GrantOutcome)
			connectJournalDeps({ ...baseDeps(kv), ...send })
			addRecord(mkSend("0xnogrant"))
			await runDepositClaim("0xnogrant")
			expect(send.claimSend).not.toHaveBeenCalled()
			expect(useBridgeJournal().runtime.value["0xnogrant"]?.attention).toBe("error")
		})

		it("a stale grant (a newer selection won) stops the lane with its own copy", async () => {
			const send = sendDeps()
			send.ensureTokenGrant = vi.fn(async () => "stale" as GrantOutcome)
			connectJournalDeps({ ...baseDeps(kv), ...send })
			addRecord(mkSend("0xstalegrant"))
			await runDepositClaim("0xstalegrant")
			expect(send.claimSend).not.toHaveBeenCalled()
			expect(useBridgeJournal().runtime.value["0xstalegrant"]?.note).toMatch(/superseded/)
		})
	})

	describe("claim through the hub", () => {
		it("claims via the hub (never the token-bridge dep) and persists BOTH transaction hashes", async () => {
			const deps = baseDeps(kv)
			const claim = smartClaimFake()
			const send = sendDeps()
			connectJournalDeps({ ...deps, claim, ...send })
			addRecord(mkSend("0xhub"))
			await runDepositClaim("0xhub")
			expect(claim).not.toHaveBeenCalled()
			expect(send.claimSend).toHaveBeenCalledTimes(1)
			const rec = useBridgeJournal().records.value.find((r) => r.id === "0xhub") as SendDepositRecord
			expect(rec.claimTxHash).toBe("0xhubclaim")
			expect(rec.registerTxHash).toBe("0xregister")
			expect(rec.completedAt).toBe(999)
		})

		it("a gas-only send keeps the Fee Juice claim dep - the hub is not involved", async () => {
			const deps = baseDeps(kv)
			const claim = smartClaimFake()
			const send = sendDeps()
			connectJournalDeps({ ...deps, claim, ...send })
			addRecord(mkGasOnly("0xgasonly"))
			await runDepositClaim("0xgasonly")
			expect(send.claimSend).not.toHaveBeenCalled()
			expect(send.ensureTokenGrant).not.toHaveBeenCalled()
			expect(claim).toHaveBeenCalledTimes(1)
		})

		it("a PUBLIC gas-only claim spends the fuel block's secret - the record has no other copy", async () => {
			const claim = smartClaimFake()
			connectJournalDeps({ ...baseDeps(kv), claim, ...sendDeps() })
			addRecord(mkGasOnly("0xgassecret"))
			await runDepositClaim("0xgassecret")
			expect(claim).toHaveBeenCalledWith(expect.objectContaining({ id: "0xgassecret" }), "0xfuelsecret", undefined)
			expect(useBridgeJournal().runtime.value["0xgassecret"]?.attention).toBeUndefined()
		})

		it("the claim value handed to the hub is the record's own claim material", async () => {
			const send = sendDeps()
			connectJournalDeps({ ...baseDeps(kv), ...send })
			addRecord(mkSend("0xmaterial", { secret: "0xsaltish" }))
			await runDepositClaim("0xmaterial")
			expect(send.claimSend).toHaveBeenCalledWith(expect.objectContaining({ id: "0xmaterial" }), "0xsaltish", undefined)
		})
	})

	describe("exit consume", () => {
		it("consumes a send exit through the token's own portal leg, never the single-portal one", async () => {
			const deps = baseDeps(kv)
			const send = sendDeps()
			connectJournalDeps({ ...deps, ...send })
			addRecord(mkSendExit("0xexit"))
			markSessionLive("0xexit")
			await runWithdrawConsume("0xexit")
			expect(deps.consumeSend).not.toHaveBeenCalled()
			expect(send.consumeSend).toHaveBeenCalledTimes(1)
			expect(useBridgeJournal().records.value.find((r) => r.id === "0xexit")?.completedAt).toBe(999)
		})

		it("a send exit whose block no longer matches is blocked before the Outbox consume", async () => {
			const deps = baseDeps(kv)
			const send = sendDeps()
			send.validateTokenBlock = vi.fn(async () => "The token's registration changed." as string | null)
			connectJournalDeps({ ...deps, ...send })
			addRecord(mkSendExit("0xexitbad"))
			await runWithdrawConsume("0xexitbad")
			expect(send.consumeSend).not.toHaveBeenCalled()
			expect(useBridgeJournal().records.value.find((r) => r.id === "0xexitbad")?.blocked).toBe("The token's registration changed.")
		})

		it("a rediscovered consume tx is matched by the send-side identity check", async () => {
			const deps = baseDeps(kv)
			const send = sendDeps()
			connectJournalDeps({ ...deps, ...send })
			addRecord(mkSendExit("0xresumed", { consumeTxHash: "0xprior" }))
			await runWithdrawConsume("0xresumed")
			expect(send.verifyConsumeIdentitySend).toHaveBeenCalledWith(expect.objectContaining({ id: "0xresumed" }), "0xprior")
			expect(deps.verifyConsumeIdentitySend).not.toHaveBeenCalled()
		})
	})

	it("sendTokenBlocks lists each schema-3 token once and skips gas-only records", () => {
		connectJournalDeps({ ...baseDeps(kv), ...sendDeps() })
		addRecord(mkSend("0xa"))
		addRecord(mkSend("0xb"))
		addRecord(mkSend("0xc", { intent: "gas", token: undefined }))
		addRecord(mkDeposit("0xschema1"))
		expect(sendTokenBlocks()).toEqual([TOKEN_BLOCK])
	})

	describe("pins follow the records that earned them", () => {
		const OTHER_BLOCK = { ...TOKEN_BLOCK, l2Token: `0x${"e".repeat(64)}` }

		it("discarding the LAST record needing a token re-derives the pin set without it", () => {
			const retainPinnedTokens = vi.fn()
			connectJournalDeps({ ...baseDeps(kv), ...sendDeps(), retainPinnedTokens })
			addRecord(mkSend("0xa"))
			addRecord(mkSend("0xb", { token: OTHER_BLOCK }))

			discard("0xa")
			expect(retainPinnedTokens).toHaveBeenLastCalledWith([OTHER_BLOCK.l2Token])
			discard("0xb")
			expect(retainPinnedTokens).toHaveBeenLastCalledWith([])
		})

		it("a token a SURVIVING record still needs keeps its pin", () => {
			const retainPinnedTokens = vi.fn()
			connectJournalDeps({ ...baseDeps(kv), ...sendDeps(), retainPinnedTokens })
			addRecord(mkSend("0xa"))
			addRecord(mkSend("0xb"))

			discard("0xa")
			expect(retainPinnedTokens).toHaveBeenLastCalledWith([TOKEN_BLOCK.l2Token])
		})
	})
})

/** A fueled hub send: the token leg plus a public gas slice, both messages' facts on the record. */
function mkFueled(id: string, over: Record<string, unknown> = {}): SendDepositRecord {
	return mkSend(id, {
		intent: "token+gas",
		fuel: { amount: "10", secret: "0xfuelsecret", secretHashHex: `${id}fuel`, minOutput: "9", leafIndex: "8", received: "5" },
		...over,
	})
}

const WALLET = { status: "connected", selectedAccount: RECIPIENT, accounts: [{ address: RECIPIENT }] }
const CLAIM_TX = "0x00140000000000000000000000000000000000000000000000636c61696d7478"

describe("useBridgeJournal - consumed → done on the message's own nullifier", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	const recordOf = (id: string) => useBridgeJournal().records.value.find((r) => r.id === id) as SendDepositRecord | undefined

	it("(a) a public hub claim whose message is already nullified completes as claimed-by-another: no build, no send", async () => {
		const send = sendDeps()
		const messageNullified = vi.fn(async () => "nullified" as const)
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified })
		addRecord(mkSend("0xother"))
		await runDepositClaim("0xother")
		const rec = recordOf("0xother") as SendDepositRecord
		expect(rec.claimedByOther).toBe(true)
		expect(rec.completedAt).toBe(999)
		expect(rec.claimTxHash).toBeUndefined()
		expect(send.claimSend).not.toHaveBeenCalled()
		expect(messageNullified).toHaveBeenCalledWith(expect.objectContaining({ id: "0xother" }), { secretHex: "0xpublicsecret" })
		expect(useBridgeJournal().runtime.value["0xother"]?.attention).toBeUndefined()
	})

	it("(b) a private record with its secret cached hands the dep the unsealed material, then completes", async () => {
		const send = sendDeps()
		const messageNullified = vi.fn(async () => "nullified" as const)
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified })
		const rec = mkSend("0xprivother", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		addRecord(rec)
		cacheSecret("0xprivother", "0xprivatesecret", {
			v: 2,
			secret: "0xprivatesecret",
			recipient: rec.recipient,
			amount: rec.amount,
			sealerL1: SEALER,
			leafIndex: rec.leafIndex,
		})
		await runDepositClaim("0xprivother")
		expect(messageNullified).toHaveBeenCalledWith(
			expect.objectContaining({ id: "0xprivother" }),
			expect.objectContaining({ secretHex: "0xprivatesecret", envelope: expect.objectContaining({ secret: "0xprivatesecret" }) }),
		)
		expect(recordOf("0xprivother")?.claimedByOther).toBe(true)
		expect(recordOf("0xprivother")?.completedAt).toBe(999)
		expect(send.claimSend).not.toHaveBeenCalled()
	})

	it("(c) a live message claims exactly as before: the hub build, the send, the receipt", async () => {
		const send = sendDeps()
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: vi.fn(async () => "live" as const) })
		addRecord(mkSend("0xlive"))
		await runDepositClaim("0xlive")
		expect(send.claimSend).toHaveBeenCalledTimes(1)
		expect(recordOf("0xlive")?.claimTxHash).toBe("0xhubclaim")
		expect(recordOf("0xlive")?.completedAt).toBe(999)
		expect(recordOf("0xlive")?.claimedByOther).toBeUndefined()
	})

	it.each([
		["the private-context wording", "No non-nullified L1 to L2 message found"],
		["the public-context wording", "L1-to-L2 message is already nullified"],
	])("(d) the simulate throws %s: nullified ⇒ claimed by another; still live ⇒ today's error", async (_label, wording) => {
		const consumedSimulate = () => ({
			simulate: async () => {
				throw new Error(wording)
			},
			send: async () => ({ txHash: "0xnever" }),
		})
		const send = { ...sendDeps(), claimSend: vi.fn(async () => consumedSimulate()) }
		const messageNullified = vi
			.fn<() => Promise<"nullified" | "live">>()
			.mockResolvedValueOnce("live")
			.mockResolvedValueOnce("nullified")
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified })
		addRecord(mkSend("0xsim"))
		await runDepositClaim("0xsim")
		expect(recordOf("0xsim")?.claimedByOther).toBe(true)
		expect(recordOf("0xsim")?.completedAt).toBe(999)
		expect(recordOf("0xsim")?.claimTxHash).toBeUndefined()

		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: vi.fn(async () => "live" as const) })
		addRecord(mkSend("0xsimlive"))
		await runDepositClaim("0xsimlive")
		expect(recordOf("0xsimlive")?.claimedByOther).toBeUndefined()
		expect(recordOf("0xsimlive")?.completedAt).toBeUndefined()
		expect(useBridgeJournal().runtime.value["0xsimlive"]?.attention).toBe("error")
	})

	it("(e) a prompt-free resume with no material asks the dep nothing, prompts for nothing, and keeps today's outcome", async () => {
		const deps = baseDeps(kv)
		const messageNullified = vi.fn(async () => "nullified" as const)
		connectJournalDeps({ ...deps, ...sendDeps(), messageNullified })
		const rec = mkSend("0xnomaterial", { isPrivate: true, secret: undefined, sealerL1: SEALER, claimTxHash: CLAIM_TX })
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		addRecord(rec)
		resumeSessionWork()
		await new Promise((r) => setTimeout(r, 0))
		expect(messageNullified).not.toHaveBeenCalled()
		expect(deps.signL1).not.toHaveBeenCalled()
		expect(recordOf("0xnomaterial")?.completedAt).toBe(999)
		expect(recordOf("0xnomaterial")?.claimedByOther).toBeUndefined()
	})

	it("(g) an invalid message identity stops with tampered, builds nothing and completes nothing - fresh and resumed", async () => {
		const send = sendDeps()
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: vi.fn(async () => "invalid" as const) })
		addRecord(mkSend("0xbadid"))
		await runDepositClaim("0xbadid")
		expect(useBridgeJournal().runtime.value["0xbadid"]?.attention).toBe("tampered")
		expect(send.claimSend).not.toHaveBeenCalled()
		expect(recordOf("0xbadid")?.completedAt).toBeUndefined()
		expect(recordOf("0xbadid")?.claimedByOther).toBeUndefined()

		addRecord(mkSend("0xbadresume", { claimTxHash: CLAIM_TX }))
		await runDepositClaim("0xbadresume")
		expect(useBridgeJournal().runtime.value["0xbadresume"]?.attention).toBe("tampered")
		expect(recordOf("0xbadresume")?.completedAt).toBeUndefined()
		expect(send.claimSend).not.toHaveBeenCalled()
	})

	it("(h) gas-only and pre-generation records never reach the nullifier: their claim-build probe decides as before", async () => {
		const messageNullified = vi.fn(async () => "nullified" as const)
		// The claim-build probe's own consumed answer: the message is gone ⇒ the awaited claim landed.
		const claim = vi.fn(async () => ({
			simulate: async () => {
				throw new Error("No non-nullified L1 to L2 message found")
			},
			send: async () => ({ txHash: "0xnever" }),
		}))
		connectJournalDeps({ ...baseDeps(kv), ...sendDeps(), claim, messageNullified })
		addRecord(mkGasOnly("0xgasresume", { claimTxHash: CLAIM_TX }))
		addRecord(mkDeposit("0xtokenresume", { claimTxHash: CLAIM_TX }))
		await runDepositClaim("0xgasresume")
		await runDepositClaim("0xtokenresume")
		expect(messageNullified).not.toHaveBeenCalled()
		expect(claim).toHaveBeenCalledTimes(2) // the probe rebuilt the claim for each, as today
		expect(recordOf("0xgasresume")?.completedAt).toBe(999)
		expect(recordOf("0xtokenresume")?.completedAt).toBe(999)
		expect(recordOf("0xgasresume")?.claimedByOther).toBeUndefined()
	})

	it("(i) a resumed hub claim with a success receipt reads the nullifier, never the claim build: live keeps polling, nullified completes", async () => {
		const send = sendDeps()
		const messageNullified = vi
			.fn<() => Promise<"nullified" | "live">>()
			.mockResolvedValueOnce("live")
			.mockResolvedValueOnce("live")
			.mockResolvedValue("nullified")
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified })
		addRecord(mkSend("0xresumed", { claimTxHash: CLAIM_TX }))
		await runDepositClaim("0xresumed")
		expect(send.claimSend).not.toHaveBeenCalled()
		expect(messageNullified).toHaveBeenCalledTimes(3)
		expect(recordOf("0xresumed")?.completedAt).toBe(999)
		expect(recordOf("0xresumed")?.claimedByOther).toBeUndefined() // our own claim landed; not another's
	})

	it("(j) a record another tab replaced while the read awaited is never completed", async () => {
		const send = sendDeps()
		const messageNullified = vi.fn(async () => {
			upsertRecord(kv, { ...mkSend("0xreplaced"), amount: "1" })
			return "nullified" as const
		})
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified })
		addRecord(mkSend("0xreplaced"))
		await runDepositClaim("0xreplaced")
		expect(recordOf("0xreplaced")?.amount).toBe("1")
		expect(recordOf("0xreplaced")?.completedAt).toBeUndefined()
		expect(recordOf("0xreplaced")?.claimedByOther).toBeUndefined()
		expect(send.claimSend).not.toHaveBeenCalled()
	})

	it("(k) token+gas PUBLIC, token gone and fuel live: the fact without completion, the gas claim stays offered, and the settled fuel completes it after a reload", async () => {
		const send = sendDeps()
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: vi.fn(async () => "nullified" as const) })
		addRecord(mkFueled("0xfueled"))
		await runDepositClaim("0xfueled")
		let rec = recordOf("0xfueled") as SendDepositRecord
		expect(rec.claimedByOther).toBe(true)
		expect(rec.completedAt).toBeUndefined()
		expect(recordState(rec, {}, WALLET).fuelRecoverable).toBe(true)
		expect(recordState(rec, {}, WALLET).showClaim).toBe(true) // CLAIM verifies the marker; CLAIM YOUR GAS claims the gas
		// The standalone gas claim lands, then the tab dies before the engine sees it.
		updateRecord("0xfueled", {
			fuel: { ...(rec.fuel as NonNullable<typeof rec.fuel>), standaloneClaimed: true },
		} as Partial<SendDepositRecord>)
		__resetJournalForTests()
		const messageNullified = vi.fn(async () => "nullified" as const)
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified })
		useBridgeJournal()
		resumeSessionWork()
		await new Promise((r) => setTimeout(r, 0))
		rec = recordOf("0xfueled") as SendDepositRecord
		expect(rec.completedAt).toBe(999)
		expect(rec.claimedByOther).toBe(true)
		expect(messageNullified).toHaveBeenCalledTimes(1) // the marker is re-read from the chain, never trusted
		expect(send.claimSend).not.toHaveBeenCalled()
	})

	it("(k′) token+gas PRIVATE, token gone and fuel live: the fact without completion, no fuel affordance, the sealed copy kept, never resumed", async () => {
		const send = sendDeps()
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: vi.fn(async () => "nullified" as const) })
		const rec = mkFueled("0xprivfueled", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		addRecord(rec)
		cacheSecret("0xprivfueled", "0xprivatesecret", {
			v: 2,
			secret: "0xprivatesecret",
			recipient: rec.recipient,
			amount: rec.amount,
			sealerL1: SEALER,
			leafIndex: rec.leafIndex,
		})
		await runDepositClaim("0xprivfueled")
		const after = recordOf("0xprivfueled") as SendDepositRecord
		expect(after.claimedByOther).toBe(true)
		expect(after.completedAt).toBeUndefined()
		expect(after.sealedEnvelope).toBe(rec.sealedEnvelope)
		const wallet = WALLET
		expect(recordState(after, {}, wallet).fuelRecovery).toBe("none")
		expect(recordState(after, {}, wallet).showClaim).toBe(true) // CLAIM = verify the marker; never a gas claim
		expect(recordState(after, {}, wallet).claimedByOther).toBe(true)

		__resetJournalForTests()
		const messageNullified = vi.fn(async () => "nullified" as const)
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified, now: () => 999 + 30 * 24 * 60 * 60 * 1000 })
		useBridgeJournal()
		resumeSessionWork()
		await new Promise((r) => setTimeout(r, 0))
		expect(recordOf("0xprivfueled")?.sealedEnvelope).toBe(rec.sealedEnvelope) // not pruned: never completed
		expect(messageNullified).not.toHaveBeenCalled()
	})

	it("a persisted claimedByOther marker is re-read from the nullifier, never trusted: live drops it, nullified completes, no material waits", async () => {
		const send = sendDeps()
		const live = vi.fn(async () => "live" as const)
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: live })
		addRecord(mkSend("0xforged", { messageHash: "0xm", claimedByOther: true }))
		await runDepositClaim("0xforged")
		expect(live).toHaveBeenCalledTimes(1)
		expect(recordOf("0xforged")?.completedAt).toBeUndefined()
		expect(recordOf("0xforged")?.claimedByOther).toBeUndefined() // the marker was wrong and is gone
		expect(send.claimSend).not.toHaveBeenCalled()

		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: vi.fn(async () => "nullified" as const) })
		addRecord(mkSend("0xtrue", { messageHash: "0xm", claimedByOther: true }))
		await runDepositClaim("0xtrue")
		expect(recordOf("0xtrue")?.completedAt).toBe(999)

		// A private record without its secret at hand: nothing is read, nothing prompts, nothing completes.
		const deps = baseDeps(kv)
		const probe = vi.fn(async () => "nullified" as const)
		connectJournalDeps({ ...deps, ...send, messageNullified: probe })
		const priv = mkSend("0xforgedpriv", {
			isPrivate: true,
			secret: undefined,
			sealerL1: SEALER,
			messageHash: "0xm",
			claimedByOther: true,
		})
		priv.sealedEnvelope = await sealEnvelopeFor(priv)
		addRecord(priv)
		resumeSessionWork()
		await new Promise((r) => setTimeout(r, 0))
		await runDepositClaim("0xforgedpriv", { interactive: false })
		expect(probe).not.toHaveBeenCalled()
		expect(deps.signL1).not.toHaveBeenCalled()
		expect(recordOf("0xforgedpriv")?.completedAt).toBeUndefined()
		expect(recordOf("0xforgedpriv")?.sealedEnvelope).toBe(priv.sealedEnvelope)
		// The explicit click unseals (one signature) and verifies: a live message drops the marker.
		connectJournalDeps({ ...deps, ...send, messageNullified: vi.fn(async () => "live" as const) })
		await runDepositClaim("0xforgedpriv", { interactive: true })
		expect(deps.signL1).toHaveBeenCalledTimes(1)
		expect(recordOf("0xforgedpriv")?.claimedByOther).toBeUndefined()
		expect(recordOf("0xforgedpriv")?.completedAt).toBeUndefined()
	})

	it("a false marker on a private token+gas record: the click unseals, the live message drops it, the claim is back", async () => {
		const deps = baseDeps(kv)
		const send = sendDeps()
		connectJournalDeps({ ...deps, ...send, messageNullified: vi.fn(async () => "live" as const) })
		const priv = mkFueled("0xfalsepriv", {
			isPrivate: true,
			secret: undefined,
			sealerL1: SEALER,
			messageHash: "0xm",
			claimedByOther: true,
		})
		priv.sealedEnvelope = await sealEnvelopeFor(priv)
		addRecord(priv)
		await runDepositClaim("0xfalsepriv", { interactive: true })
		expect(deps.signL1).toHaveBeenCalledTimes(1)
		expect(recordOf("0xfalsepriv")?.claimedByOther).toBeUndefined()
		expect(send.claimSend).not.toHaveBeenCalled() // the verification never claims; the next click does
	})

	it("a fuel block swapped in while the reconciliation awaits inherits nothing: no completion", async () => {
		const send = sendDeps()
		const f1 = {
			amount: "10",
			secret: "0xfuelsecret",
			secretHashHex: "0xf1",
			minOutput: "9",
			leafIndex: "8",
			received: "5",
			claimTxHash: CLAIM_TX,
		}
		const reconcileFuel = vi.fn(async (id: string) => {
			// Another tab replaced F1 with an unconsumed F2, then this tab's receipt merges into F2.
			upsertRecord(kv, {
				...mkFueled("0xf2swap", { fuel: { ...f1, secretHashHex: "0xf2", claimTxHash: undefined, consumed: true } }),
			})
			void id
		})
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: vi.fn(async () => "nullified" as const), reconcileFuel })
		addRecord(mkFueled("0xf2swap", { fuel: f1 }))
		await runDepositClaim("0xf2swap")
		expect(recordOf("0xf2swap")?.completedAt).toBeUndefined()
		expect(recordOf("0xf2swap")?.claimedByOther).toBeUndefined()
	})

	it("a marked record whose fuel receipt was pending resumes, reconciles, and completes once it checkpoints", async () => {
		const send = sendDeps()
		const fuel = {
			amount: "10",
			secret: "0xfuelsecret",
			secretHashHex: "0xfh",
			minOutput: "9",
			leafIndex: "8",
			received: "5",
			claimTxHash: CLAIM_TX,
		}
		const pending = vi.fn(async () => {}) // the receipt is not checkpointed yet
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: vi.fn(async () => "nullified" as const), reconcileFuel: pending })
		addRecord(mkFueled("0xlater", { fuel }))
		await runDepositClaim("0xlater")
		expect(recordOf("0xlater")?.claimedByOther).toBe(true)
		expect(recordOf("0xlater")?.completedAt).toBeUndefined()

		__resetJournalForTests()
		const included = vi.fn(async (id: string) => {
			const rec = recordOf(id) as SendDepositRecord
			updateRecord(id, { fuel: { ...(rec.fuel as NonNullable<typeof rec.fuel>), consumed: true } } as Partial<SendDepositRecord>)
		})
		const messageNullified = vi.fn(async () => "nullified" as const)
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified, reconcileFuel: included })
		useBridgeJournal()
		resumeSessionWork() // prompt-free: the public record carries its own material
		await new Promise((r) => setTimeout(r, 0))
		expect(included).toHaveBeenCalledWith("0xlater")
		expect(messageNullified).toHaveBeenCalledTimes(1)
		expect(recordOf("0xlater")?.completedAt).toBe(999)
	})

	it("a fuel block replaced while the read awaits refuses the completion", async () => {
		const send = sendDeps()
		const settledFuel = {
			amount: "10",
			secret: "0xfuelsecret",
			secretHashHex: "0xfh",
			minOutput: "9",
			leafIndex: "8",
			received: "5",
			consumed: true,
		}
		const messageNullified = vi.fn(async () => {
			// Another tab swapped the settled fuel for a live one under the same id.
			upsertRecord(kv, { ...mkFueled("0xswapped", { fuel: settledFuel }), fuel: { ...settledFuel, consumed: undefined } })
			return "nullified" as const
		})
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified })
		addRecord(mkFueled("0xswapped", { fuel: settledFuel }))
		await runDepositClaim("0xswapped")
		expect(recordOf("0xswapped")?.completedAt).toBeUndefined()
		expect(recordOf("0xswapped")?.claimedByOther).toBeUndefined()
	})

	it("a fuel leg with its own spending transaction is reconciled before the fuel is judged unsettled", async () => {
		const send = sendDeps()
		const fuel = {
			amount: "10",
			secret: "0xfuelsecret",
			secretHashHex: "0xfh",
			minOutput: "9",
			leafIndex: "8",
			received: "5",
			claimTxHash: CLAIM_TX,
		}
		const reconcileFuel = vi.fn(async (id: string) => {
			const rec = recordOf(id) as SendDepositRecord
			updateRecord(id, { fuel: { ...(rec.fuel as NonNullable<typeof rec.fuel>), consumed: true } } as Partial<SendDepositRecord>)
		})
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: vi.fn(async () => "nullified" as const), reconcileFuel })
		addRecord(mkFueled("0xreconciled", { fuel }))
		await runDepositClaim("0xreconciled")
		expect(reconcileFuel).toHaveBeenCalledWith("0xreconciled")
		expect(recordOf("0xreconciled")?.completedAt).toBe(999)
		expect(recordOf("0xreconciled")?.claimedByOther).toBe(true)
	})

	it("a record discarded while the nullifier read awaited is never built or sent — even a remote deletion this tab has not yet heard of", async () => {
		const send = sendDeps()
		const messageNullified = vi.fn(async () => {
			removeRecord(kv, "0xgoneprobe") // another tab's write: storage only, no storage event here
			return "live" as const
		})
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified })
		addRecord(mkSend("0xgoneprobe"))
		await runDepositClaim("0xgoneprobe")
		expect(send.claimSend).not.toHaveBeenCalled()
	})

	it("a fuel identity replaced during the nullifier read cannot inherit the verification", async () => {
		const send = sendDeps()
		const settled = {
			amount: "10",
			secret: "0xfuelsecret",
			secretHashHex: "0xfh",
			minOutput: "9",
			leafIndex: "8",
			received: "5",
			consumed: true,
		}
		const messageNullified = vi.fn(async () => {
			updateRecord("0xfuelswap", { fuel: { ...settled, secretHashHex: "0xother" } } as Partial<SendDepositRecord>)
			return "nullified" as const
		})
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified })
		addRecord(mkFueled("0xfuelswap", { fuel: settled }))
		await runDepositClaim("0xfuelswap")
		expect(recordOf("0xfuelswap")?.completedAt).toBeUndefined()
		expect(recordOf("0xfuelswap")?.claimedByOther).toBeUndefined()
	})

	it("a marker on a record without its message hash is ignored: the ordinary claim runs", async () => {
		const send = sendDeps()
		const messageNullified = vi.fn(async () => "unknown" as const)
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified })
		addRecord(mkSend("0xnohash", { messageHash: undefined, claimedByOther: true }))
		await runDepositClaim("0xnohash")
		expect(send.claimSend).toHaveBeenCalledTimes(1)
		expect(recordOf("0xnohash")?.completedAt).toBe(999)
	})

	it("a forged marker never preempts hash-less reconciliation or receipt polling", async () => {
		const send = sendDeps()
		const findDepositTx = vi.fn(async () => "none" as const)
		const messageNullified = vi.fn(async () => "nullified" as const)
		connectJournalDeps({ ...baseDeps(kv), ...send, findDepositTx, messageNullified })
		addRecord(mkSend("0xhashlessmarker", { leafIndex: undefined, claimedByOther: true }))
		await runDepositClaim("0xhashlessmarker")
		expect(findDepositTx).toHaveBeenCalledTimes(1) // the finder ran; the marker was ignored
		expect(recordOf("0xhashlessmarker")?.completedAt).toBeUndefined()

		addRecord(mkSend("0xsentmarker", { claimTxHash: CLAIM_TX, messageHash: "0xm", claimedByOther: true }))
		await runDepositClaim("0xsentmarker")
		expect(recordOf("0xsentmarker")?.completedAt).toBe(999) // the receipt round decided, as for any sent claim
		expect(send.claimSend).not.toHaveBeenCalled()
	})

	it("a public false marker with open fuel is verified on resume and on the click, whatever the gas recovery does", async () => {
		const send = sendDeps()
		const messageNullified = vi.fn(async () => "live" as const)
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified })
		const rec = mkFueled("0xfalsepublic", { messageHash: "0xm", claimedByOther: true })
		addRecord(rec)
		const wallet = { status: "connected", selectedAccount: RECIPIENT, accounts: [{ address: RECIPIENT }] }
		expect(recordState(rec, {}, wallet).showClaim).toBe(true)
		resumeSessionWork()
		await new Promise((r) => setTimeout(r, 0))
		expect(messageNullified).toHaveBeenCalledTimes(1)
		expect(recordOf("0xfalsepublic")?.claimedByOther).toBeUndefined() // dropped: the ordinary claim is back
	})

	it("two immediate starts in one tab under a delayed lock grant: the second is a local duplicate, never a cross-tab note", async () => {
		// A lock table that grants only when told to, so both starts are pending together.
		let grant: () => void = () => {}
		const granted = new Promise<void>((r) => (grant = r))
		const locks = {
			...memoryJournalLocks(),
			record: async <T>(_id: string, fn: () => Promise<T>) => {
				await granted
				return fn()
			},
		}
		let releaseClaim: () => void = () => {}
		const send = {
			...sendDeps(),
			claimSend: vi.fn(async () => ({
				simulate: () => new Promise<unknown>((r) => (releaseClaim = () => r({}))),
				send: async () => ({ txHash: "0xhubclaim" }),
			})),
		}
		connectJournalDeps({ ...baseDeps(kv), ...send, locks })
		addRecord(mkSend("0xtwice"))
		const first = runDepositClaim("0xtwice")
		const second = runDepositClaim("0xtwice")
		grant()
		await new Promise((r) => setTimeout(r, 0))
		await second
		// While the first runner still waits on its simulate, the loser left no cross-tab note.
		expect(useBridgeJournal().runtime.value["0xtwice"]?.note).toBeUndefined()
		expect(useBridgeJournal().runtime.value["0xtwice"]?.busy).toBe(true)
		releaseClaim()
		await first
		expect(send.claimSend).toHaveBeenCalledTimes(1)
		expect(recordOf("0xtwice")?.completedAt).toBe(999)
	})

	it("(l) token+gas with its fuel already settled completes at once", async () => {
		const send = sendDeps()
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: vi.fn(async () => "nullified" as const) })
		addRecord(
			mkFueled("0xsettled", {
				fuel: {
					amount: "10",
					secret: "0xfuelsecret",
					secretHashHex: "0xfh",
					minOutput: "9",
					leafIndex: "8",
					received: "5",
					consumed: true,
				},
			}),
		)
		await runDepositClaim("0xsettled")
		expect(recordOf("0xsettled")?.completedAt).toBe(999)
		expect(recordOf("0xsettled")?.claimedByOther).toBe(true)
		expect(send.claimSend).not.toHaveBeenCalled()
	})

	it("a dep that throws reads as unknown: the claim proceeds as today", async () => {
		const send = sendDeps()
		connectJournalDeps({
			...baseDeps(kv),
			...send,
			messageNullified: vi.fn(async () => {
				throw new Error("rpc down")
			}),
		})
		addRecord(mkSend("0xthrows"))
		await runDepositClaim("0xthrows")
		expect(send.claimSend).toHaveBeenCalledTimes(1)
		expect(recordOf("0xthrows")?.completedAt).toBe(999)
	})
})

describe("useBridgeJournal - the two cross-tab locks", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	it("a record another tab holds is skipped (held elsewhere) and runs once the holder releases", async () => {
		const locks = memoryJournalLocks()
		const send = sendDeps()
		connectJournalDeps({ ...baseDeps(kv), ...send, locks })
		addRecord(mkSend("0xheld"))
		let release: () => void = () => {}
		const holder = locks.record("0xheld", () => new Promise<void>((r) => (release = r)))
		await runDepositClaim("0xheld")
		expect(send.claimSend).not.toHaveBeenCalled()
		expect(useBridgeJournal().runtime.value["0xheld"]?.busy).toBeFalsy()
		release()
		await holder
		await runDepositClaim("0xheld")
		expect(send.claimSend).toHaveBeenCalledTimes(1)
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xheld")?.completedAt).toBe(999)
	})

	it("a held journal lock delays the guarded completion, and the guard re-reads after the release", async () => {
		const locks = memoryJournalLocks()
		const send = sendDeps()
		connectJournalDeps({ ...baseDeps(kv), ...send, locks, messageNullified: vi.fn(async () => "nullified" as const) })
		addRecord(mkSend("0xdelayed"))
		let release: () => void = () => {}
		const holder = locks.journal(() => new Promise<void>((r) => (release = r)))
		const run = runDepositClaim("0xdelayed")
		await new Promise((r) => setTimeout(r, 0))
		expect((useBridgeJournal().records.value.find((r) => r.id === "0xdelayed") as SendDepositRecord).claimedByOther).toBeUndefined()
		// Another tab moved the record while the write waited: the re-read guard must refuse it.
		upsertRecord(kv, { ...mkSend("0xdelayed"), amount: "2" })
		release()
		await holder
		await run
		const rec = useBridgeJournal().records.value.find((r) => r.id === "0xdelayed") as SendDepositRecord
		expect(rec.amount).toBe("2")
		expect(rec.claimedByOther).toBeUndefined()
		expect(rec.completedAt).toBeUndefined()
	})

	it("without a lock API the record lock is the process-local dedup and the guarded write is synchronous best effort", async () => {
		const send = sendDeps()
		connectJournalDeps({ ...baseDeps(kv), ...send, messageNullified: vi.fn(async () => "nullified" as const) })
		addRecord(mkSend("0xnolocks"))
		const first = runDepositClaim("0xnolocks")
		const second = runDepositClaim("0xnolocks")
		await Promise.all([first, second])
		expect(useBridgeJournal().records.value.find((r) => r.id === "0xnolocks")?.completedAt).toBe(999)
	})
})

describe("useBridgeJournal - a hash-less deposit reconciled from Ethereum", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	const recordOf = (id: string) => useBridgeJournal().records.value.find((r) => r.id === id) as SendDepositRecord | undefined
	const hashless = (id: string, over: Record<string, unknown> = {}) =>
		mkSend(id, { leafIndex: undefined, depositTxHash: undefined, ...over })
	const FOUND = "0x00160000000000000000000000000000000000000000000000000000646570" as const

	function reconcileDeps(kvv: KV, result: DepositSearch | (() => Promise<DepositSearch>)) {
		const findDepositTx = vi.fn(typeof result === "function" ? result : async () => result)
		// The leg recovery, reduced to its effect: the leaf lands on the record it was called with.
		const recoverDepositLeg = vi.fn(async (rec: DepositJournalRecord) => {
			updateRecord(rec.id, { leafIndex: "7" })
			return "recovered" as const
		})
		return { ...baseDeps(kvv), ...sendDeps(), findDepositTx, recoverDepositLeg }
	}

	it("found ⇒ the hash is written once, the leg recovered from it, and the claim proceeds", async () => {
		const deps = reconcileDeps(kv, { txHash: FOUND })
		connectJournalDeps(deps)
		addRecord(hashless("0xfound"))
		await runDepositClaim("0xfound")
		expect(deps.findDepositTx).toHaveBeenCalledTimes(1)
		expect(deps.recoverDepositLeg).toHaveBeenCalledWith(expect.objectContaining({ id: "0xfound", depositTxHash: FOUND }))
		const rec = recordOf("0xfound") as SendDepositRecord
		expect(rec.depositTxHash).toBe(FOUND)
		expect(rec.leafIndex).toBe("7")
		expect(rec.completedAt).toBe(999)
	})

	it.each([
		["none", "error", /No deposit for this record was found/],
		["ambiguous", "unknown-outcome", /More than one matching deposit/],
		["incomplete", "error", /could not be searched far enough/],
	] as const)("%s ⇒ its note, no hash, no claim", async (outcome, attention, note) => {
		const deps = reconcileDeps(kv, outcome)
		connectJournalDeps(deps)
		addRecord(hashless(`0x${outcome}`))
		await runDepositClaim(`0x${outcome}`)
		const rt = useBridgeJournal().runtime.value[`0x${outcome}`]
		expect(rt?.attention).toBe(attention)
		expect(rt?.note).toMatch(note)
		expect(recordOf(`0x${outcome}`)?.depositTxHash).toBeUndefined()
		expect(deps.claimSend).not.toHaveBeenCalled()
	})

	it("a search that throws reads as incomplete", async () => {
		const deps = reconcileDeps(kv, async () => {
			throw new Error("rpc down")
		})
		connectJournalDeps(deps)
		addRecord(hashless("0xthrew"))
		await runDepositClaim("0xthrew")
		expect(useBridgeJournal().runtime.value["0xthrew"]?.note).toMatch(/could not be searched/)
	})

	it("a record discarded while the search ran is never written", async () => {
		const deps = reconcileDeps(kv, async () => {
			discard("0xgone")
			return { txHash: FOUND }
		})
		connectJournalDeps(deps)
		addRecord(hashless("0xgone"))
		await runDepositClaim("0xgone")
		expect(recordOf("0xgone")).toBeUndefined()
		expect(loadJournal(kv).some((r) => r.id === "0xgone")).toBe(false)
		expect(deps.recoverDepositLeg).not.toHaveBeenCalled()
	})

	it("a hash another tab wrote meanwhile is kept, never overwritten: the same hash proceeds, a different one stops", async () => {
		const OTHER = "0x00170000000000000000000000000000000000000000000000000000006f7468" as const
		const foreign = reconcileDeps(kv, async () => {
			upsertRecord(kv, { ...hashless("0xraced"), depositTxHash: OTHER })
			return { txHash: FOUND }
		})
		connectJournalDeps(foreign)
		addRecord(hashless("0xraced"))
		await runDepositClaim("0xraced")
		expect(recordOf("0xraced")?.depositTxHash).toBe(OTHER)
		expect(foreign.recoverDepositLeg).not.toHaveBeenCalled() // whose receipt that is, this run never verified

		const same = reconcileDeps(kv, async () => {
			upsertRecord(kv, { ...hashless("0xsame"), depositTxHash: FOUND })
			return { txHash: FOUND }
		})
		connectJournalDeps(same)
		addRecord(hashless("0xsame"))
		await runDepositClaim("0xsame")
		expect(same.recoverDepositLeg).toHaveBeenCalledWith(expect.objectContaining({ depositTxHash: FOUND }))
		expect(recordOf("0xsame")?.completedAt).toBe(999)
	})

	it("a record discarded and restored with a hash while the journal lock waits never continues", async () => {
		const locks = memoryJournalLocks()
		const deps = { ...reconcileDeps(kv, { txHash: FOUND }), locks }
		connectJournalDeps(deps)
		addRecord(hashless("0xrestored"))
		let release: () => void = () => {}
		const holder = locks.journal(() => new Promise<void>((r) => (release = r)))
		const run = runDepositClaim("0xrestored")
		await new Promise((r) => setTimeout(r, 0))
		discard("0xrestored")
		addRecord({ ...hashless("0xrestored"), depositTxHash: FOUND })
		release()
		await holder
		await run
		expect(deps.recoverDepositLeg).not.toHaveBeenCalled()
		expect(recordOf("0xrestored")?.completedAt).toBeUndefined()
	})

	it("a fuel recipient replaced while the search ran is not written", async () => {
		const fuel = { amount: "10", secret: "0xfuelsecret", secretHashHex: "0xfh", minOutput: "9", fpc: `0x${"a".repeat(64)}` }
		const deps = reconcileDeps(kv, async () => {
			upsertRecord(kv, {
				...hashless("0xfpc", { intent: "token+gas", isPrivate: true, fuel }),
				fuel: { ...fuel, fpc: `0x${"b".repeat(64)}` },
			})
			return { txHash: FOUND }
		})
		connectJournalDeps(deps)
		addRecord(hashless("0xfpc", { intent: "token+gas", isPrivate: true, secret: undefined, sealedEnvelope: "blob", fuel }))
		await runDepositClaim("0xfpc")
		expect(recordOf("0xfpc")?.depositTxHash).toBeUndefined()
		expect(deps.recoverDepositLeg).not.toHaveBeenCalled()
	})

	it("a record whose identity changed meanwhile is not written", async () => {
		const deps = reconcileDeps(kv, async () => {
			upsertRecord(kv, { ...hashless("0xmoved"), amount: "1" })
			return { txHash: FOUND }
		})
		connectJournalDeps(deps)
		addRecord(hashless("0xmoved"))
		await runDepositClaim("0xmoved")
		expect(recordOf("0xmoved")?.depositTxHash).toBeUndefined()
		expect(deps.recoverDepositLeg).not.toHaveBeenCalled()
	})

	it("a gas-only send and a pre-generation record keep today's bail: the search is never asked", async () => {
		const deps = reconcileDeps(kv, { txHash: FOUND })
		connectJournalDeps(deps)
		addRecord(
			mkGasOnly("0xgasless", {
				leafIndex: undefined,
				fuel: { amount: "10", secret: "0xfuelsecret", secretHashHex: "0xgasless", minOutput: "9" },
			}),
		)
		addRecord(mkDeposit("0xtokenless", { leafIndex: undefined }))
		await runDepositClaim("0xgasless")
		await runDepositClaim("0xtokenless")
		expect(deps.findDepositTx).not.toHaveBeenCalled()
		expect(recordOf("0xgasless")?.depositTxHash).toBeUndefined()
	})
})

describe("useBridgeJournal - a hash-less exit attached by its recomputed message", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	const H = "0x00180000000000000000000000000000000000000000000000000000657869"
	const recordOf = (id: string) => useBridgeJournal().records.value.find((r) => r.id === id) as SendWithdrawRecord | undefined
	const pending = (id = "wd-pending-1", over: Record<string, unknown> = {}) => mkSendExit(id, { exitTxHash: undefined, ...over })
	const found: ExitSearch = { exitTxHash: H, exitBlock: 42, messageHash: "0xmsg" }

	function attachDeps(kvv: KV, result: ExitSearch | (() => Promise<ExitSearch>), over: Record<string, unknown> = {}) {
		const findExitTx = vi.fn(typeof result === "function" ? result : async () => result)
		return { ...baseDeps(kvv), ...sendDeps(), locks: memoryJournalLocks(), findExitTx, ...over }
	}

	it("attached ⇒ re-keyed onto the hash, consumed under it, done; the old id holds no runtime", async () => {
		const deps = attachDeps(kv, found)
		connectJournalDeps(deps)
		addRecord(pending())
		await runWithdrawConsume("wd-pending-1")
		expect(deps.findExitTx).toHaveBeenCalledWith(expect.objectContaining({ id: "wd-pending-1" }), expect.any(Set))
		expect(recordOf("wd-pending-1")).toBeUndefined()
		const rec = recordOf(H) as SendWithdrawRecord
		expect(rec.exitTxHash).toBe(H)
		expect(rec.exitBlock).toBe(42)
		expect(rec.consumeTxHash).toBe("0xhubconsume")
		expect(rec.completedAt).toBe(999)
		expect(deps.consumeSend).toHaveBeenCalledTimes(1)
		expect(useBridgeJournal().runtime.value["wd-pending-1"]).toBeUndefined()
		expect(useBridgeJournal().runtime.value[H]?.busy).toBeFalsy()
	})

	it("a throw after the re-key is reported against the new id; the old id's runtime is gone", async () => {
		const deps = attachDeps(kv, found, {
			consumeSend: vi.fn(async () => {
				throw new Error("portal reverted")
			}),
		})
		connectJournalDeps(deps)
		addRecord(pending())
		await runWithdrawConsume("wd-pending-1")
		expect(recordOf(H)?.exitTxHash).toBe(H)
		expect(recordOf(H)?.completedAt).toBeUndefined()
		expect(useBridgeJournal().runtime.value[H]?.attention).toBe("error")
		expect(useBridgeJournal().runtime.value["wd-pending-1"]).toBeUndefined()
	})

	it("a second FINISH during the consume is refused by the hash's lock", async () => {
		let release: () => void = () => {}
		const deps = attachDeps(kv, found, {
			consumeSend: vi.fn(() => new Promise<{ consumeTxHash: string }>((r) => (release = () => r({ consumeTxHash: "0xhubconsume" })))),
		})
		connectJournalDeps(deps)
		addRecord(pending())
		const first = runWithdrawConsume("wd-pending-1")
		await new Promise((r) => setTimeout(r, 0))
		await runWithdrawConsume(H)
		expect(deps.consumeSend).toHaveBeenCalledTimes(1)
		release()
		await first
		expect(recordOf(H)?.completedAt).toBe(999)
	})

	it("FINISH on an already attached hash that another tab is running reports the contention", async () => {
		const locks = memoryJournalLocks()
		const deps = attachDeps(kv, "none", { locks })
		connectJournalDeps(deps)
		addRecord(mkSendExit(H, { exitBlock: 42 }))
		let releaseExit: () => void = () => {}
		const exitHolder = locks.record(H, () => new Promise<void>((r) => (releaseExit = r)))
		await runWithdrawConsume(H)
		expect(useBridgeJournal().runtime.value[H]?.note).toMatch(/another tab is finishing/i)
		expect(deps.consumeSend).not.toHaveBeenCalled()
		// The same for a deposit another tab is claiming.
		addRecord(mkSend("0xheldclaim"))
		let releaseClaim: () => void = () => {}
		const claimHolder = locks.record("0xheldclaim", () => new Promise<void>((r) => (releaseClaim = r)))
		await runDepositClaim("0xheldclaim")
		expect(useBridgeJournal().runtime.value["0xheldclaim"]?.note).toMatch(/another tab is claiming/i)
		releaseExit()
		releaseClaim()
		await exitHolder
		await claimHolder
	})

	it("the live handoff keeps the provisional record while another runner holds the hash", async () => {
		const locks = memoryJournalLocks()
		connectJournalDeps(attachDeps(kv, "none", { locks }))
		addRecord(pending())
		let release: () => void = () => {}
		const holder = locks.record(H, () => new Promise<void>((r) => (release = r)))
		const outcome = await attachAndConsume("wd-pending-1", { ...pending(), id: H, exitTxHash: H, exitBlock: 7 }, () => true)
		expect(outcome).toBe("held-elsewhere")
		expect(recordOf("wd-pending-1")).toBeDefined()
		expect(recordOf(H)).toBeUndefined()
		release()
		await holder
	})

	it("a live exit vs an attach of the same hash: the attach finds the lock held and says so", async () => {
		const locks = memoryJournalLocks()
		const deps = attachDeps(kv, found, { locks })
		connectJournalDeps(deps)
		addRecord(pending())
		let release: () => void = () => {}
		const holder = locks.record(H, () => new Promise<void>((r) => (release = r)))
		await runWithdrawConsume("wd-pending-1")
		expect(recordOf("wd-pending-1")).toBeDefined()
		expect(recordOf(H)).toBeUndefined()
		expect(useBridgeJournal().runtime.value["wd-pending-1"]?.note).toMatch(/another tab/i)
		expect(deps.consumeSend).not.toHaveBeenCalled()
		release()
		await holder
	})

	it("attached but already finished on L1 ⇒ done as consumed by another", async () => {
		const deps = attachDeps(kv, found, { consumeSend: vi.fn(async () => ({ consumedByOther: true as const })) })
		connectJournalDeps(deps)
		addRecord(pending())
		await runWithdrawConsume("wd-pending-1")
		expect(recordOf(H)?.consumedByOther).toBe(true)
		expect(recordOf(H)?.completedAt).toBe(999)
	})

	it.each([
		["none", "error", /No exit for this record was found/],
		["ambiguous", "unknown-outcome", /More than one matching exit/],
		["incomplete", "error", /could not be searched far enough/],
	] as const)("%s ⇒ its note, no re-key, no consume", async (outcome, attention, note) => {
		const deps = attachDeps(kv, outcome)
		connectJournalDeps(deps)
		addRecord(pending())
		await runWithdrawConsume("wd-pending-1")
		const rt = useBridgeJournal().runtime.value["wd-pending-1"]
		expect(rt?.attention).toBe(attention)
		expect(rt?.note).toMatch(note)
		expect(recordOf("wd-pending-1")?.exitTxHash).toBeUndefined()
		expect(deps.consumeSend).not.toHaveBeenCalled()
	})

	it("a search that throws reads as incomplete", async () => {
		const deps = attachDeps(kv, async () => {
			throw new Error("node down")
		})
		connectJournalDeps(deps)
		addRecord(pending())
		await runWithdrawConsume("wd-pending-1")
		expect(useBridgeJournal().runtime.value["wd-pending-1"]?.note).toMatch(/could not be searched/)
	})

	it("a record discarded, or whose identity changed, while the search ran is never re-keyed", async () => {
		const gone = attachDeps(kv, async () => {
			discard("wd-pending-1")
			return found
		})
		connectJournalDeps(gone)
		addRecord(pending())
		await runWithdrawConsume("wd-pending-1")
		expect(recordOf(H)).toBeUndefined()
		expect(gone.consumeSend).not.toHaveBeenCalled()

		const moved = attachDeps(kv, async () => {
			upsertRecord(kv, { ...pending("wd-pending-2"), amount: "1" })
			return found
		})
		connectJournalDeps(moved)
		addRecord(pending("wd-pending-2"))
		await runWithdrawConsume("wd-pending-2")
		expect(recordOf("wd-pending-2")?.amount).toBe("1")
		expect(recordOf("wd-pending-2")?.exitTxHash).toBeUndefined()
		expect(recordOf(H)).toBeUndefined()
		expect(moved.consumeSend).not.toHaveBeenCalled()
	})

	it("a hash that is already a record (the other tab re-keyed first) is refused: no second runner", async () => {
		const deps = attachDeps(kv, async () => {
			// The other tab, loaded before either wrote, attached its copy onto H already.
			upsertRecord(kv, mkSendExit(H, { exitBlock: 42 }))
			return found
		})
		connectJournalDeps(deps)
		addRecord(pending())
		await runWithdrawConsume("wd-pending-1")
		expect(recordOf("wd-pending-1")).toBeDefined()
		expect(recordOf(H)?.consumeTxHash).toBeUndefined()
		expect(deps.consumeSend).not.toHaveBeenCalled()
	})

	it("without a lock API the attach fails closed with its note, while a plain consume still runs", async () => {
		const deps = { ...baseDeps(kv), ...sendDeps(), findExitTx: vi.fn(async () => found) }
		connectJournalDeps(deps)
		addRecord(pending())
		addRecord(mkSendExit("0xplain"))
		await runWithdrawConsume("wd-pending-1")
		expect(deps.findExitTx).not.toHaveBeenCalled()
		expect(useBridgeJournal().runtime.value["wd-pending-1"]?.note).toMatch(/another tab may be finishing/i)
		await runWithdrawConsume("0xplain")
		expect(recordOf("0xplain")?.completedAt).toBe(999)
	})

	it("an unwired finder keeps today's note", async () => {
		connectJournalDeps({ ...baseDeps(kv), ...sendDeps(), locks: memoryJournalLocks() })
		addRecord(pending())
		await runWithdrawConsume("wd-pending-1")
		expect(useBridgeJournal().runtime.value["wd-pending-1"]?.note).toMatch(/never recorded/)
		expect(recordOf("wd-pending-1")?.exitTxHash).toBeUndefined()
	})

	it("the live exit's handoff: re-keys the provisional record and consumes it under the hash's lock", async () => {
		const deps = attachDeps(kv, "none")
		connectJournalDeps(deps)
		addRecord(pending())
		const outcome = await attachAndConsume(
			"wd-pending-1",
			{ ...pending(), id: H, exitTxHash: H, exitBlock: 7 },
			(_l, all) => !all.some((r) => r.id === H),
		)
		expect(outcome).toBe("attached")
		expect(recordOf(H)?.completedAt).toBe(999)
		// A second handoff onto an id that is now a record is refused.
		addRecord(pending("wd-pending-2"))
		expect(
			await attachAndConsume(
				"wd-pending-2",
				{ ...pending(), id: H, exitTxHash: H, exitBlock: 7 },
				(_l, all) => !all.some((r) => r.id === H),
			),
		).toBe("moved")
	})
})

describe("useBridgeJournal - the session log", () => {
	let kv: KV
	const HASH_A = `0x${"a1".repeat(32)}`
	const HASH_B = `0x${"b2".repeat(32)}`
	const HASH_EXIT = `0x${"e3".repeat(32)}`
	const HASH_C = `0x${"c4".repeat(32)}`
	const texts = (id: string) => (useBridgeJournal().runtime.value[id]?.log ?? []).map((row) => row.text)
	const storageEvent = () => window.dispatchEvent(new StorageEvent("storage", { key: JOURNAL_KEY }))
	const fromOtherTab = (rec: SendDepositRecord | SendWithdrawRecord) => {
		upsertRecord(kv, rec)
		storageEvent()
	}

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
		connectJournalDeps({ ...baseDeps(kv), ...sendDeps() })
		useBridgeJournal()
	})

	it("phrases a step once per stretch: a repeat, a runner's cleared step or a poll's alternation adds nothing until a hash row", () => {
		addRecord(mkSend("0xsteps"))
		setRecordStep("0xsteps", "approving", "confirm the allowance")
		setRecordStep("0xsteps", "approving", "still waiting for the approval (round 2)")
		setRecordStep("0xsteps", undefined, undefined)
		setRecordStep("0xsteps", "approving", "first time only: approve Permit2 in your Ethereum wallet")
		for (const step of ["confirming", "verifying", "confirming", "verifying"] as const) setRecordStep("0xsteps", step)
		updateRecord("0xsteps", { claimTxHash: HASH_B })
		setRecordStep("0xsteps", "confirming")
		expect(texts("0xsteps")).toEqual([
			"approving USDC for Permit2",
			"waiting for the confirmation",
			"checking the record against the chain",
			"Claim hash observed · 0xb2b2b2…b2b2",
			"waiting for the confirmation",
		])
		expect(useBridgeJournal().runtime.value["0xsteps"]?.log?.[0]?.at).toBe(999)
		// A gas-only send approves the ERC-20 it pays with, which its record does not name.
		addRecord(mkGasOnly("0xgasonly"))
		setRecordStep("0xgasonly", "approving")
		expect(texts("0xgasonly")).toEqual(["approving this token for Permit2"])
	})

	it("logs a hash once, as observed, only when it appears after the log began, from this tab or another", () => {
		addRecord(mkSend("0xhashes", { depositTxHash: HASH_A }))
		setRecordStep("0xhashes", "syncing", "2 checkpoints until your funds arrive")
		updateRecord("0xhashes", { claimTxHash: HASH_B })
		updateRecord("0xhashes", { updatedAt: 5 })
		fromOtherTab(mkSend("0xhashes", { depositTxHash: HASH_A, claimTxHash: HASH_B, approveTxHash: HASH_EXIT }))
		updateRecord("0xhashes", { claimTxHash: HASH_C })
		expect(texts("0xhashes")).toEqual([
			"waiting for Aztec to include it",
			"Claim hash observed · 0xb2b2b2…b2b2",
			"Approval hash observed · 0xe3e3e3…e3e3",
			"Claim hash observed · 0xc4c4c4…c4c4",
		])
		expect(texts("0xhashes").join(" ")).not.toMatch(/sent|confirmed/i)
	})

	it("logs nothing for a malformed hash or a pending placeholder", () => {
		addRecord(mkSendExit("wd-pending-q", { exitTxHash: undefined }))
		setRecordStep("wd-pending-q", "exiting", "confirm the exit in your Aztec wallet")
		updateRecord("wd-pending-q", { exitTxHash: "wd-pending-q", consumeTxHash: "0xabc" })
		expect(texts("wd-pending-q")).toEqual(["starting the exit on Aztec"])
	})

	it("carries a re-keyed record's log once, even when a reload lands between the write and the hand-over", () => {
		addRecord(mkSendExit("wd-pending-r", { exitTxHash: undefined }))
		setRecordStep("wd-pending-r", "exiting", "confirm the exit in your Aztec wallet")
		const next = mkSendExit(HASH_EXIT)
		rekeyRecord(kv, "wd-pending-r", next)
		storageEvent()
		rekeyJournalRecord("wd-pending-r", next)
		updateRecord(HASH_EXIT, { updatedAt: 5 })
		expect(texts(HASH_EXIT)).toEqual(["starting the exit on Aztec", "Exit hash observed · 0xe3e3e3…e3e3"])
		expect(useBridgeJournal().runtime.value["wd-pending-r"]).toBeUndefined()
	})

	it("starts empty: neither the boot load nor a restored record logs anything", () => {
		__resetJournalForTests()
		kv = memKV()
		upsertRecord(kv, mkSend("0xbooted", { depositTxHash: HASH_A }))
		connectJournalDeps({ ...baseDeps(kv), ...sendDeps() })
		useBridgeJournal()
		addRecord(mkSend("0xrestored", { depositTxHash: HASH_A, claimTxHash: HASH_B }))
		updateRecord("0xrestored", { approveTxHash: HASH_EXIT })
		const rt = useBridgeJournal().runtime.value
		expect([rt["0xbooted"]?.log, rt["0xrestored"]?.log]).toEqual([undefined, undefined])
	})

	it("keeps the latest 50 rows", () => {
		addRecord(mkSend("0xcap"))
		setRecordStep("0xcap", "confirming")
		for (let i = 0; i < 60; i++) updateRecord("0xcap", { claimTxHash: `0x${String(i).padStart(64, "0")}` })
		const rows = texts("0xcap")
		expect(rows).toHaveLength(50)
		expect([rows[0], rows[49]]).toEqual(["Claim hash observed · 0x000000…0010", "Claim hash observed · 0x000000…0059"])
	})

	it("never logs a note, a step detail, an error or a secret, and a raised attention lets the retry narrate afresh", async () => {
		const claim = vi.fn(async () => ({
			simulate: async () => {
				throw new Error("boom sentinel-error")
			},
			send: async () => ({ txHash: "0x" }),
		}))
		connectJournalDeps({ claim })
		addRecord(mkDeposit("0xsentinel", { secret: "0xsentinelsecret" }))
		setRecordStep("0xsentinel", "sending", "sentinel-detail")
		await runDepositClaim("0xsentinel")
		expect(useBridgeJournal().runtime.value["0xsentinel"]?.note).toMatch(/sentinel-error/)
		expect(texts("0xsentinel").length).toBeGreaterThan(0)
		expect(JSON.stringify(texts("0xsentinel"))).not.toMatch(/sentinel/i)
		setRecordStep("0xsentinel", "sending", "retrying")
		expect(texts("0xsentinel").filter((t) => t === "claiming on Aztec")).toHaveLength(2)
	})
})
