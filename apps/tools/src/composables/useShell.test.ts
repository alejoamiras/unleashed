import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type EffectScope, effectScope } from "vue"
import { __resetShellForTests, syncShellWithUrl, useShell } from "./useShell"

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

	it("follow switches on a plain click and leaves a modified one to the browser", () => {
		const shell = useShell()
		const newTab = new MouseEvent("click", { metaKey: true, cancelable: true })
		shell.follow(newTab, "drip")
		expect(newTab.defaultPrevented).toBe(false)
		expect(shell.section.value).toBe("send")
		const plain = new MouseEvent("click", { cancelable: true })
		shell.follow(plain, "drip")
		expect(plain.defaultPrevented).toBe(true)
		expect(shell.section.value).toBe("drip")
	})
})

describe("syncShellWithUrl", () => {
	let scope: EffectScope | undefined
	beforeEach(() => __resetShellForTests())
	afterEach(() => scope?.stop())

	function bindAt(url: string): void {
		history.replaceState(null, "", url)
		scope = effectScope()
		scope.run(syncShellWithUrl)
	}

	it("a section's path opens it, in any case and with a trailing slash, with no history entry", () => {
		const entries = history.length
		bindAt("/Faucet/?chainId=1")
		expect(useShell().section.value).toBe("drip")
		expect(location.pathname + location.search).toBe("/faucet?chainId=1")
		expect(history.length).toBe(entries)
	})

	it("the bare origin and an unknown path show Bridge at /bridge, keeping the query and hash", () => {
		bindAt("/")
		expect(useShell().section.value).toBe("send")
		expect(location.pathname).toBe("/bridge")
		scope?.stop()
		useShell().goTo("drip")
		bindAt("/nope?chainId=1#x")
		expect(useShell().section.value).toBe("send")
		expect(location.pathname + location.search + location.hash).toBe("/bridge?chainId=1#x")
	})

	it("a switch pushes the section's path, Back switches back without pushing, and the binding ends with its scope", async () => {
		bindAt("/faucet")
		const entries = history.length
		useShell().openActivity("0xabc")
		expect(location.pathname).toBe("/activity")
		expect(history.length).toBe(entries + 1)

		const pushes = vi.spyOn(history, "pushState")
		const popped = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }))
		history.back()
		await popped
		expect(useShell().section.value).toBe("drip")
		expect(location.pathname).toBe("/faucet")
		expect(pushes).not.toHaveBeenCalled()

		scope?.stop()
		useShell().goTo("addresses")
		expect(location.pathname).toBe("/faucet")
		history.replaceState(null, "", "/activity")
		window.dispatchEvent(new PopStateEvent("popstate"))
		expect(useShell().section.value).toBe("addresses")
		pushes.mockRestore()
	})
})
