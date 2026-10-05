import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { GrantOutcome, ResolvedToken, SelectableToken, TokenBalances } from "@/lib/send-model"

// A stale mounted wizard still watches the shared journal refs and would adopt the next test's
// record — unmount between cases.
enableAutoUnmount(afterEach)

// `vi.hoisted`: the generation + wallet mocks are evaluated while the component under test imports
// them, which is before ordinary module-level consts exist.
const { FACTORY, IMPLEMENTATION, ERC20, L1_ADDRESS, AZTEC_ACCOUNT, L2_TOKEN, WORD } = vi.hoisted(() => ({
	FACTORY: "0x1111111111111111111111111111111111111111",
	IMPLEMENTATION: "0x2222222222222222222222222222222222222222",
	ERC20: "0x3333333333333333333333333333333333333333",
	L1_ADDRESS: "0x4444444444444444444444444444444444444444",
	AZTEC_ACCOUNT: `0x${"10".repeat(32)}`,
	L2_TOKEN: `0x${"0a".repeat(32)}`,
	WORD: `0x${"bb".repeat(32)}`,
}))
const ROUTE = { path: [{ currency0: ERC20, currency1: ERC20, fee: 500, tickSpacing: 10, hooks: ERC20 }], zeroForOnes: [true] }

const catalogTokens = ref<SelectableToken[]>([])
const search = ref("")
const catalogRefresh = vi.fn(async () => {})
const addPasted = vi.fn((address: string) => candidate(address))
const catalogDispose = vi.fn()

const selected = ref<ResolvedToken | null>(null)
const selectLoading = ref(false)
const balances = ref<TokenBalances>({})
const selectionError = ref<string | null>(null)
const selectDispose = vi.fn()
const refreshBalances = vi.fn(async () => {})
let epoch = 0
/** What the next `select` resolves to; a case swaps it to drive first-time / fee-asset shapes. */
let nextResolved: (token: SelectableToken) => ResolvedToken = (token) => resolvedToken(token)
const selectFn = vi.fn(async (token: SelectableToken) => {
	epoch++
	selected.value = nextResolved(token)
})

const granted = ref<string[]>([])
let grantOutcome: GrantOutcome = "granted"
/** The private Fee Juice the connected Aztec account holds at the fee contract; null = unknown. */
const gasHeld = ref<bigint | null>(null)
/** The account's public Fee Juice, and whether the wallet routes it as a dApp-named payer. */
const gasHeldPublic = ref<bigint | null>(0n)
const gasHeldSelfPay = ref(false)
const gasHeldRefresh = vi.fn(async () => {})
const selectedAccount = ref<string | null>(AZTEC_ACCOUNT)
const L1_SENDER = "0x71c4000000000000000000000000000000003a9f"
const ensureGranted = vi.fn(async (): Promise<GrantOutcome> => {
	if (grantOutcome === "granted") granted.value = [...granted.value, L2_TOKEN]
	return grantOutcome
})
const grantDispose = vi.fn()

const routeQuoted = ref<{ token: string; probeAmount: bigint; outcome: unknown } | null>(null)
const routeError = ref<string | null>(null)
const quoteFn = vi.fn(async () => {})
const routeDispose = vi.fn()

/** An answer the wizard will accept: tagged with the token on screen and its 1-unit probe (8 dec). */
const setRoute = (outcome: unknown, token: string = ERC20): void => {
	routeQuoted.value = outcome === null ? null : { token, probeAmount: 10n ** 8n, outcome }
}

const txTarget = ref(20)
/** The confirm re-reads the network's fees; false = the read failed, and a private slice is not signed on a stale price. */
const primeFn = vi.fn(async () => true)
/** The ceilings a private claim sets aside. Negligible by default (the fixtures' slices are tiny);
 *  the fee-line tests raise them to one transaction's 0.1 FJ, plus a registration's 0.5 FJ for a
 *  token the hub does not know — the same figures the public line calibrates. */
const ceilingsFor = vi.fn((state: { kind: string }): bigint => (state.kind === "registered" ? 1n : 6n))
const realCeilings = () => ceilingsFor.mockImplementation((state) => (state.kind === "registered" ? 10n ** 17n : 6n * 10n ** 17n))
/** What a token-only claim sets aside from held gas: small by default, so a held balance covers it. */
const ownGasCeilingFor = vi.fn((): bigint | null => 1n)
/** A gas-only send's standalone private fuel claim: 0.4 FJ, apart from every hub-claim figure. */
const fuelClaimCeiling = vi.fn((): bigint | null => 4n * 10n ** 17n)
const proposeFn = vi.fn(() => ({ fuelAmount: 2_000_000n, fuelFj: 5n * 10n ** 18n, capped: null }))
const gasShareDispose = vi.fn()

const records = ref<Record<string, unknown>[]>([])
/** Records THIS tab's engine created — the wizard's provenance test for adopting a run's record. */
const sessionLive = new Set<string>()
/** Provisional id → the id the record's transaction gave it. */
const rekeys = ref<Record<string, string>>({})
const activeFlowId = ref<string | null>(null)
const journalRuntime = ref<Record<string, unknown>>({})
const claimForeground = vi.fn((id: string) => {
	activeFlowId.value = id
})
const releaseForeground = vi.fn((id: string) => {
	if (activeFlowId.value === id) activeFlowId.value = null
})

const sendError = ref<string | null>(null)
const sendBusy = ref(false)
const sendFn = vi.fn(async (): Promise<string> => "")
const sendDispose = vi.fn()
const exitError = ref<string | null>(null)
const exitFn = vi.fn(async (_plan: unknown, _approvedCeiling?: bigint): Promise<string> => "")
const exitDispose = vi.fn()

const readContract = vi.fn(async () => "0x0000000000000000000000000000000000000000")
const addTokenFn = vi.fn(async () => {})
const isRegisteredFn = vi.fn(async () => false)
const aztecWallet = ref<object | null>(null)
const l1WrongChain = ref(false)
let rowOwner: () => string | undefined = () => undefined
let selectionOwner: () => string | undefined = () => undefined
const addTokenStatus = ref<{ kind: string; error?: { message: string } }>({ kind: "idle" })
const toasts: { kind: string; text: string }[] = []

vi.mock("@/contracts/bridge-generation", () => ({
	HUB: { toString: () => AZTEC_ACCOUNT },
	HUB_TOKEN_ARTIFACT: {},
	SEND_GENERATION: { factory: FACTORY, implementation: IMPLEMENTATION },
	SWAP: { slippageBps: 300, fjPerTx: "100000000000000000", fjRegister: "500000000000000000", minFuelFj: "1000000" },
	MANIFEST_TOKENS: [],
}))
vi.mock("@/composables/useL1Wallet", () => ({
	useL1Wallet: () => ({ address: ref(L1_ADDRESS), chainId: ref(31337), wrongChain: l1WrongChain, publicClient: { readContract } }),
}))
vi.mock("@/composables/useBridgeWallet", () => ({
	useBridgeWallet: () => ({
		wallet: aztecWallet,
		selectedAccount,
		accounts: ref([{ address: AZTEC_ACCOUNT, alias: "main" }]),
		status: ref("connected"),
		preferredWalletName: ref(null),
	}),
}))
vi.mock("@/composables/useBridgeJournal", () => ({
	useBridgeJournal: () => ({
		records,
		activeFlowId,
		runtime: journalRuntime,
		claimForeground,
		releaseForeground,
		isSessionLive: (id: string) => sessionLive.has(id),
		canonicalRecordId: (id: string) => rekeys.value[id] ?? id,
	}),
}))
vi.mock("@/composables/useBridgeBackup", () => ({ useBridgeBackup: () => ({ exportBridgeWithToast: vi.fn() }) }))
vi.mock("@/composables/useAddDripToken", () => ({
	useAddDripToken: () => ({ status: addTokenStatus, addToken: addTokenFn, isRegistered: isRegisteredFn, reset: vi.fn() }),
}))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ push: (t: { kind: string; text: string }) => toasts.push(t) }),
}))
vi.mock("@/composables/useTokenCatalog", () => ({
	useTokenCatalog: () => ({
		tokens: catalogTokens,
		provenance: ref("fresh"),
		loading: ref(false),
		error: ref(null),
		search,
		filtered: catalogTokens,
		addPasted,
		refresh: catalogRefresh,
		dispose: catalogDispose,
	}),
}))
vi.mock("@/contracts/hub-binding", () => ({ readHubBinding: async () => undefined }))
vi.mock("@/composables/useGasHeld", () => ({
	useGasHeld: () => ({
		credit: gasHeld,
		publicFeeJuice: gasHeldPublic,
		selfPay: gasHeldSelfPay,
		refresh: gasHeldRefresh,
		dispose: vi.fn(),
	}),
}))
vi.mock("@/composables/useAddressLookup", () => ({
	useAddressLookup: () => ({ state: ref(null), dispose: vi.fn() }),
}))
vi.mock("@/composables/useRowBalances", () => ({
	useRowBalances: (deps: { owner: () => string | undefined }) => {
		rowOwner = deps.owner
		return { balances: ref({}), refresh: vi.fn(async () => {}), dispose: vi.fn() }
	},
}))
vi.mock("@/composables/useTokenSelection", () => ({
	useTokenSelection: (deps: { l1Account: () => string | undefined }) => {
		selectionOwner = deps.l1Account
		return {
			selected,
			balances,
			loading: selectLoading,
			error: selectionError,
			epoch: () => epoch,
			select: selectFn,
			refreshBalances,
			dispose: selectDispose,
		}
	},
}))
vi.mock("@/composables/useTokenGrant", () => ({
	useTokenGrant: () => ({
		isGranted: (l2Token: string) => granted.value.includes(l2Token),
		ensureGranted,
		dispose: grantDispose,
	}),
}))
vi.mock("@/composables/useRouteQuote", () => ({
	useRouteQuote: () => ({ quoted: routeQuoted, loading: ref(false), error: routeError, quote: quoteFn, dispose: routeDispose }),
}))
vi.mock("@/composables/useGasShare", () => ({
	useGasShare: () => ({
		txTarget,
		propose: proposeFn,
		prime: primeFn,
		invalidate: () => {},
		pricingError: ref(null),
		ceilingsFor,
		fuelClaimCeiling,
		ownGasCeilingFor,
		floorFor: (q: bigint) => (q * 97n) / 100n,
		reset: () => {
			txTarget.value = 20
		},
		dispose: gasShareDispose,
	}),
}))
vi.mock("@/composables/useSend", () => ({
	useSend: () => ({ send: sendFn, stage: ref(null), busy: sendBusy, error: sendError, dispose: sendDispose }),
	previewBlock: (plan: { token: ResolvedToken }) => ({
		erc20: plan.token.address,
		portal: plan.token.portal,
		l2Token: plan.token.l2Token,
		nameWord: plan.token.words.nameWord,
		symbolWord: plan.token.words.symbolWord,
		decimals: plan.token.decimals,
		displaySymbol: plan.token.symbol,
	}),
}))
vi.mock("@/composables/useHubExit", () => ({
	EXIT_TOKEN_NOT_REGISTERED: "The bridge hasn't registered this token on Aztec yet, so there is nothing here to withdraw.",
	useHubExit: () => ({ exit: exitFn, busy: ref(false), error: exitError, paused: ref(null), dispose: exitDispose }),
}))

import { predictPortal } from "@unleashed/bridge-core"
import BridgeReceipt from "@/components/BridgeReceipt.vue"
import { EXIT_TOKEN_NOT_REGISTERED } from "@/composables/useHubExit"
import { __resetShellForTests, useShell } from "@/composables/useShell"
import { TESTIDS } from "@/lib/testids"
import SendWizard from "./SendWizard.vue"

const stub = (name: string, props: string[]) => ({ name, props, template: "<div />" })
const stubs = {
	TokenStep: stub("TokenStep", [
		"direction",
		"tokens",
		"search",
		"loading",
		"catalogError",
		"lookup",
		"addError",
		"selected",
		"selectionError",
		"rowBalances",
	]),
	AmountStep: stub("AmountStep", [
		"direction",
		"token",
		"resolving",
		"balances",
		"intent",
		"amount",
		"isPrivate",
		"gas",
		"routeKind",
		"routeLoading",
		"txTarget",
		"fjPerTx",
		"gasSetAside",
		"gasError",
		"blockedReason",
		"tokenOnlyBlocked",
	]),
	ReviewStep: stub("ReviewStep", [
		"plan",
		"portalVerified",
		"account",
		"signatureValiditySeconds",
		"slippageBps",
		"estimate",
		"grant",
		"busy",
		"error",
	]),
	StepStrip: stub("StepStrip", ["steps", "active", "completed"]),
	BridgeStepper: stub("BridgeStepper", ["record", "runtime", "canBackground", "startedAt"]),
	BridgeReceipt: stub("BridgeReceipt", ["snapshot", "ctaLabel", "addTokenBusy"]),
}

function candidate(address = ERC20): SelectableToken {
	return {
		chainId: 1,
		address: address as `0x${string}`,
		symbol: "WBTC",
		name: "Wrapped BTC",
		decimals: 8,
		source: "list",
		logoKey: `1:${address}`,
	}
}

const REGISTRATION = {
	portal: FACTORY as `0x${string}`,
	decimals: 8,
	registerIndex: 3n,
	nameWord: WORD as `0x${string}`,
	symbolWord: WORD as `0x${string}`,
	registerKey: WORD as `0x${string}`,
}

/** Only a hub-registered token can be exited, so an exit case must resolve to one. */
const HUB_REGISTERED: ResolvedToken["state"] = { kind: "registered", registration: REGISTRATION, l2Token: L2_TOKEN as `0x${string}` }

function resolvedToken(token: SelectableToken, state: ResolvedToken["state"] = { kind: "first-time" }): ResolvedToken {
	return {
		...token,
		state,
		portal: FACTORY as `0x${string}`,
		words: { nameWord: WORD as `0x${string}`, symbolWord: WORD as `0x${string}` },
		l2Token: L2_TOKEN as `0x${string}`,
	}
}

function sendRecord(id: string, over: Record<string, unknown> = {}) {
	return {
		schema: 3,
		id,
		direction: "deposit",
		intent: "token",
		isPrivate: true,
		amount: "100000000",
		createdAt: 1_000,
		updatedAt: 1_000,
		chainId: 1,
		portal: FACTORY,
		bridge: AZTEC_ACCOUNT,
		recipient: AZTEC_ACCOUNT,
		secretHashHex: id,
		token: { erc20: ERC20, portal: FACTORY, l2Token: L2_TOKEN, nameWord: WORD, symbolWord: WORD, decimals: 8, displaySymbol: "WBTC" },
		...over,
	}
}

async function wizard() {
	const w = mount(SendWizard, { global: { stubs } })
	await flushPromises()
	return w
}

/** Walk the wizard to the review step with a resolved token and a valid amount. The stub stands in
 *  for the real step's own validation, which is what the wizard gates on. */
async function atReview(w: Awaited<ReturnType<typeof wizard>>, amount = "1") {
	// Picking a row is the whole token step: the wizard is on the amount step when this resolves.
	w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
	await flushPromises()
	w.findComponent({ name: "AmountStep" }).vm.$emit("update:amount", amount)
	w.findComponent({ name: "AmountStep" }).vm.$emit("update:valid", true)
	await flushPromises()
	w.findComponent({ name: "AmountStep" }).vm.$emit("next")
	await flushPromises()
	return w.findComponent({ name: "ReviewStep" })
}

describe("SendWizard", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		__resetShellForTests()
		ceilingsFor.mockImplementation((state) => (state.kind === "registered" ? 1n : 6n))
		ownGasCeilingFor.mockImplementation(() => 1n)
		catalogTokens.value = [candidate()]
		selected.value = null
		balances.value = { l1: 10n ** 9n, l2Public: 5n * 10n ** 8n, l2Private: 3n * 10n ** 8n }
		selectionError.value = null
		epoch = 0
		gasHeld.value = 10n ** 18n
		gasHeldPublic.value = 0n
		gasHeldSelfPay.value = false
		gasHeldRefresh.mockReset().mockImplementation(async () => {})
		selectedAccount.value = AZTEC_ACCOUNT
		rekeys.value = {}
		sessionLive.clear()
		nextResolved = (token) => resolvedToken(token)
		granted.value = [L2_TOKEN]
		grantOutcome = "granted"
		setRoute(null)
		routeError.value = null
		records.value = []
		sessionLive.clear()
		activeFlowId.value = null
		journalRuntime.value = {}
		sendError.value = null
		sendBusy.value = false
		exitError.value = null
		addTokenStatus.value = { kind: "idle" }
		isRegisteredFn.mockResolvedValue(false)
		aztecWallet.value = {}
		l1WrongChain.value = false
		toasts.length = 0
		readContract.mockResolvedValue("0x0000000000000000000000000000000000000000")
		sendFn.mockResolvedValue("")
		exitFn.mockResolvedValue("")
		proposeFn.mockReturnValue({ fuelAmount: 2_000_000n, fuelFj: 5n * 10n ** 18n, capped: null })
	})

	it("opens on the token step and hands it the catalog", async () => {
		const w = await wizard()
		expect(catalogRefresh).toHaveBeenCalled()
		const token = w.findComponent({ name: "TokenStep" })
		expect(token.exists()).toBe(true)
		expect(token.props("tokens")).toEqual([candidate()])
		expect(w.findComponent({ name: "AmountStep" }).exists()).toBe(false)
	})

	it("selecting a token resolves it for the current direction and unlocks the amount step", async () => {
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		expect(selectFn).toHaveBeenCalledWith(candidate(), "l1-to-l2")
		expect(w.findComponent({ name: "StepStrip" }).props("completed")).toBe(1)
	})

	it("the amount step owns the verdict on its field; the wizard only follows it", async () => {
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		await flushPromises()
		const amount = w.findComponent({ name: "AmountStep" })
		amount.vm.$emit("update:amount", "1")
		await flushPromises()
		// No verdict yet — an amount the wizard cannot judge for itself keeps the review out of reach.
		expect(w.findComponent({ name: "StepStrip" }).props("completed")).toBe(1)
		amount.vm.$emit("update:valid", true)
		await flushPromises()
		expect(w.findComponent({ name: "StepStrip" }).props("completed")).toBe(2)
		amount.vm.$emit("update:valid", false)
		await flushPromises()
		expect(w.findComponent({ name: "StepStrip" }).props("completed")).toBe(1)
	})

	it("a cleared amount stands the review down even while the step's last verdict was yes", async () => {
		const w = await wizard()
		await atReview(w)
		expect(w.findComponent({ name: "StepStrip" }).props("completed")).toBe(2)
		w.findComponent({ name: "ReviewStep" }).vm.$emit("back")
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:amount", "")
		await flushPromises()
		expect(w.findComponent({ name: "StepStrip" }).props("completed")).toBe(1)
	})

	it("token+gas has no gas plan to hand down until a route is quoted", async () => {
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:amount", "1")
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:intent", "token+gas")
		await flushPromises()
		expect(w.findComponent({ name: "AmountStep" }).props("gas")).toBeNull()
		setRoute({ kind: "route", route: ROUTE, quoteOut: 10n ** 18n })
		await flushPromises()
		expect(w.findComponent({ name: "AmountStep" }).props("gas")?.route).toEqual(ROUTE)
	})

	it("the fee asset's gas leg is one-for-one with no pools and no slippage floor", async () => {
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:amount", "1")
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:intent", "token+gas")
		setRoute({ kind: "identity" })
		await flushPromises()
		const gas = w.findComponent({ name: "AmountStep" }).props("gas")
		expect(gas.route).toEqual({ path: [], zeroForOnes: [] })
		expect(gas.minFuelOutput).toBe(gas.quote)
		expect(gas.quote).toBe(gas.fuelAmount)
	})

	it("a gas-only send routes the WHOLE amount through the swap", async () => {
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:amount", "1")
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:intent", "gas")
		setRoute({ kind: "route", route: ROUTE, quoteOut: 10n ** 18n })
		await flushPromises()
		expect(w.findComponent({ name: "AmountStep" }).props("gas").fuelAmount).toBe(10n ** 8n)
	})

	it("picking a row moves to the amount step at once, on the row's own symbol, and a failed read brings the user back", async () => {
		let releaseSelect = (): void => {}
		selectFn.mockImplementationOnce(async (token: SelectableToken) => {
			selectLoading.value = true
			await new Promise<void>((resolve) => {
				releaseSelect = resolve
			})
			epoch++
			selected.value = nextResolved(token)
			selectLoading.value = false
		})
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		const amountStep = w.findComponent({ name: "AmountStep" })
		expect(amountStep.exists()).toBe(true)
		expect(amountStep.props("resolving")).toBe(true)
		expect(amountStep.props("token")).toMatchObject({ symbol: candidate().symbol, decimals: candidate().decimals })
		releaseSelect()
		await flushPromises()
		expect(w.findComponent({ name: "AmountStep" }).props("resolving")).toBe(false)

		// A read that fails returns the user to the row, where the reason is shown.
		selectionError.value = "That address is not an ERC-20."
		await flushPromises()
		expect(w.findComponent({ name: "TokenStep" }).exists()).toBe(true)
		expect(w.findComponent({ name: "TokenStep" }).props("selectionError")).toContain("not an ERC-20")
	})

	it("a second row picked while the first is still being read renders on ITS row, sanitised, never the first's answer", async () => {
		const OTHER = "0x5555555555555555555555555555555555555555"
		const bidi = `PA${String.fromCodePoint(0x202e)}XG`
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		expect(w.findComponent({ name: "AmountStep" }).props("token")).toMatchObject({ symbol: "WBTC", decimals: 8 })

		// The first read stands; the user goes back and picks a 6-decimal row with a hostile symbol.
		selectFn.mockImplementationOnce(async () => {
			selectLoading.value = true
		})
		w.findComponent({ name: "WizardShell" }).vm.$emit("goto", 0)
		await flushPromises()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", { ...candidate(OTHER), symbol: bidi, decimals: 6 })
		await flushPromises()
		const token = w.findComponent({ name: "AmountStep" }).props("token")
		expect(token.decimals).toBe(6)
		expect(token.symbol).toBe("PAXG")
		expect(token.symbol).not.toContain(String.fromCodePoint(0x202e))
		selectLoading.value = false
	})

	it("a grant that throws (not declines) returns to the wizard and reports it, never a stuck permission screen", async () => {
		granted.value = []
		// The send composable normalises a wallet error into its `error` ref and resolves empty; a
		// rejection here would be its own bug (pinned in useSend.test.ts), so this is the contract.
		sendFn.mockImplementation(async () => {
			sendError.value = "wallet unreachable"
			return ""
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(false)
		const back = w.findComponent({ name: "ReviewStep" })
		expect(back.exists()).toBe(true)
		expect(back.props("busy")).toBe(false)
		expect(back.props("error")).toBe("wallet unreachable")
	})

	it("the wallet's token permission is the stepper's first phase, shown before any record exists", async () => {
		granted.value = []
		let releaseSend = (): void => {}
		sendFn.mockImplementation(async () => {
			// The grant is still open inside the send: nothing is in the journal yet.
			await new Promise<void>((resolve) => {
				releaseSend = resolve
			})
			sessionLive.add("rec-1")
			records.value = [...records.value, sendRecord("rec-1")]
			return "rec-1"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		const permit = w.findComponent({ name: "BridgeStepper" })
		expect(permit.exists()).toBe(true)
		expect(permit.props("record")).toMatchObject({ schema: 3, registers: true, token: { displaySymbol: "WBTC" } })
		expect(permit.props("record").id).toMatch(/^dep-pending-permit-/)
		expect(permit.props("runtime")).toEqual({ step: "granting" })
		expect(permit.props("canBackground")).toBe(false)
		expect(useShell().bridgeForm.value).toBe(false)
		expect(claimForeground).not.toHaveBeenCalled()
		const startedAt = permit.props("startedAt")
		expect(startedAt).toEqual(expect.any(Number))

		releaseSend()
		await flushPromises()
		// The real record takes over the stepper the moment it exists, and its clock runs on.
		expect(w.findComponent({ name: "BridgeStepper" }).props("record").id).toBe("rec-1")
		expect(w.findComponent({ name: "BridgeStepper" }).props("canBackground")).toBeUndefined()
		expect(w.findComponent({ name: "BridgeStepper" }).props("startedAt")).toBe(startedAt)
		expect(claimForeground).toHaveBeenCalledWith("rec-1")
	})

	it("a declined permission leaves the permission phase and returns to the review, which says so", async () => {
		granted.value = []
		grantOutcome = "declined"
		sendFn.mockImplementation(async () => "")
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(false)
		expect(w.findComponent({ name: "ReviewStep" }).props("grant")).toBe("declined")
	})

	it("a token-only send is blocked while the account is known to hold no gas, and released by adding gas", async () => {
		gasHeld.value = 0n
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		const amountStep = () => w.findComponent({ name: "AmountStep" })
		amountStep().vm.$emit("update:amount", "1")
		amountStep().vm.$emit("update:valid", true)
		await flushPromises()
		expect(amountStep().props("tokenOnlyBlocked")).toContain("holds no gas")
		// The default choice moved off the blocked one on its own: the card is greyed out, not chosen,
		// and a choice forced back onto it bounces off while the verdict stands.
		expect(amountStep().props("intent")).toBe("token+gas")
		amountStep().vm.$emit("update:intent", "token")
		await flushPromises()
		expect(amountStep().props("intent")).toBe("token+gas")
		// The reason stays on the step whatever the choice (it greys the card out); the verdict clears
		// it, and the token alone is a choice again.
		expect(amountStep().props("tokenOnlyBlocked")).toContain("holds no gas")
		gasHeld.value = null
		await flushPromises()
		expect(amountStep().props("tokenOnlyBlocked")).toBeNull()
		amountStep().vm.$emit("update:intent", "token")
		await flushPromises()
		expect(amountStep().props("intent")).toBe("token")
	})

	it("public Fee Juice counts as held gas only on a wallet that routes a dApp-named payer, and the review then names the account as payer", async () => {
		realCeilings()
		ownGasCeilingFor.mockImplementation(() => 10n ** 16n)
		gasHeld.value = 0n
		gasHeldPublic.value = 10n ** 18n
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		const amountStep = () => w.findComponent({ name: "AmountStep" })
		amountStep().vm.$emit("update:isPrivate", false)
		await flushPromises()
		expect(amountStep().props("tokenOnlyBlocked")).toContain("holds no gas")
		gasHeldSelfPay.value = true
		await flushPromises()
		expect(amountStep().props("tokenOnlyBlocked")).toBeNull()
		amountStep().vm.$emit("update:intent", "token")
		amountStep().vm.$emit("update:amount", "1")
		amountStep().vm.$emit("update:valid", true)
		await flushPromises()
		amountStep().vm.$emit("next")
		await flushPromises()
		const review = w.findComponent({ name: "ReviewStep" })
		expect(review.props("estimate").networkFee).toBe("up to ≈ 0.01 FJ")
		expect(review.props("estimate").networkFeeNote).toContain(
			"from the Fee Juice you already hold — paid by your account as its own fee",
		)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(sendFn).toHaveBeenCalledTimes(1)
	})

	it("a private send never claims with public Fee Juice: token-only stays blocked on a full public balance and the choice moves to Token + gas", async () => {
		realCeilings()
		ownGasCeilingFor.mockImplementation(() => 10n ** 16n)
		gasHeld.value = 0n
		gasHeldPublic.value = 10n ** 21n
		gasHeldSelfPay.value = true
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		const amountStep = () => w.findComponent({ name: "AmountStep" })
		expect(amountStep().props("isPrivate")).toBe(true)
		expect(amountStep().props("tokenOnlyBlocked")).toContain("claims only with private gas")
		expect(amountStep().props("intent")).toBe("token+gas")
		amountStep().vm.$emit("update:intent", "token")
		await flushPromises()
		expect(amountStep().props("intent")).toBe("token+gas")
		// Private credit under the ceiling is short, not none; enough of it releases the choice.
		gasHeld.value = 10n ** 15n
		await flushPromises()
		expect(amountStep().props("tokenOnlyBlocked")).toContain("under what this claim sets aside")
		gasHeld.value = 10n ** 17n
		await flushPromises()
		expect(amountStep().props("tokenOnlyBlocked")).toBeNull()
		// The same public balance pays a PUBLIC send of the same token.
		gasHeld.value = 0n
		amountStep().vm.$emit("update:isPrivate", false)
		await flushPromises()
		expect(amountStep().props("tokenOnlyBlocked")).toBeNull()
	})

	it("a balance known to cover pays whatever the other read did - public with the private read failed, and the reverse", async () => {
		realCeilings()
		ownGasCeilingFor.mockImplementation(() => 10n ** 16n)
		const enterTokenOnly = async () => {
			const w = await wizard()
			w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
			await flushPromises()
			const amountStep = () => w.findComponent({ name: "AmountStep" })
			amountStep().vm.$emit("update:isPrivate", false)
			await flushPromises()
			expect(amountStep().props("tokenOnlyBlocked")).toBeNull()
			amountStep().vm.$emit("update:intent", "token")
			amountStep().vm.$emit("update:amount", "1")
			amountStep().vm.$emit("update:valid", true)
			await flushPromises()
			amountStep().vm.$emit("next")
			await flushPromises()
			w.findComponent({ name: "ReviewStep" }).vm.$emit("confirm")
			await flushPromises()
		}
		gasHeld.value = null
		gasHeldPublic.value = 10n ** 18n
		gasHeldSelfPay.value = true
		await enterTokenOnly()
		expect(sendFn).toHaveBeenCalledTimes(1)
		gasHeld.value = 10n ** 18n
		gasHeldPublic.value = null
		await enterTokenOnly()
		expect(sendFn).toHaveBeenCalledTimes(2)
	})

	it("a gas slice under the bridge's claim minimum is refused before any signature — the swap would revert on Ethereum", async () => {
		// 0.02 token at 1e-12 FJ per token: 20,000 wei of gas, under the mocked 1,000,000-wei minimum.
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("back")
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:intent", "token+gas")
		setRoute({ kind: "route", route: ROUTE, quoteOut: 10n ** 6n })
		await flushPromises()
		const amount = w.findComponent({ name: "AmountStep" })
		expect(amount.props("gas")).toBeNull()
		expect(amount.props("gasError")).toMatch(/buys only ≈ .* FJ of gas, under the ≈ .* FJ minimum a claim needs/)
	})

	it("Run in background starts the wizard over and keeps a line on the send until it lands", async () => {
		// The send lane resolves only once the whole bridge is done: the record lands first, the
		// background happens while the lane is still open, and the lane resolves last.
		let releaseSend = (): void => {}
		sendFn.mockImplementation(async () => {
			sessionLive.add("rec-1")
			records.value = [...records.value, sendRecord("rec-1")]
			await new Promise<void>((resolve) => {
				releaseSend = resolve
			})
			return "rec-1"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(true)

		w.findComponent({ name: "BridgeStepper" }).vm.$emit("background")
		await flushPromises()
		expect(releaseForeground).toHaveBeenCalledWith("rec-1")
		expect(w.findComponent({ name: "TokenStep" }).exists()).toBe(true)
		const strip = w.find(`[data-testid="${TESTIDS.sendBackgroundStrip}"]`)
		expect(strip.text()).toContain("is on its way")
		// Carrier means done: a running send's dot is ink, a failed one's amber.
		const dotTone = () => strip.get("[data-tone]").attributes("data-tone")
		expect(dotTone()).toBe("running")
		journalRuntime.value = { "rec-1": { attention: "error", note: "reverted" } }
		await flushPromises()
		expect(strip.text()).toContain("needs your attention")
		expect(dotTone()).toBe("failed")
		journalRuntime.value = {}
		await flushPromises()
		// Its Activity link hands the shell THIS record, so the page opens with it highlighted.
		await strip.get(`[data-testid="${TESTIDS.sendBackgroundActivity}"]`).trigger("click")
		expect(useShell().section.value).toBe("activity")
		expect(useShell().highlightedId.value).toBe("rec-1")
		__resetShellForTests()

		// The engine keeps writing the record: that must not take the wizard over again.
		records.value = records.value.map((r) => (r.id === "rec-1" ? { ...r, updatedAt: 1_500 } : r))
		await flushPromises()
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(false)
		expect(claimForeground).toHaveBeenCalledTimes(1)

		// Nor may the lane resolving, nor the record completing: the finished send belongs to the
		// journal now, never to a receipt the wizard left behind.
		releaseSend()
		await flushPromises()
		records.value = records.value.map((r) => (r.id === "rec-1" ? { ...r, completedAt: 2_000 } : r))
		await flushPromises()
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(false)
		expect(w.findComponent({ name: "BridgeReceipt" }).exists()).toBe(false)
		expect(w.find(`[data-testid="${TESTIDS.sendBackgroundStrip}"]`).exists()).toBe(false)
		expect(claimForeground).toHaveBeenCalledTimes(1)
	})

	it("a backgrounded send follows its record through a rekey, and the renamed record is never re-adopted", async () => {
		let releaseSend = (): void => {}
		sendFn.mockImplementation(async () => {
			sessionLive.add("dep-pending-1")
			records.value = [...records.value, sendRecord("dep-pending-1")]
			await new Promise<void>((resolve) => {
				releaseSend = resolve
			})
			return "0xfinal"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		w.findComponent({ name: "BridgeStepper" }).vm.$emit("background")
		await flushPromises()
		expect(w.find(`[data-testid="${TESTIDS.sendBackgroundStrip}"]`).exists()).toBe(true)

		// The deposit transaction names the record: the journal rekeys it, session-live moves with it.
		sessionLive.delete("dep-pending-1")
		sessionLive.add("0xfinal")
		rekeys.value = { "dep-pending-1": "0xfinal" }
		records.value = records.value.map((r) => (r.id === "dep-pending-1" ? { ...r, id: "0xfinal" } : r))
		await flushPromises()
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(false)
		expect(w.find(`[data-testid="${TESTIDS.sendBackgroundStrip}"]`).exists()).toBe(true)

		releaseSend()
		await flushPromises()
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(false)
		expect(claimForeground).toHaveBeenCalledTimes(1)

		records.value = records.value.map((r) => (r.id === "0xfinal" ? { ...r, completedAt: 2_000 } : r))
		await flushPromises()
		expect(w.find(`[data-testid="${TESTIDS.sendBackgroundStrip}"]`).exists()).toBe(false)
		expect(w.findComponent({ name: "BridgeReceipt" }).exists()).toBe(false)
	})

	it("a no-gas verdict that lands under the frozen review stands it down, and confirm never signs past it", async () => {
		const w = await wizard()
		const review = await atReview(w)
		gasHeld.value = 0n
		await flushPromises()
		expect(w.findComponent({ name: "ReviewStep" }).exists()).toBe(false)
		expect(w.findComponent({ name: "AmountStep" }).props("tokenOnlyBlocked")).toContain("holds no gas")
		expect(w.find(`[data-testid="${TESTIDS.sendReviewStale}"]`).exists()).toBe(true)
		// A confirm the frozen review still had in flight sends nothing.
		review.vm.$emit("confirm")
		await flushPromises()
		expect(sendFn).not.toHaveBeenCalled()
	})

	it("confirm re-reads the gas gate before signing a token-only send, holding the buttons meanwhile", async () => {
		gasHeld.value = 10n ** 18n
		let releaseRead = (): void => {}
		gasHeldRefresh.mockImplementation(async () => {
			await new Promise<void>((resolve) => {
				releaseRead = resolve
			})
			gasHeld.value = 0n
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(w.findComponent({ name: "ReviewStep" }).props("busy")).toBe(true)
		expect(sendFn).not.toHaveBeenCalled()
		releaseRead()
		await flushPromises()
		expect(sendFn).not.toHaveBeenCalled()
		expect(w.findComponent({ name: "ReviewStep" }).exists()).toBe(false)
		expect(w.findComponent({ name: "AmountStep" }).props("tokenOnlyBlocked")).toContain("holds no gas")
	})

	it("a review opened before the claim was priced stands down at confirm once the price lands, and one whose figure grew stands down too", async () => {
		let ceiling: bigint | null = null
		ownGasCeilingFor.mockImplementation(() => ceiling)
		const w = await wizard()
		let review = await atReview(w)
		expect(review.props("estimate").networkFee).toBeNull()
		expect(review.props("estimate").networkFeeNote).toMatch(/^paid from the private gas you already hold — set aside in full/)
		ceiling = 10n ** 16n
		review.vm.$emit("confirm")
		await flushPromises()
		expect(sendFn).not.toHaveBeenCalled()
		expect(w.find(`[data-testid="${TESTIDS.sendReviewStale}"]`).text()).toContain("priced after you opened the review")
		// Stood down to the amount step; re-entered with the price, a figure that then grows past a
		// tenth is not the one approved.
		const reenter = async () => {
			w.findComponent({ name: "AmountStep" }).vm.$emit("update:valid", true)
			await flushPromises()
			w.findComponent({ name: "AmountStep" }).vm.$emit("next")
			await flushPromises()
			return w.findComponent({ name: "ReviewStep" })
		}
		review = await reenter()
		expect(review.props("estimate").networkFee).toBe("≈ 0.01 FJ")
		expect(review.props("estimate").networkFeeNote).toMatch(/^from the private gas you already hold/)
		ceiling = 10n ** 16n + 10n ** 15n + 1n
		review.vm.$emit("confirm")
		await flushPromises()
		expect(sendFn).not.toHaveBeenCalled()
		expect(w.find(`[data-testid="${TESTIDS.sendReviewStale}"]`).text()).toContain("fees moved")
		// A figure within the tenth is the one approved: the confirm signs.
		review = await reenter()
		ceiling = ceiling + ceiling / 20n
		review.vm.$emit("confirm")
		await flushPromises()
		expect(sendFn).toHaveBeenCalledTimes(1)
	})

	/** Every gas read the wizard starts, in order, each held until the test releases it: the amount
	 *  step reads on entry (index 0), confirm reads again (index 1), and so on. */
	function gatedReads(): Array<() => void> {
		const reads: Array<() => void> = []
		gasHeldRefresh.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					reads.push(resolve)
				}),
		)
		return reads
	}

	it("an account that switches while confirm reads the gas gate stands the review down; nothing signs", async () => {
		const reads = gatedReads()
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(w.findComponent({ name: "ReviewStep" }).props("busy")).toBe(true)
		selectedAccount.value = `0x${"20".repeat(32)}`
		await flushPromises()
		// The review was stood down under the read; the read returning must not resurrect it.
		expect(w.findComponent({ name: "ReviewStep" }).exists()).toBe(false)
		reads[1]?.()
		await flushPromises()
		expect(sendFn).not.toHaveBeenCalled()
		expect(w.findComponent({ name: "ReviewStep" }).exists()).toBe(false)
		expect(w.find(`[data-testid="${TESTIDS.sendReviewStale}"]`).exists()).toBe(true)
	})

	it("a review re-entered under another account while the read is pending is never signed by the earlier confirm", async () => {
		const reads = gatedReads()
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		selectedAccount.value = `0x${"20".repeat(32)}`
		await flushPromises()
		expect(w.findComponent({ name: "ReviewStep" }).exists()).toBe(false)

		// The same token and amount: the wizard's cached plan is the same object under the new review.
		w.findComponent({ name: "AmountStep" }).vm.$emit("next")
		await flushPromises()
		const again = w.findComponent({ name: "ReviewStep" })
		expect(again.exists()).toBe(true)
		expect(again.props("account")).toBe(selectedAccount.value)

		// The first confirm's read returns now: it must sign nothing.
		reads[1]?.()
		await flushPromises()
		expect(sendFn).not.toHaveBeenCalled()
		expect(w.findComponent({ name: "ReviewStep" }).exists()).toBe(true)

		// The new review signs only on its own confirm, after its own read.
		w.findComponent({ name: "ReviewStep" }).vm.$emit("confirm")
		await flushPromises()
		expect(sendFn).not.toHaveBeenCalled()
		reads.at(-1)?.()
		await flushPromises()
		expect(sendFn).toHaveBeenCalledTimes(1)
	})

	it("a backgrounded send that lands re-resolves the token, standing down a next review priced from it", async () => {
		let releaseSend = (): void => {}
		sendFn.mockImplementation(async () => {
			sessionLive.add("rec-1")
			records.value = [...records.value, sendRecord("rec-1")]
			await new Promise<void>((resolve) => {
				releaseSend = resolve
			})
			return "rec-1"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		w.findComponent({ name: "BridgeStepper" }).vm.$emit("background")
		await flushPromises()
		// The background reset re-resolved once (the token is still first-time at that point), and
		// the user prepares the next send from it while the first is still running.
		expect(selectFn).toHaveBeenCalledTimes(2)
		w.findComponent({ name: "WizardShell" }).vm.$emit("goto", 1)
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:amount", "2")
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:valid", true)
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("next")
		await flushPromises()
		expect(w.findComponent({ name: "ReviewStep" }).exists()).toBe(true)

		// The first send lands and may have registered the token: it is re-read, and the review
		// priced before that read is stood down rather than signed.
		releaseSend()
		records.value = records.value.map((r) => (r.id === "rec-1" ? { ...r, completedAt: 2_000 } : r))
		await flushPromises()
		expect(selectFn).toHaveBeenCalledTimes(3)
		expect(w.findComponent({ name: "ReviewStep" }).exists()).toBe(false)
		expect(w.find(`[data-testid="${TESTIDS.sendReviewStale}"]`).exists()).toBe(true)
	})

	it("tells the shell it is on a form step, until the stepper or the receipt takes over", async () => {
		let releaseSend = (): void => {}
		sendFn.mockImplementation(async () => {
			sessionLive.add("rec-1")
			records.value = [...records.value, sendRecord("rec-1")]
			await new Promise<void>((resolve) => {
				releaseSend = resolve
			})
			return "rec-1"
		})
		const form = useShell().bridgeForm
		const w = await wizard()
		expect(form.value).toBe(true)
		const review = await atReview(w)
		expect(form.value).toBe(true)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(true)
		expect(form.value).toBe(false)
		releaseSend()
		records.value = records.value.map((r) => (r.id === "rec-1" ? { ...r, completedAt: 2_000 } : r))
		await flushPromises()
		expect(w.findComponent({ name: "BridgeReceipt" }).exists()).toBe(true)
		expect(form.value).toBe(false)
		w.findComponent({ name: "BridgeReceipt" }).vm.$emit("new-bridge")
		await flushPromises()
		expect(form.value).toBe(true)
		w.unmount()
		expect(form.value).toBe(false)
	})

	it("New send re-resolves the token — a send that registered it must not be priced as first-time again", async () => {
		sendFn.mockImplementation(async () => {
			records.value = [...records.value, sendRecord("rec-1")]
			return "rec-1"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		records.value = records.value.map((r) => (r.id === "rec-1" ? { ...r, completedAt: 2_000 } : r))
		await flushPromises()
		expect(w.findComponent({ name: "BridgeReceipt" }).exists()).toBe(true)
		expect(selectFn).toHaveBeenCalledTimes(1)
		w.findComponent({ name: "BridgeReceipt" }).vm.$emit("new-bridge")
		await flushPromises()
		expect(selectFn).toHaveBeenCalledTimes(2)
		expect(selectFn).toHaveBeenLastCalledWith(candidate(), "l1-to-l2")
		expect(w.findComponent({ name: "TokenStep" }).exists()).toBe(true)
	})

	it("a token-only review says the fee is the gas already held; adding gas names one transaction's cost out of it", async () => {
		realCeilings()
		const w = await wizard()
		let review = await atReview(w)
		expect(review.props("estimate")).toEqual({
			takes: expect.any(String),
			networkFee: expect.stringMatching(/^≈ [\d.]+ FJ$/),
			networkFeeNote:
				"from the private gas you already hold — set aside in full from your gas at the fee contract: the claim's fee ceiling, not its exact cost",
			txCovered: null,
		})
		review.vm.$emit("back")
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:intent", "token+gas")
		// 0.02 token of slice at 135 FJ per token = 2.7 FJ, floor 2.619 FJ: the mocked ceilings (0.6 FJ)
		// leave 2.019 FJ, twenty transactions at the mocked 0.1 FJ each.
		setRoute({ kind: "route", route: ROUTE, quoteOut: 135n * 10n ** 18n })
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("next")
		await flushPromises()
		review = w.findComponent({ name: "ReviewStep" })
		// The default token is first-time, so the claim also registers it: one transaction plus the
		// registration budget — and the default send is private, so the line is the ceilings set aside.
		expect(review.props("estimate").networkFee).toBe("≈ 0.6 FJ")
		expect(review.props("estimate").networkFeeNote).toBe(
			"taken from the gas that arrives — a private claim sets aside its fee ceiling, not its exact cost",
		)
		expect(review.props("estimate").txCovered).toBe(20)
		expect(review.props("slippageBps")).toBe(300)
	})

	it("a registered token's fee is one transaction alone; a gas-only send counts what the quote divides into", async () => {
		realCeilings()
		nextResolved = (token) => resolvedToken(token, HUB_REGISTERED)
		const w = await wizard()
		let review = await atReview(w)
		review.vm.$emit("back")
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:intent", "token+gas")
		setRoute({ kind: "route", route: ROUTE, quoteOut: 135n * 10n ** 18n })
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("next")
		await flushPromises()
		review = w.findComponent({ name: "ReviewStep" })
		expect(review.props("estimate").networkFee).toBe("≈ 0.1 FJ")
		// 2.619 FJ guaranteed less the registered token's 0.1 FJ ceiling: 25 transactions, not the target.
		expect(review.props("estimate").txCovered).toBe(25)

		review.vm.$emit("back")
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:intent", "gas")
		setRoute({ kind: "route", route: ROUTE, quoteOut: 10n ** 18n })
		await flushPromises()
		expect(w.findComponent({ name: "AmountStep" }).props("gasSetAside")).toBe(4n * 10n ** 17n)
		w.findComponent({ name: "AmountStep" }).vm.$emit("next")
		await flushPromises()
		// 1 token (8 decimals) at 1 FJ per token = 1 FJ, guaranteed floor 0.97 FJ, less the private fuel
		// claim's 0.4 FJ ceiling; 0.1 FJ per transaction.
		expect(w.findComponent({ name: "ReviewStep" }).props("estimate").txCovered).toBe(5)

		// An expired fee quote leaves the ceiling unpriced: no count, never the whole floor.
		fuelClaimCeiling.mockReturnValue(null)
		try {
			w.findComponent({ name: "ReviewStep" }).vm.$emit("back")
			await flushPromises()
			expect(w.findComponent({ name: "AmountStep" }).props("gasSetAside")).toBeNull()
			w.findComponent({ name: "AmountStep" }).vm.$emit("next")
			await flushPromises()
			expect(w.findComponent({ name: "ReviewStep" }).props("estimate").txCovered).toBeNull()
		} finally {
			fuelClaimCeiling.mockReturnValue(4n * 10n ** 17n)
		}
	})

	it.each([
		{ isPrivate: true, registered: true, fee: "≈ 0.4 FJ" },
		{ isPrivate: true, registered: false, fee: "≈ 0.4 FJ" },
		{ isPrivate: false, registered: true, fee: "≈ 0.1 FJ" },
		{ isPrivate: false, registered: false, fee: "≈ 0.1 FJ" },
	])(
		"a gas-only send's fee is its own fuel claim's, never the token's registration or hub claim (private $isPrivate, registered $registered)",
		async ({ isPrivate, registered, fee }) => {
			realCeilings()
			if (registered) nextResolved = (token) => resolvedToken(token, HUB_REGISTERED)
			const w = await wizard()
			const amountStep = () => w.findComponent({ name: "AmountStep" })
			w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
			await flushPromises()
			amountStep().vm.$emit("update:intent", "gas")
			amountStep().vm.$emit("update:is-private", isPrivate)
			amountStep().vm.$emit("update:amount", "1")
			amountStep().vm.$emit("update:valid", true)
			setRoute({ kind: "route", route: ROUTE, quoteOut: 10n ** 18n })
			await flushPromises()
			amountStep().vm.$emit("next")
			await flushPromises()
			expect(w.findComponent({ name: "ReviewStep" }).props("estimate").networkFee).toBe(fee)
		},
	)

	it("a public gas leg's fee is taken from the gas that arrives; a public exit states no figure", async () => {
		nextResolved = (token) => resolvedToken(token, HUB_REGISTERED)
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("back")
		await flushPromises()
		const amountStep = () => w.findComponent({ name: "AmountStep" })
		amountStep().vm.$emit("update:intent", "token+gas")
		amountStep().vm.$emit("update:is-private", false)
		setRoute({ kind: "route", route: ROUTE, quoteOut: 135n * 10n ** 18n })
		await flushPromises()
		amountStep().vm.$emit("next")
		await flushPromises()
		expect(w.findComponent({ name: "ReviewStep" }).props("estimate")).toMatchObject({
			networkFee: expect.stringMatching(/^≈ [\d.]+ FJ$/),
			networkFeeNote: "taken from the gas that arrives",
		})

		w.findComponent({ name: "ReviewStep" }).vm.$emit("back")
		await flushPromises()
		w.findComponent({ name: "WizardShell" }).vm.$emit("update:direction", "l2-to-l1")
		await flushPromises()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		amountStep().vm.$emit("update:is-private", false)
		amountStep().vm.$emit("update:amount", "1")
		amountStep().vm.$emit("update:valid", true)
		await flushPromises()
		amountStep().vm.$emit("next")
		await flushPromises()
		expect(w.findComponent({ name: "ReviewStep" }).props("estimate")).toMatchObject({
			networkFee: null,
			networkFeeNote: "your Aztec wallet's own fee, then Ethereum gas to finish",
		})
	})

	it("a private slice whose guaranteed floor cannot cover the ceilings a private claim sets aside is refused before any signature", async () => {
		// 0.02 token at 1 FJ per token = 0.02 FJ, floor 0.0194 FJ, under the mocked 0.6 FJ of ceilings.
		realCeilings()
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("back")
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:intent", "token+gas")
		setRoute({ kind: "route", route: ROUTE, quoteOut: 10n ** 18n })
		await flushPromises()
		const amount = w.findComponent({ name: "AmountStep" })
		expect(amount.props("gas")).toBeNull()
		expect(amount.props("gasError")).toMatch(/too small to cover the fees a private claim sets aside/)
		// A public send of the same slice carries no ceilings: it sizes normally.
		amount.vm.$emit("update:is-private", false)
		await flushPromises()
		expect(w.findComponent({ name: "AmountStep" }).props("gasError")).toBeNull()
		expect(w.findComponent({ name: "AmountStep" }).props("gas")).not.toBeNull()
	})

	it("a private slice's confirm re-reads the fees and stands the review down, saying why, when they cannot be read", async () => {
		const w = await wizard()
		let review = await atReview(w)
		review.vm.$emit("back")
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:intent", "token+gas")
		setRoute({ kind: "route", route: ROUTE, quoteOut: 10n ** 18n })
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("next")
		await flushPromises()
		review = w.findComponent({ name: "ReviewStep" })
		expect(review.exists()).toBe(true)
		primeFn.mockResolvedValueOnce(false)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(w.findComponent({ name: "ReviewStep" }).exists()).toBe(false)
		expect(w.find('[data-testid="tl-send-review-stale"]').text()).toMatch(/network fees could not be re-read/)
		expect(sendFn).not.toHaveBeenCalled()
	})

	it("the zero answer is `absent` — the state that means this send creates the clone", async () => {
		const w = await wizard()
		const review = await atReview(w)
		expect(review.props("portalVerified")).toBe("absent")
		expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "portalOf", args: [ERC20] }))
	})

	it("the derived address is `verified`, whatever case the node answers in", async () => {
		readContract.mockResolvedValue(predictPortal(FACTORY, IMPLEMENTATION, ERC20).toUpperCase())
		const w = await wizard()
		const review = await atReview(w)
		expect(review.props("portalVerified")).toBe("verified")
	})

	it("any OTHER clone is `mismatch`, never mistaken for a first-time send", async () => {
		readContract.mockResolvedValue(IMPLEMENTATION)
		const w = await wizard()
		const review = await atReview(w)
		expect(review.props("portalVerified")).toBe("mismatch")
	})

	it("a read that throws leaves the state `unknown` and reports the Error alone", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {})
		readContract.mockRejectedValue(new Error("node unreachable"))
		const w = await wizard()
		const review = await atReview(w)
		expect(review.props("portalVerified")).toBe("unknown")
		expect(logged).toHaveBeenCalledWith(expect.any(Error))
		logged.mockRestore()
	})

	it("confirming a deposit sends the plan and the stepper adopts the record the run wrote", async () => {
		sendFn.mockImplementation(async () => {
			records.value = [...records.value, sendRecord("rec-1")]
			return "rec-1"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(sendFn).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "l1-to-l2", intent: "token", amount: 10n ** 8n, isPrivate: true }),
		)
		expect(claimForeground).toHaveBeenCalledWith("rec-1")
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(true)
	})

	it("a record another tab wrote mid-send is never adopted; the run's own id is", async () => {
		let releaseSend = (): void => {}
		sendFn.mockImplementation(async () => {
			await new Promise<void>((resolve) => {
				releaseSend = resolve
			})
			sessionLive.add("mine")
			records.value = [...records.value, sendRecord("mine")]
			return "mine"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()

		// A foreign record lands while this send is still signing: send-shaped, brand new, not ours.
		records.value = [...records.value, sendRecord("foreign")]
		await flushPromises()
		expect(claimForeground).not.toHaveBeenCalled()
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(false)

		releaseSend()
		await flushPromises()
		expect(claimForeground).toHaveBeenCalledTimes(1)
		expect(claimForeground).toHaveBeenCalledWith("mine")
	})

	it("the stepper adopts the run's own record as soon as the engine writes it", async () => {
		let releaseSend = (): void => {}
		sendFn.mockImplementation(async () => {
			sessionLive.add("mine")
			records.value = [...records.value, sendRecord("mine")]
			await new Promise<void>((resolve) => {
				releaseSend = resolve
			})
			return "mine"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(claimForeground).toHaveBeenCalledWith("mine")
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(true)
		releaseSend()
		await flushPromises()
	})

	it("a route answer for another token prices nothing and leaves the review alone", async () => {
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:amount", "1")
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:intent", "token+gas")
		await flushPromises()
		setRoute({ kind: "route", route: ROUTE, quoteOut: 10n ** 18n }, L1_ADDRESS)
		await flushPromises()
		expect(w.findComponent({ name: "AmountStep" }).props("gas")).toBeNull()
		expect(w.findComponent({ name: "AmountStep" }).props("routeKind")).toBeNull()
	})

	it("a change under the review stands it down, says why, and sends nothing", async () => {
		const w = await wizard()
		const review = await atReview(w)
		const reviewed = review.props("plan")

		// A quote lands after the review rendered: the gas leg moves under the frozen plan.
		setRoute({ kind: "route", route: ROUTE, quoteOut: 10n ** 18n })
		w.findComponent({ name: "WizardShell" }).vm.$emit("goto", 1)
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:intent", "token+gas")
		await flushPromises()
		w.findComponent({ name: "AmountStep" }).vm.$emit("next")
		await flushPromises()

		const fresh = w.findComponent({ name: "ReviewStep" })
		expect(fresh.props("plan")).not.toBe(reviewed)
		expect(fresh.props("plan").gas).toBeDefined()

		// Now move the plan while the review is up.
		setRoute(null)
		await flushPromises()
		expect(w.findComponent({ name: "ReviewStep" }).exists()).toBe(false)
		expect(w.find('[data-testid="tl-send-review-stale"]').exists()).toBe(true)
		expect(sendFn).not.toHaveBeenCalled()
	})

	it("a deposit whose grant never landed reports declined and leaves the wizard up", async () => {
		granted.value = []
		sendFn.mockResolvedValue("")
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(w.findComponent({ name: "ReviewStep" }).props("grant")).toBe("declined")
		expect(w.findComponent({ name: "BridgeStepper" }).exists()).toBe(false)
	})

	it("an exit asks for the grant at SELECTION and plans a TOKEN-only release to the L1 account", async () => {
		granted.value = []
		nextResolved = (token) => resolvedToken(token, HUB_REGISTERED)
		const w = await wizard()
		w.findComponent({ name: "WizardShell" }).vm.$emit("update:direction", "l2-to-l1")
		await flushPromises()
		const review = await atReview(w)
		// Picking the row raised the grant, before any amount was typed.
		expect(ensureGranted).toHaveBeenCalledTimes(1)
		expect(review.props("plan")).toEqual(expect.objectContaining({ direction: "l2-to-l1", recipientL1: L1_ADDRESS, amount: 10n ** 8n }))
		expect(review.props("plan").gas).toBeUndefined()
		review.vm.$emit("confirm")
		await flushPromises()
		expect(exitFn).toHaveBeenCalledTimes(1)
	})

	it("a private exit is blocked without private gas and moves nothing; a public exit with the same balances goes through", async () => {
		realCeilings()
		ownGasCeilingFor.mockImplementation(() => 10n ** 16n)
		gasHeld.value = 0n
		gasHeldPublic.value = 10n ** 21n
		gasHeldSelfPay.value = true
		nextResolved = (token) => resolvedToken(token, HUB_REGISTERED)
		const w = await wizard()
		w.findComponent({ name: "WizardShell" }).vm.$emit("update:direction", "l2-to-l1")
		await flushPromises()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		const amountStep = () => w.findComponent({ name: "AmountStep" })
		expect(amountStep().props("isPrivate")).toBe(true)
		expect(amountStep().props("blockedReason")).toContain("withdrawal pays its fee only from private gas")
		// Enough credit releases it, and the review prices the private gas set aside.
		gasHeld.value = 10n ** 17n
		await flushPromises()
		expect(amountStep().props("blockedReason")).toBeNull()
		amountStep().vm.$emit("update:amount", "1")
		amountStep().vm.$emit("update:valid", true)
		await flushPromises()
		amountStep().vm.$emit("next")
		await flushPromises()
		const review = w.findComponent({ name: "ReviewStep" })
		expect(review.props("estimate").networkFee).toMatch(/^≈ [\d.]+ FJ$/)
		expect(review.props("estimate").networkFeeNote).toMatch(/^from the private gas you already hold, then Ethereum gas to finish — /)
		// Fees up by more than a tenth under the review, credit ample: the confirm signs nothing — the
		// fee contract would keep the whole new ceiling, which nobody approved.
		gasHeld.value = 10n ** 21n
		ownGasCeilingFor.mockImplementation(() => 10n ** 16n + 10n ** 15n + 1n)
		review.vm.$emit("confirm")
		await flushPromises()
		expect(exitFn).not.toHaveBeenCalled()
		expect(w.find(`[data-testid="${TESTIDS.sendReviewStale}"]`).text()).toContain("fees moved")
		// Back at the review with the price steady: the exit is sent with the approved bound (the
		// shown figure plus the tenth the confirm tolerates).
		ownGasCeilingFor.mockImplementation(() => 10n ** 16n)
		const step = w.findComponent({ name: "AmountStep" })
		step.vm.$emit("update:amount", "1")
		step.vm.$emit("update:valid", true)
		await flushPromises()
		step.vm.$emit("next")
		await flushPromises()
		const again = w.findComponent({ name: "ReviewStep" })
		again.vm.$emit("confirm")
		await flushPromises()
		expect(exitFn).toHaveBeenCalledTimes(1)
		expect(exitFn.mock.calls[0]?.[1]).toBe(10n ** 16n + 10n ** 15n)
		// The exit stub refuses, so the review stays up. The credit gone by the next confirm: the
		// re-read stands the review down and signs nothing.
		exitFn.mockClear()
		gasHeld.value = 0n
		again.vm.$emit("confirm")
		await flushPromises()
		expect(exitFn).not.toHaveBeenCalled()
		expect(w.find(`[data-testid="${TESTIDS.sendReviewStale}"]`).text()).toContain("only from private gas")
		// A public exit needs no private gas at all.
		w.findComponent({ name: "AmountStep" }).vm.$emit("update:isPrivate", false)
		await flushPromises()
		expect(w.findComponent({ name: "AmountStep" }).props("blockedReason")).toBeNull()
	})

	it("an unpriced private exit's fee note says how the fee is paid", async () => {
		ownGasCeilingFor.mockImplementation(() => null)
		nextResolved = (token) => resolvedToken(token, HUB_REGISTERED)
		const w = await wizard()
		w.findComponent({ name: "WizardShell" }).vm.$emit("update:direction", "l2-to-l1")
		await flushPromises()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		const amountStep = () => w.findComponent({ name: "AmountStep" })
		amountStep().vm.$emit("update:amount", "1")
		amountStep().vm.$emit("update:valid", true)
		await flushPromises()
		amountStep().vm.$emit("next")
		await flushPromises()
		expect(w.findComponent({ name: "ReviewStep" }).props("estimate")).toMatchObject({
			networkFee: null,
			networkFeeNote: expect.stringMatching(
				/^paid from the private gas you already hold, then Ethereum gas to finish — set aside in full/,
			),
		})
	})

	it("a grant outcome for a superseded selection is discarded", async () => {
		granted.value = []
		grantOutcome = "stale"
		nextResolved = (token) => resolvedToken(token, HUB_REGISTERED)
		const w = await wizard()
		w.findComponent({ name: "WizardShell" }).vm.$emit("update:direction", "l2-to-l1")
		await flushPromises()
		const review = await atReview(w)
		expect(review.props("grant")).toBe("pending")
	})

	it("switching to an exit with a token the hub has not bound asks the wallet for nothing", async () => {
		granted.value = []
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		w.findComponent({ name: "WizardShell" }).vm.$emit("update:direction", "l2-to-l1")
		await flushPromises()
		expect(selectFn).toHaveBeenLastCalledWith(expect.objectContaining({ address: ERC20 }), "l2-to-l1")
		expect(ensureGranted).not.toHaveBeenCalled()
	})

	it("an exit pick overtaken by the next one while it is read raises no grant; only the latest pick asks", async () => {
		const OTHER = "0x5555555555555555555555555555555555555555"
		granted.value = []
		grantOutcome = "declined"
		nextResolved = (token) => resolvedToken(token, HUB_REGISTERED)
		const w = await wizard()
		w.findComponent({ name: "WizardShell" }).vm.$emit("update:direction", "l2-to-l1")
		await flushPromises()
		let landFirst: () => void = () => {}
		selectFn.mockImplementationOnce(async (token: SelectableToken) => {
			const mine = ++epoch
			await new Promise<void>((resolve) => {
				landFirst = resolve
			})
			// The real selection drops a superseded read: only the latest pick may land.
			if (mine === epoch) selected.value = nextResolved(token)
		})
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		w.findComponent({ name: "WizardShell" }).vm.$emit("goto", 0)
		await flushPromises()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate(OTHER))
		await flushPromises()
		expect(ensureGranted).toHaveBeenCalledTimes(1)
		expect(ensureGranted).toHaveBeenLastCalledWith(expect.objectContaining({ address: OTHER }), expect.any(Function))
		landFirst()
		await flushPromises()
		expect(ensureGranted, "the overtaken read asks nothing, for its token or the one now selected").toHaveBeenCalledTimes(1)
	})

	it.each([
		["portal-only", { kind: "portal-only", registration: REGISTRATION } as const],
		["first-time", { kind: "first-time" } as const],
	])("an exit on a %s token builds no plan: the hub holds no binding it could burn", async (_label, state) => {
		nextResolved = (token) => resolvedToken(token, state)
		const w = await wizard()
		w.findComponent({ name: "WizardShell" }).vm.$emit("update:direction", "l2-to-l1")
		await flushPromises()
		const review = await atReview(w)
		// No plan means no review to confirm, so no burn authwit can be raised against it — and the
		// amount step is still the one on screen, saying why.
		expect(review.exists()).toBe(false)
		expect(w.findComponent({ name: "WizardShell" }).props("completed")).toBe(1)
		expect(w.findComponent({ name: "AmountStep" }).props("blockedReason")).toBe(EXIT_TOKEN_NOT_REGISTERED)
	})

	it("reads no Ethereum balance on the wrong chain, and re-reads both kinds on the switch back", async () => {
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		expect(rowOwner()).toBe(L1_ADDRESS)
		l1WrongChain.value = true
		await flushPromises()
		expect([rowOwner(), selectionOwner()]).toEqual([undefined, undefined])
		refreshBalances.mockClear()
		l1WrongChain.value = false
		await flushPromises()
		expect([rowOwner(), selectionOwner()]).toEqual([L1_ADDRESS, L1_ADDRESS])
		expect(refreshBalances).toHaveBeenCalledOnce()
	})

	it("switching direction returns to the token step and re-resolves the same token", async () => {
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("select", candidate())
		await flushPromises()
		await flushPromises()
		w.findComponent({ name: "WizardShell" }).vm.$emit("update:direction", "l2-to-l1")
		await flushPromises()
		expect(w.findComponent({ name: "TokenStep" }).exists()).toBe(true)
		expect(selectFn).toHaveBeenLastCalledWith(expect.objectContaining({ address: ERC20 }), "l2-to-l1")
	})

	it("a completed record becomes a receipt carrying the record's own token and the review's promise", async () => {
		sendFn.mockImplementation(async () => {
			records.value = [...records.value, sendRecord("rec-2", { sender: L1_SENDER })]
			return "rec-2"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		records.value = [{ ...records.value[0], completedAt: 9_000 }]
		await flushPromises()
		const snapshot = w.findComponent({ name: "BridgeReceipt" }).props("snapshot")
		expect(snapshot.token).toEqual({
			erc20: ERC20,
			portal: FACTORY,
			l2Token: L2_TOKEN,
			nameWord: WORD,
			symbolWord: WORD,
			decimals: 8,
			displaySymbol: "WBTC",
		})
		expect(snapshot.reviewedAmount).toBe("100000000")
		expect(snapshot.sender).toBe(L1_SENDER)
		expect(snapshot.recipient).toBe(AZTEC_ACCOUNT)
		expect(snapshot.recipientAlias).toBe("main")
		expect(snapshot.addTokenLabel).toBe("Add WBTC to wallet")
		expect(isRegisteredFn).toHaveBeenCalledOnce()
		expect(releaseForeground).toHaveBeenCalledWith("rec-2")
	})

	it("a receipt never offers to add a token the wallet already lists", async () => {
		isRegisteredFn.mockResolvedValue(true)
		sendFn.mockImplementation(async () => {
			records.value = [...records.value, sendRecord("rec-2")]
			return "rec-2"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		records.value = [{ ...records.value[0], completedAt: 9_000 }]
		await flushPromises()
		const receipt = w.findComponent({ name: "BridgeReceipt" })
		expect(receipt.exists()).toBe(true)
		expect(receipt.props("snapshot").addTokenLabel).toBeUndefined()
	})

	it("a replaced wallet's late answer does not decide the add-token offer", async () => {
		let answerOld: (held: boolean) => void = () => undefined
		isRegisteredFn.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answerOld = resolve)))
		isRegisteredFn.mockResolvedValue(true)
		sendFn.mockImplementation(async () => {
			records.value = [...records.value, sendRecord("rec-2")]
			return "rec-2"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		records.value = [{ ...records.value[0], completedAt: 9_000 }]
		await flushPromises()
		aztecWallet.value = {}
		await flushPromises()
		answerOld(false)
		await flushPromises()
		expect(isRegisteredFn).toHaveBeenCalledTimes(2)
		expect(w.findComponent({ name: "BridgeReceipt" }).props("snapshot").addTokenLabel).toBeUndefined()
	})

	it("a record whose decimals change before it completes cannot rescale what the review said", async () => {
		nextResolved = (token) => resolvedToken({ ...token, decimals: 6 })
		const block = { erc20: ERC20, portal: FACTORY, l2Token: L2_TOKEN, nameWord: WORD, symbolWord: WORD, displaySymbol: "WBTC" }
		sendFn.mockImplementation(async () => {
			records.value = [...records.value, sendRecord("rec-2", { amount: "1000000", token: { ...block, decimals: 6 } })]
			return "rec-2"
		})
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("confirm")
		await flushPromises()
		records.value = [{ ...records.value[0], token: { ...block, decimals: 18 }, completedAt: 9_000 }]
		await flushPromises()
		const snapshot = w.findComponent({ name: "BridgeReceipt" }).props("snapshot")
		const receipt = mount(BridgeReceipt, { props: { snapshot } })
		expect(receipt.find(`[data-testid="${TESTIDS.sendReceiptReviewSaid}"]`).text()).toBe("1.00 · you got 0.000000000001")
	})

	it("a gas-only receipt's hero is the Fee Juice the deposit reported, never the token it paid", async () => {
		const fuel = {
			amount: "100000000",
			secret: "0x1",
			secretHashHex: "0x2",
			minOutput: "970000000000000000",
			received: "987000000000000000",
		}
		sendFn.mockImplementation(async () => {
			records.value = [...records.value, sendRecord("rec-gas", { intent: "gas", token: undefined, isPrivate: false, fuel })]
			return "rec-gas"
		})
		nextResolved = (token) => resolvedToken(token, HUB_REGISTERED)
		const w = await wizard()
		const review = await atReview(w)
		review.vm.$emit("back")
		await flushPromises()
		const amount = w.findComponent({ name: "AmountStep" })
		amount.vm.$emit("update:isPrivate", false)
		amount.vm.$emit("update:intent", "gas")
		setRoute({ kind: "route", route: ROUTE, quoteOut: 10n ** 18n })
		await flushPromises()
		amount.vm.$emit("next")
		await flushPromises()
		w.findComponent({ name: "ReviewStep" }).vm.$emit("confirm")
		await flushPromises()
		records.value = [{ ...records.value[0], completedAt: 9_000 }]
		await flushPromises()
		const snapshot = w.findComponent({ name: "BridgeReceipt" }).props("snapshot")
		expect(snapshot.amount).toBe(fuel.received)
		expect(snapshot.assetKind).toBe("fee-juice")
		expect(snapshot.atLeast).toBeUndefined()
		expect(snapshot.gasQuote).toBe((10n ** 18n).toString())
		expect(snapshot.reviewedAmount).toBeUndefined()
	})

	it("an address the catalog refuses surfaces on the token step and selects nothing", async () => {
		addPasted.mockImplementation(() => {
			throw new Error("The zero address is not a token.")
		})
		const w = await wizard()
		w.findComponent({ name: "TokenStep" }).vm.$emit("add", "0x0")
		await flushPromises()
		expect(w.findComponent({ name: "TokenStep" }).props("addError")).toBe("The zero address is not a token.")
		expect(selectFn).not.toHaveBeenCalled()
	})

	it("disposes every composable on unmount", async () => {
		const w = await wizard()
		w.unmount()
		for (const dispose of [exitDispose, sendDispose, gasShareDispose, routeDispose, grantDispose, selectDispose, catalogDispose]) {
			expect(dispose).toHaveBeenCalledTimes(1)
		}
	})
})
