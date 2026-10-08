/*
 * Send-wizard smoke e2e. Mounts SendView in jsdom over the REAL wizard composables (catalog,
 * selection, grant, fuel quote, gas share, send, exit) and the REAL journal engine on jsdom's
 * localStorage; only the chain/wallet boundary is faked — the generation manifest, the two wallet
 * sessions, and the bridge-core functions that would talk to a chain. Everything between the click
 * and those boundaries is production code.
 *
 * What it pins:
 *   1. discovery — manifest tokens first, the remote list after refresh, paste (good and bad)
 *   2. the grant is raised BEFORE anything is signed, and a refusal sends nothing
 *   3. a grant that lands for a selection the user has left is discarded
 *   4. a token with no fuel route can still send, with the gas choices closed
 *   5-7. the first-time paths: the review's note, the register+claim claim, the private 2-tx rail
 *   8. gas-only journals no token block
 *   9. an exit reads both pause switches before it authorises a burn
 *   10. a network with no bridge block instantiates nothing
 *
 * Selectors are data-testid only (`data-*` attributes on those elements narrow a repeated id).
 *
 * bb.js poseidon throws `std::bad_cast` under jsdom, so the two derivations a private send makes
 * (`computeSecretHash`, `deriveTokenClaimSecret`) are faked with a pure keccak stand-in. They stay
 * mutually consistent, which is the property the send actually depends on.
 */

import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

const AZTEC_ACCOUNT = `0x${"10".repeat(32)}`
const L1_ACCOUNT = "0x4444444444444444444444444444444444444444"
const LIST_WBTC = "0x1111111111111111111111111111111111111111"
const LIST_DECIMALS = 8

const h = vi.hoisted(() => ({
	/** Filled in below the imports; the module factories only ever reach the wiring through here. */
	wire: {} as {
		session?: unknown
		l1?: unknown
		gen?: Record<string, unknown>
		l2Contract?: unknown
	},
	state: {
		registrations: new Map<string, unknown>(),
		hubTokens: new Map<string, string>(),
		portals: new Map<string, string>(),
		/** The fuel swapper's answer to `quote`: FJ-wei per token base unit, a revert (no rate), or null for a
		 *  read that never answers. */
		fuelRate: null as bigint | "revert" | null,
		withdrawsPaused: false,
		exitsPaused: false,
		/** What the exit's read-only preflight sees on Aztec before it authorises a burn. */
		l2Balance: 5n * 10n ** 8n,
		/** Whether the Aztec account holds gas for a token-only claim; null = unknown. */
		gasHeld: { value: null as bigint | null },
		gasHeldPublic: { value: 0n as bigint | null },
		gasHeldSelfPay: { value: false },
		listGate: null as null | Promise<void>,
		receiptGate: null as null | Promise<void>,
		order: [] as string[],
	},
	fn: {
		loadTokenList: vi.fn(),
		runSend: vi.fn(),
		claimViaHub: vi.fn(),
		exitViaHub: vi.fn(),
		preflightHubExit: vi.fn(),
		retryCapabilities: vi.fn(),
		ensurePermit2Approval: vi.fn(),
		readContract: vi.fn(),
		buildFeeJuiceClaimDep: vi.fn(),
	},
}))

vi.mock("@/contracts/bridge-generation", async () => {
	const core = await vi.importActual<typeof import("@unleashed/bridge-core")>("@unleashed/bridge-core")
	const { keccak256, stringToHex } = await import("viem")
	const raw = (await import("../../../../packages/bridge-core/fixtures/sandbox-manifest.json")).default
	const manifest = core.parseManifestV2(raw)
	// The same derivation the test body uses for `l2TokenOf` — poseidon cannot run here, and only
	// the stability of the mapping matters to the wizard and the engine.
	const derived = (erc20: string) => `0x00${keccak256(stringToHex(`l2:${erc20}`)).slice(4)}`
	const bridge = manifest.bridge as NonNullable<typeof manifest.bridge>
	// Budgets small enough that a one-unit send can carry a slice.
	const fuel = { slippageBps: 300, minFuelFj: "1000000000000000", fjPerTx: "100000000000000000", fjRegister: "500000000000000000" }
	const placeholder = { on: false }
	const gen = {
		MANIFEST: manifest,
		GENERATION: bridge,
		MANIFEST_CHAIN: { l1ChainId: manifest.l1ChainId, walletChainId: manifest.walletChainId },
		FEE_JUICE: manifest.feeJuice,
		FUEL_PORTAL: manifest.feeJuice.portal,
		FUEL_ASSET: manifest.feeJuice.asset,
		FUEL_ASSET_HANDLER: undefined,
		FUEL_MIN_FJ: BigInt(manifest.feeJuice.minFj),
		PRIVATE_FPC: undefined,
		SEND_GENERATION: core.sendGenerationOf(manifest, bridge),
		HUB: { toString: () => bridge.l2.hub.address },
		TOKEN_CLASS_ID: bridge.l2.tokenClassId,
		MANIFEST_TOKENS: bridge.tokens,
		FUEL: fuel,
		LEGACY_ROUTERS: [bridge.l1.router],
		HUB_ARTIFACT: {},
		HUB_TOKEN_ARTIFACT: {},
		rebuildHubInstance: async () => ({ address: { toString: () => bridge.l2.hub.address } }),
		rebuildHubTokenInstance: async (erc20: string) => ({ address: { toString: () => derived(erc20) } }),
	}
	h.wire.gen = { ...gen, placeholder }
	// A getter, so one case can turn this network into a placeholder without a module reset.
	return {
		...gen,
		get IS_PLACEHOLDER() {
			return placeholder.on
		},
	}
})

vi.mock("@/composables/useL1Wallet", () => ({ useL1Wallet: () => h.wire.l1 }))
// The pinned per-chain readers would otherwise build real RPC clients; every chain read answers from the fake.
vi.mock("@/composables/useEthereumReader", () => {
	const readClientFor = () => (h.wire.l1 as { publicClient: unknown }).publicClient
	return {
		readClientFor,
		discoveryReadsFor: () => undefined,
		useEthereumReader: () => ({ ethereum: readClientFor, forChain: readClientFor, discoveryReadsFor: () => undefined }),
		__resetReadClientsForTests: () => {},
	}
})
vi.mock("@/composables/useWalletConnection", () => ({
	useWalletConnection: () => h.wire.session,
	requestHubToken: (token: { l2Token: string }) => {
		const session = h.wire.session as { requested: Set<string> }
		session.requested.add(token.l2Token.toLowerCase())
	},
	requestedHubTokens: () => [],
	retainPinnedHubTokens: () => {},
	switchActiveAccount: () => true,
	// The session here is always connected with its contracts ready, so the readiness gate never
	// refuses; its refusal branches are pinned in useWalletConnection.test.ts and the browser spec.
	contractsReadinessRefusal: () => undefined,
	// No case here injects CONTRACT_NOT_REGISTERED; pass through so the send/exit calls are the real ones.
	retryOnUnregistered: (_s: unknown, _w: unknown, op: () => Promise<unknown>) => op(),
	__resetWalletConnectionForTests: () => {},
}))
vi.mock("@/composables/useTokenBalance", () => ({
	useTokenBalance: () => ({
		publicBalance: ref(0n),
		privateBalance: ref(0n),
		loading: ref(false),
		error: ref(null),
		refresh: vi.fn(),
		dispose: vi.fn(),
	}),
	// The exit's read-only preflight reads the balance the burn will spend, before any authwit.
	readBalance: async () => h.state.l2Balance,
}))

vi.mock("@aztec-labs/aztec.js/contracts", () => ({ Contract: { at: async () => h.wire.l2Contract } }))

vi.mock("@aztec-labs/aztec.js/crypto", async (orig) => {
	const actual = await orig<typeof import("@aztec-labs/aztec.js/crypto")>()
	const { Fr } = await import("@aztec-labs/aztec.js/fields")
	const { keccak256, stringToHex } = await import("viem")
	return {
		...actual,
		// Pure and injective enough to stand in for the hash: the record id the app precomputes and
		// the one the send reports must agree, and nothing here checks the protocol value.
		computeSecretHash: async (value: { toString: () => string }) =>
			Fr.fromString(`0x00${keccak256(stringToHex(value.toString())).slice(4)}`),
	}
})

// The node answers the binding read and the fee read a private gas slice is priced from.
vi.mock("@aztec-labs/aztec.js/node", () => ({
	createAztecNodeClient: () => ({
		getPublicStorageAt: async () => undefined,
		getCurrentMinFees: async () => ({ feePerDaGas: 10n, feePerL2Gas: 20n }),
	}),
}))
// The gas-held read reaches the FeeJuice contract through the wallet; the smoke answers it directly.
vi.mock("@/composables/useGasHeld", () => ({
	useGasHeld: () => ({
		credit: h.state.gasHeld,
		publicFeeJuice: h.state.gasHeldPublic,
		selfPay: h.state.gasHeldSelfPay,
		refresh: async () => {},
		dispose: () => {},
	}),
}))

vi.mock("@unleashed/bridge-core", async (orig) => {
	const actual = await orig<typeof import("@unleashed/bridge-core")>()
	return {
		...actual,
		deriveTokenClaimSecret: (salt: unknown) => salt,
		deriveBridgeSecret: (salt: unknown) => salt,
		loadTokenList: h.fn.loadTokenList,
		runSend: h.fn.runSend,
		claimViaHub: h.fn.claimViaHub,
		exitViaHub: h.fn.exitViaHub,
		preflightHubExit: h.fn.preflightHubExit,
		hubAt: () => ({ methods: {} }),
		hubTokenFor: async (_hub: unknown, erc20: string) => h.state.hubTokens.get(erc20.toLowerCase()),
		hubBindingAt: async (_node: unknown, _hub: string, erc20: string) => h.state.hubTokens.get(erc20.toLowerCase()),
		hubExitsPaused: async () => h.state.exitsPaused,
		readRegistration: async (_pub: unknown, _factory: string, erc20: string) => h.state.registrations.get(erc20.toLowerCase()),
		readErc20Metadata: async () => {
			const raw = new TextEncoder().encode("WBTC")
			return { name: "Wrapped BTC", symbol: "WBTC", decimals: 8, nameRaw: raw, symbolRaw: raw }
		},
		readErc20Balances: async (_pub: unknown, _owner: string, tokens: readonly string[]) => new Map(tokens.map((t) => [t, 10n ** 12n])),
	}
})

// Only the four boundaries that need a live wallet or the recovery crypto; the rest of the module
// (the stop-interaction shape, the fingerprint) stays real.
vi.mock("@/composables/deposit-flow", async (orig) => {
	const actual = await orig<typeof import("@/composables/deposit-flow")>()
	const { cacheSecret } = await import("@/composables/useBridgeJournal")
	return {
		...actual,
		ensurePermit2Approval: h.fn.ensurePermit2Approval,
		resolveHubClaimSendOpts: async () => ({ kind: "opts", opts: {} }),
		// The private exit's fee reads the credit at the PrivateFPC (a 2.2 MB artifact import in the
		// real reader, which outlasts the harness's zero-delay settle); the wizard's held-gas stub answers.
		readPrivateFeeJuiceBalance: async () => h.state.gasHeld.value ?? 0n,
		recoverDepositLeg: async () => "recovered",
		buildFeeJuiceClaimDep: h.fn.buildFeeJuiceClaimDep,
		// The real seal caches the salt so the in-session claim needs no signature; keep that, drop
		// the crypto (the envelope itself is never read on the send lane).
		sealPrivateRecord: async (ctx: { id: string; secretStr: string }) => {
			cacheSecret(ctx.id, ctx.secretStr, {} as never)
		},
	}
})

import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type SendDepositRecord, predictPortal } from "@unleashed/bridge-core"
import { type Hex, keccak256, stringToHex } from "viem"
import listFixture from "./fixtures/token-list.json"

import { __resetHubExitDepsForTests } from "@/composables/useHubExit"
import { __resetJournalForTests, connectJournalDeps, useBridgeJournal } from "@/composables/useBridgeJournal"
import { __resetSendDepsForTests } from "@/composables/useSend"
import { __resetTokenGrantQueueForTests } from "@/composables/useTokenGrant"
import { TESTIDS } from "@/lib/testids"
import SendView from "@/views/SendView.vue"

enableAutoUnmount(afterEach)

// The generation the mock built from the sandbox fixture, so the test asserts against the same
// addresses the app resolved rather than a second hardcoded copy of them.
const gen = h.wire.gen as Record<string, unknown>
const MANIFEST_TOKENS = gen.MANIFEST_TOKENS as { erc20: string; decimals: number; displaySymbol: string }[]
const CHAIN_ID = (gen.MANIFEST as { l1ChainId: number }).l1ChainId
const SEND_GEN = gen.SEND_GENERATION as { factory: Hex; implementation: Hex }
const USDC = MANIFEST_TOKENS[0].erc20

const sel = (t: string) => `[data-testid="${t}"]`
const keyOf = (erc20: string) => `${CHAIN_ID}:${erc20.toLowerCase()}`
const field = (erc20: string, tag: string) => `0x00${keccak256(stringToHex(`${tag}:${erc20}`)).slice(4)}` as Hex

/** The address the hub derives — stable per ERC-20, which is all the wizard and the engine compare. */
const l2TokenOf = (erc20: string) => field(erc20, "l2")
const portalOf = (erc20: string) => predictPortal(SEND_GEN.factory, SEND_GEN.implementation, erc20)

function registrationOf(erc20: string, decimals: number) {
	return {
		portal: portalOf(erc20),
		decimals,
		registerIndex: 3n,
		nameWord: field(erc20, "name"),
		symbolWord: field(erc20, "symbol"),
		registerKey: field(erc20, "key"),
	}
}

/** Registered on both sides: a portal on Ethereum and a binding on the hub. */
function markRegistered(erc20: string, decimals: number): void {
	h.state.registrations.set(erc20.toLowerCase(), registrationOf(erc20, decimals))
	h.state.hubTokens.set(erc20.toLowerCase(), l2TokenOf(erc20))
	h.state.portals.set(erc20.toLowerCase(), portalOf(erc20))
}

/** 10^21 FJ-wei for one whole WBTC (8 decimals). */
const FUEL_RATE = 10n ** 13n

/** The revert viem raises for a swapper without a rate for the token. */
async function swapperRevert(): Promise<never> {
	const { BaseError, ContractFunctionRevertedError } = await import("viem")
	throw new BaseError("quote reverted", { cause: new ContractFunctionRevertedError({ abi: [], functionName: "quote" }) })
}

/** `TestnetFuelSwapper.quote(token, amountIn)` as `h.state.fuelRate` says it answers. */
function swapperQuote(amountIn: unknown): Promise<bigint> {
	const rate = h.state.fuelRate
	if (rate === null) return new Promise(() => {})
	if (rate === "revert") return swapperRevert()
	return Promise.resolve(BigInt(amountIn as bigint) * rate)
}

// ── the faked wallet sessions ────────────────────────────────────────────────────────────────────

const grantedContracts = ref<string[]>([])
const grantMode = { value: "grant" as "grant" | "decline", gate: null as null | Promise<void> }
const requested = new Set<string>()
const l2Contract = {
	methods: {
		balance_of_public: () => ({ simulate: async () => ({ result: 5n * 10n ** 8n }) }),
		balance_of_private: () => ({ simulate: async () => ({ result: 3n * 10n ** 8n }) }),
		burn_private: () => ({ getFunctionCall: async () => ({}) }),
		burn_public: () => ({ getFunctionCall: async () => ({}) }),
	},
}
const aztecWallet = { createAuthWit: vi.fn(async () => ({})) }

h.wire.l2Contract = l2Contract
h.wire.session = {
	status: ref("connected"),
	wallet: ref(aztecWallet),
	selectedAccount: ref(AZTEC_ACCOUNT),
	accounts: ref([{ address: AZTEC_ACCOUNT, alias: "Main" }]),
	hiddenAccountsCount: ref(0),
	preferredWalletName: ref("Aztec Wallet"),
	grantedContracts,
	requested,
	retryCapabilities: h.fn.retryCapabilities,
	selectAccount: () => true,
	reset: () => {},
}
h.wire.l1 = {
	address: ref(L1_ACCOUNT),
	chainId: ref(CHAIN_ID),
	isConnected: ref(true),
	wrongChain: ref(false),
	isConnecting: ref(false),
	error: ref(null),
	walletClient: ref({}),
	ensureWalletClient: () => ({ signTypedData: async () => "0xsig", writeContract: async () => "0xl1tx" }),
	// getChainId is the LIVE re-read both lanes make before they act: the fake answers the
	// generation's own chain, so the guard passes and the scenarios exercise the path behind it.
	publicClient: {
		readContract: h.fn.readContract,
		getBlock: async () => ({ timestamp: 1_700_000_000n }),
		getChainId: async () => CHAIN_ID,
	},
	connect: vi.fn(),
	disconnect: vi.fn(),
	switchL1Network: vi.fn(),
}

// ── the faked chain answers ──────────────────────────────────────────────────────────────────────

/** Mirrors the real hub: an unbound ERC-20 registers inside (or alongside) its first claim. */
function claimOutcome(erc20: string) {
	if (h.state.hubTokens.has(erc20.toLowerCase())) return { path: "claim", claimTxHash: "0xclaim" }
	h.state.hubTokens.set(erc20.toLowerCase(), l2TokenOf(erc20))
	return { path: "register,claim", claimTxHash: "0xclaim", registerTxHash: "0xregister" }
}

interface RunSendParams {
	intent: string
	erc20: Hex
	amount: bigint
	aztecRecipient: string
	isPrivate: boolean
	claimSalt?: Fr
	gas?: unknown
}

interface RunSendHooks {
	onSecrets?: (s: Record<string, unknown>) => void
	onSent?: (txHash: string) => void
	onConfirmed?: (r: unknown) => void
}

const PUBLIC_SECRET = `0x${"07".repeat(32)}`

/** Drives the recovery hooks in the real order and reports the registration the factory froze. */
async function fakeRunSend(_l1: unknown, _gen: unknown, p: RunSendParams, _stage?: unknown, hooks?: RunSendHooks) {
	h.state.order.push("runSend")
	const isToken = p.intent !== "gas"
	const tokenSecretHashHex = p.claimSalt
		? (await computeSecretHash(p.claimSalt)).toString()
		: (await computeSecretHash(Fr.fromString(PUBLIC_SECRET))).toString()
	// A registered token keeps the decimals the factory froze; a first-time one takes the list's.
	const frozen = h.state.registrations.get(p.erc20.toLowerCase()) as { decimals: number } | undefined
	const decimals = frozen?.decimals ?? LIST_DECIMALS
	const token = isToken
		? {
				erc20: p.erc20.toLowerCase(),
				portal: portalOf(p.erc20),
				l2Token: l2TokenOf(p.erc20),
				nameWord: field(p.erc20, "name"),
				symbolWord: field(p.erc20, "symbol"),
				decimals,
				displaySymbol: "TOK",
				registerKey: field(p.erc20, "key"),
				registerIndex: "3",
			}
		: undefined
	hooks?.onSecrets?.({
		tokenClaimValueHex: isToken ? (p.claimSalt?.toString() ?? PUBLIC_SECRET) : undefined,
		tokenSecretHashHex: isToken ? tokenSecretHashHex : undefined,
		fuelSecretHex: p.gas ? PUBLIC_SECRET : undefined,
		fuelSecretHashHex: p.gas ? `0x${"08".repeat(32)}` : undefined,
	})
	hooks?.onSent?.("0xl1tx")
	// The send created the clone, so the token is registered on Ethereum from here on.
	if (isToken && !h.state.registrations.has(p.erc20.toLowerCase())) {
		h.state.registrations.set(p.erc20.toLowerCase(), registrationOf(p.erc20, decimals))
	}
	const result = {
		txHash: "0xl1tx",
		tokenLeafIndex: isToken ? 7n : undefined,
		tokenMessageHashHex: isToken ? field(p.erc20, "msg") : undefined,
		fuelLeafIndex: p.gas ? 8n : undefined,
		fuelMessageHashHex: p.gas ? field(p.erc20, "fuelmsg") : undefined,
		fuelReceived: p.gas ? 5n : undefined,
		token,
	}
	hooks?.onConfirmed?.(result)
	return result
}

// ── mounting + driving ───────────────────────────────────────────────────────────────────────────

const settle = async (ms = 0): Promise<void> => {
	await new Promise((r) => setTimeout(r, ms))
	await flushPromises()
}

/** Long enough for useRouteQuote's 400ms debounce plus its own settle. */
const ROUTE_DEBOUNCE_MS = 500

type Wrapper = Awaited<ReturnType<typeof mountView>>

async function mountView() {
	// Only the two presentational wallet panels are stubbed; the journal below the wizard is real.
	const w = mount(SendView, { global: { stubs: { L1WalletPanel: true, BridgeWalletPanel: true } } })
	await flushPromises()
	// The send lanes wire the real node/receipt deps at construction; replace exactly those, the way
	// the bridge smoke does, so the engine runs for real against fakes.
	connectJournalDeps({
		waitMs: async () => {},
		l2BlockNumber: async () => 1,
		messageReadiness: async () => ({ checkpoint: 1, anchor: 1 }),
		claimReceiptStatus: async () => {
			if (h.state.receiptGate) await h.state.receiptGate
			return "success"
		},
		consumeSend: async () => ({ consumeTxHash: "0xconsume" }),
		verifyConsumeIdentitySend: async () => true,
		waitConsumeReceipt: async () => true,
	})
	return w
}

const tile = (w: Wrapper, erc20: string) => w.find(`${sel(TESTIDS.sendTokenTile)}[data-key="${keyOf(erc20)}"]`)

async function pick(w: Wrapper, erc20: string): Promise<void> {
	await tile(w, erc20).trigger("click")
	await settle()
}

/** Picking a row already moved the wizard to the amount step; this only waits out the route probe. */
async function toAmount(w: Wrapper, amount: string, opts: { route?: boolean } = {}): Promise<void> {
	await settle(opts.route ? ROUTE_DEBOUNCE_MS : 0)
	await w.find(sel(TESTIDS.sendAmountInput)).setValue(amount)
	await settle()
}

async function toReview(w: Wrapper): Promise<void> {
	await w.find(sel(TESTIDS.sendAmountNext)).trigger("click")
	await settle()
}

const records = () => useBridgeJournal().records.value as SendDepositRecord[]
const sendRecord = () => records().find((r) => r.schema === 3)

describe("send wizard smoke", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		localStorage.clear()
		__resetJournalForTests()
		__resetSendDepsForTests()
		__resetHubExitDepsForTests()
		__resetTokenGrantQueueForTests()

		h.state.registrations.clear()
		h.state.hubTokens.clear()
		h.state.portals.clear()
		h.state.fuelRate = null
		h.state.gasHeld.value = 10n ** 18n
		h.state.withdrawsPaused = false
		h.state.exitsPaused = false
		h.state.l2Balance = 5n * 10n ** 8n
		h.state.listGate = null
		h.state.receiptGate = null
		h.state.order = []
		requested.clear()
		grantedContracts.value = []
		grantMode.value = "grant"
		grantMode.gate = null
		;(h.wire.gen as { placeholder: { on: boolean } }).placeholder.on = false

		markRegistered(USDC, 6)

		h.fn.loadTokenList.mockImplementation(async () => {
			if (h.state.listGate) await h.state.listGate
			return { tokens: listFixture.tokens, provenance: "fresh" }
		})
		h.fn.runSend.mockImplementation(fakeRunSend)
		h.fn.claimViaHub.mockImplementation(async (_hub: unknown, p: { token: { erc20: string } }) => claimOutcome(p.token.erc20))
		h.fn.exitViaHub.mockImplementation(async () => ({ receipt: { txHash: "0xexittx", blockNumber: 5 } }))
		h.fn.preflightHubExit.mockImplementation(async () => {})
		h.fn.ensurePermit2Approval.mockImplementation(async () => {})
		h.fn.buildFeeJuiceClaimDep.mockImplementation(async () => ({
			simulate: async () => ({}),
			send: async () => ({ txHash: "0xfjclaim" }),
		}))
		h.fn.readContract.mockImplementation(async (args: { functionName: string; args?: readonly string[] }) => {
			if (args.functionName === "withdrawsPaused") return h.state.withdrawsPaused
			if (args.functionName === "quote") return swapperQuote(args.args?.[1])
			return h.state.portals.get(String(args.args?.[0]).toLowerCase()) ?? "0x0000000000000000000000000000000000000000"
		})
		// The real session answers whether the prompt RAN (false = another flow owned it); this stub
		// always runs it and lets each scenario decide what the wallet answered.
		h.fn.retryCapabilities.mockImplementation(async () => {
			h.state.order.push("retryCapabilities")
			if (grantMode.gate) await grantMode.gate
			if (grantMode.value === "grant") grantedContracts.value = [...requested]
			return true
		})
	})

	it("lists the manifest tokens first, then the remote list, and takes a pasted address", async () => {
		let release = (): void => {}
		h.state.listGate = new Promise<void>((r) => {
			release = r
		})
		const w = await mountView()
		expect(w.findAll(sel(TESTIDS.sendTokenTile))).toHaveLength(MANIFEST_TOKENS.length)

		release()
		await settle()
		const keys = w.findAll(sel(TESTIDS.sendTokenTile)).map((t) => t.attributes("data-key"))
		expect(keys.slice(0, MANIFEST_TOKENS.length)).toEqual(MANIFEST_TOKENS.map((t) => keyOf(t.erc20)))
		expect(keys).toContain(keyOf(LIST_WBTC))

		// An unlisted address typed into the search is read from the chain and offered for adding; the
		// added row joins the list under the identity that read produced, and the search clears.
		await w.find(sel(TESTIDS.sendTokenSearch)).setValue("0x3333333333333333333333333333333333333333")
		await settle()
		expect(w.find(sel(TESTIDS.sendTokenLookup)).attributes("data-status")).toBe("found")
		await w.find(sel(TESTIDS.sendLookupAdd)).trigger("click")
		await settle()
		// Adding IS picking: the wizard is on the amount step; the row waits in the list behind it.
		expect(w.find(sel(TESTIDS.sendStepAmount)).exists()).toBe(true)
		await w.find(sel(TESTIDS.sendAmountBack)).trigger("click")
		await settle()
		const tiles = w.findAll(sel(TESTIDS.sendTokenTile))
		expect(tiles).toHaveLength(MANIFEST_TOKENS.length + 3)
		expect(tiles[MANIFEST_TOKENS.length]?.text()).toContain("WBTC")
		expect(tiles[MANIFEST_TOKENS.length]?.text()).toContain("added by you")

		await w.find(sel(TESTIDS.sendTokenSearch)).setValue("0xnope")
		await settle()
		expect(w.find(sel(TESTIDS.sendTokenLookup)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendCatalogEmpty)).exists()).toBe(true)
	})

	it("raises the wallet grant BEFORE the send, and runs it once the wallet grants", async () => {
		markRegistered(LIST_WBTC, LIST_DECIMALS)
		const w = await mountView()
		await pick(w, LIST_WBTC)
		await toAmount(w, "1")
		await toReview(w)
		await w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		await settle()

		expect(h.state.order.indexOf("retryCapabilities")).toBeGreaterThanOrEqual(0)
		expect(h.state.order.indexOf("retryCapabilities")).toBeLessThan(h.state.order.indexOf("runSend"))
		expect(h.fn.runSend).toHaveBeenCalledTimes(1)
		expect(sendRecord()?.token?.erc20).toBe(LIST_WBTC)
	})

	it("a declined grant sends nothing and says so on the review", async () => {
		markRegistered(LIST_WBTC, LIST_DECIMALS)
		grantMode.value = "decline"
		const w = await mountView()
		await pick(w, LIST_WBTC)
		await toAmount(w, "1")
		await toReview(w)
		await w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		await settle()

		expect(h.fn.retryCapabilities).toHaveBeenCalled()
		expect(h.fn.runSend).not.toHaveBeenCalled()
		expect(records()).toHaveLength(0)
		expect(w.find(sel(TESTIDS.sendGrantDeclined)).exists()).toBe(true)
	})

	it("while the wallet decides on the permission, the stepper shows it as the first phase and nothing else can move", async () => {
		markRegistered(LIST_WBTC, LIST_DECIMALS)
		let release = (): void => {}
		grantMode.gate = new Promise<void>((r) => {
			release = r
		})
		const w = await mountView()
		await pick(w, LIST_WBTC)
		await toAmount(w, "1")
		await toReview(w)
		await w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		await settle()

		// The wizard is gone: the stepper is up on a record the journal does not hold yet, with the
		// permission as its active first phase, and no way to background or re-pick meanwhile.
		expect(w.find(sel(TESTIDS.sendStepReview)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.stepper)).attributes("data-id")).toMatch(/^dep-pending-permit-/)
		const first = w.findAll(sel(TESTIDS.stepperPhase))[0]
		expect(first?.attributes("data-phase")).toBe("permit")
		expect(first?.attributes("data-state")).toBe("active")
		expect(first?.text()).toContain("Allow reading WBTC state in the wallet “Aztec Wallet”.")
		expect(w.find(sel(TESTIDS.stepperBackground)).exists()).toBe(false)
		expect(records()).toHaveLength(0)

		release()
		await settle()
		expect(h.fn.runSend).toHaveBeenCalledTimes(1)
		expect(w.find(sel(TESTIDS.stepper)).attributes("data-id")).not.toMatch(/^dep-pending-permit-/)
		// Granted in this run, the permission stays on the rail as its first, done phase.
		expect(w.findAll(sel(TESTIDS.stepperPhase))[0]?.attributes("data-phase")).toBe("permit")
		expect(w.findAll(sel(TESTIDS.stepperPhase))[0]?.attributes("data-state")).toBe("done")
	})

	it("a token with no fuel route closes the gas choices but still sends the token", async () => {
		markRegistered(LIST_WBTC, LIST_DECIMALS)
		h.state.fuelRate = "revert"
		const w = await mountView()
		await pick(w, LIST_WBTC)
		await toAmount(w, "1", { route: true })

		expect(w.find(sel(TESTIDS.sendRouteStatus)).attributes("data-route")).toBe("no-route")
		expect(w.find(sel(TESTIDS.sendChoiceTokenGas)).attributes("aria-disabled")).toBe("true")
		expect(w.find(sel(TESTIDS.sendChoiceGas)).attributes("aria-disabled")).toBe("true")

		await toReview(w)
		await w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		await settle()
		expect(h.fn.runSend).toHaveBeenCalledTimes(1)
		expect(h.fn.runSend.mock.calls[0][2].intent).toBe("token")
	})

	it("an unregistered token warns on the review and claims through the register path", async () => {
		const w = await mountView()
		await pick(w, LIST_WBTC)
		await toAmount(w, "1")
		await toReview(w)
		expect(w.find(sel(TESTIDS.sendReviewFirstTime)).exists()).toBe(true)

		await w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		await settle()
		const rec = sendRecord()
		expect(rec?.token?.l2Token).toBe(l2TokenOf(LIST_WBTC))
		expect(h.fn.claimViaHub).toHaveBeenCalledTimes(1)
		expect(rec?.registerTxHash).toBe("0xregister")
	})

	it("a token with a portal but no hub binding still takes the register path", async () => {
		h.state.registrations.set(LIST_WBTC.toLowerCase(), registrationOf(LIST_WBTC, LIST_DECIMALS))
		h.state.portals.set(LIST_WBTC.toLowerCase(), portalOf(LIST_WBTC))
		const w = await mountView()
		await pick(w, LIST_WBTC)
		await toAmount(w, "1")
		await toReview(w)
		expect(w.find(sel(TESTIDS.sendReviewFirstTime)).exists()).toBe(true)

		await w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		await settle()
		expect(sendRecord()?.registerTxHash).toBe("0xregister")
	})

	it("a private first send shows the REGISTER step and finishes without a second click", async () => {
		let release = (): void => {}
		h.state.receiptGate = new Promise<void>((r) => {
			release = r
		})
		const w = await mountView()
		await pick(w, LIST_WBTC)
		await toAmount(w, "1")
		await toReview(w)
		void w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		await settle()

		expect(w.find(sel(TESTIDS.stepper)).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.sendStepperRegister)).attributes("data-phase")).toBe("register")

		release()
		await settle()
		expect(sendRecord()?.completedAt).toBeDefined()
		expect(w.find(sel(TESTIDS.receipt)).exists()).toBe(true)
	})

	it("an account with no gas cannot choose the token alone: the card is greyed out with its reason and the choice moves to token + gas", async () => {
		markRegistered(LIST_WBTC, LIST_DECIMALS)
		h.state.fuelRate = FUEL_RATE
		h.state.gasHeld.value = 0n
		const w = await mountView()
		await pick(w, LIST_WBTC)
		await toAmount(w, "1", { route: true })
		const token = w.find(sel(TESTIDS.sendChoiceToken))
		expect(token.attributes("aria-disabled")).toBe("true")
		expect(token.get(`#${token.attributes("aria-describedby")}`).text()).toContain("holds no gas")
		expect(w.find(sel(TESTIDS.sendChoiceTokenGas)).attributes("aria-checked")).toBe("true")
		expect(w.find(sel(TESTIDS.sendTokenOnlyBlocked)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled")).toBeUndefined()
	})

	it("a gas-only send journals no token block and claims with the secret in its fuel block", async () => {
		markRegistered(LIST_WBTC, LIST_DECIMALS)
		h.state.fuelRate = FUEL_RATE
		const w = await mountView()
		await pick(w, LIST_WBTC)
		await toAmount(w, "1", { route: true })
		await w.find(sel(TESTIDS.sendChoiceGas)).trigger("click")
		await settle()
		// PUBLIC: the wizard defaults to private, whose claim material is sealed. A public gas-only
		// send is the one whose only secret is the plaintext fuel block.
		await w.find(sel(TESTIDS.sendPrivateToggle)).trigger("click")
		await settle()
		await toReview(w)
		await w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		await settle()

		expect(h.fn.runSend.mock.calls[0][2].intent).toBe("gas")
		const rec = records().find((r) => r.intent === "gas")
		expect(rec).toBeDefined()
		expect(rec?.token).toBeUndefined()
		// A gas-only send has no token leg, so its one claim secret lives in the fuel block - and the
		// claim is built from THAT, not from a top-level copy the record never gets.
		expect(rec?.secret).toBeUndefined()
		expect(rec?.fuel?.secret).toBe(PUBLIC_SECRET)
		expect(h.fn.buildFeeJuiceClaimDep).toHaveBeenCalledTimes(1)
		const [claimedRec, claimedSecret] = h.fn.buildFeeJuiceClaimDep.mock.calls[0] as [{ id: string }, string]
		expect(claimedRec.id).toBe(rec?.id)
		expect(claimedSecret).toBe(PUBLIC_SECRET)
		expect(rec?.completedAt).toBeDefined()
	})

	it("an exit asks for the grant at selection and refuses while the hub is paused", async () => {
		markRegistered(USDC, 6)
		h.state.exitsPaused = true
		const w = await mountView()
		await w.find(sel(TESTIDS.sendDirectionExit)).trigger("click")
		await settle()
		await pick(w, USDC)
		expect(h.fn.retryCapabilities).toHaveBeenCalledTimes(1)

		await toAmount(w, "1")
		await toReview(w)
		expect(w.find(sel(TESTIDS.sendReviewBurnNote)).exists()).toBe(true)
		await w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		await settle()

		expect(h.fn.exitViaHub).not.toHaveBeenCalled()
		expect(w.find(sel(TESTIDS.sendPausedNotice)).text()).toContain("balance is untouched")
		expect(w.find(sel(TESTIDS.sendReviewError)).exists()).toBe(false)
		expect(records()).toHaveLength(0)
	})

	it("an unpaused private exit burns through the hub, its fee paid by the fee contract from private gas", async () => {
		markRegistered(USDC, 6)
		const w = await mountView()
		await w.find(sel(TESTIDS.sendDirectionExit)).trigger("click")
		await settle()
		await pick(w, USDC)
		await toAmount(w, "1")
		await toReview(w)
		expect(w.find(sel(TESTIDS.sendReviewBurnNote)).exists()).toBe(true)
		await w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		await settle()

		expect(h.fn.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "withdrawsPaused" }))
		expect(h.fn.exitViaHub).toHaveBeenCalledTimes(1)
		const opts = h.fn.exitViaHub.mock.calls[0][2] as { fee?: { paymentMethod: unknown; gasSettings: { gasLimits: unknown } } }
		expect(opts.fee?.paymentMethod).toBeDefined()
		expect(opts.fee?.gasSettings.gasLimits).toEqual({ daGas: 50_000, l2Gas: 1_900_000 })
	})

	it("a private exit with no private gas is blocked before the review - a public payer would link the account to it", async () => {
		markRegistered(USDC, 6)
		h.state.gasHeld.value = 0n
		const w = await mountView()
		await w.find(sel(TESTIDS.sendDirectionExit)).trigger("click")
		await settle()
		await pick(w, USDC)
		await settle()
		expect(w.find(sel(TESTIDS.sendAmountBlocked)).text()).toContain("pays its fee only from private gas")
		expect(h.fn.exitViaHub).not.toHaveBeenCalled()
		expect(records()).toHaveLength(0)
	})

	it("a network with no bridge renders the placeholder and instantiates nothing", async () => {
		;(h.wire.gen as { placeholder: { on: boolean } }).placeholder.on = true
		const w = await mountView()
		expect(w.find(sel(TESTIDS.sendUnavailable)).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.sendTokenList)).exists()).toBe(false)
		expect(h.fn.loadTokenList).not.toHaveBeenCalled()
		expect(h.fn.readContract).not.toHaveBeenCalled()
	})
})
