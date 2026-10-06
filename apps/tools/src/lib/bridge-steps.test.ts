import type { BridgeJournalRecord, DepositJournalRecord, SendDepositRecord, WithdrawJournalRecord } from "@unleashed/bridge-core"
import { describe, expect, it } from "vitest"
import type { RecordRuntime } from "@/composables/useBridgeJournal"
import { isTerminalAttention, logPhrase, overallProgress, stepperPhases } from "./bridge-steps"

const DEPLOY = { chainId: 11155111, portal: "0xportal", bridge: "0xbridge" }

function dep(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id: "0xd",
		direction: "deposit",
		isPrivate: true,
		amount: "100000000",
		createdAt: 1,
		updatedAt: 1,
		recipient: "0xa",
		secretHashHex: "0xd",
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
		amount: "40000000",
		createdAt: 1,
		updatedAt: 1,
		recipientL1: "0xe",
		exitTxHash: "0xw",
		...DEPLOY,
		...over,
	}
}

const states = (rec: BridgeJournalRecord, rt: RecordRuntime = {}) => Object.fromEntries(stepperPhases(rec, rt).map((p) => [p.key, p.state]))

/** The key of the one non-pending, non-done phase - the rail's cursor. */
const sendActive = (rec: BridgeJournalRecord, rt: RecordRuntime = {}) => stepperPhases(rec, rt).find((p) => p.state === "active")?.key

describe("stepperPhases - fuel (fee-juice) records", () => {
	const fuelRec = (over: Partial<DepositJournalRecord> = {}): DepositJournalRecord =>
		dep({ schema: 2, assetKind: "fee-juice", fuel: { amount: "1", secret: "0x1", secretHashHex: "0x2", minOutput: "0" }, ...over })

	it("a public fuel record shows NO approve step by default (sufficient allowance = no step at all)", () => {
		expect(stepperPhases(fuelRec({ isPrivate: false }), {}).map((p) => p.key)).toEqual(["sign", "deposit", "sync", "claim", "confirm"])
	})

	it("APPROVE materializes only while a real approval runs (rt.step approving), active", () => {
		const phases = stepperPhases(fuelRec({ isPrivate: true }), { step: "approving" })
		expect(phases.map((p) => p.key)).toEqual(["seal", "approve", "sign", "deposit", "sync", "claim", "confirm"])
		expect(phases.find((p) => p.key === "approve")?.state).toBe("active")
	})

	it("claim is labelled CLAIM GAS and deposit is plain DEPOSIT (gas-only, no token/swap leg)", () => {
		const phases = stepperPhases(fuelRec({ isPrivate: false }), {})
		expect(phases.find((p) => p.key === "claim")?.label).toBe("Claim gas")
		expect(phases.find((p) => p.key === "deposit")?.label).toBe("Deposit")
	})
})

describe("stepperPhases - deposit matrix", () => {
	it("private fresh record mid-seal: SEAL active, the rest pending", () => {
		expect(states(dep(), { step: "sealing" })).toEqual({
			seal: "active",
			sign: "pending",
			deposit: "pending",
			sync: "pending",
			claim: "pending",
			confirm: "pending",
		})
	})

	it("public records have NO seal phase (SIGN-first, no approve — the token pre-approves Permit2)", () => {
		const keys = stepperPhases(dep({ isPrivate: false }), {}).map((p) => p.key)
		expect(keys).toEqual(["sign", "deposit", "sync", "claim", "confirm"])
	})

	it("signing: SEAL done, SIGN active", () => {
		const s = states(dep(), { step: "signing" })
		expect(s.seal).toBe("done")
		expect(s.sign).toBe("active")
	})

	it("APPROVE renders only when an approval was part of this run (fuel-only, the sole approve path)", () => {
		// Only fuel-only can need a one-time Permit2 APPROVE (bridge-only pre-approves via the token).
		// A sufficient allowance renders no step at all; a completed approval stays visible as done for
		// the rest of the run; after a reload the ephemeral outcome is gone and the step isn't shown
		// (honest - a retry re-checks the allowance idempotently).
		const base = dep({
			assetKind: "fee-juice",
			fuel: { amount: "1", secret: "0x1", secretHashHex: "0x2", minOutput: "0" },
			isPrivate: false,
			depositTxHash: "0xt",
		})
		expect(states(base, { approveOutcome: "done" }).approve).toBe("done")
		expect(states(base, {}).approve).toBeUndefined() // absent runtime (reload / never needed) - no step
	})

	it("depositTxHash without leafIndex: DEPOSIT active (waiting for Ethereum)", () => {
		const phases = stepperPhases(dep({ depositTxHash: "0xt" }), {})
		const deposit = phases.find((p) => p.key === "deposit")
		expect(deposit?.state).toBe("active")
		expect(deposit?.detail).toMatch(/waiting for the ethereum confirmation/i)
	})

	it("leafIndex zone: SYNC active by default; runtime sending/unsealing advances to CLAIM", () => {
		const rec = dep({ depositTxHash: "0xt", leafIndex: "7" })
		expect(states(rec, { step: "syncing" }).sync).toBe("active")
		expect(states(rec, { step: "sending" }).claim).toBe("active")
		expect(states(rec, { step: "unsealing" }).claim).toBe("active")
	})

	it("a post-gate failure lands its X on CLAIM, never on a completed CROSSING (claimable attribution)", () => {
		const rec = dep({ depositTxHash: "0xt", leafIndex: "7" })
		const s = states(rec, { claimable: true, attention: "error", note: "the prompt timed out" })
		expect(s.claim).toBe("failed")
		expect(s.sync).toBe("done")
	})

	it("monotonic latch: a cleared step between engine rounds cannot regress the phase", () => {
		const rec = dep({ depositTxHash: "0xt", leafIndex: "7", claimTxHash: "0xc" })
		const withStep = states(rec, { step: "confirming" })
		const cleared = states(rec, {})
		expect(withStep.confirm).toBe("active")
		expect(cleared.confirm).toBe("active") // facts hold the zone; no flicker to pending
		expect(cleared.claim).toBe("done")
	})

	it("completedAt: everything done", () => {
		const s = states(dep({ claimTxHash: "0xc", completedAt: 9 }), {})
		expect(Object.values(s).every((v) => v === "done")).toBe(true)
	})

	it("error attention fails the ACTIVE phase with the note as detail", () => {
		const phases = stepperPhases(dep({ depositTxHash: "0xt", leafIndex: "7" }), { attention: "error", note: "boom" })
		const sync = phases.find((p) => p.key === "sync")
		expect(sync?.state).toBe("failed")
		expect(sync?.detail).toBe("boom")
	})

	it("active detail prefers live stepDetail over the static prompt", () => {
		const phases = stepperPhases(dep({ depositTxHash: "0xt", leafIndex: "7", claimTxHash: "0xc" }), {
			step: "confirming",
			stepDetail: "check 12",
		})
		expect(phases.find((p) => p.key === "confirm")?.detail).toBe("check 12")
	})
})

describe("stepperPhases - determinate progress + ETA (only where real targets exist)", () => {
	it("SYNC carries block progress from the snapshot + live syncBlock", () => {
		const rec = dep({ depositTxHash: "0xt", leafIndex: "7", depositL2Block: 100 })
		const sync = stepperPhases(rec, { step: "syncing", syncBlock: 102 }).find((p) => p.key === "sync")
		expect(sync?.progress).toEqual({ current: 102, target: 103, fraction: 2 / 3 })
		expect(sync?.eta).toBe("usually 1-4 min")
		expect(sync?.detail).toBe("Aztec picks up deposits every few blocks. Nothing for you to do.")
		// The live checkpoint count replaces the static sentence while the gate waits.
		const live = stepperPhases(rec, { step: "syncing", stepDetail: "2 checkpoints until your funds arrive" }).find(
			(p) => p.key === "sync",
		)
		expect(live?.detail).toBe("2 checkpoints until your funds arrive")
	})

	it("pending phases that wait on the chain carry a short estimate; signature phases and the live phase carry none", () => {
		const phases = stepperPhases(dep({ depositTxHash: "0xt" }))
		expect(Object.fromEntries(phases.map((p) => [p.key, p.estimate]))).toEqual({
			seal: undefined,
			sign: undefined,
			deposit: undefined,
			sync: "~1–4 min",
			claim: undefined,
			confirm: "~1–2 min",
		})
		expect(stepperPhases(dep({ isPrivate: false })).find((p) => p.key === "deposit")?.estimate).toBe("~1 min")
		const exit = stepperPhases(wd({ exitTxHash: undefined }))
		expect(exit.map((p) => p.estimate)).toEqual([undefined, "tens of min", undefined, "~2 min"])
		expect(exit[0].eta).toBe("your signatures + a few sec")
	})

	it("a failed or blocked run promises no duration on its pending phases", () => {
		const estimates = (rec: BridgeJournalRecord, rt: RecordRuntime = {}) => stepperPhases(rec, rt).map((p) => p.estimate)
		expect(estimates(dep({ depositTxHash: "0xt" }), { attention: "error", note: "boom" }).every((e) => e === undefined)).toBe(true)
		expect(estimates(dep({ depositTxHash: "0xt", blocked: "stopped" })).every((e) => e === undefined)).toBe(true)
	})

	it("SYNC without a snapshot or live block has NO bar (never fabricate determinism)", () => {
		expect(
			stepperPhases(dep({ depositTxHash: "0xt", leafIndex: "7" }), { step: "syncing" }).find((p) => p.key === "sync")?.progress,
		).toBeUndefined()
		expect(
			stepperPhases(dep({ depositTxHash: "0xt", leafIndex: "7", depositL2Block: 100 }), { step: "syncing" }).find(
				(p) => p.key === "sync",
			)?.progress,
		).toBeUndefined()
	})

	it("SYNC without a snapshot counts the gate's checkpoints against the first reading; the snapshot wins; a zero span shows none", () => {
		const sync = (rec: DepositJournalRecord, rt: RecordRuntime) =>
			stepperPhases(rec, { step: "syncing", ...rt }).find((p) => p.key === "sync")
		const crossing = dep({ depositTxHash: "0xt", leafIndex: "7" })
		expect(sync(crossing, { checkpointsLeft: 3, checkpointSpan: 3 })?.progress).toEqual({ current: 0, target: 3, fraction: 0 })
		expect(sync(crossing, { checkpointsLeft: 1, checkpointSpan: 3 })?.progress).toEqual({ current: 2, target: 3, fraction: 2 / 3 })
		expect(sync(crossing, { checkpointsLeft: 0, checkpointSpan: 0 })?.progress).toBeUndefined()
		const snapshot = dep({ depositTxHash: "0xt", leafIndex: "7", depositL2Block: 100 })
		expect(sync(snapshot, { syncBlock: 101, checkpointsLeft: 1, checkpointSpan: 3 })?.progress).toEqual({
			current: 101,
			target: 103,
			fraction: 1 / 3,
		})
	})

	it("PROVE carries proven-block progress from the first proven block it saw; CONFIRM never gets a bar", () => {
		const share = (provenBlock: number, provenFrom?: number) =>
			stepperPhases(wd(), { provenBlock, targetBlock: 50_000, provenFrom }).find((p) => p.key === "prove")?.progress
		// Absolute block numbers: the proven tip sits just under the exit's block from the start.
		expect(share(49_920, 49_920)).toEqual({ current: 49_920, target: 50_000, fraction: 0 })
		expect(share(49_960, 49_920)).toEqual({ current: 49_960, target: 50_000, fraction: 0.5 })
		// Without an anchor there is no honest share to show.
		expect(share(49_960)).toBeUndefined()
		const confirm = stepperPhases(dep({ depositTxHash: "0xt", leafIndex: "7", claimTxHash: "0xc" }), { step: "confirming" }).find(
			(p) => p.key === "confirm",
		)
		expect(confirm?.progress).toBeUndefined()
		expect(confirm?.eta).toMatch(/min/)
	})

	it("failed phases drop the ETA (no cheery estimate on an error)", () => {
		const sync = stepperPhases(dep({ depositTxHash: "0xt", leafIndex: "7" }), { attention: "error", note: "boom" }).find(
			(p) => p.key === "sync",
		)
		expect(sync?.eta).toBeUndefined()
	})
})

describe("stepperPhases - withdraw matrix", () => {
	it("provisional (no exitTxHash): EXIT active", () => {
		expect(states(wd({ exitTxHash: undefined }), { step: "exiting" }).exit).toBe("active")
	})

	it("public exit prompt names BOTH signatures", () => {
		const exit = stepperPhases(wd({ exitTxHash: undefined }), {}).find((p) => p.key === "exit")
		expect(exit?.detail).toMatch(/two signatures/i)
	})

	it("proving: PROVE active with the countdown detail", () => {
		const prove = stepperPhases(wd(), { provenBlock: 5, targetBlock: 9 }).find((p) => p.key === "prove")
		expect(prove?.state).toBe("active")
		expect(prove?.detail).toContain("Proven block 5 of 9")
	})

	it("proven: FINISH active (facts + runtime proven flag)", () => {
		expect(states(wd(), { provenBlock: 9, targetBlock: 9 }).finish).toBe("active")
		expect(states(wd(), { proven: true }).finish).toBe("active")
	})

	it("consumeTxHash: CONFIRM active; completion: all done", () => {
		expect(states(wd({ consumeTxHash: "0xc" }), {}).confirm).toBe("active")
		const s = states(wd({ consumeTxHash: "0xc", completedAt: 5 }), {})
		expect(Object.values(s).every((v) => v === "done")).toBe(true)
	})
})

describe("fueled deposit rail", () => {
	const fuel = { amount: "250000000000000000", secret: "0xs", secretHashHex: "0xsh", minOutput: "450" }

	it("fueled rail merges the swap into DEPOSIT: SIGN replaces APPROVE, no separate FUEL phase", () => {
		// Fresh record, no narration yet: the run is at its FIRST prompt (AUTHORIZE), never a
		// pre-done AUTHORIZE with DEPOSIT active (the backward-rail bug).
		const phases = stepperPhases(dep({ schema: 2, fuel, isPrivate: false }))
		expect(phases.map((p) => p.key)).toEqual(["sign", "deposit", "sync", "claim", "confirm"])
		expect(phases.find((p) => p.key === "sign")?.state).toBe("active")
		const deposit = phases.find((p) => p.key === "deposit")
		expect(deposit?.label).toBe("Deposit + fuel")
		expect(deposit?.state).toBe("pending")
		// Mid-deposit (the wallet prompt is up) the merged prompt narrates the swap riding along.
		const active = stepperPhases(dep({ schema: 2, fuel, isPrivate: false }), { step: "depositing" })
		expect(active.find((p) => p.key === "deposit")?.detail).toMatch(/fuel swap rides along/i)
	})

	it("private fueled rail keeps SEAL first, still no FUEL phase", () => {
		const phases = stepperPhases(dep({ schema: 2, fuel, isPrivate: true }))
		expect(phases.map((p) => p.key)).toEqual(["seal", "sign", "deposit", "sync", "claim", "confirm"])
	})

	it("a non-fueled deposit keeps the plain DEPOSIT label", () => {
		expect(stepperPhases(dep({ isPrivate: false })).find((p) => p.key === "deposit")?.label).toBe("Deposit")
	})

	it("rt.step signing activates SIGN", () => {
		const phases = stepperPhases(dep({ schema: 2, fuel, isPrivate: false }), { step: "signing" })
		expect(phases.find((p) => p.key === "sign")?.state).toBe("active")
	})

	it("the merged DEPOSIT+FUEL completes when the crossing starts; the swap never flips on its own", () => {
		const phases = stepperPhases(
			dep({ schema: 2, fuel: { ...fuel, received: "487", leafIndex: "7" }, depositTxHash: "0xd", leafIndex: "7", isPrivate: false }),
		)
		// The swap is not independently observable - no FUEL cell in the rail to latch on its own.
		expect(phases.map((p) => p.key)).toEqual(["sign", "deposit", "sync", "claim", "confirm"])
		expect(phases.find((p) => p.key === "deposit")?.state).toBe("done")
		expect(phases.find((p) => p.key === "sync")?.state).toBe("active")
	})

	it("a fueled CLAIM names the one-tx token+gas confirmation", () => {
		const phases = stepperPhases(
			dep({ schema: 2, fuel: { ...fuel, received: "487", leafIndex: "7" }, depositTxHash: "0xd", leafIndex: "7", isPrivate: false }),
			{ claimable: true },
		)
		expect(phases.find((p) => p.key === "claim")?.detail).toMatch(/tokens and your gas/)
	})

	it("a NON-fueled bridge-only record SIGNs (no approve, no fuel keys leak)", () => {
		const phases = stepperPhases(dep({ isPrivate: false }))
		expect(phases.map((p) => p.key)).toEqual(["sign", "deposit", "sync", "claim", "confirm"])
	})
})

describe("stepperPhases - confirm quiet flip (landed)", () => {
	it("active CONFIRM carries landed once the runtime saw THIS claim proposed", () => {
		const confirm = stepperPhases(dep({ claimTxHash: "0xc" }), { confirmLandedTxHash: "0xc" }).find((p) => p.key === "confirm")
		expect(confirm?.state).toBe("active")
		expect(confirm?.landed).toBe(true)
	})

	it("a landed flag for a PREVIOUS claim hash never lights the replacement (hash-scoped)", () => {
		const confirm = stepperPhases(dep({ claimTxHash: "0xnew" }), { confirmLandedTxHash: "0xold" }).find((p) => p.key === "confirm")
		expect(confirm?.landed).toBeUndefined()
	})

	it("no landed flag before the proposed receipt", () => {
		const confirm = stepperPhases(dep({ claimTxHash: "0xc" }), {}).find((p) => p.key === "confirm")
		expect(confirm?.landed).toBeUndefined()
	})

	it("deposit CONFIRM eta reflects the observed 1-2 minute checkpoint window", () => {
		const confirm = stepperPhases(dep({ claimTxHash: "0xc" }), {}).find((p) => p.key === "confirm")
		expect(confirm?.eta).toBe("usually 1-2 min")
	})

	it("withdraw CONFIRM (an L1 wait) never carries landed", () => {
		const confirm = stepperPhases(wd({ consumeTxHash: "0xk" }), { confirmLandedTxHash: "0xk" }).find((p) => p.key === "confirm")
		expect(confirm?.landed).toBeUndefined()
	})
})

const TOKEN = {
	erc20: "0x70e0ba845a1a0f2da3359c97e0285013525ffc49",
	portal: "0x94752ef7cf8f037f78ee7722a9387ef95c819fc8",
	l2Token: `0x${"1".repeat(64)}`,
	nameWord: `0x${"2".repeat(64)}`,
	symbolWord: `0x${"3".repeat(64)}`,
	decimals: 6,
	displaySymbol: "USDC",
	registerIndex: "4",
}

function send(over: Partial<SendDepositRecord> = {}): SendDepositRecord {
	return {
		schema: 3,
		id: "0xs",
		direction: "deposit",
		isPrivate: false,
		intent: "token",
		token: TOKEN,
		amount: "100000000",
		createdAt: 1,
		updatedAt: 1,
		recipient: "0xa",
		secretHashHex: "0xs",
		...DEPLOY,
		...over,
	} as SendDepositRecord
}

describe("stepperPhases - send (schema 3) deposit rail", () => {
	it("a public token send has no REGISTER step - its first claim registers inside the claim", () => {
		expect(stepperPhases(send()).map((p) => p.key)).toEqual(["sign", "deposit", "sync", "claim", "confirm"])
	})

	it("REGISTER appears only once a private send actually registered, and sits between CROSSING and CLAIM", () => {
		const before = stepperPhases(send({ isPrivate: true, leafIndex: "7" })).map((p) => p.key)
		expect(before).toEqual(["seal", "sign", "deposit", "sync", "claim", "confirm"])
		const after = stepperPhases(send({ isPrivate: true, leafIndex: "7", registerTxHash: "0xr" })).map((p) => p.key)
		expect(after).toEqual(["seal", "sign", "deposit", "sync", "register", "claim", "confirm"])
	})

	it("a registration with its hash and no claim yet is DONE; CLAIM is what runs then, narrating the wait for the claimer's view", () => {
		const rec = send({ isPrivate: true, leafIndex: "7", registerTxHash: "0xr" })
		expect(states(rec)).toEqual({
			seal: "done",
			sign: "done",
			deposit: "done",
			sync: "done",
			register: "done",
			claim: "active",
			confirm: "pending",
		})
		expect(stepperPhases(rec).find((p) => p.key === "claim")?.eta).toMatch(/a moment, then your signature/)
	})

	it("before its registration exists, a first-time private send's next signature is REGISTER, not CLAIM", () => {
		const rec = send({ isPrivate: true, leafIndex: "7", registers: true })
		expect(states(rec, { claimable: true })).toMatchObject({ sync: "done", register: "active", claim: "pending" })
		expect(states(rec, { step: "sending" })).toMatchObject({ register: "active", claim: "pending" })
		// The unseal signature that precedes it is narrated under the same step.
		const unseal = stepperPhases(rec, { claimable: true, step: "unsealing" }).find((p) => p.key === "register")
		expect(unseal?.detail).toMatch(/unseal/)
		// A public first-time send has no REGISTER phase: the claim is the next signature.
		expect(states(send({ leafIndex: "7", registers: true }), { claimable: true })).toMatchObject({ claim: "active" })
	})

	it("once the claim is sent the registration reads as a completed step and CONFIRM is active", () => {
		const phases = stepperPhases(send({ isPrivate: true, leafIndex: "7", registerTxHash: "0xr", claimTxHash: "0xc" }))
		expect(phases.find((p) => p.key === "register")?.state).toBe("done")
		expect(phases.find((p) => p.key === "confirm")?.state).toBe("active")
	})

	it("token+gas relabels DEPOSIT and narrates one claim for both legs; gas-only claims GAS", () => {
		const fueled = stepperPhases(send({ intent: "token+gas" }))
		expect(fueled.find((p) => p.key === "deposit")?.label).toBe("Deposit + fuel")
		expect(fueled.find((p) => p.key === "claim")?.label).toBe("Claim")
		const gas = stepperPhases(send({ intent: "gas", token: undefined }))
		expect(gas.find((p) => p.key === "claim")?.label).toBe("Claim gas")
		expect(gas.find((p) => p.key === "deposit")?.label).toBe("Deposit")
	})

	it("APPROVE renders only while a real Permit2 approval is part of this run", () => {
		expect(stepperPhases(send()).map((p) => p.key)).not.toContain("approve")
		expect(stepperPhases(send(), { approveOutcome: "done" }).map((p) => p.key)).toContain("approve")
	})

	it("CROSSING carries the block countdown; a claimable message moves the active phase to CLAIM", () => {
		const crossing = stepperPhases(send({ leafIndex: "7", depositL2Block: 10 }), { syncBlock: 11 })
		expect(crossing.find((p) => p.key === "sync")?.progress).toEqual({ current: 11, target: 13, fraction: 1 / 3 })
		expect(states(send({ leafIndex: "7" }), { claimable: true }).claim).toBe("active")
	})

	it("a fresh private send with no live step sits at its FIRST prompt (SEAL), never at DEPOSIT", () => {
		expect(sendActive(send({ isPrivate: true }))).toBe("seal")
		expect(sendActive(send({ isPrivate: false }))).toBe("sign")
		expect(sendActive(send({ depositTxHash: "0xd" }))).toBe("deposit")
	})

	it("an attention fails the ACTIVE phase and replaces its prompt with the note", () => {
		const phases = stepperPhases(send({ leafIndex: "7" }), { claimable: true, attention: "error", note: "the claim reverted" })
		const claim = phases.find((p) => p.key === "claim")
		expect(claim?.state).toBe("failed")
		expect(claim?.detail).toBe("the claim reverted")
		const hostile = `\u202Egnissim${"x".repeat(10_000)}`
		const flooded = stepperPhases(send({ leafIndex: "7" }), { claimable: true, attention: "error", note: hostile })
		const detail = flooded.find((p) => p.key === "claim")?.detail ?? ""
		expect(detail).not.toContain("\u202E")
		expect(Array.from(detail).length).toBeLessThanOrEqual(241)
	})

	it("a completed send shows every phase done", () => {
		const phases = stepperPhases(send({ leafIndex: "7", claimTxHash: "0xc", completedAt: 5 }))
		expect(phases.every((p) => p.state === "done")).toBe(true)
	})

	it("a send WITHDRAW keeps the unchanged exit rail", () => {
		const exit = { ...send(), direction: "withdraw", recipientL1: "0xe", exitTxHash: "0xw" } as unknown as SendDepositRecord
		expect(stepperPhases(exit).map((p) => p.key)).toEqual(["exit", "prove", "finish", "confirm"])
	})
})

describe("isTerminalAttention", () => {
	it("is true only for attentions no retry can clear", () => {
		expect(isTerminalAttention("stale-deployment")).toBe(true)
		expect(isTerminalAttention("receipt-mismatch")).toBe(true)
		expect(isTerminalAttention("malformed-record")).toBe(true)
	})

	it("leaves every retryable attention (and the absent one) actionable", () => {
		for (const a of ["error", "unknown-outcome", "mismatch", "tampered", "unseal-failed", "stale", undefined]) {
			expect(isTerminalAttention(a)).toBe(false)
		}
	})
})

describe("stepperPhases - the send's permission and registration phases", () => {
	const token = {
		erc20: "0x00000000000000000000000000000000000e2c20",
		portal: "0x00000000000000000000000000000000000000a1",
		l2Token: `0x${"11".repeat(32)}`,
		nameWord: `0x00${"4e".repeat(31)}`,
		symbolWord: `0x00${"54".repeat(31)}`,
		decimals: 18,
		displaySymbol: "TST",
	}
	function send(over: Partial<SendDepositRecord> = {}): SendDepositRecord {
		return {
			schema: 3,
			id: "send-1",
			direction: "deposit",
			intent: "token",
			token,
			isPrivate: false,
			amount: "1000",
			createdAt: 1,
			updatedAt: 1,
			...DEPLOY,
			recipient: "0xrecipient",
			secretHashHex: "0x1",
			...over,
		} as SendDepositRecord
	}
	const keys = (rec: BridgeJournalRecord, rt: RecordRuntime = {}) => stepperPhases(rec, rt).map((p) => p.key)

	it("PERMISSION renders first, active while the wallet is being asked, in the token's own words", () => {
		const phases = stepperPhases(send(), { step: "granting" })
		expect(phases[0]).toMatchObject({
			key: "permit",
			label: "Permission",
			state: "active",
			detail: "Allow reading TST state in your wallet.",
			eta: "your confirmation in your wallet",
		})
		expect(stepperPhases(send(), { step: "granting" }, "the wallet “Aztec”")[0]).toMatchObject({
			detail: "Allow reading TST state in the wallet “Aztec”.",
			eta: "your confirmation in the wallet “Aztec”",
		})
		expect(sendActive(send(), { step: "granting" })).toBe("permit")
	})

	it("PERMISSION stays on the rail, done, once this run's grant went through; a run that asked for none has no such phase", () => {
		expect(states(send(), { grantOutcome: "done", step: "signing" })).toMatchObject({ permit: "done", sign: "active" })
		expect(keys(send(), { step: "signing" })).not.toContain("permit")
	})

	it("a private send that registers the token shows REGISTER ahead of the claim, before any registration tx exists", () => {
		const rec = send({ isPrivate: true, registers: true })
		expect(keys(rec)).toEqual(["seal", "sign", "deposit", "sync", "register", "claim", "confirm"])
		expect(keys(send({ isPrivate: true }))).not.toContain("register")
	})

	it("a public send that registers the token does it inside the claim: one phase, labelled for both", () => {
		const rec = send({ registers: true })
		expect(keys(rec)).not.toContain("register")
		expect(stepperPhases(rec, {}).find((p) => p.key === "claim")?.label).toBe("Register + claim")
		expect(stepperPhases(send(), {}).find((p) => p.key === "claim")?.label).toBe("Claim")
	})
})

describe("overallProgress over a private deposit", () => {
	const ran: RecordRuntime = { grantOutcome: "done", approveOutcome: "done" }
	const crossed = { depositTxHash: "0xt", leafIndex: "7", depositL2Block: 100 }
	const overall = (over: Partial<SendDepositRecord>, rt: RecordRuntime) =>
		overallProgress(stepperPhases(send({ isPrivate: true, ...over }), rt))

	it("rises phase by phase, names the live phase's position and reaches 1 only once the record completes", () => {
		const table: Array<[string, Partial<SendDepositRecord>, RecordRuntime, number, number]> = [
			["granting", {}, { step: "granting" }, 1, 7],
			["sealing", {}, { step: "sealing", grantOutcome: "done" }, 2, 7],
			["approving", {}, { step: "approving", grantOutcome: "done" }, 3, 8],
			["signing", {}, { ...ran, step: "signing" }, 4, 8],
			["depositing", {}, { ...ran, step: "depositing" }, 5, 8],
			["syncing", crossed, { ...ran, step: "syncing", syncBlock: 101 }, 6, 8],
			["claim", crossed, { ...ran, step: "sending", claimable: true }, 7, 8],
			["confirm", { ...crossed, claimTxHash: "0xc" }, { ...ran, step: "confirming", confirmLandedTxHash: "0xc" }, 8, 8],
		]
		for (const [step, rec, rt, index, total] of table) {
			const o = overall(rec, rt)
			expect({ step, index: o.index, total: o.total, state: o.state }).toEqual({ step, index, total, state: "running" })
			// The bar marks the live phase's start; the rail's meter shows progress inside it.
			expect(o.fraction).toBeCloseTo((index - 1) / total)
		}
		expect(overall({ ...crossed, claimTxHash: "0xc", completedAt: 9 }, ran)).toEqual({ fraction: 1, index: 8, total: 8, state: "done" })
	})

	it("a failed phase keeps its position; a retry back to Crossing lowers the fraction to that phase's start", () => {
		const failed = overall(crossed, { ...ran, claimable: true, attention: "error", note: "timed out" })
		expect(failed).toEqual({ fraction: 6 / 8, index: 7, total: 8, state: "failed" })
		const failedCrossing = overall(crossed, { ...ran, syncBlock: 102, attention: "error", note: "timed out" })
		expect(failedCrossing).toEqual({ fraction: 5 / 8, index: 6, total: 8, state: "failed" })
		const retried = overall(crossed, { ...ran, step: "syncing", syncBlock: 100 })
		expect(retried).toEqual({ fraction: 5 / 8, index: 6, total: 8, state: "running" })
		expect(retried.fraction).toBeLessThan(failed.fraction)
	})
})

describe("logPhrase", () => {
	it("names the record's own token as display text: stripped, capped and never a replacement pattern", () => {
		const hostile = send({ token: { ...TOKEN, displaySymbol: `\u202eUSD$&C${"X".repeat(40)}` } })
		expect(logPhrase("approving", hostile)).toBe(`approving USD$&C${"X".repeat(26)}… for Permit2`)
		expect(logPhrase("granting", send({ token: undefined }))).toBe("asking your wallet to read this token")
	})
})
