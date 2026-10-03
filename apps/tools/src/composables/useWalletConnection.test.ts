import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/*
 * Mocks for the SDK boundary. The composable is module-singleton so we
 * import lazily AFTER the mocks register; each test exercises a state
 * transition under controlled SDK responses.
 *
 * The pure helper `extractGrantedAccounts` is unit-tested directly without
 * any mocking - it's import-stable.
 */

const mockEstablishSecureChannel = vi.fn()
const mockDisconnectProvider = vi.fn()
const mockOnDisconnect = vi.fn<(handler: () => void) => () => void>()
let lastDisconnectHandler: (() => void) | null = null

const mockProvider = {
	id: "test-wallet",
	name: "Test Wallet",
	establishSecureChannel: mockEstablishSecureChannel,
	disconnect: mockDisconnectProvider,
	isDisconnected: () => false,
	onDisconnect: (handler: () => void) => mockOnDisconnect(handler),
}

async function* yieldOne() {
	yield mockProvider
}

async function* yieldNone(): AsyncGenerator<typeof mockProvider, void, unknown> {
	// no providers - empty discovery
}

const mockGetAvailableWallets = vi.fn(() => ({
	wallets: yieldOne(),
	cancel: () => {},
	done: Promise.resolve(),
}))

vi.mock("@aztec-labs/wallet-sdk/manager", () => ({
	WalletManager: {
		configure: vi.fn(() => ({
			getAvailableWallets: mockGetAvailableWallets,
		})),
	},
}))

vi.mock("@/lib/emoji", () => ({
	hashToEmoji: () => "🟢🔵🟡🟣🔴⚪⚫🟠🟤",
	toGrid: (s: string) => Array.from(s).slice(0, 9),
}))

vi.mock("@aztec-labs/aztec.js/node", () => ({
	createAztecNodeClient: () => ({ getContract: async () => null }),
}))

vi.mock("@/contracts/deployments", () => ({
	DRIPPER: { toString: () => "0x1" },
	SIGNAL: { toString: () => "0x2" },
	NOISE: { toString: () => "0x3" },
	rebuildDripperInstance: vi.fn(async () => ({ address: { toString: () => "0x1" } })),
	rebuildSignalInstance: vi.fn(async () => ({ address: { toString: () => "0x2" } })),
	rebuildNoiseInstance: vi.fn(async () => ({ address: { toString: () => "0x3" } })),
}))

// The generation reader parses the live manifest at module init; the app's own manifest is still
// v1 during this phase, so the reader is faked down to what the session consumes.
const HUB_ADDR = `0x${"4".padStart(64, "0")}`
const MANIFEST_L2_TOKEN = `0x${"5".padStart(64, "0")}`
const REQUESTED_L2_TOKEN = `0x${"6".padStart(64, "0")}`
const ZERO_WORD = `0x${"0".repeat(64)}`

vi.mock("@/contracts/bridge-generation", async () => {
	const { AztecAddress } = await import("@aztec-labs/aztec.js/addresses")
	return {
		HUB: AztecAddress.fromStringUnsafe(`0x${"4".padStart(64, "0")}`),
		HUB_ARTIFACT: { name: "TokenBridgeHub" },
		HUB_TOKEN_ARTIFACT: { name: "Token" },
		MANIFEST_TOKENS: [
			{
				erc20: "0x1111111111111111111111111111111111111111",
				l2Token: `0x${"5".padStart(64, "0")}`,
				nameWord: `0x${"0".repeat(64)}`,
				symbolWord: `0x${"0".repeat(64)}`,
				decimals: 6,
			},
		],
		rebuildHubInstance: vi.fn(async () => ({ address: { toString: () => `0x${"4".padStart(64, "0")}` } })),
		rebuildHubTokenInstance: vi.fn(async (erc20: string) => ({ address: { toString: () => erc20 } })),
	}
})

vi.mock("@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js", () => ({
	DripperContractArtifact: { name: "Dripper" },
}))
vi.mock("@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js", () => ({
	TokenContractArtifact: { name: "Token" },
}))
vi.mock("@/contracts/sponsored-fpc", () => ({
	getSponsoredFpcInstance: async () => ({
		address: { toString: () => "0xfpc" },
	}),
}))
vi.mock("@/contracts/private-fpc", () => ({
	getPrivateFpc: async () => ({
		instance: { address: { toString: () => "0xprivatefpc" } },
		artifact: {},
	}),
}))

import {
	contractsReadinessRefusal,
	extractGrantedAccounts,
	forgetHubToken,
	requestHubToken,
	requestedHubTokens,
	retainPinnedHubTokens,
	retryOnUnregistered,
	SETUP_PENDING,
	useWalletConnection,
	__resetWalletConnectionForTests,
} from "./useWalletConnection"
import { rebuildHubTokenInstance } from "@/contracts/bridge-generation"
import { __resetOpsInFlightForTests, withOperation } from "./useOpsInFlight"
import { __resetToastsForTests, useToast } from "./useToast"
import { nextTick } from "vue"

// Full-length canonical addresses: the hardened parser round-trips AztecAddress.fromStringUnsafe,
// which requires 32-byte hex (short fakes are rejected as malformed grant entries).
const ADDR_MAIN = `0x${"a1b2c3".padStart(64, "0")}`
const ADDR_A = `0x${"aaa".padStart(64, "0")}`
const ADDR_B = `0x${"bbb".padStart(64, "0")}`
const ADDR_ABC = `0x${"abc".padStart(64, "0")}`

function makeWallet(grantedAccounts: Array<{ alias?: string; item?: string }> = []) {
	return {
		requestCapabilities: vi.fn(async () => ({
			granted: [{ type: "accounts", accounts: grantedAccounts }],
		})),
		registerContract: vi.fn(async () => {}),
	}
}

/** connect() → picker → pick the sole row. With no remembered wallet the picker always shows, so
 *  the connection passes through "choosing" + selectWallet. */
async function connectAndPick(c: ReturnType<typeof useWalletConnection>) {
	await c.connect()
	expect(c.status.value).toBe("choosing")
	c.selectWallet(c.discoveredWallets.value[0].key)
	// selectWallet transitions synchronously, then establishes async.
	for (let i = 0; i < 6; i++) await Promise.resolve()
}

function makePending(opts: { verificationHash?: string; confirmReturns?: unknown; confirmThrows?: Error } = {}) {
	return {
		verificationHash: opts.verificationHash ?? "deadbeef",
		confirm: vi.fn(async () => {
			if (opts.confirmThrows) throw opts.confirmThrows
			return opts.confirmReturns ?? makeWallet([{ alias: "Main", item: ADDR_MAIN }])
		}),
		cancel: vi.fn(async () => {}),
	}
}

describe("useWalletConnection", () => {
	beforeEach(() => {
		localStorage.clear()
		__resetWalletConnectionForTests()
		mockEstablishSecureChannel.mockReset()
		mockDisconnectProvider.mockReset()
		mockOnDisconnect.mockReset()
		lastDisconnectHandler = null
		mockOnDisconnect.mockImplementation((handler: () => void) => {
			lastDisconnectHandler = handler
			return () => {
				lastDisconnectHandler = null
			}
		})
		mockGetAvailableWallets.mockReset()
		mockGetAvailableWallets.mockImplementation(() => ({
			wallets: yieldOne(),
			cancel: () => {},
			done: Promise.resolve(),
		}))
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("starts in 'idle' state with empty fields", () => {
		const c = useWalletConnection()
		expect(c.status.value).toBe("idle")
		expect(c.wallet.value).toBeNull()
		expect(c.accounts.value).toEqual([])
		expect(c.selectedAccount.value).toBeNull()
		expect(c.verificationEmojis.value).toBeNull()
	})

	it("connect() lands in 'choosing'; selecting the row reaches 'verifying' with the emoji grid", async () => {
		const pending = makePending({ verificationHash: "abc123" })
		mockEstablishSecureChannel.mockResolvedValue(pending)
		const c = useWalletConnection()
		await c.connect()
		expect(c.status.value).toBe("choosing")
		expect(c.discoveredWallets.value).toHaveLength(1)
		c.selectWallet(c.discoveredWallets.value[0].key)
		expect(c.status.value).toBe("verifying")
		for (let i = 0; i < 6; i++) await Promise.resolve()
		expect(c.verificationEmojis.value).toBe("🟢🔵🟡🟣🔴⚪⚫🟠🟤")
	})

	it("confirmVerification() runs the capability handshake and lands in 'connected'", async () => {
		const wallet = makeWallet([{ alias: "Main", item: ADDR_MAIN }])
		const pending = makePending({ confirmReturns: wallet })
		mockEstablishSecureChannel.mockResolvedValue(pending)
		const c = useWalletConnection()
		await connectAndPick(c)
		await c.confirmVerification()
		expect(c.status.value).toBe("connected")
		expect(c.selectedAccount.value).toBe(ADDR_MAIN)
		expect(c.accounts.value).toEqual([{ address: ADDR_MAIN, alias: "Main" }])
		// 6 = the drip trio (dripper, usdc, eth) + the hub + the manifest's one token (granted from
		// the first connect, so this is the only place its instance reaches the wallet) + the
		// PrivateFPC (pre-registered so the no-fuel-claim private Fee-Juice balance read works).
		expect(wallet.registerContract).toHaveBeenCalledTimes(6)
	})

	it("capability rejection lands in 'error' state with the capability-rejected category", async () => {
		const wallet = {
			requestCapabilities: vi.fn(async () => {
				throw new Error("Capability denied by user")
			}),
			registerContract: vi.fn(),
		}
		const pending = makePending({ confirmReturns: wallet })
		mockEstablishSecureChannel.mockResolvedValue(pending)
		const c = useWalletConnection()
		await connectAndPick(c)
		await c.confirmVerification()
		expect(c.status.value).toBe("error")
		expect(c.error.value?.category).toBe("capability-rejected")
	})

	it("cancelVerification() invokes pending.cancel and resets to idle", async () => {
		const pending = makePending()
		mockEstablishSecureChannel.mockResolvedValue(pending)
		const c = useWalletConnection()
		await connectAndPick(c)
		await c.cancelVerification()
		expect(pending.cancel).toHaveBeenCalled()
		expect(c.status.value).toBe("idle")
		expect(c.verificationEmojis.value).toBeNull()
	})

	it("connect() with no provider available transitions to 'error'", async () => {
		mockGetAvailableWallets.mockImplementationOnce(() => ({
			wallets: yieldNone(),
			cancel: () => {},
			done: Promise.resolve(),
		}))
		const c = useWalletConnection()
		await c.connect()
		expect(c.status.value).toBe("error")
		expect(c.error.value?.message).toBe("No Aztec wallet found. Install one and reload.")
	})

	it("retryCapabilities re-runs the capability request after a rejection", async () => {
		const grants = [
			() => {
				throw new Error("Capability denied")
			},
			async () => ({ granted: [{ type: "accounts", accounts: [{ alias: "Main", item: ADDR_ABC }] }] }),
		]
		const wallet = {
			requestCapabilities: vi.fn(async () => {
				const fn = grants.shift()
				if (!fn) throw new Error("exhausted")
				return await fn()
			}),
			registerContract: vi.fn(async () => {}),
		}
		const pending = makePending({ confirmReturns: wallet })
		mockEstablishSecureChannel.mockResolvedValue(pending)
		const c = useWalletConnection()
		await connectAndPick(c)
		await c.confirmVerification()
		expect(c.status.value).toBe("error")
		await c.retryCapabilities()
		expect(c.status.value).toBe("connected")
		expect(c.selectedAccount.value).toBe(ADDR_ABC)
	})

	it("disconnect() calls provider.disconnect and resets state to idle", async () => {
		const pending = makePending()
		mockEstablishSecureChannel.mockResolvedValue(pending)
		const c = useWalletConnection()
		await connectAndPick(c)
		await c.confirmVerification()
		await c.disconnect()
		expect(mockDisconnectProvider).toHaveBeenCalled()
		expect(c.status.value).toBe("idle")
		expect(c.wallet.value).toBeNull()
		expect(c.accounts.value).toEqual([])
	})

	it("multiple connect() calls are no-ops while a flow is live (including while choosing)", async () => {
		const c = useWalletConnection()
		const a = c.connect()
		const b = c.connect() // concurrent: second must not start a discovery
		await Promise.all([a, b])
		expect(mockGetAvailableWallets).toHaveBeenCalledTimes(1)
		expect(c.status.value).toBe("choosing")
		await c.connect() // while the picker is open: still a no-op
		expect(mockGetAvailableWallets).toHaveBeenCalledTimes(1)
	})

	it("subscribes to provider.onDisconnect during connect and resets state when it fires", async () => {
		const pending = makePending()
		mockEstablishSecureChannel.mockResolvedValue(pending)
		const c = useWalletConnection()
		await connectAndPick(c)
		expect(mockOnDisconnect).not.toHaveBeenCalled() // subscribes only after confirm
		await c.confirmVerification()
		expect(c.status.value).toBe("connected")
		expect(mockOnDisconnect).toHaveBeenCalledTimes(1)
		// Simulate the wallet dropping the channel on its end.
		lastDisconnectHandler?.()
		expect(c.status.value).toBe("idle")
		expect(c.wallet.value).toBeNull()
		expect(c.accounts.value).toEqual([])
	})

	it("granted-accounts rejection (empty granted.accounts) lands in 'error'", async () => {
		const wallet = makeWallet([]) // no accounts granted
		const pending = makePending({ confirmReturns: wallet })
		mockEstablishSecureChannel.mockResolvedValue(pending)
		const c = useWalletConnection()
		await connectAndPick(c)
		await c.confirmVerification()
		expect(c.status.value).toBe("error")
	})
})

describe("extractGrantedAccounts", () => {
	it("returns [] when input is null, undefined, or non-object", () => {
		expect(extractGrantedAccounts(null)).toEqual([])
		expect(extractGrantedAccounts(undefined)).toEqual([])
		expect(extractGrantedAccounts("nope")).toEqual([])
	})

	it("returns [] when no accounts capability is present", () => {
		expect(extractGrantedAccounts({ granted: [{ type: "contracts" }] })).toEqual([])
	})

	it("maps {alias, item} entries and stringifies item objects", () => {
		const out = extractGrantedAccounts({
			granted: [
				{
					type: "accounts",
					accounts: [
						{ alias: "Main", item: { toString: () => ADDR_A } },
						{ alias: "Saver", item: ADDR_B },
					],
				},
			],
		})
		expect(out).toEqual([
			{ address: ADDR_A, alias: "Main" },
			{ address: ADDR_B, alias: "Saver" },
		])
	})
})

describe("switch gating during operations (session gate reads useOpsInFlight)", () => {
	beforeEach(() => {
		localStorage.clear()
		__resetWalletConnectionForTests()
		__resetOpsInFlightForTests()
	})

	it("selectAccount rejects while a tracked operation span is open, succeeds after it closes", async () => {
		const wallet = makeWallet([
			{ alias: "Main", item: ADDR_MAIN },
			{ alias: "Saver", item: ADDR_B },
		])
		const pending = makePending({ confirmReturns: wallet })
		mockEstablishSecureChannel.mockResolvedValue(pending)
		const c = useWalletConnection()
		await connectAndPick(c)
		await c.confirmVerification()
		expect(c.status.value).toBe("choosing-account")
		await c.confirmAccountChoice(ADDR_MAIN)
		expect(c.status.value).toBe("connected")

		let release: () => void = () => {}
		const span = withOperation(() => new Promise<void>((res) => (release = res)))
		expect(c.selectAccount(ADDR_B)).toBe(false) // blocked mid-operation, at the session boundary
		expect(c.selectedAccount.value).toBe(ADDR_MAIN)
		release()
		await span
		expect(c.selectAccount(ADDR_B)).toBe(true)
		expect(c.selectedAccount.value).toBe(ADDR_B)
	})
})

describe("selection-notice toasts (single module-level owner, exactly once)", () => {
	beforeEach(() => {
		localStorage.clear()
		__resetWalletConnectionForTests()
		__resetToastsForTests()
	})

	it("auto-remembered and truncation notices each toast exactly once and drain the queue", async () => {
		const c = useWalletConnection()
		const { toasts } = useToast()
		c.accounts.value = [
			{ address: ADDR_MAIN, alias: "Main" },
			{ address: ADDR_B, alias: "Saver" },
		]
		c.selectionNotices.value = [
			{ key: 0, kind: "auto-remembered", alias: "Main", address: ADDR_MAIN },
			{ key: 1, kind: "grant-truncated", hiddenCount: 4 },
		]
		await nextTick()
		expect(toasts.value.map((t) => t.text)).toEqual([
			"Using account Main",
			"Your wallet granted more accounts than the app can show — using the first 2 (4 hidden).",
		])
		expect(c.selectionNotices.value).toEqual([]) // drained by the single owner

		// The drain itself must not re-fire (empty-list retrigger is a no-op).
		await nextTick()
		expect(toasts.value).toHaveLength(2)
	})
})

/** Enough of the manifest's capability shape for a fake wallet to echo (or narrow) the request. */
type ManifestCapability = { type: string; scope?: { contract: { toString(): string }; function: string }[] }

describe("per-token grant surface", () => {
	beforeEach(() => {
		localStorage.clear()
		__resetWalletConnectionForTests()
		mockEstablishSecureChannel.mockReset()
		mockGetAvailableWallets.mockReset()
		mockGetAvailableWallets.mockImplementation(() => ({ wallets: yieldOne(), cancel: () => {}, done: Promise.resolve() }))
	})

	const ERC20 = "0x2222222222222222222222222222222222222222"
	const hubToken = (l2Token: string) => ({
		l2Token,
		erc20: ERC20,
		words: { nameWord: ZERO_WORD as `0x${string}`, symbolWord: ZERO_WORD as `0x${string}` },
		decimals: 6,
	})

	async function connectWith(wallet: ReturnType<typeof makeWallet>) {
		mockEstablishSecureChannel.mockResolvedValue(makePending({ confirmReturns: wallet }))
		const c = useWalletConnection()
		await connectAndPick(c)
		await c.confirmVerification()
		return c
	}

	it("requestHubToken is idempotent and keys the set by the lowercase L2 address", () => {
		requestHubToken(hubToken(REQUESTED_L2_TOKEN.toUpperCase()))
		requestHubToken(hubToken(REQUESTED_L2_TOKEN))
		expect(requestedHubTokens().map((t) => t.l2Token)).toEqual([REQUESTED_L2_TOKEN])
	})

	it("caps the BROWSED tokens at 32, oldest request first, and never evicts a pinned one", () => {
		const l2Of = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
		requestHubToken(hubToken(REQUESTED_L2_TOKEN), { pinned: true })
		for (let n = 1; n <= 40; n++) requestHubToken(hubToken(l2Of(n)))

		const kept = requestedHubTokens().map((t) => t.l2Token)
		// The wallet truncates its granted list, so the set it is asked for has to stay bounded.
		expect(kept).toHaveLength(33)
		expect(kept).toContain(REQUESTED_L2_TOKEN)
		expect(kept).not.toContain(l2Of(8))
		expect(kept).toContain(l2Of(9))
		expect(kept).toContain(l2Of(40))
	})

	it("a re-request refreshes recency, so a browsed token in use is not the one evicted", () => {
		const l2Of = (n: number) => `0x${n.toString(16).padStart(64, "0")}`
		for (let n = 1; n <= 32; n++) requestHubToken(hubToken(l2Of(n)))
		requestHubToken(hubToken(l2Of(1)))
		requestHubToken(hubToken(l2Of(33)))

		const kept = requestedHubTokens().map((t) => t.l2Token)
		expect(kept).toContain(l2Of(1))
		expect(kept).not.toContain(l2Of(2))
	})

	it("forgetHubToken drops a token from the requested set, pin and all", () => {
		requestHubToken(hubToken(REQUESTED_L2_TOKEN), { pinned: true })
		forgetHubToken(REQUESTED_L2_TOKEN.toUpperCase())
		expect(requestedHubTokens()).toEqual([])
	})

	it("retainPinnedHubTokens drops a pin no record needs any more, keeping the ones still named", () => {
		const stillHeld = `0x${"7".padStart(64, "0")}`
		requestHubToken(hubToken(REQUESTED_L2_TOKEN), { pinned: true })
		requestHubToken(hubToken(stillHeld), { pinned: true })
		retainPinnedHubTokens([stillHeld.toUpperCase()])
		expect(requestedHubTokens().map((t) => t.l2Token)).toEqual([stillHeld])
	})

	it("retainPinnedHubTokens never drops a MANIFEST token - the first connect granted it, not the journal", () => {
		requestHubToken(hubToken(MANIFEST_L2_TOKEN), { pinned: true })
		retainPinnedHubTokens([])
		expect(requestedHubTokens().map((t) => t.l2Token)).toEqual([MANIFEST_L2_TOKEN])
	})

	it("retainPinnedHubTokens leaves BROWSED tokens alone - they were never pinned to begin with", () => {
		requestHubToken(hubToken(REQUESTED_L2_TOKEN))
		retainPinnedHubTokens([])
		expect(requestedHubTokens().map((t) => t.l2Token)).toEqual([REQUESTED_L2_TOKEN])
	})

	it("the manifest carries the hub plus the manifest's tokens UNION the requested ones", async () => {
		requestHubToken(hubToken(REQUESTED_L2_TOKEN))
		const wallet = makeWallet([{ alias: "Main", item: ADDR_MAIN }])
		await connectWith(wallet)

		const calls = wallet.requestCapabilities.mock.calls as unknown as unknown[][]
		const manifest = calls[0][0] as { capabilities: Array<{ type: string; contracts?: Array<{ toString(): string }> }> }
		const contracts = manifest.capabilities.find((cap) => cap.type === "contracts")?.contracts?.map((a) => a.toString())
		expect(contracts?.slice(0, 3)).toEqual([HUB_ADDR, MANIFEST_L2_TOKEN, REQUESTED_L2_TOKEN])
	})

	it("registers the hub and every requested token instance", async () => {
		requestHubToken(hubToken(REQUESTED_L2_TOKEN))
		const wallet = makeWallet([{ alias: "Main", item: ADDR_MAIN }])
		await connectWith(wallet)

		expect(rebuildHubTokenInstance).toHaveBeenCalledWith(ERC20, { nameWord: ZERO_WORD, symbolWord: ZERO_WORD, decimals: 6 })
		// The faucet trio + the hub + the manifest token + the requested token + the PrivateFPC.
		expect(wallet.registerContract).toHaveBeenCalledTimes(7)
	})

	/** A wallet that approves the manifest verbatim, optionally after `edit` reshapes what comes back. */
	function echoingWallet(edit: (capabilities: ManifestCapability[]) => ManifestCapability[] = (caps) => caps) {
		return {
			requestCapabilities: vi.fn(async (manifest: { capabilities: ManifestCapability[] }) => ({
				granted: [{ type: "accounts", accounts: [{ alias: "Main", item: ADDR_MAIN }] }, ...edit(manifest.capabilities)],
			})),
			registerContract: vi.fn(async () => {}),
		}
	}

	it("publishes the requested contracts the answer covered, lowercased", async () => {
		const c = await connectWith(echoingWallet() as unknown as ReturnType<typeof makeWallet>)
		expect(c.grantedContracts.value).toContain(HUB_ADDR)
		expect(c.grantedContracts.value).toContain(MANIFEST_L2_TOKEN)
	})

	it("withholds a contract whose requested transaction scope did not come back", async () => {
		const withoutTxScope = (caps: ManifestCapability[]) =>
			caps.map((cap) =>
				cap.type === "transaction"
					? { ...cap, scope: (cap.scope ?? []).filter((s) => s.contract.toString().toLowerCase() !== MANIFEST_L2_TOKEN) }
					: cap,
			)
		const c = await connectWith(echoingWallet(withoutTxScope) as unknown as ReturnType<typeof makeWallet>)
		expect(c.grantedContracts.value).toContain(HUB_ADDR)
		expect(c.grantedContracts.value).not.toContain(MANIFEST_L2_TOKEN)
	})

	it("clears the granted contracts on disconnect", async () => {
		const c = await connectWith(echoingWallet() as unknown as ReturnType<typeof makeWallet>)
		expect(c.grantedContracts.value).toContain(HUB_ADDR)
		await c.disconnect()
		expect(c.grantedContracts.value).toEqual([])
	})
})

describe("contractsReadinessRefusal", () => {
	const ready = { status: { value: "connected" }, error: { value: null }, contractsReady: { value: true } }

	it("passes (undefined) when connected and contracts are ready", () => {
		expect(contractsReadinessRefusal(ready)).toBeUndefined()
	})

	it("returns SETUP_PENDING when connected but contracts are not yet registered", () => {
		expect(contractsReadinessRefusal({ ...ready, contractsReady: { value: false } })).toBe(SETUP_PENDING)
	})

	it("returns the session's own error message when it is not connected", () => {
		const refusal = contractsReadinessRefusal({
			status: { value: "error" },
			error: { value: { message: "Alpha-testnet is not responding. Try again." } },
			contractsReady: { value: false },
		})
		expect(refusal).toBe("Alpha-testnet is not responding. Try again.")
	})

	it("falls back to a connect prompt when disconnected with no error", () => {
		expect(contractsReadinessRefusal({ status: { value: "idle" }, error: { value: null }, contractsReady: { value: false } })).toBe(
			"Connect your Aztec wallet first.",
		)
	})
})

describe("retryOnUnregistered", () => {
	// The structured code, wrapped as an extension transport does (one JSON level).
	const unregistered = () =>
		new Error(
			JSON.stringify({
				code: -32602,
				message: "Contract not registered with the wallet.",
				data: { walletErrorCode: "CONTRACT_NOT_REGISTERED" },
			}),
		)
	// The same wording, but as free text with no structured code — must NOT trigger the retry.
	const substringOnly = () => new Error("Contract not registered with the wallet. Register it and retry.")

	// biome-ignore lint/suspicious/noExplicitAny: opaque wallet handle; identity is all the helper reads
	const walletHandle = (): any => ({})
	function sessionHolding(wallet: unknown, reregister = vi.fn(async () => true)) {
		return { wallet: { value: wallet }, reregisterContracts: reregister } as Parameters<typeof retryOnUnregistered>[0] & {
			reregisterContracts: ReturnType<typeof vi.fn>
		}
	}

	it("returns the value and never re-registers when the op succeeds", async () => {
		const wallet = walletHandle()
		const session = sessionHolding(wallet)
		const op = vi.fn(async () => "ok")
		await expect(retryOnUnregistered(session, wallet, op)).resolves.toBe("ok")
		expect(op).toHaveBeenCalledTimes(1)
		expect(session.reregisterContracts).not.toHaveBeenCalled()
	})

	it("rethrows an unrelated error without re-registering", async () => {
		const wallet = walletHandle()
		const session = sessionHolding(wallet)
		const op = vi.fn(async () => {
			throw new Error("network down")
		})
		await expect(retryOnUnregistered(session, wallet, op)).rejects.toThrow("network down")
		expect(op).toHaveBeenCalledTimes(1)
		expect(session.reregisterContracts).not.toHaveBeenCalled()
	})

	it("does NOT retry on the substring category without the structured code", async () => {
		const wallet = walletHandle()
		const session = sessionHolding(wallet)
		const op = vi.fn(async () => {
			throw substringOnly()
		})
		await expect(retryOnUnregistered(session, wallet, op)).rejects.toThrow(/Register it and retry/)
		expect(op).toHaveBeenCalledTimes(1)
		expect(session.reregisterContracts).not.toHaveBeenCalled()
	})

	it("re-registers once and re-runs the op on the structured code", async () => {
		const wallet = walletHandle()
		const session = sessionHolding(wallet)
		let calls = 0
		const op = vi.fn(async () => {
			calls += 1
			if (calls === 1) throw unregistered()
			return "ok-after-register"
		})
		await expect(retryOnUnregistered(session, wallet, op)).resolves.toBe("ok-after-register")
		expect(op).toHaveBeenCalledTimes(2)
		expect(session.reregisterContracts).toHaveBeenCalledTimes(1)
	})

	it("rethrows the ORIGINAL error when re-registration reports it could not run", async () => {
		const wallet = walletHandle()
		const session = sessionHolding(
			wallet,
			vi.fn(async () => false),
		)
		const op = vi.fn(async () => {
			throw unregistered()
		})
		await expect(retryOnUnregistered(session, wallet, op)).rejects.toThrow(/CONTRACT_NOT_REGISTERED/)
		expect(op).toHaveBeenCalledTimes(1)
	})

	it("propagates a second throw untouched, having run the op exactly twice", async () => {
		const wallet = walletHandle()
		const session = sessionHolding(wallet)
		let calls = 0
		const op = vi.fn(async () => {
			calls += 1
			if (calls === 1) throw unregistered()
			throw new Error("still broken after re-register")
		})
		await expect(retryOnUnregistered(session, wallet, op)).rejects.toThrow("still broken after re-register")
		expect(op).toHaveBeenCalledTimes(2)
		expect(session.reregisterContracts).toHaveBeenCalledTimes(1)
	})

	it("rethrows the original — no re-register, no second attempt — when the session was replaced mid-flight", async () => {
		const original = walletHandle()
		const replacement = walletHandle()
		const session = sessionHolding(replacement) // a reconnect swapped the wallet while op was in flight
		const op = vi.fn(async () => {
			throw unregistered()
		})
		await expect(retryOnUnregistered(session, original, op)).rejects.toThrow(/CONTRACT_NOT_REGISTERED/)
		expect(op).toHaveBeenCalledTimes(1)
		expect(session.reregisterContracts).not.toHaveBeenCalled()
	})

	it("rethrows the original when the wallet is replaced DURING a successful re-registration, before the retry", async () => {
		const original = walletHandle()
		const replacement = walletHandle()
		const session = sessionHolding(original)
		// A reconnect lands while reregisterContracts is awaiting: it resolves true, but the wallet is
		// no longer the one the op was bound to, so the post-registration identity check must refuse.
		session.reregisterContracts = vi.fn(async () => {
			session.wallet.value = replacement
			return true
		})
		const op = vi.fn(async () => {
			throw unregistered()
		})
		await expect(retryOnUnregistered(session, original, op)).rejects.toThrow(/CONTRACT_NOT_REGISTERED/)
		expect(op).toHaveBeenCalledTimes(1)
		expect(session.reregisterContracts).toHaveBeenCalledTimes(1)
	})
})
