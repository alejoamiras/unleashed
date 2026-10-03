import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TESTIDS } from "@/lib/testids"

// Same SDK-boundary mocks as AztecWalletPanel.test.ts: the switcher reads the REAL session
// singleton, whose refs the tests set directly.
vi.mock("@aztec-labs/wallet-sdk/manager", () => ({
	WalletManager: { configure: () => ({ getAvailableWallets: () => ({}) }) },
}))
vi.mock("@aztec-labs/aztec.js/node", () => ({ createAztecNodeClient: () => ({ getContract: async () => null }) }))
vi.mock("@/lib/emoji", () => ({ hashToEmoji: () => "🟢🔵🟡🟣🔴⚪⚫🟠🟤", toGrid: (s: string) => Array.from(s).slice(0, 9) }))
vi.mock("@/contracts/deployments", () => ({
	DRIPPER: { toString: () => "0x1" },
	SIGNAL: { toString: () => "0x2" },
	NOISE: { toString: () => "0x3" },
	rebuildDripperInstance: vi.fn(async () => ({ address: { toString: () => "0x1" } })),
	rebuildSignalInstance: vi.fn(async () => ({ address: { toString: () => "0x2" } })),
	rebuildNoiseInstance: vi.fn(async () => ({ address: { toString: () => "0x3" } })),
}))
// The generation reader validates the live manifest at module init, and the wallet session imports
// it. A bridge-less generation is enough for everything this suite asserts.
vi.mock("@/contracts/bridge-generation", () => ({
	HUB: undefined,
	HUB_ARTIFACT: { name: "TokenBridgeHub" },
	HUB_TOKEN_ARTIFACT: { name: "Token" },
	MANIFEST_TOKENS: [],
	TOKEN_CLASS_ID: undefined,
	SEND_GENERATION: undefined,
	IS_PLACEHOLDER: true,
	rebuildHubInstance: vi.fn(),
	rebuildHubTokenInstance: vi.fn(),
}))
vi.mock("@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js", () => ({ DripperContractArtifact: { name: "Dripper" } }))
vi.mock("@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js", () => ({ TokenContractArtifact: { name: "Token" } }))

// The widening composable is unit-tested on its own; here only the wiring is asserted, so its
// outcome is scripted (reactive refs, so the template re-renders on them).
vi.mock("@/composables/useAccountWidening", async () => {
	const { ref } = await import("vue")
	const busy = ref(false)
	const outcome = ref<{ kind: string; count?: number } | null>(null)
	const script = { next: { kind: "unchanged" } as { kind: string; count?: number }, calls: 0 }
	return {
		useAccountWidening: () => ({
			busy,
			outcome,
			addAccounts: async () => {
				script.calls++
				outcome.value = script.next
				return script.next
			},
		}),
		__wideningScript: Object.assign(script, { busy, outcome }),
	}
})
import * as wideningModule from "@/composables/useAccountWidening"
import { __resetOpsInFlightForTests, withOperation } from "@/composables/useOpsInFlight"
import { __resetToastsForTests, useToast } from "@/composables/useToast"
import { __resetWalletConnectionForTests, useWalletConnection } from "@/composables/useWalletConnection"
import AccountSwitcher from "./AccountSwitcher.vue"

const ADDR_A = `0x${"aa".padStart(64, "0")}`
const ADDR_B = `0x${"bb".padStart(64, "0")}`

const sel = (t: string) => `[data-testid="${t}"]`

function connectSession(
	accounts = [
		{ address: ADDR_A, alias: "Main" },
		{ address: ADDR_B, alias: "Savings" },
	],
) {
	const c = useWalletConnection()
	c.status.value = "connected"
	c.accounts.value = accounts
	c.selectedAccount.value = accounts[0].address
	return c
}

function mountSwitcher() {
	return mount(AccountSwitcher, {
		props: { addressTestid: TESTIDS.account, disconnectTestid: TESTIDS.btnDisconnect },
	})
}

describe("AccountSwitcher", () => {
	beforeEach(() => {
		localStorage.clear()
		__resetWalletConnectionForTests()
		__resetOpsInFlightForTests()
		__resetToastsForTests()
	})
	afterEach(() => {
		__resetWalletConnectionForTests()
		__resetToastsForTests()
		vi.clearAllMocks()
	})

	it("chip shows alias + short address; menu is closed until clicked", () => {
		connectSession()
		const w = mountSwitcher()
		const chip = w.find(sel(TESTIDS.accountChip))
		expect(chip.text()).toContain("Aztec")
		expect(chip.text()).toContain("Main")
		expect(chip.text()).toContain(`${ADDR_A.slice(0, 6)}…${ADDR_A.slice(-4)}`)
		expect(chip.attributes("aria-expanded")).toBe("false")
		expect(w.find(sel(TESTIDS.accountMenu)).exists()).toBe(false)
	})

	it("an unnamed account still shows its address in the chip (wallets may supply no name)", () => {
		connectSession([{ address: ADDR_A, alias: "" }])
		const w = mountSwitcher()
		const chip = w.find(sel(TESTIDS.accountChip))
		expect(chip.text()).toContain(`${ADDR_A.slice(0, 6)}…${ADDR_A.slice(-4)}`)
		// The address element keeps its panel testid whether or not a name renders beside it.
		expect(w.find(sel(TESTIDS.account)).exists()).toBe(true)
	})

	it("the chip's accessible name carries the alias and short address, the alias only when set", () => {
		connectSession()
		const short = `${ADDR_A.slice(0, 6)}…${ADDR_A.slice(-4)}`
		expect(mountSwitcher().get(sel(TESTIDS.accountChip)).attributes("aria-label")).toBe(`Aztec account Main, ${short}, switch account`)
		__resetWalletConnectionForTests()
		connectSession([{ address: ADDR_A, alias: "" }])
		expect(mountSwitcher().get(sel(TESTIDS.accountChip)).attributes("aria-label")).toBe(`Aztec account ${short}, switch account`)
	})

	it("the active account's line is in reverse video, with no check mark", async () => {
		connectSession()
		const w = mountSwitcher()
		await w.find(sel(TESTIDS.accountChip)).trigger("click")
		const lines = w.findAll(".row-line")
		expect(lines.map((l) => l.classes().includes("on"))).toEqual([true, false])
		expect(w.find(`${sel(TESTIDS.accountMenu)} .check`).exists()).toBe(false)
	})

	it("opens the menu with one row per account, active row checked", async () => {
		connectSession()
		const w = mountSwitcher()
		await w.find(sel(TESTIDS.accountChip)).trigger("click")
		const menu = w.find(sel(TESTIDS.accountMenu))
		expect(menu.exists()).toBe(true)
		expect(menu.text()).toContain("Granted accounts · 2")
		const rows = w.findAll(sel(TESTIDS.accountMenuRow))
		expect(rows).toHaveLength(2)
		expect(rows[0].attributes("aria-checked")).toBe("true")
		expect(rows[1].attributes("aria-checked")).toBe("false")
	})

	it("clicking another account switches, toasts once, closes the menu", async () => {
		const c = connectSession()
		const { toasts } = useToast()
		const w = mountSwitcher()
		await w.find(sel(TESTIDS.accountChip)).trigger("click")
		await w.findAll(sel(TESTIDS.accountMenuRow))[1].trigger("click")

		expect(c.selectedAccount.value).toBe(ADDR_B)
		expect(toasts.value).toHaveLength(1)
		expect(toasts.value[0].text).toBe("Active account: Savings")
		expect(w.find(sel(TESTIDS.accountMenu)).exists()).toBe(false)
	})

	it("clicking the ACTIVE account just closes — no switch, no toast", async () => {
		const c = connectSession()
		const { toasts } = useToast()
		const w = mountSwitcher()
		await w.find(sel(TESTIDS.accountChip)).trigger("click")
		await w.findAll(sel(TESTIDS.accountMenuRow))[0].trigger("click")
		expect(c.selectedAccount.value).toBe(ADDR_A)
		expect(toasts.value).toHaveLength(0)
		expect(w.find(sel(TESTIDS.accountMenu)).exists()).toBe(false)
	})

	it("Add accounts…: the foot action asks the wallet and reports the outcome on a status line", async () => {
		const script = (wideningModule as unknown as { __wideningScript: { next: { kind: string; count?: number }; calls: number } })
			.__wideningScript
		script.next = { kind: "added", count: 1 }
		connectSession()
		const w = mountSwitcher()
		await w.find(sel(TESTIDS.accountChip)).trigger("click")
		expect(w.find(sel(TESTIDS.accountMenuAddStatus)).exists()).toBe(false)
		const add = w.find(sel(TESTIDS.accountMenuAddAccounts))
		expect(add.text()).toBe("Add accounts…")
		await add.trigger("click")
		await w.vm.$nextTick()
		expect(script.calls).toBe(1)
		expect(w.find(sel(TESTIDS.accountMenuAddStatus)).text()).toBe("Added 1 account")

		script.next = { kind: "unchanged" }
		await add.trigger("click")
		await w.vm.$nextTick()
		expect(w.find(sel(TESTIDS.accountMenuAddStatus)).text()).toBe("No accounts were added")
	})

	it("Add accounts… is disabled while an operation is in flight or a request is up", async () => {
		const script = (wideningModule as unknown as { __wideningScript: { busy: { value: boolean } } }).__wideningScript
		connectSession()
		const w = mountSwitcher()
		let release: () => void = () => {}
		const span = withOperation(() => new Promise<void>((res) => (release = res)))
		await w.find(sel(TESTIDS.accountChip)).trigger("click")
		expect(w.find(sel(TESTIDS.accountMenuAddAccounts)).attributes("disabled")).toBeDefined()
		release()
		await span
		await w.vm.$nextTick()
		expect(w.find(sel(TESTIDS.accountMenuAddAccounts)).attributes("disabled")).toBeUndefined()

		script.busy.value = true
		await w.vm.$nextTick()
		expect(w.find(sel(TESTIDS.accountMenuAddAccounts)).attributes("disabled")).toBeDefined()
		expect(w.find(sel(TESTIDS.accountMenuAddAccounts)).text()).toBe("Asking your wallet…")
		script.busy.value = false
	})

	it("while an operation is in flight: rows disabled, hint shown, click does nothing", async () => {
		const c = connectSession()
		const w = mountSwitcher()
		let release: () => void = () => {}
		const span = withOperation(() => new Promise<void>((res) => (release = res)))

		await w.find(sel(TESTIDS.accountChip)).trigger("click")
		expect(w.find(sel(TESTIDS.accountMenu)).text()).toContain("Finish the current operation to switch.")
		const other = w.findAll(sel(TESTIDS.accountMenuRow))[1]
		expect(other.attributes("disabled")).toBeDefined()
		await other.trigger("click")
		expect(c.selectedAccount.value).toBe(ADDR_A)

		release()
		await span
	})

	it("single-account session still renders the menu — Disconnect must not disappear", async () => {
		const c = connectSession([{ address: ADDR_A, alias: "Only" }])
		const w = mountSwitcher()
		await w.find(sel(TESTIDS.accountChip)).trigger("click")
		expect(w.findAll(sel(TESTIDS.accountMenuRow))).toHaveLength(1)
		const disconnectBtn = w.find(sel(TESTIDS.btnDisconnect))
		expect(disconnectBtn.exists()).toBe(true)
		await disconnectBtn.trigger("click")
		expect(c.status.value).toBe("idle")
	})

	it("Escape closes the menu without switching", async () => {
		const c = connectSession()
		const w = mountSwitcher()
		await w.find(sel(TESTIDS.accountChip)).trigger("click")
		await w.find(sel(TESTIDS.accountMenu)).trigger("keydown", { key: "Escape" })
		expect(w.find(sel(TESTIDS.accountMenu)).exists()).toBe(false)
		expect(c.selectedAccount.value).toBe(ADDR_A)
	})

	it("copy button copies the FULL address without toggling selection", async () => {
		const c = connectSession()
		const writeText = vi.fn(async () => {})
		// Restored in finally: a leaked stub clipboard would outlive this case and silently
		// answer for every later test in the file.
		const original = Object.getOwnPropertyDescriptor(navigator, "clipboard")
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
		try {
			const w = mountSwitcher()
			await w.find(sel(TESTIDS.accountChip)).trigger("click")
			await w.findAll(sel(TESTIDS.accountMenuCopy))[1].trigger("click")
			expect(writeText).toHaveBeenCalledWith(ADDR_B)
			expect(c.selectedAccount.value).toBe(ADDR_A) // copy is a sibling control, not selection
			expect(w.find(sel(TESTIDS.accountMenu)).exists()).toBe(true) // menu stays open
		} finally {
			if (original) Object.defineProperty(navigator, "clipboard", original)
			else Reflect.deleteProperty(navigator, "clipboard")
		}
	})

	it("discloses grant truncation in the menu", async () => {
		const c = connectSession()
		c.hiddenAccountsCount.value = 3
		const w = mountSwitcher()
		await w.find(sel(TESTIDS.accountChip)).trigger("click")
		const note = w.find(sel(TESTIDS.accountMenuTruncation))
		expect(note.exists()).toBe(true)
		expect(note.text()).toContain("Showing 2 of 5")
	})
})
