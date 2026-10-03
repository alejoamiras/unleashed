/**
 * Seam pins for the controller split of `createAztecWalletSession`:
 *   - the returned surface is EXACTLY the 28 members, in order;
 *   - two sessions created concurrently share no flow state;
 *   - the remembered-account read path rejects/bounds hostile storage entries and only ever
 *     PRE-SELECTS within the live grant (an outside address pauses on the account modal).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@alejoamiras/nulo-wallet-sdk-schema-patch/register", () => ({}))
vi.mock("@/lib/chain-info", () => ({ readChainInfo: () => ({ chainId: 1 }) }))
vi.mock("@/lib/emoji", () => ({ hashToEmoji: () => "🟢🔵🟡🟣🔴⚪⚫🟠🟤" }))

const mockGetAvailableWallets = vi.fn()
vi.mock("@aztec-labs/wallet-sdk/manager", () => ({
	WalletManager: {
		configure: vi.fn(() => ({ getAvailableWallets: mockGetAvailableWallets })),
	},
}))

import { createAztecWalletSession } from "./createAztecWalletSession"

type AnyProvider = Record<string, unknown>

const ADDR_A = `0x${"a1".padStart(64, "0")}`
const ADDR_B = `0x${"b2".padStart(64, "0")}`
const ADDR_OUTSIDE = `0x${"c3".padStart(64, "0")}`

function makeStream() {
	const queue: AnyProvider[] = []
	const resolvers: Array<(r: IteratorResult<AnyProvider>) => void> = []
	let ended = false
	const push = (p: AnyProvider) => {
		const r = resolvers.shift()
		if (r) r({ value: p, done: false })
		else queue.push(p)
	}
	const end = () => {
		ended = true
		for (const r of resolvers.splice(0)) r({ value: undefined as never, done: true })
	}
	const wallets: AsyncIterable<AnyProvider> = {
		[Symbol.asyncIterator]() {
			return {
				next(): Promise<IteratorResult<AnyProvider>> {
					if (queue.length) return Promise.resolve({ value: queue.shift() as AnyProvider, done: false })
					if (ended) return Promise.resolve({ value: undefined as never, done: true })
					return new Promise((res) => resolvers.push(res))
				},
			}
		},
	}
	return { wallets, push, end, cancel: vi.fn() }
}

function makeProvider(id = "test-wallet") {
	const walletHandle = {
		requestCapabilities: vi.fn(async () => ({
			granted: [
				{
					type: "accounts",
					accounts: [
						{ alias: "A", item: ADDR_A },
						{ alias: "B", item: ADDR_B },
					],
				},
			],
		})),
	}
	const pending = { verificationHash: "deadbeef", confirm: vi.fn(async () => walletHandle), cancel: vi.fn(async () => {}) }
	return {
		id,
		name: "Test Wallet",
		type: "extension",
		establishSecureChannel: vi.fn(async () => pending),
		disconnect: vi.fn(async () => {}),
		onDisconnect: vi.fn(() => () => {}),
	}
}

function makeSession() {
	return createAztecWalletSession({ appId: "test-app", buildManifest: async () => ({}), registerContracts: vi.fn(async () => {}) })
}

async function flush(times = 6) {
	for (let i = 0; i < times; i++) await Promise.resolve()
}

/** Connect → pick the announced wallet → confirm verification; resolves once the grant settled. */
async function driveToGrant(s: ReturnType<typeof makeSession>) {
	const stream = makeStream()
	mockGetAvailableWallets.mockImplementationOnce(() => ({ wallets: stream.wallets, cancel: stream.cancel }))
	void s.connect()
	await flush()
	stream.push(makeProvider())
	await flush()
	s.selectWallet(s.discoveredWallets.value[0].key)
	await flush()
	await s.confirmVerification()
}

beforeEach(() => {
	localStorage.clear()
	mockGetAvailableWallets.mockReset()
})
afterEach(() => {
	vi.clearAllMocks()
})

describe("createAztecWalletSession — seam pins", () => {
	it("returns exactly the 32-member surface, in order", () => {
		expect(Object.keys(makeSession())).toEqual([
			"status",
			"verificationEmojis",
			"accounts",
			"grantedContracts",
			"selectedAccount",
			"selectionNotices",
			"hiddenAccountsCount",
			"contractsReady",
			"error",
			"wallet",
			"discoveredWallets",
			"scanning",
			"pickerOpen",
			"preferredWalletName",
			"autoReconnectDisabled",
			"connect",
			"connectWithPicker",
			"selectWallet",
			"cancelChoice",
			"forgetPreferredWallet",
			"switchWallet",
			"confirmVerification",
			"cancelVerification",
			"confirmAccountChoice",
			"cancelAccountChoice",
			"selectAccount",
			"consumeSelectionNotices",
			"retryCapabilities",
			"reregisterContracts",
			"refreshAccounts",
			"disconnect",
			"reset",
		])
	})

	it("two sessions created concurrently share no flow state", async () => {
		const a = makeSession()
		const b = makeSession()
		const streamA = makeStream()
		const streamB = makeStream()
		mockGetAvailableWallets.mockImplementationOnce(() => ({ wallets: streamA.wallets, cancel: streamA.cancel }))
		mockGetAvailableWallets.mockImplementationOnce(() => ({ wallets: streamB.wallets, cancel: streamB.cancel }))
		void a.connect()
		void b.connect()
		await flush()
		streamA.push(makeProvider("only-a"))
		await flush()
		expect(a.status.value).toBe("choosing")
		expect(a.discoveredWallets.value.map((w) => w.id)).toEqual(["only-a"])
		expect(b.status.value).toBe("discovering")
		expect(b.discoveredWallets.value).toEqual([])

		a.cancelChoice()
		expect(a.status.value).toBe("idle")
		expect(b.status.value).toBe("discovering")
		streamB.push(makeProvider("only-b"))
		await flush()
		expect(b.discoveredWallets.value.map((w) => w.id)).toEqual(["only-b"])
		expect(a.discoveredWallets.value).toEqual([])
	})

	describe("remembered-account read path (hostile storage)", () => {
		const seed = (value: unknown) => localStorage.setItem("test-app:selected-accounts", JSON.stringify(value))

		it("a remembered address OUTSIDE the live grant never pre-selects: the flow pauses", async () => {
			seed([["test-wallet", ADDR_OUTSIDE]])
			const s = makeSession()
			await driveToGrant(s)
			expect(s.status.value).toBe("choosing-account")
			expect(s.selectedAccount.value).toBeNull()
		})

		it("malformed entries are skipped, the first VALID pair for the wallet wins, and the choice is disclosed", async () => {
			seed([
				"junk",
				["test-wallet"],
				[1, 2],
				["", ADDR_A],
				["test-wallet", "x".repeat(257)],
				["test-wallet", ADDR_B],
				["test-wallet", ADDR_A],
			])
			const s = makeSession()
			await driveToGrant(s)
			expect(s.status.value).toBe("connected")
			expect(s.selectedAccount.value).toBe(ADDR_B)
			expect(s.consumeSelectionNotices().map((n) => n.kind)).toEqual(["auto-remembered"])
		})

		it("entries past the 8-wallet cap are ignored; a non-array root is ignored", async () => {
			const filler = Array.from({ length: 8 }, (_, i) => [`other-${i}`, ADDR_A])
			seed([...filler, ["test-wallet", ADDR_B]])
			const s1 = makeSession()
			await driveToGrant(s1)
			expect(s1.status.value).toBe("choosing-account")

			seed({ "test-wallet": ADDR_B })
			const s2 = makeSession()
			await driveToGrant(s2)
			expect(s2.status.value).toBe("choosing-account")
		})
	})
})
