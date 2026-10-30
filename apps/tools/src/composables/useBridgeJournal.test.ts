import { createHash } from "node:crypto"
import {
	type DepositEnvelopeV2,
	type DepositJournalRecord,
	JOURNAL_KEY,
	type KV,
	type SendDepositRecord,
	type SendWithdrawRecord,
	type WithdrawJournalRecord,
	isSealTrusted,
	loadJournal,
	markSealTrusted,
	removeRecord,
	RecoveryKey,
	recoveryKeyMessage,
	rekeyRecord,
	sealDepositEnvelope,
	upsertRecord,
} from "@unleashed/bridge-core"
import { recoveryBindingOf } from "@/lib/send-record"
import type { DepositRecord, JournalTokenBlock } from "@unleashed/sdk"
import { feeJuiceAddress, predictPortal } from "@unleashed/sdk/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GrantOutcome } from "@/lib/send-model"
import { FEE_STOP_COPY } from "@/lib/fee-stop-copy"
import { JOURNAL_LOCK, memoryJournalLocks } from "@/lib/journal-locks"
import { watch } from "vue"
import type { ExitSearch } from "./exit-attach"

vi.mock("@/contracts/bridge-generation", () => ({ FUEL_PORTAL: "0xfd05ee8687d4ca828ba3d26ef04b80dd1348e5bd" }))

import {
	__resetJournalForTests,
	activeFlowId,
	addRecord,
	addRecordVerified,
	attestSendTokenBlocks,
	cacheSecret,
	claimForeground,
	connectJournalDeps,
	currentRecord,
	deploymentMatches,
	discard,
	markApproveOutcome,
	markSessionLive,
	rekeyJournalRecord,
	releaseForeground,
	resumeSessionWork,
	attachAndConsume,
	runDepositClaim,
	runGasClaim,
	runOnLane,
	runWithdrawConsume,
	sendTokenBlocks,
	setRecordStep,
	updateRecord,
	updateRecordWhen,
	useBridgeJournal,
} from "./useBridgeJournal"
import {
	bridgeError,
	CLAIM_TX,
	type ClaimScript,
	type FakeClaimSdk,
	failsWith,
	fakeClaimSdk,
	pollsForever,
	sendsClaim,
} from "./test/fake-claim-sdk"
import { otherTab } from "./test/other-tab"

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

// `mkDeposit` is a direct Fee Juice bridge: the one pre-generation shape whose binding (the canonical portal + the L2
// Fee Juice address) still resolves. No SDK claim reads its schema-1 form; the claim cases run on `mkSend`.
const DEPLOY = { chainId: 11155111, portal: FJ_PORTAL, bridge: feeJuiceAddress.toString() }
const SEALER = "0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d"
const RECIPIENT = "0x1018808f2c17794badb361c02c945582b8198b495a7e8d01154f7eeb7d719c0d"
const SIG = `0x${"a".repeat(130)}`
// Field elements: the engine hands the SDK a private record's salts as `Fr`.
const PRIV_SECRET = `0x${"0".repeat(62)}2a`
const GAS_SALT = `0x${"0".repeat(62)}2b`
const DEPOSIT_TX = `0x${"de".repeat(32)}` as const
const MESSAGE_HASH = `0x00${"7d".repeat(31)}`

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
		ensureTokenGrant: vi.fn(async () => "granted" as GrantOutcome),
		verifyConsumeIdentitySend: vi.fn(async () => true),
		consumeSend: vi.fn(async () => ({ consumeTxHash: "0x0015000000000000000000000000000000000000000000636f6e73756d657478" })),
	}
}

/** The engine on a scripted SDK: the base deps, the send lane's, and the claim seam. */
function claimDeps(kv: KV, sdk: FakeClaimSdk) {
	return { ...baseDeps(kv), ...sendDeps(), ...sdk.deps }
}

type EnvelopeFields = Partial<{ recipient: string; amount: string; sealerL1: string; salt: string }>

/** The authenticated copy a private record seals: its secret is `PRIV_SECRET`. */
function envelopeOf(rec: DepositJournalRecord | SendDepositRecord, over: EnvelopeFields = {}): DepositEnvelopeV2 {
	return {
		v: 2,
		secret: PRIV_SECRET,
		recipient: over.recipient ?? rec.recipient,
		amount: over.amount ?? rec.amount,
		sealerL1: over.sealerL1 ?? SEALER,
		leafIndex: rec.leafIndex,
		...(over.salt ? { salt: over.salt } : {}),
	}
}

async function sealEnvelopeFor(rec: DepositJournalRecord | SendDepositRecord, over: EnvelopeFields = {}) {
	const { v: _v, ...envelope } = envelopeOf(rec, over)
	return sealDepositEnvelope(await RecoveryKey.derive(async () => SIG, recoveryBindingOf(rec, rec.secretHashHex), "site"), envelope)
}

const depositOf = (id: string) => useBridgeJournal().records.value.find((r) => r.id === id) as SendDepositRecord | undefined
const rt = (id: string) => useBridgeJournal().runtime.value[id]

describe("useBridgeJournal engine", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	it("② rediscovered claimable deposit NEVER auto-claims - zero claim/sign calls", async () => {
		const sdk = fakeClaimSdk()
		const deps = claimDeps(kv, sdk)
		connectJournalDeps(deps)
		addRecord(mkSend("0x00190000000000000000000000000000000000007265646973636f7665726564"))
		resumeSessionWork()
		await new Promise((r) => setTimeout(r, 10))
		expect(sdk.deps.claimContext).not.toHaveBeenCalled()
		expect(deps.signL1).not.toHaveBeenCalled()
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

	it("④ same-id double invocation runs one claim call; without a lock API the in-flight set is the dedup", async () => {
		const sdk = fakeClaimSdk()
		let release: () => void = () => {}
		const held = new Promise<void>((r) => {
			release = r
		})
		sdk.script("token", async (c) => {
			await c.hold(held)
			return sendsClaim(c)
		})
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkSend("0xa"))
		const first = runDepositClaim("0xa")
		await runDepositClaim("0xa")
		await vi.waitFor(() => expect(sdk.calls).toHaveLength(1))
		release()
		await first
		expect(sdk.calls).toHaveLength(1)
		expect(depositOf("0xa")?.completedAt).toBeDefined()
	})

	it("⑥ tampered plaintext recipient on a private record: no claim call, display resynced from the envelope", async () => {
		const sdk = fakeClaimSdk()
		const evil = `0x${"0e".repeat(32)}`
		const rec = mkSend("0xtamper", { isPrivate: true, secret: undefined, recipient: evil, sealerL1: SEALER })
		rec.sealedEnvelope = await sealEnvelopeFor(rec, { recipient: RECIPIENT })
		connectJournalDeps({ ...claimDeps(kv, sdk), connectedAztec: () => evil })
		addRecord(rec)
		await runDepositClaim("0xtamper")
		expect(sdk.calls).toHaveLength(0)
		expect(rt("0xtamper")?.attention).toBe("tampered")
		expect(depositOf("0xtamper")?.recipient).toBe(RECIPIENT)
	})

	it("⑦ unseal failure revokes trust ONLY for the sealer account and keeps the record", async () => {
		markSealTrusted(kv, DEPLOY.chainId, SEALER, "rabby")
		const rec = mkSend("0xfail", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		// The wallet now signs DIFFERENTLY than at seal time ⇒ wrong key ⇒ GCM failure.
		connectJournalDeps({ ...claimDeps(kv, fakeClaimSdk()), signL1: vi.fn(async () => `0x${"b".repeat(130)}`) })
		addRecord(rec)
		await runDepositClaim("0xfail")
		expect(rt("0xfail")?.attention).toBe("unseal-failed")
		expect(isSealTrusted(kv, DEPLOY.chainId, SEALER, "rabby")).toBe(false)
		expect(depositOf("0xfail")).toBeDefined()
	})

	it("⑧ wrong connected L1 account ⇒ pre-unseal mismatch, NO signature, trust intact", async () => {
		markSealTrusted(kv, DEPLOY.chainId, SEALER, "rabby")
		const rec = mkSend("0xwrongl1", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		const signL1 = vi.fn(async () => SIG)
		connectJournalDeps({ ...claimDeps(kv, fakeClaimSdk()), signL1, connectedL1: () => "0xsomeoneelse" })
		addRecord(rec)
		await runDepositClaim("0xwrongl1")
		expect(rt("0xwrongl1")?.attention).toBe("mismatch")
		expect(signL1).not.toHaveBeenCalled()
		expect(isSealTrusted(kv, DEPLOY.chainId, SEALER, "rabby")).toBe(true)
	})

	it("⑧b a sealer string carrying bidi controls is named in the note without them", async () => {
		const hostile = `‮${SEALER}`
		const rec = mkSend("0xbidi", { isPrivate: true, secret: undefined, sealerL1: hostile })
		rec.sealedEnvelope = await sealEnvelopeFor(rec)
		connectJournalDeps({ ...claimDeps(kv, fakeClaimSdk()), connectedL1: () => "0xsomeoneelse" })
		addRecord(rec)
		await runDepositClaim("0xbidi")
		const note = rt("0xbidi")?.note ?? ""
		expect(note).toContain(SEALER)
		expect(note).not.toContain("‮")
	})

	it("⑧d a tampered non-string recipient never loads as a record at all, so nothing can be claimed for it", async () => {
		const sdk = fakeClaimSdk()
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkSend("0xtampered", { recipient: 42 as unknown as string }))
		await runDepositClaim("0xtampered")
		expect(useBridgeJournal().records.value).toHaveLength(0)
		expect(sdk.calls).toHaveLength(0)
	})

	it("⑨ same-session cached secret claims with ZERO L1 signatures and no unsealing step; rediscovered uses exactly one", async () => {
		const sdk = fakeClaimSdk()
		const stepAtCall: (string | undefined)[] = []
		sdk.script("token", async (c) => {
			stepAtCall.push(rt(c.record.id)?.step)
			return sendsClaim(c)
		})
		const deps = claimDeps(kv, sdk)
		connectJournalDeps(deps)
		const cached = mkSend("0xsigcount", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		const rediscovered = mkSend("0xresume", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		for (const rec of [cached, rediscovered]) {
			rec.sealedEnvelope = await sealEnvelopeFor(rec)
			addRecord(rec)
		}
		cacheSecret("0xsigcount", PRIV_SECRET, envelopeOf(cached))
		await runDepositClaim("0xsigcount")
		expect(deps.signL1).not.toHaveBeenCalled()
		await runDepositClaim("0xresume")
		expect(deps.signL1).toHaveBeenCalledTimes(1)
		// A cached unseal is silent: an UNSEALING step there flashes CLAIM before the message has arrived.
		expect(stepAtCall).toEqual([undefined, "unsealing"])
		expect([depositOf("0xsigcount")?.completedAt, depositOf("0xresume")?.completedAt]).toEqual([expect.any(Number), expect.any(Number)])
	})

	it("a sent private claim is watched without its material: a resume never signs, a click unseals once", async () => {
		const sdk = fakeClaimSdk()
		const deps = claimDeps(kv, sdk)
		connectJournalDeps(deps)
		const sealed = async (id: string) => {
			const rec = mkSend(id, { isPrivate: true, secret: undefined, sealerL1: SEALER, claimTxHash: CLAIM_TX })
			rec.sealedEnvelope = await sealEnvelopeFor(rec)
			addRecord(rec)
		}
		await sealed("0xresumed")
		resumeSessionWork()
		await vi.waitFor(() => expect(depositOf("0xresumed")?.completedAt).toBeDefined())
		expect(deps.signL1).not.toHaveBeenCalled()
		await sealed("0xclicked")
		await runDepositClaim("0xclicked")
		expect(deps.signL1).toHaveBeenCalledTimes(1)
		expect(depositOf("0xclicked")?.completedAt).toBeDefined()
		expect(sdk.calls.map((c) => [c.view.id, c.run.watchOnly, c.run.secrets?.claimSalt?.toString()])).toEqual([
			["0xresumed", true, undefined],
			["0xclicked", false, PRIV_SECRET],
		])
	})

	it.each(["legacy", "site"] as const)("a rediscovered claim sealed under the %s text signs exactly that text, once", async (text) => {
		const sign = async (m: string) => `0x${createHash("sha256").update(m).digest("hex")}`
		const signL1 = vi.fn(sign)
		connectJournalDeps({ ...claimDeps(kv, fakeClaimSdk()), signL1 })
		const rec = mkSend(`0x${text}`, { isPrivate: true, secret: undefined, sealerL1: SEALER })
		const binding = recoveryBindingOf(rec, rec.secretHashHex)
		const { v: _v, ...envelope } = envelopeOf(rec)
		rec.sealedEnvelope = await sealDepositEnvelope(await RecoveryKey.derive(sign, binding, text), envelope)
		addRecord(rec)
		await runDepositClaim(rec.id)
		expect(signL1.mock.calls).toEqual([[recoveryKeyMessage(binding, text)]])
		expect(depositOf(rec.id)?.completedAt).toBeDefined()
	})

	it("an envelope under a marker this build does not know is refused unsigned, and seal trust stays", async () => {
		markSealTrusted(kv, DEPLOY.chainId, SEALER, "rabby")
		const rec = mkSend("0xnext", { isPrivate: true, secret: undefined, sealerL1: SEALER, sealedEnvelope: "next:AAAA" })
		const signL1 = vi.fn(async () => SIG)
		connectJournalDeps({ ...claimDeps(kv, fakeClaimSdk()), signL1 })
		addRecord(rec)
		await runDepositClaim("0xnext")
		expect(rt("0xnext")?.attention).toBe("unseal-failed")
		expect(signL1).not.toHaveBeenCalled()
		expect(isSealTrusted(kv, DEPLOY.chainId, SEALER, "rabby")).toBe(true)
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
		const sdk = fakeClaimSdk()
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkDeposit("0xstale", { portal: "0xOLDPORTAL" }))
		await runDepositClaim("0xstale")
		expect(useBridgeJournal().runtime.value["0xstale"]?.attention).toBe("stale-deployment")
		expect(sdk.calls).toHaveLength(0)
	})

	it("write-and-verify aborts when storage drops the record", async () => {
		const blackhole: KV = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
		connectJournalDeps({ ...baseDeps(blackhole), kv: blackhole })
		expect(() => addRecordVerified(mkDeposit("0xlost"))).toThrow(/persist/i)
	})

	it("resumeSessionWork skips mid-flight sessionLive records (no-leaf deposit, provisional withdraw)", async () => {
		const sdk = fakeClaimSdk()
		const deps = claimDeps(kv, sdk)
		connectJournalDeps(deps)
		addRecord(mkSend("0xnoleaf", { leafIndex: undefined }))
		addRecord(mkWithdraw("wd-pending-live", { exitTxHash: undefined }))
		markSessionLive("0xnoleaf")
		markSessionLive("wd-pending-live")
		resumeSessionWork()
		await new Promise((r) => setTimeout(r, 10))
		expect(sdk.deps.claimContext).not.toHaveBeenCalled()
		expect(deps.consumeSend).not.toHaveBeenCalled()
		// The live provisional record is NOT tagged unknown-outcome by the sweep.
		expect(useBridgeJournal().runtime.value["wd-pending-live"]?.attention).toBeUndefined()
	})

	it("the engine narrates the SDK's events - steps observable during the call, cleared at exit", async () => {
		const sdk = fakeClaimSdk()
		const seen: (string | undefined)[] = []
		sdk.script("token", async (c) => {
			c.emit({ type: "arrival", stage: "wallet-sync", counted: false })
			seen.push(rt(c.record.id)?.step)
			c.emit({ type: "claim-requested", leg: "token" })
			seen.push(rt(c.record.id)?.step)
			return sendsClaim(c)
		})
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkSend("0xnarrate"))
		await runDepositClaim("0xnarrate")
		expect(seen).toEqual(["syncing", "sending"])
		expect(rt("0xnarrate")).toMatchObject({ step: undefined, busy: false })
		expect(depositOf("0xnarrate")?.completedAt).toBeDefined()
	})

	it("discard mid-wait bumps the generation - the call stops, nothing resurrects", async () => {
		const sdk = fakeClaimSdk()
		sdk.script("token", async (c) => {
			c.emit({ type: "claim-waiting", leg: "token", txHash: CLAIM_TX, poll: 1, unreachable: 0 })
			void discard(c.record.id)
			await c.hold()
			return c.settle()
		})
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkSend("0xkilled", { claimTxHash: CLAIM_TX }))
		await runDepositClaim("0xkilled", { interactive: false })
		await new Promise((r) => setTimeout(r, 20))
		expect(depositOf("0xkilled")).toBeUndefined()
		expect(rt("0xkilled")).toBeUndefined()
		expect(sdk.calls).toHaveLength(1)
		expect(useBridgeJournal().lastCompleted.value).toBeNull()
	})

	it("a completion clears a stale note, feeds the toast with its foreground, and its card stays - own claim or another's", async () => {
		const sdk = fakeClaimSdk()
		const gasLeft = bridgeError("fee-stop", { stop: "below-claim-floor" })
		sdk.script(
			"token",
			sendsClaim,
			async (c) => c.settle("claimed-elsewhere"),
			async (c) => c.settle("claim", { gasLeft }),
		)
		connectJournalDeps(claimDeps(kv, sdk))
		for (const id of ["0xown", "0xother", "0xgasleft"]) addRecord(mkSend(id))
		useBridgeJournal().runtime.value = { "0xown": { note: "Still confirming after ~30 minutes — slow testnet." } }
		claimForeground("0xown")
		await runDepositClaim("0xown")
		expect(useBridgeJournal().lastCompleted.value).toMatchObject({ id: "0xown", foreground: true, txHash: CLAIM_TX })
		expect(rt("0xown")?.note).toBeUndefined()
		releaseForeground("0xown")
		await runDepositClaim("0xother")
		expect(useBridgeJournal().lastCompleted.value).toMatchObject({ id: "0xother", foreground: false })
		expect(depositOf("0xother")?.claimedByOther).toBe(true)
		for (const id of ["0xown", "0xother"]) {
			expect(depositOf(id)?.completedAt).toBeDefined()
			expect(useBridgeJournal().visibleRecords.value.some((r) => r.id === id)).toBe(true)
		}
		// Tokens that landed while their bridged gas could not be claimed settle, saying why.
		await runDepositClaim("0xgasleft")
		expect(depositOf("0xgasleft")?.completedAt).toBeDefined()
		expect(rt("0xgasleft")).toMatchObject({
			attention: "error",
			note: expect.stringMatching(/claim floor.*Your tokens are unaffected/),
		})
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

	it.each([
		["a raw message", "boom - not a sync revert", "boom - not a sync revert. Your funds are not lost — retry from this card."],
		[
			"a sentence of the app's own",
			FEE_STOP_COPY["fuel-claim-pending"],
			`${FEE_STOP_COPY["fuel-claim-pending"]} Your funds are not lost — retry from this card.`,
		],
	])("a throwing claim SURFACES %s on the record (UI call sites void the promise) with one full stop", async (_, message, note) => {
		const sdk = fakeClaimSdk()
		sdk.script("token", async (c) => {
			c.emit({ type: "claim-requested", leg: "token" })
			throw new Error(message)
		})
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkSend("0xboom"))
		await runDepositClaim("0xboom") // resolves - the failure lands on the record instead.
		expect(rt("0xboom")).toMatchObject({ attention: "error", step: undefined, busy: false })
		expect(rt("0xboom")?.note).toBe(note)
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
		fuel: {
			amount: "10",
			secret: "0xfuelsecret",
			secretHashHex: id,
			minOutput: "9",
			leafIndex: "7",
			messageHash: MESSAGE_HASH,
			received: "5",
		},
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
			const sdk = fakeClaimSdk()
			const send = sendDeps()
			send.validateTokenBlock = vi.fn(async () => "This bridge's token details changed on Ethereum." as string | null)
			connectJournalDeps({ ...baseDeps(kv), ...send, ...sdk.deps })
			addRecord(mkSend("0xbad"))
			await runDepositClaim("0xbad")
			const { records, runtime } = useBridgeJournal()
			expect(records.value.find((r) => r.id === "0xbad")?.blocked).toBe("This bridge's token details changed on Ethereum.")
			expect(runtime.value["0xbad"]?.attention).toBe("stale-deployment")
			expect(send.ensureTokenGrant).not.toHaveBeenCalled()
			expect(sdk.deps.claimContext).not.toHaveBeenCalled()
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
			const sdk = fakeClaimSdk()
			const send = sendDeps()
			send.ensureTokenGrant = vi.fn(async () => "declined" as GrantOutcome)
			connectJournalDeps({ ...baseDeps(kv), ...send, ...sdk.deps })
			addRecord(mkSend("0xnogrant"))
			await runDepositClaim("0xnogrant")
			expect(sdk.deps.claimContext).not.toHaveBeenCalled()
			expect(useBridgeJournal().runtime.value["0xnogrant"]?.attention).toBe("error")
		})

		it("a stale grant (a newer selection won) stops the lane with its own copy", async () => {
			const sdk = fakeClaimSdk()
			const send = sendDeps()
			send.ensureTokenGrant = vi.fn(async () => "stale" as GrantOutcome)
			connectJournalDeps({ ...baseDeps(kv), ...send, ...sdk.deps })
			addRecord(mkSend("0xstalegrant"))
			await runDepositClaim("0xstalegrant")
			expect(sdk.deps.claimContext).not.toHaveBeenCalled()
			expect(useBridgeJournal().runtime.value["0xstalegrant"]?.note).toMatch(/superseded/)
		})
	})

	describe("claim through the hub", () => {
		it("claims through the hub's entry with the record's own claim value, and its registration and claim land in one write", async () => {
			const sdk = fakeClaimSdk()
			const writes: string[][] = []
			const REGISTER_TX = `0x${"5e".repeat(32)}`
			sdk.script("token", async (c) => {
				c.emit({ type: "claim-requested", leg: "token" })
				await c.persist({ registerTxHash: REGISTER_TX, claimTxHash: CLAIM_TX })
				writes.push(Object.keys(currentRecord(c.record.id) ?? {}).filter((k) => k.endsWith("TxHash")))
				return c.settle("claim", { txHash: CLAIM_TX })
			})
			connectJournalDeps(claimDeps(kv, sdk))
			addRecord(mkSend("0xhub", { secret: "0xsaltish" }))
			await runDepositClaim("0xhub")
			expect(sdk.calls.map((c) => [c.entry, c.view.secret, c.run.secrets])).toEqual([["token", "0xsaltish", undefined]])
			expect(writes).toEqual([["registerTxHash", "claimTxHash"]])
			expect(depositOf("0xhub")?.completedAt).toBeDefined()
		})

		it("a gas-only send claims through the Fee Juice entry, granting nothing; a public one spends its gas block's secret", async () => {
			const sdk = fakeClaimSdk()
			const deps = claimDeps(kv, sdk)
			connectJournalDeps(deps)
			addRecord(mkGasOnly("0xgasonly"))
			await runDepositClaim("0xgasonly")
			expect(deps.ensureTokenGrant).not.toHaveBeenCalled()
			expect(sdk.calls.map((c) => [c.entry, c.view.fuel?.secret, c.run.secrets])).toEqual([["fuel", "0xfuelsecret", undefined]])
			expect(rt("0xgasonly")?.attention).toBeUndefined()
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
		fuel: {
			amount: "10",
			secret: "0xfuelsecret",
			secretHashHex: `${id}fuel`,
			minOutput: "9",
			leafIndex: "8",
			messageHash: MESSAGE_HASH,
			received: "5",
		},
		...over,
	})
}

describe("useBridgeJournal - a claim on the SDK's entries", () => {
	let kv: KV

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	it("a click prompts, a resume watches unless this session started the record, and withoutGas is the card's choice", async () => {
		const sdk = fakeClaimSdk()
		connectJournalDeps({ ...claimDeps(kv, sdk), withoutGas: (id: string) => id === "0xclick" })
		addRecord(mkSend("0xclick"))
		await runDepositClaim("0xclick")
		addRecord(mkSend("0xwatched", { claimTxHash: CLAIM_TX }))
		addRecord(mkSend("0xlive"))
		markSessionLive("0xlive")
		resumeSessionWork()
		await vi.waitFor(() => expect(sdk.calls).toHaveLength(3))
		const modeOf = (id: string) => sdk.calls.filter((c) => c.view.id === id).map((c) => [c.run.watchOnly, c.run.withoutGas])
		expect([modeOf("0xclick"), modeOf("0xwatched"), modeOf("0xlive")]).toEqual([[[false, true]], [[true, false]], [[false, false]]])
		// A watching claim asks the context for no wallet it would prompt.
		expect(sdk.deps.claimContext).toHaveBeenCalledWith({ recipient: RECIPIENT, watchOnly: true })
	})

	it("a private claim ignores the claim-without-gas choice, and a watching run never asks for the unseal signature", async () => {
		const sdk = fakeClaimSdk()
		const deps = { ...claimDeps(kv, sdk), withoutGas: () => true }
		connectJournalDeps(deps)
		const cached = mkFueled("0xprivgas", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		addRecord(cached)
		cacheSecret("0xprivgas", PRIV_SECRET, envelopeOf(cached, { salt: GAS_SALT }))
		await runDepositClaim("0xprivgas")
		expect(sdk.calls.map((c) => c.run.withoutGas)).toEqual([false])
		const sealed = mkSend("0xsealed", { isPrivate: true, secret: undefined, sealerL1: SEALER })
		sealed.sealedEnvelope = await sealEnvelopeFor(sealed)
		addRecord(sealed)
		await runDepositClaim("0xsealed", { interactive: false, watchOnly: true })
		const sent = mkSend("0xsealedsent", { isPrivate: true, secret: undefined, sealerL1: SEALER, claimTxHash: CLAIM_TX })
		sent.sealedEnvelope = await sealEnvelopeFor(sent)
		addRecord(sent)
		await runDepositClaim("0xsealedsent", { watchOnly: true })
		expect(deps.signL1).not.toHaveBeenCalled()
		expect(sdk.calls.map((c) => [c.view.id, c.run.watchOnly])).toEqual([
			["0xprivgas", false],
			["0xsealedsent", true],
		])
	})

	it("an unchecked network stops a claim not yet sent, with nothing sent", async () => {
		const sdk = fakeClaimSdk()
		sdk.network.mockRejectedValue(new Error("fetch failed"))
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkSend("0xunchecked"))
		await runDepositClaim("0xunchecked")
		expect(rt("0xunchecked")).toMatchObject({
			attention: "error",
			note: "This app could not check the bridge on this network. Nothing was sent.",
		})
		expect(sdk.network).toHaveBeenCalledTimes(1)
		expect(sdk.calls).toHaveLength(0)
	})

	it("a sent claim's network check retries through an unreachable node; the network's own refusal is the run's failure", async () => {
		const sdk = fakeClaimSdk()
		const details: (string | undefined)[] = []
		sdk.network.mockRejectedValueOnce(new Error("fetch failed")).mockRejectedValueOnce(new Error("fetch failed"))
		connectJournalDeps({
			...claimDeps(kv, sdk),
			waitMs: async () => {
				details.push(rt("0xretried")?.stepDetail)
			},
		})
		addRecord(mkSend("0xretried", { claimTxHash: CLAIM_TX }))
		await runDepositClaim("0xretried")
		expect(details).toEqual(["node unreachable — retrying (1)", "node unreachable — retrying (2)"])
		expect(depositOf("0xretried")?.completedAt).toBeDefined()

		sdk.network.mockRejectedValueOnce(bridgeError("wrong-aztec-network", {}, "the wallet is on another Aztec network"))
		addRecord(mkSend("0xrefused", { claimTxHash: CLAIM_TX }))
		await runDepositClaim("0xrefused")
		expect(rt("0xrefused")?.note).toMatch(/another Aztec network.*Your funds are not lost — retry from this card\./)
		expect(sdk.calls).toHaveLength(1)
	})

	it("a watching call stopped at a prompt ends quietly, unless its tokens landed: then the gas claim needs the wallet", async () => {
		const sdk = fakeClaimSdk()
		sdk.script("token", sendsClaim, async (c) => {
			c.emit({ type: "claim-landed", via: "claim", txHash: CLAIM_TX })
			throw bridgeError("needs-prompt")
		})
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkSend("0xunsent"))
		await runDepositClaim("0xunsent", { interactive: false })
		expect(rt("0xunsent")?.attention).toBeUndefined()
		addRecord(mkFueled("0xlanded", { claimTxHash: CLAIM_TX }))
		await runDepositClaim("0xlanded", { interactive: false })
		expect(rt("0xlanded")).toMatchObject({
			attention: "error",
			note: "The gas claim needs your wallet. Your tokens are unaffected — retry the gas claim from this card.",
		})
		expect(depositOf("0xlanded")?.completedAt).toBeUndefined()
	})

	const recovering =
		(stage: "searching" | "reading", e: unknown): ClaimScript =>
		async (c) => {
			c.emit(stage === "searching" ? { type: "deposit-recovery", stage } : { type: "deposit-recovery", stage, txHash: DEPOSIT_TX })
			throw e
		}
	const afterLanding =
		(e: unknown): ClaimScript =>
		async (c) => {
			c.emit({ type: "claim-landed", via: "claim", txHash: CLAIM_TX })
			throw e
		}
	it.each<[string, ClaimScript, string, RegExp]>([
		["a dropped claim", failsWith(bridgeError("claim-dropped")), "error", /dropped — claim again from this card/],
		["a reverted claim", failsWith(bridgeError("claim-reverted")), "error", /reverted on Aztec/],
		["a message that is not the record's", failsWith(bridgeError("message-invalid")), "tampered", /doesn't match its stored details/],
		["a deposit receipt that reverted", recovering("reading", bridgeError("deposit-reverted")), "error", /transaction reverted/],
		["no deposit found", recovering("searching", bridgeError("deposit-not-found", { search: "none" })), "error", /No deposit/],
		[
			"more than one deposit",
			recovering("searching", bridgeError("deposit-not-found", { search: "ambiguous" })),
			"unknown-outcome",
			/More than one matching deposit/,
		],
		["a search that failed", recovering("searching", bridgeError("read-failed")), "error", /could not be searched far enough/],
		["a failure after the tokens landed", afterLanding(bridgeError("claim-reverted")), "error", /Your tokens are unaffected/],
	])("%s leaves its card, and completes nothing", async (label, script, attention, note) => {
		const sdk = fakeClaimSdk()
		sdk.script("token", script)
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkSend("0xfailed"))
		// A proposed claim lit the rail; a claim the chain dropped or reverted must not keep it lit.
		useBridgeJournal().runtime.value = { "0xfailed": { confirmLandedTxHash: CLAIM_TX } }
		await runDepositClaim("0xfailed")
		expect(rt("0xfailed")).toMatchObject({ attention, note: expect.stringMatching(note) })
		if (/^a (dropped|reverted) claim$/.test(label)) expect(rt("0xfailed")?.confirmLandedTxHash).toBeUndefined()
		expect(depositOf("0xfailed")?.completedAt).toBeUndefined()
	})

	it("the SDK's writes queue on the journal lock: a write queued between two is kept, a remote discard refuses the next quietly", async () => {
		const locks = memoryJournalLocks()
		const sdk = fakeClaimSdk()
		sdk.script("token", async (c) => {
			await c.persist({ claimTxHash: CLAIM_TX })
			return c.settle("claim", { txHash: CLAIM_TX })
		})
		connectJournalDeps({ ...claimDeps(kv, sdk), locks })
		const interleaved = async (id: string, write: () => void) => {
			addRecord(mkSend(id))
			let release: () => void = () => {}
			const holder = locks.journal(
				() =>
					new Promise<void>((r) => {
						release = r
					}),
			)
			const run = runDepositClaim(id)
			// The claim's first write waits behind the holder; another writer queues behind it, before the claim's next.
			await vi.waitFor(() => expect(sdk.calls.some((c) => c.view.id === id)).toBe(true))
			const other = locks.journal(write)
			release()
			await Promise.all([holder, other, run])
		}
		await interleaved("0xkept", () => updateRecord("0xkept", { depositTxHash: DEPOSIT_TX }))
		expect(depositOf("0xkept")).toMatchObject({ claimTxHash: CLAIM_TX, depositTxHash: DEPOSIT_TX, completedAt: expect.any(Number) })

		await interleaved("0xgone", () => removeRecord(kv, "0xgone"))
		expect(currentRecord("0xgone")).toBeUndefined()
		expect(rt("0xgone")).toMatchObject({ attention: undefined, note: undefined })
		expect(useBridgeJournal().lastCompleted.value?.id).toBe("0xkept")
	})

	it("a write the record no longer takes is refused quietly; a remote completion stands, with no toast; a storage failure is the run's", async () => {
		const sdk = fakeClaimSdk()
		// Another tab's write lands while the claim runs: a different deposit under the id, or its own completion.
		const otherTab: Record<string, () => void> = {
			"0xreplaced": () => upsertRecord(kv, { ...mkSend("0xreplaced"), amount: "1" }),
			"0xracedone": () => upsertRecord(kv, { ...mkSend("0xracedone"), completedAt: 12345 }),
		}
		sdk.script("token", async (c) => {
			otherTab[c.record.id]?.()
			return sendsClaim(c)
		})
		connectJournalDeps(claimDeps(kv, sdk))
		for (const id of Object.keys(otherTab)) {
			addRecord(mkSend(id))
			await runDepositClaim(id)
			expect(rt(id)).toMatchObject({ attention: undefined, note: undefined })
		}
		expect([currentRecord("0xreplaced")?.amount, currentRecord("0xreplaced")?.completedAt]).toEqual(["1", undefined])
		expect(currentRecord("0xracedone")?.completedAt).toBe(12345)
		expect(useBridgeJournal().lastCompleted.value).toBeNull()

		addRecord(mkSend("0xfull"))
		connectJournalDeps({
			kv: {
				...kv,
				setItem: () => {
					throw new Error("QuotaExceededError: the quota has been exceeded")
				},
			},
		})
		await runDepositClaim("0xfull")
		expect(rt("0xfull")).toMatchObject({ attention: "error", note: expect.stringMatching(/quota.*funds are not lost/i) })
	})

	it("a record another tab holds is skipped (held elsewhere) and runs once the holder releases", async () => {
		const locks = memoryJournalLocks()
		const sdk = fakeClaimSdk()
		connectJournalDeps({ ...claimDeps(kv, sdk), locks })
		addRecord(mkSend("0xheld"))
		let release: () => void = () => {}
		const holder = locks.record(
			"0xheld",
			() =>
				new Promise<void>((r) => {
					release = r
				}),
		)
		await runDepositClaim("0xheld")
		expect(sdk.calls).toHaveLength(0)
		expect(rt("0xheld")?.busy).toBeFalsy()
		expect(rt("0xheld")?.note).toMatch(/another tab is claiming/i)
		release()
		await holder
		await runDepositClaim("0xheld")
		expect(sdk.calls).toHaveLength(1)
		expect(depositOf("0xheld")?.completedAt).toBeDefined()
	})

	it("two immediate starts in one tab under a delayed lock grant: the second is a local duplicate, never a cross-tab note", async () => {
		// A lock table that grants only when told to, so both starts are pending together.
		let grant: () => void = () => {}
		const granted = new Promise<void>((r) => {
			grant = r
		})
		const locks = {
			...memoryJournalLocks(),
			record: async <T>(_id: string, fn: () => Promise<T>) => {
				await granted
				return fn()
			},
		}
		const sdk = fakeClaimSdk()
		let releaseClaim: () => void = () => {}
		const claimHeld = new Promise<void>((r) => {
			releaseClaim = r
		})
		sdk.script("token", async (c) => {
			await c.hold(claimHeld)
			return sendsClaim(c)
		})
		connectJournalDeps({ ...claimDeps(kv, sdk), locks })
		addRecord(mkSend("0xtwice"))
		const first = runDepositClaim("0xtwice")
		const second = runDepositClaim("0xtwice")
		grant()
		await new Promise((r) => setTimeout(r, 0))
		await second
		// While the first runner still waits on its claim, the loser left no cross-tab note.
		expect(rt("0xtwice")).toMatchObject({ note: undefined, busy: true })
		releaseClaim()
		await first
		expect(sdk.calls).toHaveLength(1)
		expect(depositOf("0xtwice")?.completedAt).toBeDefined()
	})

	it("a private record missing its leaves recovers them in a watching call before the unseal signature, then claims with its salts", async () => {
		const sdk = fakeClaimSdk()
		const order: string[] = []
		sdk.script(
			"token",
			async (c) => {
				order.push(`call:${c.run.watchOnly ? "watch" : "claim"}`)
				c.emit({ type: "deposit-recovery", stage: "reading", txHash: DEPOSIT_TX })
				order.push(`step:${rt(c.record.id)?.step}`)
				await c.persist({ leafIndex: "7", messageHash: MESSAGE_HASH })
				c.emit({ type: "deposit-confirmed", leaves: {} })
				throw new Error("the facts-only call ran past its facts")
			},
			async (c) => {
				order.push(`call:${c.run.watchOnly ? "watch" : "claim"}`)
				return sendsClaim(c)
			},
		)
		const signL1 = vi.fn(async () => {
			order.push("signature")
			return SIG
		})
		connectJournalDeps({ ...claimDeps(kv, sdk), signL1 })
		const hashless = mkSend("0xfacts", {
			isPrivate: true,
			secret: undefined,
			sealerL1: SEALER,
			leafIndex: undefined,
			messageHash: undefined,
			depositTxHash: DEPOSIT_TX,
		})
		hashless.sealedEnvelope = await sealEnvelopeFor(mkSend("0xfacts"), { salt: GAS_SALT })
		addRecord(hashless)
		await runDepositClaim("0xfacts")
		expect(order).toEqual(["call:watch", "step:depositing", "signature", "call:claim"])
		const [facts, claim] = sdk.calls
		expect(facts?.run.secrets).toBeUndefined()
		expect([claim?.view.leafIndex, claim?.run.secrets?.claimSalt?.toString(), claim?.run.secrets?.fuelSalt?.toString()]).toEqual([
			"7",
			PRIV_SECRET,
			GAS_SALT,
		])
		expect(depositOf("0xfacts")?.completedAt).toBeDefined()
	})

	it("a deposit Ethereum has not confirmed costs no signature, and the card says so", async () => {
		const sdk = fakeClaimSdk()
		sdk.script("token", async (c) => {
			c.emit({ type: "deposit-recovery", stage: "waiting", txHash: DEPOSIT_TX })
			await c.hold()
			throw new Error("the wait outlived the engine's stop")
		})
		const deps = claimDeps(kv, sdk)
		connectJournalDeps(deps)
		const hashless = mkSend("0xunmined", {
			isPrivate: true,
			secret: undefined,
			sealerL1: SEALER,
			leafIndex: undefined,
			depositTxHash: DEPOSIT_TX,
		})
		hashless.sealedEnvelope = await sealEnvelopeFor(mkSend("0xunmined"))
		addRecord(hashless)
		await runDepositClaim("0xunmined")
		expect(rt("0xunmined")).toMatchObject({ attention: "error", note: "The Ethereum deposit isn't confirmed yet — retry in a minute." })
		expect(deps.signL1).not.toHaveBeenCalled()
		expect(sdk.calls).toHaveLength(1)
	})

	it("a watching call leaves a marked record open and drops a marker the chain contradicts", async () => {
		const sdk = fakeClaimSdk()
		sdk.script("token", async (c) => {
			if (c.record.id === "0xtrue") throw bridgeError("needs-prompt")
			await c.persist({ claimedByOther: undefined })
			// Whatever the watch meets after the marker is gone, the ordinary claim is the record's next step.
			throw bridgeError("message-timeout")
		})
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkSend("0xtrue", { claimedByOther: true }))
		addRecord(mkSend("0xfalse", { claimedByOther: true }))
		resumeSessionWork()
		await vi.waitFor(() => expect(depositOf("0xfalse")?.claimedByOther).toBeUndefined())
		await vi.waitFor(() => expect([rt("0xtrue")?.busy, rt("0xfalse")?.busy]).toEqual([false, false]))
		expect(sdk.calls.map((c) => [c.view.id, c.run.watchOnly])).toEqual([
			["0xtrue", true],
			["0xfalse", true],
		])
		expect([depositOf("0xtrue")?.completedAt, depositOf("0xtrue")?.claimedByOther]).toEqual([undefined, true])
		for (const id of ["0xtrue", "0xfalse"]) expect(rt(id)).toMatchObject({ attention: undefined, note: undefined })
		expect(depositOf("0xfalse")?.completedAt).toBeUndefined()
	})

	it("a click on a marked record runs one non-watching token call after the watch; a resume leaves it open", async () => {
		const sdk = fakeClaimSdk()
		sdk.script("token", async (c) => {
			if (c.run.watchOnly) throw bridgeError("needs-prompt")
			return c.settle("claimed-elsewhere")
		})
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkFueled("0xresumed", { claimedByOther: true }))
		await runDepositClaim("0xresumed", { interactive: false })
		expect(rt("0xresumed")?.attention).toBeUndefined()
		expect(depositOf("0xresumed")?.completedAt).toBeUndefined()
		addRecord(mkFueled("0xclicked", { claimedByOther: true }))
		await runDepositClaim("0xclicked")
		// The SDK's one call settles the tokens and claims the gas they left: the app makes no gas call of its own.
		expect(sdk.calls.map((c) => [c.view.id, c.entry, c.run.watchOnly])).toEqual([
			["0xresumed", "token", true],
			["0xclicked", "token", true],
			["0xclicked", "token", false],
		])
		expect([depositOf("0xclicked")?.completedAt !== undefined, depositOf("0xclicked")?.claimedByOther]).toEqual([true, true])
	})

	it("a marked private record: a resume without its material reads nothing; a click unseals once and verifies", async () => {
		const sdk = fakeClaimSdk()
		sdk.script("token", async (c) => {
			await c.persist({ claimedByOther: undefined })
			throw bridgeError("needs-prompt")
		})
		const deps = claimDeps(kv, sdk)
		connectJournalDeps(deps)
		const priv = mkSend("0xpriv", { isPrivate: true, secret: undefined, sealerL1: SEALER, claimedByOther: true })
		priv.sealedEnvelope = await sealEnvelopeFor(priv)
		addRecord(priv)
		await runDepositClaim("0xpriv", { interactive: false })
		expect(sdk.deps.claimContext).not.toHaveBeenCalled()
		expect(deps.signL1).not.toHaveBeenCalled()
		await runDepositClaim("0xpriv")
		expect(deps.signL1).toHaveBeenCalledTimes(1)
		expect(sdk.calls.map((c) => [c.run.watchOnly, c.run.secrets?.claimSalt?.toString()])).toEqual([[true, PRIV_SECRET]])
		expect(depositOf("0xpriv")?.claimedByOther).toBeUndefined()
	})

	it("a marker without its message hash, or beside a sent claim, is ignored: the ordinary claim runs", async () => {
		const sdk = fakeClaimSdk()
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkSend("0xnohash", { messageHash: undefined, claimedByOther: true }))
		addRecord(mkSend("0xsent", { claimTxHash: CLAIM_TX, claimedByOther: true }))
		await runDepositClaim("0xnohash")
		await runDepositClaim("0xsent")
		expect(sdk.calls.map((c) => [c.view.id, c.run.watchOnly])).toEqual([
			["0xnohash", false],
			["0xsent", false],
		])
	})

	it("a schema-1 Fee Juice record has nothing to claim, and says so", async () => {
		const sdk = fakeClaimSdk()
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkDeposit("0xschema1"))
		await runDepositClaim("0xschema1")
		expect(rt("0xschema1")?.note).toMatch(/This Fuel bridge has no claimable Fee Juice.*retry from this card/)
		expect(sdk.deps.claimContext).not.toHaveBeenCalled()
	})

	it("missing leaves nothing here recovers wait quietly; a legacy record with its deposit hash is told it predates the send", async () => {
		const sdk = fakeClaimSdk()
		connectJournalDeps(claimDeps(kv, sdk))
		const gas = { amount: "10", secret: "0xfuelsecret", minOutput: "9" }
		const legacy = (id: string, over: Partial<DepositJournalRecord> = {}) =>
			mkDeposit(id, { schema: 2, fuel: { ...gas, secretHashHex: `${id}f` }, ...over })
		addRecord(legacy("0xlegacyquiet"))
		addRecord(mkGasOnly("0xgasquiet", { fuel: { ...gas, secretHashHex: "0xgasquiet" } }))
		addRecord(legacy("0xlegacyhash", { depositTxHash: DEPOSIT_TX }))
		// A hash-less hub send is not left alone: the SDK's claim searches Ethereum for it.
		addRecord(mkSend("0xhubsearch", { leafIndex: undefined, messageHash: undefined }))
		// A legacy record holding its gas leg's facts claims through the Fee Juice entry, as a gas-only send.
		addRecord(
			legacy("0xlegacyfull", { fuel: { ...gas, secretHashHex: "0xlf", leafIndex: "7", messageHash: MESSAGE_HASH, received: "5" } }),
		)
		for (const id of ["0xlegacyquiet", "0xgasquiet", "0xlegacyhash", "0xhubsearch", "0xlegacyfull"]) await runDepositClaim(id)
		expect([rt("0xlegacyquiet")?.attention, rt("0xgasquiet")?.attention]).toEqual([undefined, undefined])
		expect(rt("0xlegacyhash")).toMatchObject({ attention: "error", note: expect.stringMatching(/predates the current bridge/) })
		expect(sdk.calls.map((c) => [c.view.id, c.entry, c.view.intent])).toEqual([
			["0xhubsearch", "token", "token"],
			["0xlegacyfull", "fuel", "gas"],
		])
	})

	it("the card's gas claim never runs beside the record's own claim, and leaves the card idle while it runs", async () => {
		const sdk = fakeClaimSdk()
		let release: () => void = () => {}
		const held = new Promise<void>((r) => {
			release = r
		})
		sdk.script("token", async (c) => {
			await c.hold(held)
			return sendsClaim(c)
		})
		const busy: unknown[] = []
		sdk.script("fuel", async (c) => {
			busy.push(rt(c.record.id)?.busy)
			await c.persist({ fuel: { ...(c.record.fuel as NonNullable<DepositRecord["fuel"]>), consumed: true } })
			return { record: c.record, via: "claim" as const }
		})
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkFueled("0xrunning"))
		const running = runDepositClaim("0xrunning")
		await vi.waitFor(() => expect(sdk.calls).toHaveLength(1))
		await runGasClaim("0xrunning")
		release()
		await running
		addRecord(mkFueled("0xdone", { completedAt: 5 }))
		await runGasClaim("0xdone")
		expect(sdk.calls.map((c) => [c.view.id, c.entry])).toEqual([
			["0xrunning", "token"],
			["0xdone", "fuel"],
		])
		expect(busy).toEqual([undefined])
		expect(depositOf("0xdone")?.fuel?.consumed).toBe(true)
	})

	it("the card's gas claim finishes the record through a non-watching token call, and throws its failure's words", async () => {
		const sdk = fakeClaimSdk()
		sdk.script(
			"fuel",
			async (c) => ({ record: c.record, via: "claim" as const }),
			failsWith(bridgeError("fee-stop", { stop: "fuel-short" })),
		)
		sdk.script("token", async (c) => {
			if (c.run.watchOnly) throw bridgeError("needs-prompt")
			return c.settle("claimed-elsewhere")
		})
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkFueled("0xleft", { claimedByOther: true }))
		await runGasClaim("0xleft")
		expect(sdk.calls.map((c) => [c.entry, c.run.watchOnly])).toEqual([
			["fuel", false],
			["token", true],
			["token", false],
		])
		expect(depositOf("0xleft")?.completedAt).toBeDefined()
		addRecord(mkFueled("0xshort", { completedAt: 5 }))
		await expect(runGasClaim("0xshort")).rejects.toThrow(/under the private claim's fee ceiling/)
	})

	it("the card's gas claim says it has not confirmed when its watch runs out or it is dropped; a retry gets the sent claim", async () => {
		const sdk = fakeClaimSdk()
		sdk.script(
			"fuel",
			async (c) => {
				await c.persist({ fuel: { ...c.record.fuel, claimTxHash: CLAIM_TX } } as never)
				return pollsForever(c)
			},
			async (c) => ({ record: c.record, via: "claim" as const }),
			failsWith(bridgeError("claim-dropped")),
		)
		connectJournalDeps(claimDeps(kv, sdk))
		addRecord(mkFueled("0xslow", { completedAt: 5 }))
		await expect(runGasClaim("0xslow")).rejects.toThrow("The gas claim was sent but hasn't confirmed yet")
		expect(depositOf("0xslow")?.fuel?.claimTxHash).toBe(CLAIM_TX)
		await runGasClaim("0xslow")
		expect(sdk.calls[1]?.view.fuel?.claimTxHash).toBe(CLAIM_TX)
		addRecord(mkFueled("0xdropped", { completedAt: 5 }))
		await expect(runGasClaim("0xdropped")).rejects.toThrow("The gas claim was sent but hasn't confirmed yet")
	})

	it("a discard waiting for the journal lock reads as gone at once, and no reload brings the record back", async () => {
		const locks = memoryJournalLocks()
		connectJournalDeps({ ...claimDeps(kv, fakeClaimSdk()), locks })
		addRecord(mkSend("0xgone"))
		addRecord(mkSend("0xother"))
		let release: () => void = () => {}
		const held = new Promise<void>((r) => {
			release = r
		})
		const holder = locks.journal(() => held)
		const removed = discard("0xgone")
		expect(currentRecord("0xgone")).toBeUndefined()
		updateRecord("0xother", { depositTxHash: DEPOSIT_TX })
		expect(useBridgeJournal().records.value.map((r) => r.id)).toEqual(["0xother"])
		release()
		await Promise.all([holder, removed])
		expect(kv.getItem(JOURNAL_KEY)).not.toContain("0xgone")
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
		const sdk = fakeClaimSdk()
		sdk.script("token", failsWith(new Error("boom sentinel-error")))
		connectJournalDeps(sdk.deps)
		addRecord(mkSend("0xsentinel", { secret: "0xsentinelsecret" }))
		setRecordStep("0xsentinel", "sending", "sentinel-detail")
		await runDepositClaim("0xsentinel")
		expect(useBridgeJournal().runtime.value["0xsentinel"]?.note).toMatch(/sentinel-error/)
		expect(texts("0xsentinel").length).toBeGreaterThan(0)
		expect(JSON.stringify(texts("0xsentinel"))).not.toMatch(/sentinel/i)
		setRecordStep("0xsentinel", "sending", "retrying")
		expect(texts("0xsentinel").filter((t) => t === "claiming on Aztec")).toHaveLength(2)
	})
})

describe("useBridgeJournal - the engine's own writes under the journal lock", () => {
	let kv: KV
	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
	})

	const DAY = 24 * 60 * 60 * 1000
	const REASON = "This bridge's token details changed on Ethereum."
	const HASH = "0x0015000000000000000000000000000000000000000000636f6e73756d657478"
	const PRIOR = "0x0018000000000000000000000000000000000000000000000000007072696f72"
	const stored = (id: string) => loadJournal(kv).find((r) => r.id === id) as SendWithdrawRecord | undefined
	type Deps = ReturnType<typeof baseDeps>
	const armed = <T>(arm: () => Promise<void>, value: T) =>
		vi.fn(async () => {
			await arm()
			return value
		})

	// Each case arms the other tab's hold from the dep the engine calls just before the write under test.
	it.each([
		{
			write: "a lane's block check",
			seed: mkWithdraw("0xexit"),
			wire: (d: Deps, arm: () => Promise<void>) => {
				d.validateTokenBlock = armed(arm, REASON)
			},
			run: () => runWithdrawConsume("0xexit"),
			check: () => expect(stored("0xexit")?.blocked).toBe(REASON),
		},
		{
			write: "the attestation's block",
			seed: mkSend("0xsend"),
			wire: (d: Deps, arm: () => Promise<void>) => {
				d.validateTokenBlock = armed(arm, REASON)
			},
			run: () => attestSendTokenBlocks(),
			// The other tab's record holds the same token: the selection reads the stored copy, not this tab's view.
			check: () => expect([stored("0xsend")?.blocked, stored("0xother")?.blocked]).toEqual([REASON, REASON]),
		},
		{
			write: "the consume hash",
			seed: mkWithdraw("0xfresh"),
			wire: (d: Deps, arm: () => Promise<void>) => {
				d.consumeSend = armed(arm, { consumeTxHash: HASH })
			},
			run: () => runWithdrawConsume("0xfresh"),
			check: () => expect(stored("0xfresh")?.consumeTxHash).toBe(HASH),
		},
		{
			write: "the completion",
			seed: mkWithdraw("0xfresh"),
			wire: (d: Deps, arm: () => Promise<void>) => {
				d.waitConsumeReceipt = armed(arm, true)
			},
			run: () => runWithdrawConsume("0xfresh"),
			check: () => expect(stored("0xfresh")?.completedAt).toBe(999),
		},
		{
			write: "a failed receipt's clear",
			seed: mkWithdraw("0xfresh"),
			wire: (d: Deps, arm: () => Promise<void>) => {
				d.waitConsumeReceipt = armed(arm, false)
			},
			run: () => runWithdrawConsume("0xfresh"),
			check: () => expect([stored("0xfresh")?.exitTxHash, stored("0xfresh")?.consumeTxHash]).toEqual(["0xfresh", undefined]),
		},
		{
			write: "a prior hash's clear",
			seed: mkWithdraw("0xexit", { consumeTxHash: PRIOR }),
			wire: (d: Deps, arm: () => Promise<void>) => {
				d.waitConsumeReceipt = armed(arm, false)
			},
			run: () => runWithdrawConsume("0xexit"),
			check: () => expect([stored("0xexit")?.exitTxHash, stored("0xexit")?.consumeTxHash]).toEqual(["0xexit", undefined]),
		},
	])("$write queues behind another tab's journal write, so neither is lost", async ({ seed, wire, run, check }) => {
		const tab = otherTab()
		const deps = baseDeps(kv)
		wire(deps, () => tab.hold(kv, JOURNAL_KEY, mkSend("0xother")))
		connectJournalDeps({ ...deps, locks: tab.locks })
		addRecord(seed)
		useBridgeJournal()
		const running = run()
		await vi.waitFor(() => expect(tab.behind).toBe(1))
		expect(kv.getItem(JOURNAL_KEY)).toBe(tab.loaded)
		await tab.release()
		await running
		expect(stored("0xother")).toBeDefined()
		check()
	})

	it.each([
		{ remote: 5, completedAt: 5, raised: false },
		{ remote: undefined, completedAt: 999, raised: true },
	])("a completion another tab stored ($remote) is kept, and only this tab's own raises one", async ({ remote, completedAt, raised }) => {
		const deps = baseDeps(kv)
		deps.waitConsumeReceipt = vi.fn(async () => {
			// Another tab finished the exit; no storage event has reached this tab.
			if (remote !== undefined) upsertRecord(kv, { ...(stored("0xfresh") as SendWithdrawRecord), completedAt: remote })
			return true
		})
		connectJournalDeps(deps)
		addRecord(mkWithdraw("0xfresh"))
		await runWithdrawConsume("0xfresh")
		expect(stored("0xfresh")?.completedAt).toBe(completedAt)
		expect(useBridgeJournal().lastCompleted.value?.id === "0xfresh").toBe(raised)
	})

	it("a completion keeps its takeover in the toast when a watcher releases the takeover on completedAt", async () => {
		connectJournalDeps(baseDeps(kv))
		addRecord(mkWithdraw("0xfresh"))
		claimForeground("0xfresh")
		const { records, lastCompleted } = useBridgeJournal()
		const stop = watch(
			() => records.value.find((r) => r.id === "0xfresh")?.completedAt,
			(at) => at && releaseForeground("0xfresh"),
		)
		await runWithdrawConsume("0xfresh")
		stop()
		expect(activeFlowId.value).toBeNull()
		expect(lastCompleted.value?.foreground).toBe(true)
	})

	it("the startup prune waits for another tab's journal write, and its expired row never shows", async () => {
		const tab = otherTab()
		connectJournalDeps({ ...baseDeps(kv), now: () => 8 * DAY, locks: tab.locks })
		upsertRecord(kv, mkDeposit("0xold", { completedAt: 1, claimTxHash: CLAIM_TX }))
		upsertRecord(kv, mkDeposit("0xlive"))
		tab.hold(kv, JOURNAL_KEY, mkSend("0xother"))
		const { records } = useBridgeJournal()
		expect(records.value.map((r) => r.id)).toEqual(["0xlive"])
		await vi.waitFor(() => expect(tab.behind).toBe(1))
		expect(kv.getItem(JOURNAL_KEY)).toBe(tab.loaded)
		await tab.release()
		await vi.waitFor(() => expect(loadJournal(kv).map((r) => r.id)).toEqual(["0xlive", "0xother"]))
		expect(records.value.map((r) => r.id)).toEqual(["0xlive", "0xother"])
	})

	it("a prune whose write fails keeps its expired row hidden and both rows stored", async () => {
		upsertRecord(kv, mkDeposit("0xold", { completedAt: 1, claimTxHash: CLAIM_TX }))
		upsertRecord(kv, mkDeposit("0xlive"))
		const before = kv.getItem(JOURNAL_KEY)
		const setItem = vi.fn(() => {
			throw new Error("QuotaExceededError")
		})
		connectJournalDeps({ ...baseDeps({ ...kv, setItem }), now: () => 8 * DAY })
		const { records } = useBridgeJournal()
		await vi.waitFor(() => expect(setItem).toHaveBeenCalled())
		await new Promise((r) => setTimeout(r, 0))
		expect(records.value.map((r) => r.id)).toEqual(["0xlive"])
		expect(kv.getItem(JOURNAL_KEY)).toBe(before)
	})

	it("the startup prune takes the browser's journal lock before any composable connects one", async () => {
		let grant = () => {}
		const request = vi.fn(
			(_name: string, granted: (lock: unknown) => unknown) =>
				new Promise((resolve) => {
					grant = () => resolve(granted({}))
				}),
		)
		vi.stubGlobal("navigator", { locks: { request } })
		try {
			__resetJournalForTests()
			upsertRecord(kv, mkDeposit("0xold", { completedAt: 1, claimTxHash: CLAIM_TX }))
			connectJournalDeps({ kv, now: () => 8 * DAY })
			useBridgeJournal()
			expect(request).toHaveBeenCalledWith(JOURNAL_LOCK, expect.any(Function))
			expect(stored("0xold")).toBeDefined()
			grant()
			await vi.waitFor(() => expect(stored("0xold")).toBeUndefined())
		} finally {
			vi.unstubAllGlobals()
			__resetJournalForTests()
		}
	})
})
