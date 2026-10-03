/**
 * Ordering + narration pins for the journal claim engine, driven over the same injected-deps style
 * as useBridgeJournal.test.ts (scaffolding duplicated — no vi.mock sharing across files).
 */
import {
	type DepositJournalRecord,
	type JournalTokenBlock,
	type KV,
	patchRecord as kvPatchRecord,
	type SendDepositRecord,
	type SendWithdrawRecord,
	feeJuiceAddress,
	predictPortal,
	recoveryKeyFromSignature,
	sealDepositEnvelope,
} from "@unleashed/bridge-core"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/contracts/bridge-generation", () => ({ FUEL_PORTAL: "0xfd05ee8687d4ca828ba3d26ef04b80dd1348e5bd" }))

import {
	__resetJournalForTests,
	addRecord,
	cacheSecret,
	connectJournalDeps,
	discard,
	markSessionLive,
	resumeSessionWork,
	runDepositClaim,
	runWithdrawConsume,
	updateRecord,
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
	registerIndex: "3",
}

// The deposit fixtures are direct Fee Juice bridges: the one pre-generation shape whose binding
// still resolves, so the engine's shape-agnostic machinery runs on a genuinely runnable record.
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
		ensureTokenGrant: vi.fn(async () => "granted" as const),
		verifyConsumeIdentitySend: vi.fn(async () => true),
		consumeSend: vi.fn(async () => ({ consumeTxHash: "0x0015000000000000000000000000000000000000000000636f6e73756d657478" })),
	}
}

async function _sealEnvelopeFor(rec: DepositJournalRecord, over: Partial<{ recipient: string; amount: string; sealerL1: string }> = {}) {
	const key = await recoveryKeyFromSignature(SIG)
	return sealDepositEnvelope(key, {
		secret: "0xprivatesecret",
		recipient: over.recipient ?? rec.recipient,
		amount: over.amount ?? rec.amount,
		sealerL1: over.sealerL1 ?? SEALER,
		leafIndex: rec.leafIndex,
	})
}

import { SYNC_TARGET_MARGIN_BLOCKS } from "@/lib/bridge-steps"
import { RECEIPT_RECORD_MISMATCH_MSG } from "@/lib/fuel-claim-state"

describe("journal engine — stage pins", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	const notReady = () => new Error("No L1 to L2 message found for message hash 0xdead")

	it("(a) shared budget off-by-one: N countdown ticks leave exactly 300−N simulate polls", async () => {
		const deps = baseDeps(kv)
		const target = 100 + SYNC_TARGET_MARGIN_BLOCKS
		// 5 below-target reads, then arrived.
		const seq = [target - 5, target - 4, target - 3, target - 2, target - 1]
		let call = 0
		const l2BlockNumber = vi.fn(async () => (call < seq.length ? seq[call++] : target))
		let simulateCalls = 0
		const claim = vi.fn(async () => ({
			simulate: async () => {
				simulateCalls++
				throw notReady()
			},
			send: async () => ({ txHash: "0xnever" }),
		}))
		connectJournalDeps({ ...deps, claim, l2BlockNumber })
		addRecord(mkDeposit("0xbudget", { depositL2Block: 100 }))
		await runDepositClaim("0xbudget")
		// 5 countdown iterations consumed → 295 simulate polls remain, then the never-consumable error.
		expect(simulateCalls).toBe(295)
		const { runtime } = useBridgeJournal()
		expect(runtime.value["0xbudget"]?.note).toMatch(/never became consumable/)
	})

	it("(a) all 300 consumed by the countdown ⇒ ZERO simulate attempts", async () => {
		const deps = baseDeps(kv)
		const l2BlockNumber = vi.fn(async () => 1) // forever below target
		let simulateCalls = 0
		const claim = vi.fn(async () => ({
			simulate: async () => {
				simulateCalls++
				throw notReady()
			},
			send: async () => ({ txHash: "0xnever" }),
		}))
		connectJournalDeps({ ...deps, claim, l2BlockNumber })
		addRecord(mkDeposit("0xexhaust", { depositL2Block: 100 }))
		await runDepositClaim("0xexhaust")
		expect(l2BlockNumber).toHaveBeenCalledTimes(300)
		expect(simulateCalls).toBe(0)
	})

	it("(b) full order: claim-build → countdown → token+fuel checkpoint gate → simulate → send; checkpoint waiting sets the arrived narration", async () => {
		const deps = baseDeps(kv)
		const order: string[] = []
		const { runtime } = useBridgeJournal()
		const target = 100 + SYNC_TARGET_MARGIN_BLOCKS
		const l2BlockNumber = vi.fn(async () => {
			order.push("countdown")
			return target
		})
		let readinessCall = 0
		const messageReadiness = vi.fn(async (h: string) => {
			order.push(`gate:${h}`)
			readinessCall++
			// First sweep: token message not yet anchored past the checkpoint → waits once.
			return readinessCall === 1 ? { checkpoint: 5, anchor: 4 } : { checkpoint: 5, anchor: 5 }
		})
		let narrationAtSimulate = ""
		const claim = vi.fn(async () => {
			order.push("build")
			return {
				simulate: async () => {
					order.push("simulate")
					narrationAtSimulate = runtime.value["0xorder"]?.stepDetail ?? ""
				},
				send: async () => {
					order.push("send")
					return { txHash: "0xsent" }
				},
			}
		})
		connectJournalDeps({ ...deps, claim, l2BlockNumber, messageReadiness })
		addRecord(
			mkDeposit("0xorder", {
				schema: 2,
				depositL2Block: 100,
				messageHash: "0xTOK",
				fuel: { amount: "1", secret: "0xf", secretHashHex: "0xfh", minOutput: "1", messageHash: "0xFUEL" },
			}),
		)
		await runDepositClaim("0xorder")
		expect(order[0]).toBe("build")
		expect(order[1]).toBe("countdown")
		expect(order.slice(2, 4)).toEqual(["gate:0xTOK", "gate:0xTOK"]) // blocked once, re-swept
		expect(order[4]).toBe("gate:0xFUEL")
		expect(order.indexOf("simulate")).toBeGreaterThan(order.lastIndexOf("gate:0xFUEL"))
		expect(order.indexOf("send")).toBeGreaterThan(order.indexOf("simulate"))
		// Checkpoint waiting set counted=true → the simulate phase narrates "message arrived".
		expect(narrationAtSimulate).toMatch(/message arrived — waiting for your wallet to sync it/)
	})

	it("(b) the checkpoint gate counts down from its first reading, never back up, afresh each attempt, and none once it passes", async () => {
		const deps = baseDeps(kv)
		const { runtime } = useBridgeJournal()
		// A lagging node's wider readings hold the count; the pass reads as nothing left.
		const anchors = [3, 1, 2, 4, 5]
		const seen: Array<[number | undefined, number | undefined]> = []
		const messageReadiness = vi.fn(async () => {
			const rt = runtime.value["0xcount"]
			seen.push([rt?.checkpointsLeft, rt?.checkpointSpan])
			return { checkpoint: 5, anchor: anchors[seen.length - 1] ?? 5 }
		})
		connectJournalDeps({ ...deps, claim: smartClaimFake(), messageReadiness })
		addRecord(mkDeposit("0xcount", { messageHash: "0xTOK" }))
		// A previous attempt's count shows until this attempt's first reading replaces it.
		runtime.value = { ...runtime.value, "0xcount": { checkpointsLeft: 0, checkpointSpan: 5 } }
		await runDepositClaim("0xcount")
		expect(seen).toEqual([
			[0, 5],
			[2, 2],
			[2, 2],
			[2, 2],
			[1, 2],
		])
		const rt = runtime.value["0xcount"]
		expect([rt?.checkpointsLeft, rt?.checkpointSpan]).toEqual([0, 2])
	})

	it("(b) a record with no messageHash skips the checkpoint gate entirely", async () => {
		const deps = baseDeps(kv)
		const messageReadiness = vi.fn(async () => ({ checkpoint: 1, anchor: 1 }))
		const claim = smartClaimFake()
		connectJournalDeps({ ...deps, claim, messageReadiness })
		addRecord(mkDeposit("0xnohash"))
		await runDepositClaim("0xnohash")
		expect(messageReadiness).not.toHaveBeenCalled()
	})

	it("(c) preGated retry: countdown AND checkpoint deps untouched; claimable latches after simulate, before a rejected send", async () => {
		const deps = baseDeps(kv)
		const { runtime } = useBridgeJournal()
		let sendRejects = true
		let claimableInsideSend: boolean | undefined
		const claim = vi.fn(async () => ({
			simulate: async () => {},
			send: async () => {
				claimableInsideSend = runtime.value["0xpregate"]?.claimable
				if (sendRejects) throw new Error("wallet closed")
				return { txHash: "0xsent2" }
			},
		}))
		const l2BlockNumber = vi.fn(async () => 100 + SYNC_TARGET_MARGIN_BLOCKS)
		const messageReadiness = vi.fn(async () => ({ checkpoint: 1, anchor: 1 }))
		connectJournalDeps({ ...deps, claim, l2BlockNumber, messageReadiness })
		addRecord(mkDeposit("0xpregate", { depositL2Block: 100, messageHash: "0xTOK" }))
		await runDepositClaim("0xpregate")
		// claimable latched by the successful simulate BEFORE the send rejected — the send
		// itself observed it already true.
		expect(claimableInsideSend).toBe(true)
		expect(runtime.value["0xpregate"]?.claimable).toBe(true)
		const countdownCalls = l2BlockNumber.mock.calls.length
		const gateCalls = messageReadiness.mock.calls.length
		sendRejects = false
		await runDepositClaim("0xpregate")
		// The preGated retry consults NEITHER gate dep.
		expect(l2BlockNumber.mock.calls.length).toBe(countdownCalls)
		expect(messageReadiness.mock.calls.length).toBe(gateCalls)
		const { records } = useBridgeJournal()
		expect(records.value.find((r) => r.id === "0xpregate")?.completedAt).toBe(999)
	})

	it("(a) the checkpoint gate does NOT consume the simulate budget", async () => {
		const deps = baseDeps(kv)
		let readiness = 0
		const messageReadiness = vi.fn(async () => {
			readiness++
			// Three blocked sweeps, then ready.
			return readiness <= 3 ? { checkpoint: 9, anchor: 5 } : { checkpoint: 9, anchor: 9 }
		})
		let simulateCalls = 0
		const claim = vi.fn(async () => ({
			simulate: async () => {
				simulateCalls++
				// Succeed on the 300th poll — only reachable if the checkpoint waits did NOT
				// consume from the simulate budget.
				if (simulateCalls < 300) throw new Error("No L1 to L2 message found for message hash 0xdead")
			},
			send: async () => ({ txHash: "0xindep" }),
		}))
		connectJournalDeps({ ...deps, claim, messageReadiness })
		addRecord(mkDeposit("0xindep", { messageHash: "0xTOK" }))
		await runDepositClaim("0xindep")
		expect(simulateCalls).toBe(300)
		const { records } = useBridgeJournal()
		expect(records.value.find((r) => r.id === "0xindep")?.completedAt).toBe(999)
	})

	it("(d) claim-material conservation: the claim receives the recovery-patched record + exact private material", async () => {
		const deps = baseDeps(kv)
		const seen: Array<{
			leafIndex?: string
			messageHash?: string
			fuelLeaf?: string
			fuelKey?: string
			fuelReceived?: string
			secretHex: string
			envelopeSecret?: string
			envelopeSalt?: string
		}> = []
		const claim = vi.fn(async (rec: DepositJournalRecord, secretHex: string, envelope?: { secret?: string; salt?: string }) => {
			seen.push({
				leafIndex: rec.leafIndex,
				messageHash: rec.messageHash,
				fuelLeaf: rec.fuel?.leafIndex,
				fuelKey: rec.fuel?.messageHash,
				fuelReceived: rec.fuel?.received,
				secretHex,
				envelopeSecret: envelope?.secret,
				envelopeSalt: envelope?.salt,
			})
			return { simulate: async () => {}, send: async () => ({ txHash: "0xdone" }) }
		})
		const recoverDepositLeg = vi.fn(async (rec: DepositJournalRecord) => {
			updateRecord(rec.id, {
				leafIndex: "77",
				messageHash: "0xTOKKEY",
				fuel: { ...(rec.fuel ?? {}), leafIndex: "78", messageHash: "0xFUELKEY", received: "4444" } as never,
			})
			return "recovered" as const
		})
		const base = mkDeposit("0xmaterial", {
			isPrivate: true,
			secret: undefined,
			schema: 2,
			leafIndex: undefined,
			depositTxHash: "0xdep",
			fuel: { amount: "1", secret: "0xf", secretHashHex: "0xfh", minOutput: "1", bridgeSecretSalt: "0xsalt" } as never,
		})
		connectJournalDeps({ ...deps, claim, recoverDepositLeg })
		addRecord(base)
		// Same-session cached secret (the in-session path): the claim must receive EXACTLY this
		// material alongside the recovery-patched record.
		cacheSecret("0xmaterial", "0xprivatesecret", {
			v: 2,
			secret: "0xprivatesecret",
			salt: "0xenvelopesalt",
			recipient: base.recipient,
			amount: base.amount,
			sealerL1: SEALER,
		} as never)
		await runDepositClaim("0xmaterial")
		expect(recoverDepositLeg).toHaveBeenCalledTimes(1)
		const first = seen[0]
		expect(first).toMatchObject({
			leafIndex: "77",
			messageHash: "0xTOKKEY",
			fuelLeaf: "78",
			fuelKey: "0xFUELKEY",
			fuelReceived: "4444",
			secretHex: "0xprivatesecret",
			envelopeSecret: "0xprivatesecret",
			// The envelope SALT is the private-FJ claim's source of truth — losing it strands fuel.
			envelopeSalt: "0xenvelopesalt",
		})
	})

	it("(d) public claim material: the raw journal secret, NO envelope", async () => {
		const deps = baseDeps(kv)
		const seen: Array<{ secretHex: string; envelope: unknown }> = []
		const claim = vi.fn(async (_rec: DepositJournalRecord, secretHex: string, envelope?: unknown) => {
			seen.push({ secretHex, envelope })
			return { simulate: async () => {}, send: async () => ({ txHash: "0xpub" }) }
		})
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xpubmat"))
		await runDepositClaim("0xpubmat")
		expect(seen[0]).toEqual({ secretHex: "0xpublicsecret", envelope: undefined })
	})

	it("(d) terminal receipt-mismatch classifies as receipt-mismatch; a generic recovery throw as error", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		const recoverDepositLeg = vi.fn(async () => {
			throw new Error(`This bridge's Ethereum ${RECEIPT_RECORD_MISMATCH_MSG} - unrecoverable`)
		})
		connectJournalDeps({ ...deps, claim, recoverDepositLeg })
		addRecord(mkDeposit("0xmm", { leafIndex: undefined, depositTxHash: "0xdep" }))
		await runDepositClaim("0xmm")
		const { runtime } = useBridgeJournal()
		expect(runtime.value["0xmm"]?.attention).toBe("receipt-mismatch")

		const recover2 = vi.fn(async () => {
			throw new Error("rpc exploded")
		})
		connectJournalDeps({ ...deps, claim, recoverDepositLeg: recover2 })
		addRecord(mkDeposit("0xgen", { leafIndex: undefined, depositTxHash: "0xdep2" }))
		await runDepositClaim("0xgen")
		expect(runtime.value["0xgen"]?.attention).toBe("error")
	})

	it("(e) sent-claim monotonicity: receipt FIRST, verification-only claim build, interaction.send NEVER", async () => {
		const deps = baseDeps(kv)
		const order: string[] = []
		deps.claimReceiptStatus.mockImplementation((async (h: string) => {
			order.push(`receipt:${h}`)
			return "success"
		}) as never)
		// The probe build is ALLOWED (verification-only) — but only AFTER the receipt, and its
		// interaction's send must never fire.
		const claim = vi.fn(async () => {
			order.push("build")
			return {
				simulate: async () => {
					order.push("probe-simulate")
					throw new Error("No non-nullified L1 to L2 message found")
				},
				send: async () => {
					order.push("send")
					throw new Error("send must never fire on the sent path")
				},
			}
		})
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xsentalready", { claimTxHash: "0x001f00000000000000000000000000000000000000000000746865636c61696d" }))
		await runDepositClaim("0xsentalready")
		expect(order[0]).toBe("receipt:0x001f00000000000000000000000000000000000000000000746865636c61696d")
		expect(order.indexOf("build")).toBeGreaterThan(0)
		expect(order).toContain("probe-simulate")
		// Explicit: the sent path NEVER sends (the throwing fake would also have pushed).
		expect(order).not.toContain("send")
		const { records } = useBridgeJournal()
		expect(records.value.find((r) => r.id === "0xsentalready")?.completedAt).toBe(999)
	})

	it("(e) a terminal revert clears claimTxHash, so RETRY re-enters the build path and sends a fresh claim", async () => {
		const deps = baseDeps(kv)
		const claim = vi.fn(async () => ({ simulate: async () => {}, send: async () => ({ txHash: "0xnew" }) }))
		deps.claimReceiptStatus.mockResolvedValue("reverted")
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xrevtrap", { claimTxHash: "0x001c000000000000000000000000000000000000000000007265766572746564" }))
		await runDepositClaim("0xrevtrap")
		const { records, runtime } = useBridgeJournal()
		const rec = () => records.value.find((r) => r.id === "0xrevtrap") as DepositJournalRecord | undefined
		expect(runtime.value["0xrevtrap"]?.note).toMatch(/reverted on Aztec/)
		expect(runtime.value["0xrevtrap"]?.attention).toBe("error")
		expect(rec()?.claimTxHash).toBeUndefined()
		expect(claim).not.toHaveBeenCalled() // the first run was the receipt path, verbatim
		await runDepositClaim("0xrevtrap")
		expect(claim).toHaveBeenCalledTimes(1)
		expect(deps.claimReceiptStatus).toHaveBeenLastCalledWith("0xnew")
		expect(rec()?.completedAt).toBeUndefined()
	})

	it("(e) the revert clear is an expected-hash guard: a late reverted poll never wipes a fresh hash another tab sent", async () => {
		const deps = baseDeps(kv)
		deps.claimReceiptStatus.mockImplementation((async (hash: string) => {
			if (hash !== "0x0010000000000000000000000000000000000000000000000000000000000048") return "pending"
			// Between this tab's poll and its clear, "another tab" retried and journaled a new hash.
			kvPatchRecord(kv, "0xrace", { claimTxHash: "0x001100000000000000000000000000000000000000000000000000000000004e" })
			return "reverted"
		}) as never)
		connectJournalDeps({ ...deps, claim: vi.fn() as never })
		addRecord(mkDeposit("0xrace", { claimTxHash: "0x0010000000000000000000000000000000000000000000000000000000000048" }))
		await runDepositClaim("0xrace")
		const { records, runtime } = useBridgeJournal()
		expect((records.value.find((r) => r.id === "0xrace") as DepositJournalRecord | undefined)?.claimTxHash).toBe(
			"0x001100000000000000000000000000000000000000000000000000000000004e",
		)
		// The guard rejected, so this runner says nothing about a claim it no longer owns.
		expect(runtime.value["0xrace"]?.note).toBeUndefined()
		expect(runtime.value["0xrace"]?.attention).toBeUndefined()
	})

	it("(e) after the clear, only a SESSION-LIVE reverted record auto-resends on reconnect; an idle one waits for RETRY", async () => {
		const deps = baseDeps(kv)
		const claim = vi.fn(async () => ({ simulate: async () => {}, send: async () => ({ txHash: "0xnew" }) }))
		deps.claimReceiptStatus.mockResolvedValue("reverted")
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xrevlive", { claimTxHash: "0x001a000000000000000000000000000000000000000000000000000072657631" }))
		addRecord(mkDeposit("0xrevidle", { claimTxHash: "0x001b000000000000000000000000000000000000000000000000000072657632" }))
		markSessionLive("0xrevlive")
		await runDepositClaim("0xrevlive")
		await runDepositClaim("0xrevidle")
		expect(claim).not.toHaveBeenCalled()
		resumeSessionWork()
		await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
		expect((claim.mock.calls[0] as unknown as [DepositJournalRecord])[0].id).toBe("0xrevlive")
	})

	it("(e) a malformed persisted claim hash is a terminal record fault — named, never probed, never resent", async () => {
		const deps = baseDeps(kv)
		const claim = vi.fn()
		connectJournalDeps({ ...deps, claim: claim as never })
		addRecord(mkDeposit("0xbadhash", { claimTxHash: "0xnot-a-tx-hash" }))
		await runDepositClaim("0xbadhash")
		const { records, runtime } = useBridgeJournal()
		expect(runtime.value["0xbadhash"]?.attention).toBe("malformed-record")
		expect(runtime.value["0xbadhash"]?.note).toMatch(/malformed/)
		expect(deps.claimReceiptStatus).not.toHaveBeenCalled()
		expect(claim).not.toHaveBeenCalled()
		// The record is untouched: only a restore or a discard changes it.
		expect((records.value.find((r) => r.id === "0xbadhash") as DepositJournalRecord | undefined)?.claimTxHash).toBe("0xnot-a-tx-hash")
		// Once known, session resume leaves it alone — the explicit RETRY is the only path back in.
		deps.claimReceiptStatus.mockClear()
		resumeSessionWork()
		await new Promise((r) => setTimeout(r, 0))
		expect(deps.claimReceiptStatus).not.toHaveBeenCalled()
		expect(claim).not.toHaveBeenCalled()
	})

	it("(e) after a fresh reload, the first session resume classifies a malformed record without a click, probe or resend", async () => {
		const deps = baseDeps(kv)
		const claim = vi.fn()
		connectJournalDeps({ ...deps, claim: claim as never })
		// A persisted hash makes the record a prompt-free receipt wait, which resume picks up.
		addRecord(mkDeposit("0xbadreload", { claimTxHash: "0xnot-a-tx-hash" }))
		resumeSessionWork()
		const { runtime } = useBridgeJournal()
		await vi.waitFor(() => expect(runtime.value["0xbadreload"]?.attention).toBe("malformed-record"))
		expect(deps.claimReceiptStatus).not.toHaveBeenCalled()
		expect(claim).not.toHaveBeenCalled()
	})

	it("(f) the dropped-streak clear is expected-hash guarded too: a fresh hash another tab sent survives three late drops", async () => {
		const deps = baseDeps(kv)
		let polls = 0
		deps.claimReceiptStatus.mockImplementation((async (hash: string) => {
			if (hash !== "0x0010000000000000000000000000000000000000000000000000000000000048") return "pending"
			// "Another tab" retried and journaled a new hash while this tab's drop streak was building.
			if (++polls === 2)
				kvPatchRecord(kv, "0xdroprace", { claimTxHash: "0x001100000000000000000000000000000000000000000000000000000000004e" })
			return "dropped"
		}) as never)
		connectJournalDeps({ ...deps, claim: vi.fn() as never })
		addRecord(mkDeposit("0xdroprace", { claimTxHash: "0x0010000000000000000000000000000000000000000000000000000000000048" }))
		await runDepositClaim("0xdroprace")
		const { records, runtime } = useBridgeJournal()
		expect(deps.claimReceiptStatus).toHaveBeenCalledTimes(3)
		expect((records.value.find((r) => r.id === "0xdroprace") as DepositJournalRecord | undefined)?.claimTxHash).toBe(
			"0x001100000000000000000000000000000000000000000000000000000000004e",
		)
		// The guard rejected, so this runner says nothing about a claim it no longer owns.
		expect(runtime.value["0xdroprace"]?.note).toBeUndefined()
		expect(runtime.value["0xdroprace"]?.attention).toBeUndefined()
	})

	it("(f) dropped debounce: any non-dropped status resets the streak; three straight drops clear the hash", async () => {
		const deps = baseDeps(kv)
		const claim = vi.fn()
		const seq: Array<"dropped" | "pending" | "success"> = ["dropped", "dropped", "pending", "dropped", "dropped", "dropped"]
		let n = 0
		deps.claimReceiptStatus.mockImplementation(async () => (n < seq.length ? seq[n++] : "pending"))
		connectJournalDeps({ ...deps, claim: claim as never })
		addRecord(mkDeposit("0xstreak", { claimTxHash: "0x001600000000000000000000000000000000000000000000000064726f707079" }))
		claim.mockImplementation(async () => ({ simulate: async () => {}, send: async () => ({ txHash: "0xx" }) }))
		await runDepositClaim("0xstreak")
		const { records, runtime } = useBridgeJournal()
		// The pending at position 3 reset the first two drops; drops 4-6 hit the threshold.
		expect(deps.claimReceiptStatus).toHaveBeenCalledTimes(6)
		expect((records.value.find((r) => r.id === "0xstreak") as DepositJournalRecord | undefined)?.claimTxHash).toBeUndefined()
		expect(runtime.value["0xstreak"]?.note).toMatch(/dropped — claim again/)
	})

	it("(f) quiet flip: a proposed receipt lands confirmLandedTxHash for exactly the sent hash", async () => {
		const deps = baseDeps(kv)
		const seq: Array<"proposed" | "success"> = ["proposed", "proposed", "success"]
		let n = 0
		deps.claimReceiptStatus.mockImplementation((async () => (n < seq.length ? seq[n++] : "success")) as never)
		const claim = vi.fn(async () => ({ simulate: async () => {}, send: async () => ({ txHash: "0xfliptx" }) }))
		connectJournalDeps({ ...deps, claim })
		const { runtime } = useBridgeJournal()
		addRecord(mkDeposit("0xflip"))
		await runDepositClaim("0xflip")
		// The send established forge-resistant provenance; the proposed polls quietly flipped the
		// hash-scoped landed marker before the success completed the record.
		expect(runtime.value["0xflip"]?.confirmLandedTxHash).toBe("0xfliptx")
		const { records } = useBridgeJournal()
		expect(records.value.find((r) => r.id === "0xflip")?.completedAt).toBe(999)
	})

	it("(f) drops spanning the 45-poll round boundary do NOT accumulate (streaks are round-local)", async () => {
		const deps = baseDeps(kv)
		// Round 1: 43 pending + 2 dropped (streak 2 at the boundary). Round 2: 1 dropped (would be
		// 3 if carried) + success. The hash must survive to completion.
		const seq: string[] = [...Array(43).fill("pending"), "dropped", "dropped", "dropped", "success"]
		let n = 0
		deps.claimReceiptStatus.mockImplementation((async () => (n < seq.length ? seq[n++] : "success")) as never)
		const claim = vi.fn(async () => ({
			simulate: async () => {
				throw new Error("No non-nullified L1 to L2 message found")
			},
			send: async () => ({ txHash: "0xx" }),
		}))
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xboundary", { claimTxHash: "0x001e00000000000000000000000000000000000000000000000000007370616e" }))
		await runDepositClaim("0xboundary")
		await vi.waitFor(() => {
			const { records } = useBridgeJournal()
			expect(records.value.find((r) => r.id === "0xboundary")?.completedAt).toBe(999)
		})
		const { records } = useBridgeJournal()
		expect((records.value.find((r) => r.id === "0xboundary") as DepositJournalRecord | undefined)?.claimTxHash).toBe(
			"0x001e00000000000000000000000000000000000000000000000000007370616e",
		)
	})

	it("(f) streak independence: alternating dropped/unreachable never clears (each resets the other)", async () => {
		const deps = baseDeps(kv)
		const seq: string[] = ["dropped", "unreachable", "dropped", "unreachable", "dropped", "success"]
		let n = 0
		deps.claimReceiptStatus.mockImplementation((async () => (n < seq.length ? seq[n++] : "success")) as never)
		const claim = vi.fn(async () => ({
			simulate: async () => {
				throw new Error("No non-nullified L1 to L2 message found")
			},
			send: async () => ({ txHash: "0xx" }),
		}))
		connectJournalDeps({ ...deps, claim })
		addRecord(mkDeposit("0xalt", { claimTxHash: "0x00120000000000000000000000000000000000000000000000616c7468617368" }))
		await runDepositClaim("0xalt")
		const { records } = useBridgeJournal()
		expect((records.value.find((r) => r.id === "0xalt") as DepositJournalRecord | undefined)?.claimTxHash).toBe(
			"0x00120000000000000000000000000000000000000000000000616c7468617368",
		)
		expect(records.value.find((r) => r.id === "0xalt")?.completedAt).toBe(999)
	})

	it("(f) round accounting: exactly ten 45-poll rounds, then the soft cap re-arms RETRY (no round 11)", async () => {
		const deps = baseDeps(kv)
		deps.claimReceiptStatus.mockResolvedValue("pending")
		connectJournalDeps({ ...deps, claim: smartClaimFake() })
		const { runtime } = useBridgeJournal()
		addRecord(mkDeposit("0xrounds", { claimTxHash: "0x001d0000000000000000000000000000000000000000000000000000736c6f77" }))
		await runDepositClaim("0xrounds")
		// Rounds 2-10 chain detached between lock releases; waitMs is a no-op so they finish fast.
		await vi.waitFor(() => {
			expect(deps.claimReceiptStatus.mock.calls.length).toBe(450)
			expect(runtime.value["0xrounds"]?.note).toMatch(/Still confirming after ~30 minutes/)
		})
		// Soft cap: no round 11 fires on its own.
		await new Promise((r) => setTimeout(r, 30))
		expect(deps.claimReceiptStatus.mock.calls.length).toBe(450)
	})

	it("(g) recipient guard fails CLOSED: absent connected account AND empty recipient both refuse", async () => {
		const deps = baseDeps(kv)
		const claim = smartClaimFake()
		connectJournalDeps({ ...deps, claim, connectedAztec: () => null as never })
		addRecord(mkDeposit("0xnoacct"))
		await runDepositClaim("0xnoacct")
		const { runtime } = useBridgeJournal()
		expect(runtime.value["0xnoacct"]?.attention).toBe("mismatch")
		expect(claim).not.toHaveBeenCalled()

		connectJournalDeps({ ...deps, claim, connectedAztec: () => RECIPIENT })
		addRecord(mkDeposit("0xemptyrec", { recipient: "" }))
		await runDepositClaim("0xemptyrec")
		expect(runtime.value["0xemptyrec"]?.attention).toBe("mismatch")
		expect(claim).not.toHaveBeenCalled()
	})

	it("(h) withdraw latch: the fresh consumeTxHash is journaled BEFORE the receipt wait; a failed wait clears with its copy", async () => {
		const deps = baseDeps(kv)
		const { records, runtime } = useBridgeJournal()
		let hashAtWait: string | undefined
		deps.waitConsumeReceipt.mockImplementation(async () => {
			hashAtWait = (records.value.find((r) => r.id === "0xwd") as SendWithdrawRecord | undefined)?.consumeTxHash
			return false
		})
		connectJournalDeps({ ...deps, claim: smartClaimFake() })
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
		connectJournalDeps({ ...deps, claim: smartClaimFake() })
		addRecord(mkWithdraw("0xwprior", { consumeTxHash: "0x001700000000000000000000000000000000000000006f6c64636f6e73756d65" }))
		await runWithdrawConsume("0xwprior")
		expect((records.value.find((r) => r.id === "0xwprior") as SendWithdrawRecord | undefined)?.consumeTxHash).toBeUndefined()
		expect(runtime.value["0xwprior"]?.note).toMatch(/The prior finish transaction failed/)

		// Fresh consume success: hash journaled, receipt ok, completion from the post-wait reread.
		deps.waitConsumeReceipt.mockResolvedValue(true)
		connectJournalDeps({ ...deps, claim: smartClaimFake() })
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
		connectJournalDeps({ ...deps, claim: smartClaimFake() })
		addRecord(mkWithdraw("0xwgone"))
		await runWithdrawConsume("0xwgone")
		// The success path rereads the journal; the discarded record must not come back completed.
		expect(records.value.find((r) => r.id === "0xwgone")).toBeUndefined()
	})

	it("(h) absent verifier defaults open (?? true) on a rediscovered consume; progress ?? fallbacks derive proven", async () => {
		const deps = baseDeps(kv)
		const { runtime } = useBridgeJournal()
		const noVerify = { ...deps, claim: smartClaimFake() } as Record<string, unknown>
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

		connectJournalDeps({ ...deps, claim: smartClaimFake() })
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
		connectJournalDeps({ ...deps, claim: smartClaimFake() })
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

	function sendDeps(order: string[]) {
		return {
			sendBinding: () => ({ factory: FACTORY, implementation: IMPLEMENTATION, hub: HUB, feeJuicePortal: FJ_PORTAL }),
			validateTokenBlock: vi.fn(async () => {
				order.push("validate")
				return null as string | null
			}),
			ensureTokenGrant: vi.fn(async () => {
				order.push("grant")
				return "granted" as const
			}),
			claimSend: vi.fn(async () => {
				order.push("build")
				return {
					simulate: async () => {
						order.push("simulate")
						return {}
					},
					send: async () => {
						order.push("send")
						return { txHash: "0xhubclaim", registerTxHash: "0xregister" }
					},
				}
			}),
		}
	}

	it("the block check precedes the grant, which precedes the claim build, simulate and send", async () => {
		const order: string[] = []
		connectJournalDeps({ ...baseDeps(kv), ...sendDeps(order) })
		addRecord(mkSend("0xorder"))
		await runDepositClaim("0xorder")
		expect(order).toEqual(["validate", "grant", "build", "simulate", "send"])
	})

	it("a private send hands the hub its UNSEALED claim salt AND the envelope it came from", async () => {
		const order: string[] = []
		const send = sendDeps(order)
		connectJournalDeps({ ...baseDeps(kv), ...send })
		const rec = mkSend("0xpriv", { isPrivate: true, secret: undefined })
		addRecord(rec)
		const envelope = {
			v: 2 as const,
			secret: "0xsealedsalt",
			recipient: RECIPIENT,
			amount: rec.amount,
			sealerL1: SEALER,
			salt: "0xsealedfuelsalt",
		}
		cacheSecret("0xpriv", "0xsealedsalt", envelope)
		await runDepositClaim("0xpriv")
		// The envelope travels with the claim: the private fuel fee rebuilds its secret from the
		// authenticated `salt`, which the journal's plaintext copy can contradict.
		expect(send.claimSend).toHaveBeenCalledWith(expect.objectContaining({ id: "0xpriv" }), "0xsealedsalt", envelope)
	})

	it("the registration and the claim it precedes are journaled in ONE patch, never half-written", async () => {
		const order: string[] = []
		connectJournalDeps({ ...baseDeps(kv), ...sendDeps(order) })
		addRecord(mkSend("0xpair"))
		await runDepositClaim("0xpair")
		const rec = useBridgeJournal().records.value.find((r) => r.id === "0xpair") as SendDepositRecord
		expect([rec.registerTxHash, rec.claimTxHash]).toEqual(["0xregister", "0xhubclaim"])
	})
})
