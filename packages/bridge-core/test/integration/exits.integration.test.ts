import { describe, expect, it } from "vitest"
import { MIN_FJ } from "../../scripts/sandbox/constants"
import {
	flowGuardianPause,
	flowL1Pause,
	flowPrivateDeposit,
	flowPrivateGasFragmented,
	flowPrivateGasOneNote,
	flowPublicDeposit,
	runExit,
} from "../../scripts/sandbox/flows"
import { flowOutboxRoundTrip, fundPublicFeeJuice } from "../../scripts/sandbox/flows-matrix"
import { type ActorContext, freshActor, INTEGRATION, sandbox } from "./sandbox"

/** A fresh actor holding something to exit: the sponsor pays these scaffolding claims. */
async function funded(kind: "public" | "private" | "both"): Promise<ActorContext> {
	const a = await freshActor()
	const { usdc } = await sandbox()
	const l2Token = await a.l2TokenOf(usdc)
	if (kind !== "private") await flowPublicDeposit(a.s, usdc, l2Token)
	if (kind !== "public") await flowPrivateDeposit(a.s, usdc, l2Token)
	return a
}

describe.skipIf(!INTEGRATION)("exits", () => {
	it("public exit → Outbox consume releases on L1; authwit and exit paid from the actor's public Fee Juice (cell 27)", async () => {
		const a = await funded("public")
		const { usdc } = await sandbox()
		const unit = 10n ** BigInt(usdc.decimals)
		await fundPublicFeeJuice(a.s, 5n * MIN_FJ)
		const line = await runExit(a.s, {
			token: usdc,
			l2Token: await a.l2TokenOf(usdc),
			amount: 10n * unit,
			isPrivate: false,
			payer: "own",
		})
		expect(line).toContain("released")
		expect(line).toContain("paid from the actor's public Fee Juice")
	})

	it("private exit paid from one credit note, then across three notes (cell 28)", async () => {
		const a = await funded("private")
		const { usdc } = await sandbox()
		const unit = 10n ** BigInt(usdc.decimals)
		const l2Token = await a.l2TokenOf(usdc)
		expect(await flowPrivateGasOneNote(a.s)).toContain("one note")
		expect(await runExit(a.s, { token: usdc, l2Token, amount: 5n * unit, isPrivate: true, label: "one note", notes: 1 })).toContain(
			"released",
		)
		expect(await flowPrivateGasFragmented(a.s)).toContain("none covers a ceiling")
		expect(await runExit(a.s, { token: usdc, l2Token, amount: 5n * unit, isPrivate: true, label: "three notes", notes: 3 })).toContain(
			"released",
		)
		expect(a.s.samples.exitGas.map((x) => x.notes)).toEqual([1, 3])
	})

	it("the guardian pause blocks exits, not claims, and is always lifted (cell 31, L2)", async () => {
		const a = await freshActor()
		const { usdc } = await sandbox()
		expect(await flowGuardianPause(a.s, usdc)).toContain("unpaused")
	})

	it("the factory pause makes every portal refuse deposits and withdraws first, and is always lifted (cell 31, L1)", async () => {
		const a = await freshActor()
		const { usdc } = await sandbox()
		expect(await flowL1Pause(a.s, usdc)).toContain("WithdrawsPaused")
	})

	it("an exit reads as not consumed at proposal and is consumed once finalized (cell 32)", async () => {
		const a = await funded("public")
		const { usdc } = await sandbox()
		expect(await flowOutboxRoundTrip(a.s, usdc, await a.l2TokenOf(usdc))).toContain("after finalization")
	})
})
