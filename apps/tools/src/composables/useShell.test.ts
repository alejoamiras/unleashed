import { beforeEach, describe, expect, it } from "vitest"
import { __resetShellForTests, useShell } from "./useShell"

describe("useShell", () => {
	beforeEach(() => __resetShellForTests())

	it("lands on the bridge", () => {
		expect(useShell().section.value).toBe("send")
	})

	it("goTo switches the section; openActivity switches and highlights a record", () => {
		const shell = useShell()
		shell.goTo("send")
		expect(shell.section.value).toBe("send")
		shell.openActivity("0xabc")
		expect(shell.section.value).toBe("activity")
		expect(shell.highlightedId.value).toBe("0xabc")
		shell.openActivity()
		expect(shell.highlightedId.value).toBeNull()
	})

	it("is one state for every caller", () => {
		useShell().goTo("activity")
		expect(useShell().section.value).toBe("activity")
	})

	it("opens the Bridge section with a request the wizard takes exactly once", () => {
		const shell = useShell()
		shell.goTo("activity")
		const request = { token: "0xabc", amount: 5n, intent: "token+gas", isPrivate: true, fromRecordId: "0x1" } as const
		shell.continueFromEthereum(request)
		expect(shell.section.value).toBe("send")
		expect(shell.takePrefill()).toEqual(request)
		expect(shell.takePrefill()).toBeNull()
		shell.showReceipt("0x2")
		expect(shell.takeReceiptRequest()).toBe("0x2")
		expect(shell.takeReceiptRequest()).toBeNull()
	})
})
