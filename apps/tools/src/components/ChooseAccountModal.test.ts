import { enableAutoUnmount, mount } from "@vue/test-utils"
import { clickScrim } from "@unleashed/design/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TESTIDS } from "@/lib/testids"

// Real-session harness (same SDK mocks as useWalletConnection.test.ts): the modal is driven
// through the ACTUAL choose-account pause, so Continue exercises the real single-use token,
// not a spied method.
const mockEstablishSecureChannel = vi.fn()
const mockGetAvailableWallets = vi.fn()

vi.mock("@aztec-labs/wallet-sdk/manager", () => ({
	WalletManager: { configure: vi.fn(() => ({ getAvailableWallets: mockGetAvailableWallets })) },
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
vi.mock("@unleashed/bridge-core/artifacts", () => ({
	bridgeProxyArtifact: { name: "BridgeProxy" },
	tokenBridgeArtifact: { name: "TokenBridge" },
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
vi.mock("@/contracts/sponsored-fpc", () => ({ getSponsoredFpcInstance: async () => ({ address: { toString: () => "0xfpc" } }) }))
vi.mock("@/contracts/private-fpc", () => ({
	getPrivateFpc: async () => ({ instance: { address: { toString: () => "0xprivatefpc" } }, artifact: {} }),
}))

import { __resetOpsInFlightForTests, withOperation } from "@/composables/useOpsInFlight"
import { __resetWalletConnectionForTests, useWalletConnection } from "@/composables/useWalletConnection"
import ChooseAccountModal from "./ChooseAccountModal.vue"

const ADDR_A = `0x${"aa".padStart(64, "0")}`
const ADDR_B = `0x${"bb".padStart(64, "0")}`

const mockProvider = {
	id: "test-wallet",
	name: "Test Wallet",
	type: "extension",
	establishSecureChannel: mockEstablishSecureChannel,
	disconnect: vi.fn(async () => {}),
	isDisconnected: () => false,
	onDisconnect: () => () => {},
}

async function* yieldOne() {
	yield mockProvider
}

function makeWallet(grantedAccounts: Array<{ alias?: string; item?: string }>) {
	return {
		requestCapabilities: vi.fn(async () => ({ granted: [{ type: "accounts", accounts: grantedAccounts }] })),
		registerContract: vi.fn(async () => {}),
	}
}

async function driveTo(grantedAccounts: Array<{ alias?: string; item?: string }>) {
	const wallet = makeWallet(grantedAccounts)
	mockEstablishSecureChannel.mockResolvedValue({
		verificationHash: "deadbeef",
		confirm: vi.fn(async () => wallet),
		cancel: vi.fn(async () => {}),
	})
	const c = useWalletConnection()
	await c.connect()
	c.selectWallet(c.discoveredWallets.value[0].key)
	for (let i = 0; i < 6; i++) await Promise.resolve()
	await c.confirmVerification()
	return c
}

function mountModal() {
	// Teleport stubbed so the dialog renders inside the wrapper (jsdom-friendly queries); attached so
	// keys reach the dialog's document listener.
	return mount(ChooseAccountModal, { attachTo: document.body, global: { stubs: { teleport: true } } })
}

enableAutoUnmount(afterEach)

describe("ChooseAccountModal", () => {
	beforeEach(() => {
		localStorage.clear()
		__resetWalletConnectionForTests()
		mockEstablishSecureChannel.mockReset()
		mockGetAvailableWallets.mockReset()
		mockGetAvailableWallets.mockImplementation(() => ({ wallets: yieldOne(), cancel: () => {}, done: Promise.resolve() }))
	})
	afterEach(() => {
		__resetWalletConnectionForTests()
		__resetOpsInFlightForTests()
		vi.clearAllMocks()
	})

	it("is not rendered outside the choosing-account state", () => {
		const w = mountModal()
		expect(w.find(`[data-testid="${TESTIDS.accountChoice}"]`).exists()).toBe(false)
	})

	it("never appears for a single-account grant (flow auto-selects)", async () => {
		const w = mountModal()
		const c = await driveTo([{ alias: "Only", item: ADDR_A }])
		expect(c.status.value).toBe("connected")
		expect(w.find(`[data-testid="${TESTIDS.accountChoice}"]`).exists()).toBe(false)
	})

	it("renders one radio row per account with alias fallback, first pre-selected, no truncation row", async () => {
		const w = mountModal()
		await driveTo([
			{ alias: "Main", item: ADDR_A },
			{ alias: "", item: ADDR_B },
		])
		await w.vm.$nextTick()

		const rows = w.findAll(`[data-testid="${TESTIDS.accountChoiceRow}"]`)
		expect(rows).toHaveLength(2)
		expect(rows[0].attributes("aria-checked")).toBe("true")
		expect(rows[0].text()).toContain("Main")
		expect(rows[1].attributes("aria-checked")).toBe("false")
		expect(rows[1].text()).toContain("—") // empty alias falls back to a dash
		expect(rows[1].text()).toContain(`${ADDR_B.slice(0, 6)}…${ADDR_B.slice(-4)}`)
		expect(w.find(`[data-testid="${TESTIDS.accountChoiceTruncation}"]`).exists()).toBe(false)
		await vi.waitFor(() => expect(document.activeElement).toBe(rows[0].element))
	})

	it("picking a row and pressing Continue resumes the REAL flow to connected", async () => {
		const w = mountModal()
		const c = await driveTo([
			{ alias: "Main", item: ADDR_A },
			{ alias: "Savings", item: ADDR_B },
		])
		expect(c.status.value).toBe("choosing-account")
		await w.vm.$nextTick()

		await w.findAll(`[data-testid="${TESTIDS.accountChoiceRow}"]`)[1].trigger("click")
		await w.find(`[data-testid="${TESTIDS.accountChoiceContinue}"]`).trigger("click")
		// The real registerAllContracts chains several awaits — poll until the flow settles.
		await vi.waitFor(() => expect(c.status.value).toBe("connected"))
		expect(c.selectedAccount.value).toBe(ADDR_B)
	})

	it("Escape cancels the whole connect (idle), not just the dialog", async () => {
		const w = mountModal()
		const c = await driveTo([
			{ alias: "Main", item: ADDR_A },
			{ alias: "Savings", item: ADDR_B },
		])
		await w.vm.$nextTick()

		await w.find('[role="dialog"]').trigger("keydown", { key: "Escape" })
		for (let i = 0; i < 4; i++) await Promise.resolve()
		expect(c.status.value).toBe("idle")
		expect(w.find(`[data-testid="${TESTIDS.accountChoice}"]`).exists()).toBe(false)
	})

	it("Continue waits for an operation in flight: disabled with the hint, live again once it ends", async () => {
		const w = mountModal()
		const c = await driveTo([
			{ alias: "Main", item: ADDR_A },
			{ alias: "Savings", item: ADDR_B },
		])
		let release: () => void = () => {}
		const span = withOperation(() => new Promise<void>((res) => (release = res)))
		await w.vm.$nextTick()
		expect(w.find(`[data-testid="${TESTIDS.accountChoiceContinue}"]`).attributes("disabled")).toBeDefined()
		expect(w.find(`[data-testid="${TESTIDS.accountChoiceBusy}"]`).exists()).toBe(true)
		expect(c.status.value).toBe("choosing-account")
		release()
		await span
		await w.vm.$nextTick()
		expect(w.find(`[data-testid="${TESTIDS.accountChoiceBusy}"]`).exists()).toBe(false)
		await w.find(`[data-testid="${TESTIDS.accountChoiceContinue}"]`).trigger("click")
		await vi.waitFor(() => expect(c.status.value).toBe("connected"))
	})

	it("the header × cancels the connect", async () => {
		const w = mountModal()
		const c = await driveTo([
			{ alias: "Main", item: ADDR_A },
			{ alias: "Savings", item: ADDR_B },
		])
		await w.vm.$nextTick()

		await w.find(`[data-testid="${TESTIDS.accountChoiceClose}"]`).trigger("click")
		for (let i = 0; i < 4; i++) await Promise.resolve()
		expect(c.status.value).toBe("idle")
	})

	it("backdrop click cancels the connect", async () => {
		const w = mountModal()
		const c = await driveTo([
			{ alias: "Main", item: ADDR_A },
			{ alias: "Savings", item: ADDR_B },
		])
		await w.vm.$nextTick()

		clickScrim(w.find(`[data-testid="${TESTIDS.accountChoice}"]`).element)
		for (let i = 0; i < 4; i++) await Promise.resolve()
		expect(c.status.value).toBe("idle")
	})

	it("mounting WHILE already in choosing-account still pre-selects the first account (immediate watcher)", async () => {
		const c = await driveTo([
			{ alias: "Main", item: ADDR_A },
			{ alias: "Savings", item: ADDR_B },
		])
		expect(c.status.value).toBe("choosing-account")
		const w = mountModal() // mounted AFTER the pause began — remount/HMR path
		await w.vm.$nextTick()
		const rows = w.findAll(`[data-testid="${TESTIDS.accountChoiceRow}"]`)
		expect(rows[0].attributes("aria-checked")).toBe("true")
		expect(w.find(`[data-testid="${TESTIDS.accountChoiceContinue}"]`).attributes("disabled")).toBeUndefined()
	})

	it("discloses grant truncation ('Showing 16 of 17')", async () => {
		const w = mountModal()
		const seventeen = Array.from({ length: 17 }, (_, i) => ({
			alias: `Acct ${i}`,
			item: `0x${(i + 1).toString(16).padStart(64, "0")}`,
		}))
		await driveTo(seventeen)
		await w.vm.$nextTick()

		const note = w.find(`[data-testid="${TESTIDS.accountChoiceTruncation}"]`)
		expect(note.exists()).toBe(true)
		expect(note.text()).toContain("Showing 16 of 17")
	})
})
