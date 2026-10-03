/*
 * Shell smoke. Mounts App.vue in jsdom over the same mocked SDK boundary as tools-smoke and walks
 * the shell itself: the rail, the section header's wallet chips, the Activity page, and the
 * completion toast that must fire whichever section is showing.
 */

import { flushPromises, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

import { __resetJournalForTests, addRecord, claimForeground, lastCompleted, releaseForeground } from "@/composables/useBridgeJournal"
import { __resetDockStateForTests } from "@/composables/useDockState"
import { __resetDripForTests } from "@/composables/useDrip"
import { __resetShellForTests } from "@/composables/useShell"
import { __resetToastsForTests } from "@/composables/useToast"
import { __resetWalletConnectionForTests } from "@/composables/useWalletConnection"
import { IS_PLACEHOLDER } from "@/contracts/bridge-generation"
import { TESTIDS } from "@/lib/testids"
import { mountApp, resetBoundary } from "./fixtures/sdk-boundary"

const sel = (t: string) => `[data-testid="${t}"]`

/** A deposit whose message has landed (leaf index known): CLAIM is the next step. */
function claimableDeposit(id: string) {
	return {
		schema: 1 as const,
		id,
		direction: "deposit" as const,
		isPrivate: false,
		amount: "1000000000000000000",
		createdAt: Date.now() - 60_000,
		updatedAt: Date.now() - 60_000,
		recipient: "0x000000000000000000000000000000000000000000000000000000000000000a",
		secretHashHex: "0x1",
		leafIndex: "7",
		chainId: 11155111,
		portal: "0xportal",
		bridge: "0xbridge",
	}
}

describe("shell smoke", () => {
	let wrapper: VueWrapper | null = null

	beforeEach(() => {
		localStorage.clear()
		__resetWalletConnectionForTests()
		__resetDripForTests()
		__resetToastsForTests()
		__resetShellForTests()
		__resetDockStateForTests()
		if (!IS_PLACEHOLDER) __resetJournalForTests()
		resetBoundary()
	})

	afterEach(() => {
		wrapper?.unmount()
		wrapper = null
		vi.clearAllMocks()
		document.body.innerHTML = ""
	})

	it("1. the rail lands on the bridge with three sections, and Tab reaches exactly one of them", async () => {
		wrapper = await mountApp()
		const rail = wrapper.get(sel(TESTIDS.tabs))
		expect(rail.attributes("role")).toBe("tablist")
		const tabs = [TESTIDS.tabSend, TESTIDS.tabDrip, TESTIDS.tabActivity].map((id) => wrapper?.get(sel(id)))
		expect(tabs.map((t) => t?.attributes("tabindex"))).toEqual(["0", "-1", "-1"])
		expect(wrapper.get(sel(TESTIDS.tabSend)).text()).toBe("Bridge")
		expect(wrapper.find(sel(TESTIDS.sendView)).isVisible()).toBe(true)
		expect(wrapper.find(sel(TESTIDS.dripView)).isVisible()).toBe(false)
	})

	it("2. each section keeps its wallet chips in the header: Ethereum + Aztec on the bridge, the faucet chip alone", async () => {
		wrapper = await mountApp()
		const header = () => wrapper?.get(sel(TESTIDS.sectionHeader))
		expect(header()?.find(sel(TESTIDS.l1Status)).exists()).toBe(true)
		expect(header()?.find(sel(TESTIDS.bridgeL2Status)).exists()).toBe(true)
		expect(header()?.find(sel(TESTIDS.status)).exists()).toBe(false)
		// The wizard view no longer carries chips of its own.
		expect(wrapper.get(sel(TESTIDS.sendView)).find(sel(TESTIDS.l1Status)).exists()).toBe(false)
		await wrapper.get(sel(TESTIDS.tabDrip)).trigger("click")
		await flushPromises()
		expect(header()?.find(sel(TESTIDS.status)).exists()).toBe(true)
		expect(header()?.find(sel(TESTIDS.l1Status)).exists()).toBe(false)
	})

	it("3. Activity is a page: the first-visit tiles route to Send and Faucet; the dock is not there", async () => {
		wrapper = await mountApp()
		await wrapper.get(sel(TESTIDS.tabActivity)).trigger("click")
		await flushPromises()
		expect(wrapper.find(sel(TESTIDS.activityView)).exists()).toBe(true)
		if (IS_PLACEHOLDER) {
			expect(wrapper.find(sel(TESTIDS.activityUnavailable)).exists()).toBe(true)
			return
		}
		expect(wrapper.find(sel(TESTIDS.activityFirstVisit)).exists()).toBe(true)
		await wrapper.get(sel(TESTIDS.activityTileSend)).trigger("click")
		await flushPromises()
		expect(wrapper.find(sel(TESTIDS.sendView)).isVisible()).toBe(true)
		expect(wrapper.find(sel(TESTIDS.activityView)).exists()).toBe(false)
	})

	it("4. a background completion toasts while the faucet is showing (the shell owns the toast)", async () => {
		if (IS_PLACEHOLDER) return
		wrapper = await mountApp()
		await wrapper.get(sel(TESTIDS.tabDrip)).trigger("click")
		await flushPromises()
		lastCompleted.value = {
			id: "0xbg",
			direction: "deposit",
			display: { raw: "1000000", decimals: 6, atLeast: false, symbol: "USDC", gross: false },
			isPrivate: false,
			assetKind: "bridge-token",
			txHash: `0x${"ab".repeat(32)}`,
			foreground: false,
		}
		await flushPromises()
		expect(wrapper.get(sel(TESTIDS.toast)).text()).toContain("to Aztec")
	})

	it("6. the dock: hidden with no badge; a record that starts needing you opens it once; hidden again, the badge equals the page's buttons", async () => {
		if (IS_PLACEHOLDER) return
		wrapper = await mountApp()
		expect(wrapper.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(wrapper.find(sel(TESTIDS.dockStrip)).exists()).toBe(true)
		expect(wrapper.find(sel(TESTIDS.dockBadge)).exists()).toBe(false)

		addRecord(claimableDeposit("0xneeds"))
		await flushPromises()
		expect(wrapper.find(sel(TESTIDS.dock)).exists()).toBe(true)
		const actions = wrapper.findAll(sel(TESTIDS.activityRowAction))
		expect(actions.map((a) => a.text())).toEqual(["Claim"])
		expect(localStorage.getItem("unleashed:tools-dock")).toBeNull()

		await wrapper.get(sel(TESTIDS.dockHide)).trigger("click")
		await flushPromises()
		expect(wrapper.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(wrapper.get(sel(TESTIDS.dockBadge)).text()).toBe("1")

		// The page agrees with the badge: one CLAIM there, and no dock beside it.
		await wrapper.get(sel(TESTIDS.tabActivity)).trigger("click")
		await flushPromises()
		expect(wrapper.findAll(sel(TESTIDS.journalClaim))).toHaveLength(1)
		expect(wrapper.find(sel(TESTIDS.dockStrip)).exists()).toBe(false)

		// Back on Send the record is still needing you, and the dock stays as it was left.
		await wrapper.get(sel(TESTIDS.tabSend)).trigger("click")
		await flushPromises()
		expect(wrapper.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(wrapper.get(sel(TESTIDS.dockBadge)).text()).toBe("1")
	})

	it("7. the record whose stepper is on screen is a read-only row that never opens the dock or badges; released, it needs you", async () => {
		if (IS_PLACEHOLDER) return
		wrapper = await mountApp()
		claimForeground("0xfg")
		addRecord(claimableDeposit("0xfg"))
		await flushPromises()
		expect(wrapper.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(wrapper.find(sel(TESTIDS.dockBadge)).exists()).toBe(false)

		await wrapper.get(sel(TESTIDS.dockOpen)).trigger("click")
		await flushPromises()
		const row = wrapper.get(sel(TESTIDS.activityRow))
		expect(row.attributes("data-record-id")).toBe("0xfg")
		expect(row.attributes("aria-current")).toBe("true")
		expect(row.text()).toContain("this send")
		expect(row.find(sel(TESTIDS.activityRowAction)).exists()).toBe(false)
		await wrapper.get(sel(TESTIDS.dockHide)).trigger("click")
		await flushPromises()

		releaseForeground("0xfg")
		await flushPromises()
		expect(wrapper.find(sel(TESTIDS.dock)).exists()).toBe(true)
		const released = wrapper.get(sel(TESTIDS.activityRow))
		expect(released.attributes("data-group")).toBe("needs-you")
		expect(released.attributes("aria-current")).toBeUndefined()
		expect(released.get(sel(TESTIDS.activityRowAction)).text()).toBe("Claim")
	})

	it("5. the rail's keyboard: arrows move between sections without leaving the tablist", async () => {
		wrapper = await mountApp()
		await wrapper.get(sel(TESTIDS.tabSend)).trigger("keydown", { key: "ArrowDown" })
		await flushPromises()
		expect(wrapper.find(sel(TESTIDS.dripView)).isVisible()).toBe(true)
		await wrapper.get(sel(TESTIDS.tabDrip)).trigger("keydown", { key: "ArrowDown" })
		await flushPromises()
		expect(wrapper.find(sel(TESTIDS.activityView)).exists()).toBe(true)
		await wrapper.get(sel(TESTIDS.tabActivity)).trigger("keydown", { key: "ArrowDown" })
		await flushPromises()
		expect(wrapper.find(sel(TESTIDS.sendView)).isVisible()).toBe(true)
	})
})
