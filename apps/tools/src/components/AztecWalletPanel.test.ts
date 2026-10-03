import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TESTIDS } from "@/lib/testids"

// Mock the wallet-sdk and aztec node clients so importing the composable
// doesn't trip on missing browser-only globals.
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

import { __resetWalletConnectionForTests, useWalletConnection } from "@/composables/useWalletConnection"
import AztecWalletPanel from "./AztecWalletPanel.vue"

const sel = (t: string) => `[data-testid="${t}"]`
const faucet = () => mount(AztecWalletPanel, { props: { variant: "faucet" } })
const bridge = () => mount(AztecWalletPanel, { props: { variant: "bridge" } })

describe("AztecWalletPanel", () => {
	beforeEach(() => __resetWalletConnectionForTests())
	afterEach(() => __resetWalletConnectionForTests())

	it("idle: one magenta 'Connect Aztec' with a wallet glyph, under each variant's own testid", () => {
		const btn = faucet().get(sel(TESTIDS.btnConnect))
		expect(btn.text()).toBe("Connect Aztec")
		expect(btn.classes().join(" ")).toMatch(/primary/)
		expect(btn.find("svg").attributes("width")).toBe("24")
		expect(bridge().get(sel(TESTIDS.bridgeL2Connect)).text()).toBe("Connect Aztec")
		expect(bridge().find(sel(TESTIDS.btnConnect)).exists()).toBe(false)
	})

	it("idle with a remembered wallet: split button — 'Connect <name>' + picker caret", () => {
		useWalletConnection().preferredWalletName.value = "Test Wallet"
		const w = faucet()
		expect(w.get(sel(TESTIDS.btnConnect)).text()).toBe("Connect Test Wallet")
		expect(w.get(sel(TESTIDS.btnSwitchWallet)).attributes("aria-label")).toBe("Choose a different wallet")
		expect(bridge().find(sel(TESTIDS.bridgeL2SwitchWallet)).exists()).toBe(true)
	})

	it("discovering: the button reads 'Searching…', is busy, and is disabled so a press cannot re-fire", () => {
		useWalletConnection().status.value = "discovering"
		const btn = faucet().get(sel(TESTIDS.btnConnect))
		expect(btn.text()).toContain("Searching for wallet")
		expect(btn.attributes("aria-busy")).toBe("true")
		expect(btn.attributes("disabled")).toBeDefined()
	})

	it("verifying: the modal mounts when emojis are set", () => {
		const c = useWalletConnection()
		c.status.value = "verifying"
		c.verificationEmojis.value = "🟢🔵🟡🟣🔴⚪⚫🟠🟤"
		mount(AztecWalletPanel, { props: { variant: "bridge" }, attachTo: document.body })
		expect(document.querySelector(sel(TESTIDS.verificationModal))).not.toBeNull()
	})

	it("capability-approval: the button morphs to the awaiting state in the same footprint", () => {
		useWalletConnection().status.value = "capability-approval"
		const w = faucet()
		expect(w.find(sel(TESTIDS.capabilityApproval)).exists()).toBe(true)
		const btn = w.get(sel(TESTIDS.btnCapabilityRetry))
		expect(btn.text()).toContain("Approve in your wallet")
		expect(btn.attributes("aria-busy")).toBe("true")
		expect(btn.attributes("disabled")).toBeDefined()
		expect(bridge().text()).toContain("Approve in your wallet")
	})

	it("capability-rejected: denied retry button in the same footprint", () => {
		const c = useWalletConnection()
		c.status.value = "error"
		c.error.value = { category: "capability-rejected", message: "x", raw: null }
		expect(faucet().get(sel(TESTIDS.btnCapabilityRetry)).text()).toContain("Permissions denied")
	})

	it("no-wallet: the faucet variant offers the install CTA; the bridge variant leaves it to the strip", () => {
		const c = useWalletConnection()
		c.status.value = "error"
		c.error.value = { category: "no-wallet", message: "x", raw: null }
		const w = faucet()
		expect(w.text()).toContain("No Aztec wallet found.")
		expect(w.get(sel(TESTIDS.btnInstallWallet)).text()).toBe("Get a wallet")
		const b = bridge()
		expect(b.find(sel(TESTIDS.btnInstallWallet)).exists()).toBe(false)
		expect(b.get(sel(TESTIDS.bridgeL2Connect)).text()).toBe("Retry connection")
	})

	it("connected: the account chip; Disconnect lives in the menu, under the variant's testid", async () => {
		const c = useWalletConnection()
		c.status.value = "connected"
		c.selectedAccount.value = `0x${"a1b2c3".padStart(64, "0")}`
		const w = faucet()
		expect(w.text()).toContain("Aztec")
		expect(w.find(sel(TESTIDS.account)).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.btnDisconnect)).exists()).toBe(false)
		await w.find(sel(TESTIDS.accountChip)).trigger("click")
		expect(w.find(sel(TESTIDS.btnDisconnect)).exists()).toBe(true)
		const b = bridge()
		expect(b.find(sel(TESTIDS.bridgeL2Account)).exists()).toBe(true)
		await b.find(sel(TESTIDS.accountChip)).trigger("click")
		expect(b.find(sel(TESTIDS.bridgeL2Disconnect)).exists()).toBe(true)
	})

	it("generic error: red retry button, the message delegated to the strip", () => {
		const c = useWalletConnection()
		c.status.value = "error"
		c.error.value = { category: "network", message: "Alpha-testnet is not responding. Try again.", raw: null }
		const btn = faucet().get(sel(TESTIDS.btnConnect))
		expect(btn.text()).toBe("Retry connection")
		expect(btn.classes()).toContain("denied")
		expect(faucet().text()).not.toContain("Alpha-testnet is not responding")
	})
})
