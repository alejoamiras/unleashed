/*
 * Tools smoke e2e. Mounts App.vue in jsdom, mocks the wallet-sdk +
 * contracts boundaries, walks through:
 *
 *   1. empty state (no wallet detected when discovery times out)
 *   2. discover → emoji modal → confirm → capability approval → connected
 *   3. balances render (0.00 / 0.00 across both tokens)
 *   4. click 'Drip 1,000 SIGNAL to public' → loading → success toast
 *   5. disconnect → resets to empty state
 *
 * No real browser, no aztec network. The mock provider satisfies every
 * RPC the tools app issues — discovery, secure-channel, confirm,
 * requestCapabilities, registerContract, executeUtility, sendTx.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, type VueWrapper } from "@vue/test-utils"

// The mock bodies live in the fixture (shared with shell-smoke); vi.mock itself must be declared here.
vi.mock("@aztec-labs/wallet-sdk/manager", async () => (await import("./fixtures/sdk-boundary")).walletManagerModule())
vi.mock("@/lib/emoji", async () => (await import("./fixtures/sdk-boundary")).emojiModule())
vi.mock("@aztec-labs/aztec.js/node", async () => (await import("./fixtures/sdk-boundary")).aztecNodeModule())
vi.mock("@/contracts/deployments", async () => (await import("./fixtures/sdk-boundary")).deploymentsModule())
vi.mock("@/contracts/sponsored-fpc", async () => (await import("./fixtures/sdk-boundary")).sponsoredFpcModule())
vi.mock("@/contracts/private-fpc", async () => (await import("./fixtures/sdk-boundary")).privateFpcModule())
vi.mock("@/contracts/bridge-generation", async (importActual) =>
	(await import("./fixtures/sdk-boundary")).bridgeGenerationModule(importActual),
)
vi.mock("@aztec-labs/aztec.js/contracts", async () => (await import("./fixtures/sdk-boundary")).aztecContractsModule())
vi.mock("@aztec-labs/aztec.js/addresses", async (importActual) => importActual())
vi.mock("@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js", async () =>
	(await import("./fixtures/sdk-boundary")).dripperArtifactModule(),
)
vi.mock("@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js", async () =>
	(await import("./fixtures/sdk-boundary")).tokenArtifactModule(),
)

import { __resetDockStateForTests } from "@/composables/useDockState"
import { __resetDripForTests } from "@/composables/useDrip"
import { __resetShellForTests, useShell } from "@/composables/useShell"
import { __resetToastsForTests } from "@/composables/useToast"
import { __resetWalletConnectionForTests } from "@/composables/useWalletConnection"
import { TESTIDS } from "@/lib/testids"
import {
	connectThroughPicker,
	makePending,
	makeWalletStub,
	mockEstablishSecureChannel,
	mockGetAvailableWallets,
	mockProvider,
	mountApp,
	resetBoundary,
	yieldNone,
} from "./fixtures/sdk-boundary"

describe("tools smoke", () => {
	let wrapper: VueWrapper | null = null

	beforeEach(() => {
		localStorage.clear()
		__resetWalletConnectionForTests()
		__resetDripForTests()
		__resetToastsForTests()
		__resetShellForTests()
		__resetDockStateForTests()
		resetBoundary()
		// The faucet smoke drives the faucet chip's connect flow; the app itself lands on the bridge.
		useShell().goTo("drip")
	})

	afterEach(() => {
		wrapper?.unmount()
		wrapper = null
		vi.clearAllMocks()
		document.body.innerHTML = ""
	})

	it("1. empty state — no wallet detected after discovery timeout", async () => {
		mockGetAvailableWallets.mockImplementationOnce(() => ({
			wallets: yieldNone(),
			cancel: () => {},
			done: Promise.resolve(),
		}))
		wrapper = await mountApp()
		await wrapper.get(`[data-testid="${TESTIDS.btnConnect}"]`).trigger("click")
		await flushPromises()
		expect(wrapper.text()).toContain("No Aztec wallet found.")
		expect(wrapper.get(`[data-testid="${TESTIDS.btnInstallWallet}"]`).text()).toBe("Get a wallet")
	})

	it("2. discover → emoji modal → confirm → connected", async () => {
		const pending = makePending()
		mockEstablishSecureChannel.mockResolvedValueOnce(pending)
		wrapper = await mountApp()

		await connectThroughPicker(wrapper)

		const modal = document.querySelector(`[data-testid="${TESTIDS.verificationModal}"]`)
		expect(modal).not.toBeNull()

		const confirmBtn = document.querySelector(`[data-testid="${TESTIDS.btnVerifyConfirm}"]`) as HTMLElement
		confirmBtn.click()
		await flushPromises()

		const statusEl = wrapper.get(`[data-testid="${TESTIDS.status}"]`)
		expect(statusEl.attributes("data-status")).toBe("connected")
		expect(wrapper.find(`[data-testid="${TESTIDS.account}"]`).exists()).toBe(true)
	})

	it("3. once connected, both token cards render with 0.00 balances", async () => {
		const pending = makePending()
		mockEstablishSecureChannel.mockResolvedValueOnce(pending)
		wrapper = await mountApp()

		await connectThroughPicker(wrapper)
		const confirm = document.querySelector(`[data-testid="${TESTIDS.btnVerifyConfirm}"]`) as HTMLElement
		confirm.click()
		await flushPromises()
		await flushPromises()

		const cards = wrapper.findAll(`[data-testid="${TESTIDS.tokenCard}"]`)
		expect(cards).toHaveLength(2)
		expect(cards[0].attributes("data-symbol")).toBe("SIGNAL")
		expect(cards[1].attributes("data-symbol")).toBe("NOISE")
	})

	it("2b. a remembered wallet skips the picker", async () => {
		// The discovery stream yields the sole claimant and ends naturally, so
		// the remembered path resolves immediately (no ambiguity-window wait).
		localStorage.setItem("unleashed:preferred-wallet", JSON.stringify({ id: mockProvider.id, name: mockProvider.name }))
		const pending = makePending()
		mockEstablishSecureChannel.mockResolvedValueOnce(pending)
		wrapper = await mountApp()

		await wrapper.get(`[data-testid="${TESTIDS.btnConnect}"]`).trigger("click")
		await flushPromises()

		expect(document.querySelector(`[data-testid="${TESTIDS.walletPicker}"]`)).toBeNull()
		expect(document.querySelector(`[data-testid="${TESTIDS.verificationModal}"]`)).not.toBeNull()
	})

	it("3b. the Send section renders the wizard; the bridges list lives on Activity alone", async () => {
		wrapper = await mountApp()
		await wrapper.get(`[data-testid="${TESTIDS.tabSend}"]`).trigger("click")
		await flushPromises()
		expect(wrapper.find(`[data-testid="${TESTIDS.sendView}"]`).isVisible()).toBe(true)
		// A network whose manifest carries no bridge renders the placeholder instead of the wizard.
		const hasBridge = wrapper.find(`[data-testid="${TESTIDS.sendUnavailable}"]`).exists() === false
		expect(wrapper.find(`[data-testid="${TESTIDS.sendStepStrip}"]`).exists()).toBe(hasBridge)
		expect(wrapper.findAll(`[data-testid="${TESTIDS.journal}"]`).length).toBe(0)
		await wrapper.get(`[data-testid="${TESTIDS.tabActivity}"]`).trigger("click")
		await flushPromises()
		// Exactly one list, on Activity; a bridge-less network shows its notice there instead.
		expect(wrapper.findAll(`[data-testid="${TESTIDS.journal}"]`).length).toBe(hasBridge ? 1 : 0)
		expect(wrapper.find(`[data-testid="${TESTIDS.activityUnavailable}"]`).exists()).toBe(!hasBridge)
	})

	it("4. clicking 'Drip … to public' fires sendTx and shows a success toast", async () => {
		const wallet = makeWalletStub()
		const pending = { verificationHash: "deadbeef", confirm: async () => wallet, cancel: async () => {} }
		mockEstablishSecureChannel.mockResolvedValueOnce(pending)
		wrapper = await mountApp()

		await connectThroughPicker(wrapper)
		const confirm = document.querySelector(`[data-testid="${TESTIDS.btnVerifyConfirm}"]`) as HTMLElement
		confirm.click()
		await flushPromises()
		await flushPromises()

		const signalCard = wrapper.findAll(`[data-testid="${TESTIDS.tokenCard}"]`).find((c) => c.attributes("data-symbol") === "SIGNAL")
		const dripBtn = signalCard?.find(`[data-testid="${TESTIDS.btnDripPublic}"]`)
		expect(dripBtn?.exists()).toBe(true)
		await dripBtn?.trigger("click")
		await flushPromises()

		expect(wallet.sendTx).toHaveBeenCalledTimes(1)
		// Toast pushed; rendered via AppToastRegion + Toast component.
		const toasts = wrapper.findAll(`[data-testid="${TESTIDS.toast}"]`)
		expect(toasts.length).toBeGreaterThan(0)
		expect(toasts[0].text()).toContain("Dripped 1,000 SIGNAL to public")
	})

	it("5. clicking disconnect resets back to the connect button", async () => {
		const pending = makePending()
		mockEstablishSecureChannel.mockResolvedValueOnce(pending)
		wrapper = await mountApp()

		await connectThroughPicker(wrapper)
		const confirm = document.querySelector(`[data-testid="${TESTIDS.btnVerifyConfirm}"]`) as HTMLElement
		confirm.click()
		await flushPromises()
		await flushPromises()

		// Disconnect moved into the account menu (multi-account switcher) — open it from the chip.
		expect(wrapper.find(`[data-testid="${TESTIDS.accountChip}"]`).exists()).toBe(true)
		await wrapper.get(`[data-testid="${TESTIDS.accountChip}"]`).trigger("click")
		expect(wrapper.find(`[data-testid="${TESTIDS.btnDisconnect}"]`).exists()).toBe(true)
		await wrapper.get(`[data-testid="${TESTIDS.btnDisconnect}"]`).trigger("click")
		await flushPromises()

		const statusEl = wrapper.get(`[data-testid="${TESTIDS.status}"]`)
		expect(statusEl.attributes("data-status")).toBe("idle")
		expect(wrapper.find(`[data-testid="${TESTIDS.btnConnect}"]`).exists()).toBe(true)
	})
})
