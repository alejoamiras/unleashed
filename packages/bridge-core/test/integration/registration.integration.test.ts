import { describe, expect, it } from "vitest"
import {
	flowConcurrentFirstClaims,
	flowPortalOnlyToken,
	flowRejectedRegistration,
	flowRelayerFirstRegister,
} from "../../scripts/sandbox/flows"
import { freshActor, INTEGRATION, sandbox } from "./sandbox"

describe.skipIf(!INTEGRATION)("registration races and tampering (cell 33)", () => {
	it("the relayer registers first; the depositor's claim is a plain claim", async () => {
		const a = await freshActor()
		expect(await flowRelayerFirstRegister(a.s)).toContain("registered RLY first")
	})

	it("two concurrent first-time deposits settle as one register+claim and one claim", async () => {
		const a = await freshActor()
		// Either depositor may win the registration; the flow asserts one of each path.
		expect(await flowConcurrentFirstClaims(a.s)).toMatch(/register\+claim \+ claim|claim \+ register\+claim/)
	})

	it("a portal-only token registers on its first claim", async () => {
		const a = await freshActor()
		const { pxo } = await sandbox()
		expect(await flowPortalOnlyToken(a.s, pxo)).toContain("register+claim")
	})

	it.each(["sponsored", "fee-juice-claim", "private-fpc"] as const)(
		"a tampered registration is rejected, then corrected, under the %s fee mode",
		async (mode) => {
			const a = await freshActor()
			expect(await flowRejectedRegistration(a.s, mode)).toContain("tampered register rejected")
		},
	)
})
