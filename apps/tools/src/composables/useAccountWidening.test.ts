import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The session is faked down to what widening reads: a status, an error, the granted accounts, and
 * a `retryCapabilities` whose script (`onPrompt`) is what the wallet does while the prompt is up.
 */
const wallet = vi.hoisted(() => ({
	status: { value: "connected" as string },
	error: { value: null as unknown },
	accounts: { value: [] as Array<{ address: string; alias: string }> },
	hiddenAccountsCount: { value: 0 },
	prompts: 0,
	runs: true,
	onPrompt: async (): Promise<void> => {},
	opsInFlight: false,
}))

vi.mock("@/composables/useWalletConnection", () => ({
	useWalletConnection: () => ({
		status: wallet.status,
		error: wallet.error,
		accounts: wallet.accounts,
		hiddenAccountsCount: wallet.hiddenAccountsCount,
		retryCapabilities: async () => {
			if (!wallet.runs) return false
			wallet.prompts++
			await wallet.onPrompt()
			return true
		},
	}),
}))

vi.mock("@/composables/useOpsInFlight", () => ({
	opsInFlight: () => wallet.opsInFlight,
}))

import { __resetPromptQueueForTests, enqueuePrompt } from "@/lib/prompt-queue"
import { useAccountWidening } from "./useAccountWidening"

const A = { address: `0x${"a".repeat(64)}`, alias: "Main" }
const B = { address: `0x${"b".repeat(64)}`, alias: "Second" }

describe("useAccountWidening", () => {
	beforeEach(() => {
		__resetPromptQueueForTests()
		wallet.status.value = "connected"
		wallet.error.value = null
		wallet.accounts.value = [A]
		wallet.hiddenAccountsCount.value = 0
		wallet.prompts = 0
		wallet.runs = true
		wallet.onPrompt = async () => {}
		wallet.opsInFlight = false
	})

	it("added: the grant grew by the accounts the wallet answered with", async () => {
		wallet.onPrompt = async () => {
			wallet.accounts.value = [A, B]
		}
		const w = useAccountWidening()
		await expect(w.addAccounts()).resolves.toEqual({ kind: "added", count: 1 })
		expect(w.outcome.value).toEqual({ kind: "added", count: 1 })
		expect(wallet.prompts).toBe(1)
	})

	it("added: an account past the app's cap counts too (the list is capped, the grant is not)", async () => {
		wallet.onPrompt = async () => {
			wallet.hiddenAccountsCount.value = 1
		}
		const w = useAccountWidening()
		await expect(w.addAccounts()).resolves.toEqual({ kind: "added", count: 1 })
	})

	it("unchanged: the wallet answered with the same grant (a decline reads the same way)", async () => {
		const w = useAccountWidening()
		await expect(w.addAccounts()).resolves.toEqual({ kind: "unchanged" })
		expect(wallet.prompts).toBe(1)
	})

	it("busy: not connected — nothing is asked", async () => {
		wallet.status.value = "setting-up"
		const w = useAccountWidening()
		await expect(w.addAccounts()).resolves.toEqual({ kind: "busy" })
		expect(wallet.prompts).toBe(0)
	})

	it("busy: an operation is in flight when the request reaches the queue — nothing is asked", async () => {
		wallet.opsInFlight = true
		const w = useAccountWidening()
		await expect(w.addAccounts()).resolves.toEqual({ kind: "busy" })
		expect(wallet.prompts).toBe(0)
	})

	it("busy: the session's own no-op (another flow owns the wallet) is never reported as unchanged", async () => {
		wallet.runs = false
		const w = useAccountWidening()
		await expect(w.addAccounts()).resolves.toEqual({ kind: "busy" })
	})

	it("failed: the session left connected while the wallet answered", async () => {
		wallet.onPrompt = async () => {
			wallet.status.value = "error"
			wallet.error.value = { message: "rejected" }
		}
		const w = useAccountWidening()
		await expect(w.addAccounts()).resolves.toEqual({ kind: "failed" })
	})

	it("busy flag: a second click while the first is up is refused without a second prompt", async () => {
		let release: () => void = () => {}
		wallet.onPrompt = () => new Promise<void>((r) => (release = r))
		const w = useAccountWidening()
		const first = w.addAccounts()
		await Promise.resolve()
		expect(w.busy.value).toBe(true)
		await expect(w.addAccounts()).resolves.toEqual({ kind: "busy" })
		release()
		await first
		expect(w.busy.value).toBe(false)
		expect(wallet.prompts).toBe(1)
	})

	it("queues behind another prompt and re-checks the state when its turn comes", async () => {
		let releaseGrant: () => void = () => {}
		const grant = enqueuePrompt(() => new Promise<void>((r) => (releaseGrant = r)))
		wallet.opsInFlight = true
		const w = useAccountWidening()
		const pending = w.addAccounts()
		await new Promise((r) => setTimeout(r, 0))
		// The token grant ahead in the queue holds the wallet; the widening waits its turn...
		expect(wallet.prompts).toBe(0)
		// ...and by then an operation started, so it is refused rather than asked.
		releaseGrant()
		await grant
		await expect(pending).resolves.toEqual({ kind: "busy" })
		expect(wallet.prompts).toBe(0)
	})
})
