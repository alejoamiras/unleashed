import { BridgeError, type TransferEventBody } from "@unleashed/sdk"
import { describe, expect, it } from "vitest"
import { FEE_STOP_COPY } from "@/lib/fee-stop-copy"
import { claimFailure, failureText, narrateClaim, newScene } from "./claim-narration"
import type { RecordRuntime } from "./useBridgeJournal"

const HASH: `0x${string}` = `0x${"ab".repeat(32)}`
const OTHER = `0x${"cd".repeat(32)}`
const CONFIRM = "confirm in your Aztec wallet"
const PROCESSING = "the claim is processing on Aztec"

const err = (code: BridgeError["code"], message: string = code, options?: ConstructorParameters<typeof BridgeError>[4]) =>
	new BridgeError(code, message, "none", "safe", options)

/** Feeds events through one scene, applying each narration's runtime the way the engine does. */
function play(events: TransferEventBody[], opts: { preGated?: boolean; ownClaim?: boolean; rt?: RecordRuntime } = {}) {
	const scene = newScene(opts.preGated ?? false, opts.ownClaim ?? false)
	let rt: RecordRuntime = { ...opts.rt }
	const out = events.map((e) => {
		const n = narrateClaim(e, scene, rt, HASH)
		rt = { ...rt, ...n.runtime }
		return n
	})
	return { scene, rt, out }
}

describe("narrateClaim", () => {
	it("narrates the deposit's recovery on the deposit step, and its confirmation clears the card", () => {
		const { scene, out } = play([
			{ type: "deposit-recovery", stage: "searching" },
			{ type: "deposit-recovery", stage: "reading", txHash: HASH },
			{ type: "deposit-recovery", stage: "waiting", txHash: HASH },
		])
		expect(out.map((n) => n.step)).toEqual([
			{ step: "depositing", detail: "looking for the deposit on Ethereum" },
			{ step: "depositing", detail: "checking the Ethereum deposit" },
			{ step: "depositing", detail: "waiting for the Ethereum confirmation" },
		])
		expect(scene.recovering).toBe("reading")
		const confirmed = narrateClaim({ type: "deposit-confirmed", leaves: {} as never }, scene, undefined, HASH)
		expect(confirmed).toEqual({ runtime: { attention: undefined, note: undefined } })
		expect(scene.recovering).toBeUndefined()
	})

	it("counts blocks, and shows no count once none are left", () => {
		const { out } = play([
			{ type: "arrival", stage: "counting", block: 10, blocksLeft: 1 },
			{ type: "arrival", stage: "counting", block: 11, blocksLeft: 0 },
		])
		expect(out).toEqual([
			{ step: { step: "syncing", detail: "1 block until your funds arrive" }, runtime: { syncBlock: 10 } },
			{ runtime: { syncBlock: 11 } },
		])
	})

	it("restarts the checkpoint count per call, never lets it rise, and completes it only when one was shown", () => {
		const previousCall = { checkpointsLeft: 2, checkpointSpan: 5 }
		const { out, rt } = play(
			[
				{ type: "arrival", stage: "counting", checkpointsLeft: 4 },
				{ type: "arrival", stage: "counting", checkpointsLeft: 6 },
				{ type: "arrival", stage: "counting", checkpointsLeft: 1 },
				{ type: "arrival", stage: "counting", checkpointsLeft: 0 },
			],
			{ rt: previousCall },
		)
		expect(out.map((n) => n.step?.detail)).toEqual([
			"4 checkpoints until your funds arrive",
			"4 checkpoints until your funds arrive",
			"1 checkpoint until your funds arrive",
			undefined,
		])
		expect(rt).toEqual({ checkpointsLeft: 0, checkpointSpan: 4 })
		expect(play([{ type: "arrival", stage: "counting", checkpointsLeft: 0 }]).out).toEqual([{}])
	})

	it("narrates arrival as the quick re-check once the record passed its gates this session", () => {
		const { out } = play(
			[
				{ type: "arrival", stage: "counting", checkpointsLeft: 3 },
				{ type: "arrival", stage: "wallet-sync", counted: true },
			],
			{ preGated: true },
		)
		expect(out.map((n) => n.step)).toEqual([
			{ step: "sending", detail: "checking the message" },
			{ step: "sending", detail: "checking the message" },
		])
	})

	it("says whether the message was counted in before the wallet syncs it", () => {
		const { out } = play([
			{ type: "arrival", stage: "unfolded" },
			{ type: "arrival", stage: "wallet-sync", counted: false },
			{ type: "arrival", stage: "wallet-sync", counted: true },
			{ type: "claimable" },
		])
		expect(out.map((n) => n.step?.detail)).toEqual([
			"waiting for the message to reach the L2",
			"waiting for your wallet to sync the message",
			"message arrived — waiting for your wallet to sync it",
			undefined,
		])
		expect(out[3]).toEqual({ runtime: { claimable: true } })
	})

	it("asks for the claim by name only after this call registered the token", () => {
		const plain = play([{ type: "claim-requested", leg: "token" }]).out
		expect(plain[0]?.step).toEqual({ step: "sending", detail: CONFIRM })
		const { out } = play([
			{ type: "registration-requested" },
			{ type: "registration-sent", txHash: OTHER },
			{ type: "claim-requested", leg: "token" },
			{ type: "claim-requested", leg: "gas" },
		])
		expect(out.map((n) => n.step?.detail)).toEqual([
			CONFIRM,
			"registered — preparing the claim",
			"confirm the claim in your Aztec wallet",
			CONFIRM,
		])
	})

	it("reads a receipt poll's second event as its result: the node's silence, or still processing", () => {
		const wait = (poll: number, unreachable: number): TransferEventBody => ({
			type: "claim-waiting",
			leg: "token",
			txHash: HASH,
			poll,
			unreachable,
		})
		const { out } = play([wait(1, 0), wait(1, 2), wait(2, 2), wait(2, 0)])
		expect(out.map((n) => n.step?.detail)).toEqual([PROCESSING, "node unreachable — retrying (2)", PROCESSING, PROCESSING])
	})

	it("lights the proposed block only for the record's stored claim, once", () => {
		const scene = newScene(false, true)
		expect(narrateClaim({ type: "claim-proposed", txHash: OTHER }, scene, {}, HASH)).toEqual({})
		expect(narrateClaim({ type: "claim-proposed", txHash: HASH }, scene, {}, HASH)).toEqual({
			runtime: { confirmLandedTxHash: HASH },
		})
		expect(narrateClaim({ type: "claim-proposed", txHash: HASH }, scene, { confirmLandedTxHash: HASH }, HASH)).toEqual({})
	})

	it("narrates a verification only for a claim this call did not send", () => {
		const verifying = (stage: "checking" | "wallet-sync"): TransferEventBody => ({
			type: "claim-verifying",
			leg: "token",
			txHash: HASH,
			stage,
		})
		expect(play([verifying("checking"), verifying("wallet-sync")]).out.map((n) => n.step?.detail)).toEqual([
			"checking the claim against this record",
			"confirmed on the node — waiting for your wallet to sync",
		])
		const sent = play([{ type: "claim-sent", leg: "token", txHash: HASH, payer: "fuel" }, verifying("checking")])
		expect(sent.out).toEqual([{}, {}])
		expect(sent.scene.ownClaim).toBe(true)
	})

	it("clears the card when the tokens were claimed elsewhere, and remembers either landing", () => {
		const elsewhere = play([{ type: "claim-landed", via: "claimed-elsewhere" }])
		expect(elsewhere.out).toEqual([{ runtime: { attention: undefined, note: undefined, claimable: undefined } }])
		expect(elsewhere.scene.landed).toBe("claimed-elsewhere")
		const own = play([{ type: "claim-landed", via: "claim", txHash: HASH }])
		expect(own.out).toEqual([{}])
		expect(own.scene.landed).toBe("claim")
	})
})

describe("claimFailure", () => {
	const scene = (patch: Partial<ReturnType<typeof newScene>> = {}) => ({ ...newScene(false, false), ...patch })

	it("words a fee stop with its own copy and anything else with its deepest cause", () => {
		expect(failureText(err("fee-stop", "x", { stop: "credit-short" }))).toBe(FEE_STOP_COPY["credit-short"])
		expect(failureText(err("read-failed", "outer", { cause: new Error("mid", { cause: new Error("the node said no") }) }))).toBe(
			"the node said no",
		)
		expect(failureText("plain")).toBe("plain")
	})

	it("hands every failure after the tokens landed to the gas claim", () => {
		const view = claimFailure(err("claim-reverted", "x", { cause: new Error("the gas claim reverted") }), scene({ landed: "claim" }))
		expect(view).toEqual({
			kind: "card",
			runtime: {
				attention: "error",
				note: "the gas claim reverted. Your tokens are unaffected — retry the gas claim from this card.",
			},
		})
	})

	it("leaves anything but a bridge error to the run's retry template", () => {
		expect(claimFailure(new Error("boom"), scene())).toEqual({ kind: "run-failure", text: "boom" })
	})

	it("reads a failed recovery as its search or its receipt said", () => {
		expect(claimFailure(err("deposit-not-found", "x", { search: "ambiguous" }), scene({ recovering: "searching" }))).toEqual({
			kind: "search",
			search: "ambiguous",
		})
		expect(claimFailure(err("read-failed"), scene({ recovering: "searching" }))).toEqual({ kind: "search", search: "incomplete" })
		expect(claimFailure(err("deposit-reverted"), scene({ recovering: "reading" }))).toEqual({
			kind: "card",
			runtime: { attention: "error", note: FEE_STOP_COPY["deposit-reverted"] },
		})
		const mismatch = "The deposit's receipt doesn't match its record"
		expect(claimFailure(err("receipt-mismatch", mismatch), scene({ recovering: "reading" }))).toEqual({
			kind: "card",
			runtime: { attention: "receipt-mismatch", note: mismatch },
		})
	})

	it("keeps today's notes for a dropped, reverted, tampered or never-consumable claim", () => {
		expect(claimFailure(err("claim-dropped"), scene())).toEqual({
			kind: "card",
			runtime: {
				attention: "error",
				note: "The claim was dropped — claim again from this card. Nothing was lost.",
				confirmLandedTxHash: undefined,
			},
		})
		expect(claimFailure(err("claim-reverted"), scene())).toMatchObject({
			kind: "card",
			clearRounds: true,
			runtime: { note: "The claim reverted on Aztec. You can retry from this card — the deposit remains claimable." },
		})
		expect(claimFailure(err("message-invalid"), scene())).toMatchObject({ kind: "card", runtime: { attention: "tampered" } })
		expect(claimFailure(err("message-timeout"), scene())).toEqual({
			kind: "run-failure",
			text: "the L1→L2 message never became consumable — claim it again from the journal later",
		})
		expect(claimFailure(err("message-timeout", "x", { cause: new Error("node down") }), scene())).toEqual({
			kind: "run-failure",
			text: "node down",
		})
		expect(claimFailure(err("fee-stop", "x", { stop: "fuel-short" }), scene())).toEqual({
			kind: "run-failure",
			text: FEE_STOP_COPY["fuel-short"],
		})
	})
})
