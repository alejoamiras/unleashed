/**
 * The mocked SDK + contract boundary the jsdom smokes mount `App.vue` over. `vi.mock` must be
 * declared in each test file (it is hoisted per file), but the bodies live here once: a smoke
 * imports the factory it needs inside its `vi.mock` callback.
 */
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { expect, vi } from "vitest"
import { TESTIDS } from "@/lib/testids"

export const mockEstablishSecureChannel = vi.fn()
export const mockDisconnectProvider = vi.fn(async () => {})
export const mockProvider = {
	id: "test-wallet",
	name: "Test Wallet",
	establishSecureChannel: mockEstablishSecureChannel,
	disconnect: mockDisconnectProvider,
	isDisconnected: () => false,
	onDisconnect: () => () => {},
}

export async function* yieldOne() {
	yield mockProvider
}

export async function* yieldNone(): AsyncGenerator<typeof mockProvider, void, unknown> {
	// no providers
}

export const mockGetAvailableWallets = vi.fn(() => ({
	wallets: yieldOne(),
	cancel: () => {},
	done: Promise.resolve(),
}))

export const walletManagerModule = () => ({
	WalletManager: { configure: () => ({ getAvailableWallets: mockGetAvailableWallets }) },
})

export const emojiModule = () => ({
	hashToEmoji: () => "🟢🔵🟡🟣🔴⚪⚫🟠🟤",
	toGrid: (s: string) => Array.from(s).slice(0, 9),
})

export const aztecNodeModule = () => ({
	createAztecNodeClient: () => ({ getContract: async () => ({}) }),
})

export const deploymentsModule = () => ({
	DRIPPER: { toString: () => "0xdripper", equals: () => false },
	SIGNAL: { toString: () => "0xusdc", equals: () => false },
	NOISE: { toString: () => "0xeth", equals: () => false },
	rebuildDripperInstance: vi.fn(async () => ({ address: { toString: () => "0xdripper" } })),
	rebuildSignalInstance: vi.fn(async () => ({ address: { toString: () => "0xusdc" } })),
	rebuildNoiseInstance: vi.fn(async () => ({ address: { toString: () => "0xeth" } })),
})

export const sponsoredFpcModule = () => ({
	getSponsoredFpcInstance: async () => ({ address: { toString: () => "0xfpc" } }),
})

// Pre-baked like every other contract module here: the real getPrivateFpc dynamically imports the
// PrivateFPC artifact + runs loadContractArtifact/derivation, which the gutted aztec.js mocks can't
// support - unmocked, the connect-time registration rejects and status wedges at "setting-up".
export const privateFpcModule = () => ({
	getPrivateFpc: async () => ({ instance: { address: { toString: () => "0xprivfpc" } }, artifact: { name: "PrivateFPC" } }),
})

// Same treatment for the generation's hub + hub-token instances the connect registers on a live
// bridge manifest: their re-derivation runs bb.js address math the gutted aztec.js mocks answer with
// `0x0`, which the instantiation check rightly refuses. The manifest constants stay real.
export async function bridgeGenerationModule(importActual: <T>() => Promise<T>) {
	const actual = await importActual<typeof import("@/contracts/bridge-generation")>()
	const instanceAt = (address: string) => ({ address: { toString: () => address, equals: () => false } })
	return {
		...actual,
		rebuildHubInstance: vi.fn(async () => instanceAt(actual.GENERATION?.l2.hub.address ?? "0xhub")),
		rebuildHubTokenInstance: vi.fn(async (erc20: string) =>
			instanceAt(actual.MANIFEST_TOKENS.find((t) => t.erc20.toLowerCase() === erc20.toLowerCase())?.l2Token ?? "0xhubtoken"),
		),
	}
}

export const aztecContractsModule = () => ({
	Contract: {
		at: vi.fn(async () => ({
			methods: {
				balance_of_public: () => ({ request: async () => ({ call: "balance_of_public" }) }),
				balance_of_private: () => ({ request: async () => ({ call: "balance_of_private" }) }),
				drip_to_public: () => ({ request: async () => ({ calls: [{ target: "public" }] }) }),
				drip_to_private: () => ({ request: async () => ({ calls: [{ target: "private" }] }) }),
			},
		})),
	},
	getContractInstanceFromInstantiationParams: vi.fn(async () => ({ address: { toString: () => "0x0" } })),
})

export const dripperArtifactModule = () => ({ DripperContractArtifact: { name: "Dripper" } })
export const tokenArtifactModule = () => ({ TokenContractArtifact: { name: "Token" } })

export function makeWalletStub() {
	return {
		requestCapabilities: vi.fn(async () => ({
			granted: [
				{
					type: "accounts",
					accounts: [{ alias: "Main", item: "0x000000000000000000000000000000000000000000000000000000000000000a" }],
				},
			],
		})),
		registerContract: vi.fn(async () => {}),
		executeUtility: vi.fn(async () => 0n),
		sendTx: vi.fn(async () => ({ txHash: "0xtxabcdef" })),
	}
}

export function makePending(verificationHash = "deadbeef") {
	return {
		verificationHash,
		confirm: vi.fn(async () => makeWalletStub()),
		cancel: vi.fn(async () => {}),
	}
}

/** The mainnet-placeholder split loads the shell asynchronously. Warming the module first is what
 *  makes the mount usable within one flush — the shell's own import graph takes more than a tick. */
export async function mountApp(): Promise<VueWrapper> {
	await import("@/AppShell.vue")
	const { default: App } = await import("@/App.vue")
	const w = mount(App, { attachTo: document.body })
	await flushPromises()
	return w
}

export async function connectThroughPicker(wrapper: VueWrapper) {
	await wrapper.get(`[data-testid="${TESTIDS.btnConnect}"]`).trigger("click")
	await flushPromises()
	const pickerRow = document.querySelector(`[data-testid="${TESTIDS.walletPickerConnect}"]`) as HTMLElement | null
	expect(pickerRow).not.toBeNull()
	// The picker ignores row activation for 500 ms after the rows change.
	await new Promise((r) => setTimeout(r, 550))
	pickerRow?.click()
	await flushPromises()
}

/** Every smoke starts from a cold session: the singletons reset and the provider stream yields the fixture wallet. */
export function resetBoundary(): void {
	mockEstablishSecureChannel.mockReset()
	mockDisconnectProvider.mockReset()
	mockDisconnectProvider.mockImplementation(async () => {})
	mockGetAvailableWallets.mockReset()
	mockGetAvailableWallets.mockImplementation(() => ({ wallets: yieldOne(), cancel: () => {}, done: Promise.resolve() }))
}
