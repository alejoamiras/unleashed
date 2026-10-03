import { describe, expect, it } from "vitest"
import { flowPrivateDeposit, flowPrivateGasOneNote, flowPublicDeposit, flowRelayedPrivateDeposit } from "../../scripts/sandbox/flows"
import { flowDiscoveredRouteSend, flowTokenOnlyHeldPublicFj } from "../../scripts/sandbox/flows-matrix"
import { freshActor, INTEGRATION, sandbox } from "./sandbox"

describe.skipIf(!INTEGRATION)("deposits", () => {
	it("public deposit → claim_public on a registered token, paid from private credit (cell 1)", async () => {
		const a = await freshActor()
		const { usdc } = await sandbox()
		await flowPrivateGasOneNote(a.s)
		expect(await flowPublicDeposit(a.s, usdc, await a.l2TokenOf(usdc), "credit")).toContain("private credit charged")
	})

	it("private deposit → claim_private, paid from private credit (cell 2)", async () => {
		const a = await freshActor()
		const { usdc } = await sandbox()
		await flowPrivateGasOneNote(a.s)
		expect(await flowPrivateDeposit(a.s, usdc, await a.l2TokenOf(usdc), "credit")).toContain("privately (")
	})

	it("a relayer cannot redirect a private claim, then submits it for the actor", async () => {
		const a = await freshActor()
		const { usdc } = await sandbox()
		expect(await flowRelayedPrivateDeposit(a.s, usdc, await a.l2TokenOf(usdc))).toContain("wrong recipient rejected")
	})

	it("token-only claim paid from held public Fee Juice (cell 5)", async () => {
		const a = await freshActor()
		const { usdc } = await sandbox()
		expect(await flowTokenOnlyHeldPublicFj(a.s, usdc, await a.l2TokenOf(usdc))).toContain("from held public Fee Juice")
	})

	it("a discovered route feeds the send and the claim pays for itself (cell 23)", async () => {
		const a = await freshActor()
		const { usdt } = await sandbox()
		expect(await flowDiscoveredRouteSend(a.s, usdt, await a.l2TokenOf(usdt))).toContain("quote")
	})
})
