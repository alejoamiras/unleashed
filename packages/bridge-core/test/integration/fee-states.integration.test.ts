import { describe, expect, it } from "vitest"
import {
	flowFirstTimeFromCredit,
	flowFueledClaimWithPublicFjHeld,
	flowGasOnlySwappedWithPublicFjHeld,
	flowGasOnlyWithPublicFjHeld,
	flowPrivateFuelWithPublicFjHeld,
} from "../../scripts/sandbox/flows-matrix"
import { freshActor, INTEGRATION, sandbox } from "./sandbox"

describe.skipIf(!INTEGRATION)("fee states: what the actor already holds", () => {
	it("token only, public, first-time token paid from credit; the second send is cheaper (cell 3)", async () => {
		const a = await freshActor()
		expect(await flowFirstTimeFromCredit(a.s, false)).toContain("register+claim then claim")
	})

	it("token only, private, first-time token paid from credit (cell 4)", async () => {
		const a = await freshActor()
		expect(await flowFirstTimeFromCredit(a.s, true)).toContain("register,claim then claim")
	})

	it("fueled public claim beside held public Fee Juice: after = before + claimed − fee (cell 13b)", async () => {
		const a = await freshActor()
		const { usdt } = await sandbox()
		expect(await flowFueledClaimWithPublicFjHeld(a.s, usdt, await a.l2TokenOf(usdt))).toContain("conserved")
	})

	it("private fuel beside held public Fee Juice: the public balance is never touched (cell 15b)", async () => {
		const a = await freshActor()
		const { usdt } = await sandbox()
		expect(await flowPrivateFuelWithPublicFjHeld(a.s, usdt, a.s.l2TokenOf)).toContain("+ 0 − 0")
	})

	it("identity-route gas adds to held public Fee Juice (cell 18b)", async () => {
		const a = await freshActor()
		expect(await flowGasOnlyWithPublicFjHeld(a.s)).toContain("conserved")
	})

	it("swapped gas adds exactly its quote to held public Fee Juice (cell 20b)", async () => {
		const a = await freshActor()
		const { usdt } = await sandbox()
		expect(await flowGasOnlySwappedWithPublicFjHeld(a.s, usdt)).toContain("conserved")
	})
})
