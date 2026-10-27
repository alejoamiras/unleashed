/**
 * @vitest-environment node
 *
 * Node, not jsdom: the private legs derive real claim material through bb.js poseidon, which does
 * not run under jsdom.
 */
import type { JournalTokenBlock, Registration, SendResult } from "@unleashed/bridge-core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GasLegPlan, ResolvedToken, SendPlan } from "@/lib/send-model"

const RECIPIENT = "0x1018808f2c17794badb361c02c945582b8198b495a7e8d01154f7eeb7d719c0d"
const L1_ACCOUNT = "0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d"

/** The recovery seal is real crypto over a DETERMINISTIC fake signature: the seal-trust cache and
 *  the envelope both need a store, and node has none. */
const memStore = new Map<string, string>()
globalThis.localStorage = {
	getItem: (k: string) => memStore.get(k) ?? null,
	setItem: (k: string, v: string) => void memStore.set(k, v),
	removeItem: (k: string) => void memStore.delete(k),
	clear: () => memStore.clear(),
	key: (i: number) => [...memStore.keys()][i] ?? null,
	get length() {
		return memStore.size
	},
} as Storage

const SEAL_SIG = `0x${"a".repeat(130)}`

const h = vi.hoisted(() => ({
	requestHubToken: vi.fn(),
	ensureGranted: vi.fn(async (_token: unknown, _epoch: () => number) => "granted" as "granted" | "declined" | "stale"),
	isGranted: vi.fn((_l2Token: string) => true),
	disposeGrant: vi.fn(),
	status: { value: "connected" as string },
	contractsReady: { value: true },
	error: { value: null as { message: string } | null },
	selectedAccount: { value: "0x1018808f2c17794badb361c02c945582b8198b495a7e8d01154f7eeb7d719c0d" as string | null },
	wallet: { value: {} as unknown },
	address: { value: "0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d" as string | null },
	signTypedData: vi.fn(async () => "0xsig"),
	/** The swap bytes the slice is quoted to at send time; a throw is a venue that moved under the reviewed floor. */
	sliceSwapData: vi.fn(async (_pub: unknown, _token: string, _gas: unknown) => "0x5eed" as `0x${string}`),
	signMessage: vi.fn(async () => `0x${"a".repeat(130)}`),
	writeContract: vi.fn(async () => "0xl1tx"),
	chainId: { value: 31337 } as { value: number },
	ensurePermit2Approval: vi.fn(async (_permit2: string, _needed: bigint, _recordId: string) => {}),
	readRegistration: vi.fn(async () => undefined as Registration | undefined),
	sealPrivateRecord: vi.fn(async (_ctx: Record<string, unknown>) => {}),
	/** Opt-in per case: run the REAL seal (and its real envelope) after the spy records the call. */
	realSeal: { on: false },
	resolveHubClaimSendOpts: vi.fn(async () => ({ kind: "opts", opts: {} }) as Record<string, unknown>),
	/** What the hub answers for the token's binding; undefined = it does not know the token yet. */
	hubToken: { value: undefined as string | undefined },
	sendStandaloneFjClaim: vi.fn(async (_aztec: unknown, _to: unknown, _fuel: unknown, _id: string) => {}),
	runSend: vi.fn(),
	rebuiltL2Token: { value: "" as string },
}))

vi.mock("@/contracts/bridge-generation", async () => {
	const { readFileSync } = await import("node:fs")
	const { fileURLToPath } = await import("node:url")
	const core = await vi.importActual<typeof import("@unleashed/bridge-core")>("@unleashed/bridge-core")
	const path = fileURLToPath(new URL("../../../../packages/bridge-core/fixtures/sandbox-manifest.json", import.meta.url))
	const manifest = core.parseManifestV2(JSON.parse(readFileSync(path, "utf8")))
	const bridge = manifest.bridge as NonNullable<typeof manifest.bridge>
	h.rebuiltL2Token.value = bridge.tokens[0].l2Token
	return {
		MANIFEST: manifest,
		GENERATION: bridge,
		MANIFEST_CHAIN: { l1ChainId: manifest.l1ChainId, walletChainId: manifest.walletChainId },
		IS_PLACEHOLDER: false,
		MANIFEST_TOKENS: bridge.tokens,
		SEND_GENERATION: core.sendGenerationOf(manifest, bridge),
		HUB: { toString: () => bridge.l2.hub.address },
		TOKEN_CLASS_ID: bridge.l2.tokenClassId,
		FUEL_PORTAL: manifest.feeJuice.portal,
		FUEL_ASSET: manifest.feeJuice.asset,
		FUEL_MIN_FJ: BigInt(manifest.feeJuice.minFj),
		rebuildHubTokenInstance: async () => ({ address: { toString: () => h.rebuiltL2Token.value } }),
	}
})

vi.mock("@/composables/useWalletConnection", async (importOriginal) => {
	// The real readiness gate + its copy, over the h-backed session stub — so the send path is
	// tested against the actual refusal strings, not a reimplementation.
	const actual = await importOriginal<typeof import("./useWalletConnection")>()
	return {
		requestHubToken: h.requestHubToken,
		requestedHubTokens: () => [],
		retainPinnedHubTokens: () => {},
		useWalletConnection: () => ({
			status: h.status,
			contractsReady: h.contractsReady,
			error: h.error,
			selectedAccount: h.selectedAccount,
			wallet: h.wallet,
		}),
		contractsReadinessRefusal: actual.contractsReadinessRefusal,
		SETUP_PENDING: actual.SETUP_PENDING,
		__resetWalletConnectionForTests: () => {},
	}
})

vi.mock("./useFuelQuote", () => ({ sliceSwapData: h.sliceSwapData }))
// No pinned Ethereum reader by default, so every Ethereum read goes through the mocked wallet below.
vi.mock("./useEthereumReader", async (orig) => ({
	...(await orig<typeof import("./useEthereumReader")>()),
	readClientFor: () => undefined,
}))

vi.mock("@/composables/useTokenGrant", () => ({
	useTokenGrant: () => ({ isGranted: h.isGranted, ensureGranted: h.ensureGranted, dispose: h.disposeGrant }),
}))

vi.mock("@/composables/useL1Wallet", async () => {
	// A REAL ref: the boot's pin attestation watches this source and must re-run when a wallet arrives.
	const { ref } = await import("vue")
	h.address = ref("0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d" as string | null)
	// The live chain is ONE knob: the wallet's `chainId` ref and the public client's `getChainId`
	// answer from it, so a wrong-chain case sees a consistent wallet.
	h.chainId = ref<number>(31337)
	const { computed } = await import("vue")
	return {
		useL1Wallet: () => ({
			address: h.address,
			chainId: h.chainId,
			wrongChain: computed(() => h.address.value !== null && h.chainId.value !== 31337),
			isConnected: { value: true },
			publicClient: {
				getBlock: async () => ({ timestamp: 1_700_000_000n }),
				readContract: async () => 0n,
				getChainId: async () => h.chainId.value,
			},
			ensureWalletClient: () => ({
				signTypedData: h.signTypedData,
				signMessage: h.signMessage,
				writeContract: h.writeContract,
				chain: { id: 31337 },
			}),
		}),
	}
})

// Only the boundaries that would talk to a chain or a live wallet; the seal, its envelope and the
// stop-interaction shape stay REAL - a mocked seal is exactly what hid the missing fuel material.
vi.mock("@/composables/deposit-flow", async (orig) => {
	const actual = await orig<typeof import("@/composables/deposit-flow")>()
	return {
		...actual,
		buildFeeJuiceClaimDep: async () => ({ simulate: async () => ({}), send: async () => ({ txHash: "0xfjclaim" }) }),
		ensurePermit2Approval: h.ensurePermit2Approval,
		recoverDepositLeg: async () => "recovered" as const,
		resolveHubClaimSendOpts: h.resolveHubClaimSendOpts,
		sendStandaloneFjClaim: h.sendStandaloneFjClaim,
		sealPrivateRecord: async (ctx: Parameters<typeof actual.sealPrivateRecord>[0]) => {
			await h.sealPrivateRecord(ctx as unknown as Record<string, unknown>)
			if (h.realSeal.on) await actual.sealPrivateRecord(ctx)
		},
	}
})

vi.mock("@unleashed/bridge-core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@unleashed/bridge-core")>()),
	runSend: h.runSend,
	claimViaHub: async () => ({ path: "claim", claimTxHash: "0xhubclaim" }),
	hubAt: () => ({ methods: {} }),
	hubTokenFor: async () => h.hubToken.value,
	readRegistration: h.readRegistration,
}))

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
	type DepositJournalRecord,
	type SendDepositRecord,
	PRIVATE_FPC_ADDRESS,
	deriveBridgeSecret,
	deriveTokenClaimSecret,
	openDepositEnvelope,
	predictPortal,
	recoveryKeyFromSignature,
	validateAnyBackupRecord,
} from "@unleashed/bridge-core"
import { FUEL_PORTAL, HUB, SEND_GENERATION } from "@/contracts/bridge-generation"
import { __resetPromptQueueForTests, enqueuePrompt, PROMPT_WAIT_MS, PROMPTS_STALLED } from "@/lib/prompt-queue"
import {
	__resetJournalForTests,
	addRecord,
	connectJournalDeps,
	runDepositClaim,
	setRecordStep,
	updateRecord,
	useBridgeJournal,
} from "./useBridgeJournal"
import { __resetSendDepsForTests, useSend, validateTokenBlock } from "./useSend"
import { useOpsInFlight } from "./useOpsInFlight"

/** What the mocked hub derives before a case points it somewhere else. */
const MANIFEST_L2_TOKEN = h.rebuiltL2Token.value

const ERC20 = "0x70e0ba845a1a0f2da3359c97e0285013525ffc49"
// The clone the factory would CREATE2 for this ERC-20: the journal engine refuses to resume a
// record whose portal isn't the one this generation derives, so the fixture has to be the real one.
const GEN = SEND_GENERATION as NonNullable<typeof SEND_GENERATION>
const PORTAL = predictPortal(GEN.factory, GEN.implementation, ERC20)

const token: ResolvedToken = {
	chainId: 31337,
	address: ERC20,
	symbol: "USDC",
	name: "Test USDC",
	decimals: 6,
	source: "manifest",
	logoKey: `31337:${ERC20}`,
	state: { kind: "first-time" },
	portal: PORTAL,
	words: {
		nameWord: `0x${"1".repeat(64)}`,
		symbolWord: `0x${"2".repeat(64)}`,
	},
	l2Token: `0x${"c".repeat(64)}`,
}

const gasLeg: GasLegPlan = {
	fuelAmount: 1_000_000n,
	fuelFj: 5n,
	quote: 5n,
	minFuelOutput: 4n,
	venue: { provider: "testnetSwapper" },
	capped: null,
}

const plan = (over: Partial<SendPlan> = {}): SendPlan => ({
	direction: "l1-to-l2",
	intent: "token",
	token,
	amount: 100_000_000n,
	isPrivate: false,
	...over,
})

/** The read-back the router's receipt produces; `l2Token` defaults to the wizard's prediction. */
function readBack(over: Partial<SendResult["token"]> = {}) {
	return {
		erc20: ERC20,
		portal: PORTAL,
		l2Token: token.l2Token,
		nameWord: token.words.nameWord,
		symbolWord: token.words.symbolWord,
		decimals: 6,
		displaySymbol: "USDC",
		registerKey: `0x${"4".repeat(64)}`,
		registerIndex: "3",
		...over,
	}
}

/** A real field element: the hub claim parses the public claim value, so it can't be a word. */
const PUBLIC_SECRET = `0x${"07".repeat(32)}`

interface FakeParams {
	isPrivate: boolean
	claimSalt?: Fr
	intent: string
	aztecRecipient: string
	gas?: { fuelSecret?: Fr }
}

interface FakeRecovery {
	onSecrets?: (s: Record<string, unknown>) => void
	onSent?: (h: string) => void
	onConfirmed?: (r: unknown) => void
}

/** Mirrors the real derivation: a private leg's committed hash is over the recipient-bound secret,
 *  so the id the app pre-computed and the one the witness carries must agree. */
async function fakeSecrets(p: FakeParams) {
	const isToken = p.intent !== "gas"
	const salt = p.claimSalt
	const tokenHash = salt
		? (await computeSecretHash(deriveTokenClaimSecret(salt, AztecAddress.fromStringUnsafe(p.aztecRecipient)))).toString()
		: "0xtokenhash"
	// A private gas leg carries an INJECTED secret (the FPC re-derives it); a public one is random
	// inside runSend. Mirrored here, or the id the app precomputed and the witness's would disagree.
	const fuelSecret = p.gas?.fuelSecret
	return {
		tokenClaimValueHex: isToken ? (salt?.toString() ?? PUBLIC_SECRET) : undefined,
		tokenSecretHashHex: isToken ? tokenHash : undefined,
		fuelSecretHex: p.gas ? (fuelSecret?.toString() ?? "0xfuelsecret") : undefined,
		fuelSecretHashHex: p.gas ? (fuelSecret ? (await computeSecretHash(fuelSecret)).toString() : "0xfuelhash") : undefined,
		isPrivate: p.isPrivate,
	}
}

function fakeResult(p: FakeParams, token?: ReturnType<typeof readBack>) {
	const isToken = p.intent !== "gas"
	return {
		txHash: "0xl1tx",
		tokenLeafIndex: isToken ? 7n : undefined,
		tokenMessageHashHex: isToken ? "0xtokenkey" : undefined,
		fuelLeafIndex: p.gas ? 8n : undefined,
		fuelMessageHashHex: p.gas ? "0xfuelkey" : undefined,
		fuelReceived: p.gas ? 5n : undefined,
		token: isToken ? (token ?? readBack()) : undefined,
	}
}

/** A runSend fake that drives the recovery hooks in the real order. */
function fakeRunSend(opts: { token?: ReturnType<typeof readBack>; throwAfterSend?: boolean } = {}) {
	return async (_l1: unknown, _gen: unknown, p: FakeParams, onStage?: (s: string) => void, recovery?: FakeRecovery) => {
		recovery?.onSecrets?.(await fakeSecrets(p))
		onStage?.("signing")
		recovery?.onSent?.("0xl1tx")
		if (opts.throwAfterSend) throw new Error("bridge() REVERTED (0xl1tx) — no funds moved; inspect the tx and retry")
		const res = fakeResult(p, opts.token)
		recovery?.onConfirmed?.(res)
		onStage?.("done")
		return res
	}
}

const recordOf = (id: string) => useBridgeJournal().records.value.find((r) => r.id === id) as SendDepositRecord | undefined

/** A stored send record naming one token block - what the boot attests before pinning anything. */
const journalled = (id: string, block: ReturnType<typeof readBack>): SendDepositRecord =>
	({
		schema: 3,
		id,
		direction: "deposit",
		isPrivate: false,
		intent: "token",
		token: block,
		amount: "1",
		createdAt: 1,
		updatedAt: 1,
		chainId: 31337,
		portal: PORTAL,
		bridge: `0x${"b".repeat(64)}`,
		recipient: RECIPIENT,
		secretHashHex: id,
	}) as unknown as SendDepositRecord

/** One macrotask: every pending microtask (the attestation's chain of awaits) has drained by then. */
const flushMicrotasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** The engine deps a gas-only send needs to reach its Fee Juice claim: the chain answers that are
 *  ready, plus the claim leg itself. */
const fuelClaimDeps = (claim: unknown) =>
	({
		kv: localStorage,
		waitMs: async () => {},
		messageReadiness: async () => ({ checkpoint: 1, anchor: 1 }),
		claimReceiptStatus: async () => "success",
		recoverDepositLeg: async () => "recovered",
		claim,
	}) as never

describe("useSend", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		memStore.clear()
		__resetJournalForTests()
		__resetSendDepsForTests()
		__resetPromptQueueForTests()
		// The send lane wires the browser store into the engine, and here that is the shim above -
		// so the engine and anything seeded before `useSend()` must already be reading the same one.
		connectJournalDeps({ kv: localStorage })
		h.status.value = "connected"
		h.contractsReady.value = true
		h.error.value = null
		h.selectedAccount.value = RECIPIENT
		h.address.value = L1_ACCOUNT
		h.chainId.value = 31337
		h.realSeal.on = false
		h.hubToken.value = undefined
		// clearAllMocks keeps implementations, so the cases that install a live registration have to
		// hand the default back or their factory answer leaks into every later send.
		h.readRegistration.mockImplementation(async () => undefined)
		h.rebuiltL2Token.value = MANIFEST_L2_TOKEN
		h.ensureGranted.mockImplementation(async () => "granted")
		h.isGranted.mockImplementation(() => true)
		h.ensurePermit2Approval.mockImplementation(async () => {})
		h.signMessage.mockImplementation(async () => SEAL_SIG)
		h.resolveHubClaimSendOpts.mockImplementation(async () => ({ kind: "opts", opts: {} }))
		h.runSend.mockImplementation(fakeRunSend())
		h.sliceSwapData.mockImplementation(async () => "0x5eed")
	})

	it("a grant that THROWS is a reported failure, not an escaping exception - no send, no record", async () => {
		h.ensureGranted.mockImplementation(async () => {
			throw new Error("wallet unreachable")
		})
		const send = useSend()
		await expect(send.send(plan())).resolves.toBe("")
		expect(h.runSend).not.toHaveBeenCalled()
		expect(send.error.value).toContain("wallet unreachable")
		expect(useBridgeJournal().records.value).toHaveLength(0)
	})

	it("refuses with SETUP_PENDING while contracts are still registering - grant ran, nothing sent", async () => {
		h.contractsReady.value = false
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(h.ensureGranted).toHaveBeenCalled()
		expect(h.runSend).not.toHaveBeenCalled()
		expect(send.error.value).toMatch(/still setting up the app's contracts/)
	})

	it("a send of a granted token confirmed while another token's re-grant is registering waits for it, then sends", async () => {
		h.contractsReady.value = false
		let land: () => void = () => {}
		const regrant = new Promise<void>((resolve) => {
			land = resolve
		})
		void enqueuePrompt(async () => {
			await regrant
			h.contractsReady.value = true
		})
		const send = useSend()
		const sent = send.send(plan())
		await flushMicrotasks()
		expect(h.runSend, "nothing is signed while the contracts are registering").not.toHaveBeenCalled()
		land()
		expect(await sent).not.toBe("")
		expect(h.runSend).toHaveBeenCalled()
		expect(send.error.value).toBeNull()
	})

	it("a re-grant that fails while the send waits surfaces the session's error, and nothing is signed", async () => {
		h.contractsReady.value = false
		let land: () => void = () => {}
		const regrant = new Promise<void>((resolve) => {
			land = resolve
		})
		void enqueuePrompt(async () => {
			await regrant
			h.status.value = "error"
			h.error.value = { message: "The wallet could not register the app's contracts." }
		})
		const send = useSend()
		const sent = send.send(plan())
		await flushMicrotasks()
		land()
		expect(await sent).toBe("")
		expect(h.runSend).not.toHaveBeenCalled()
		expect(send.error.value).toBe("The wallet could not register the app's contracts.")
	})

	it("a queued re-grant that lands without this send's token refuses the send before any Ethereum transaction", async () => {
		let land: () => void = () => {}
		const regrant = new Promise<void>((resolve) => {
			land = resolve
		})
		// Another token's re-grant replaces the whole grant; this answer left the send's token out.
		void enqueuePrompt(async () => {
			await regrant
			h.isGranted.mockImplementation(() => false)
		})
		const send = useSend()
		const sent = send.send(plan())
		await flushMicrotasks()
		land()
		expect(await sent).toBe("")
		expect(h.ensurePermit2Approval).not.toHaveBeenCalled()
		expect(h.signTypedData).not.toHaveBeenCalled()
		expect(h.runSend).not.toHaveBeenCalled()
		expect(send.error.value).toMatch(/didn't grant access to this token/)
	})

	it("a queued request that never settles ends the send after the bound: nothing signed, the hold released, a late settle ignored", async () => {
		vi.useFakeTimers()
		try {
			let settle: () => void = () => {}
			void enqueuePrompt(
				() =>
					new Promise<void>((resolve) => {
						settle = resolve
					}),
			)
			const send = useSend()
			const sent = send.send(plan())
			await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MS)
			expect(await sent).toBe("")
			expect(send.error.value).toBe(PROMPTS_STALLED)
			expect(useOpsInFlight().busy.value, "the operation hold is released").toBe(false)
			settle()
			await vi.runAllTimersAsync()
			expect(h.ensurePermit2Approval).not.toHaveBeenCalled()
			expect(h.signTypedData).not.toHaveBeenCalled()
			expect(h.runSend, "nothing is sent, before or after the late settle").not.toHaveBeenCalled()
			expect(send.error.value).toBe(PROMPTS_STALLED)
		} finally {
			vi.useRealTimers()
		}
	})

	it("in the error state the refusal is the session's own message, not SETUP_PENDING", async () => {
		h.status.value = "error"
		h.error.value = { message: "Alpha-testnet is not responding. Try again." }
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(h.runSend).not.toHaveBeenCalled()
		expect(send.error.value).toBe("Alpha-testnet is not responding. Try again.")
	})

	it("proceeds when connected and contracts are ready", async () => {
		const send = useSend()
		await send.send(plan())
		expect(h.runSend).toHaveBeenCalled()
	})

	it("a DECLINED grant cancels before anything is signed - no approval, no send, no record", async () => {
		h.ensureGranted.mockImplementation(async () => "declined")
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(h.runSend).not.toHaveBeenCalled()
		expect(h.ensurePermit2Approval).not.toHaveBeenCalled()
		expect(h.signTypedData).not.toHaveBeenCalled()
		expect(send.error.value).toMatch(/didn't grant/)
		expect(useBridgeJournal().records.value).toHaveLength(0)
	})

	it("a wallet on another chain is refused BEFORE the grant prompt - no prompt, no signature", async () => {
		h.chainId.value = 1
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(h.ensureGranted).not.toHaveBeenCalled()
		expect(h.runSend).not.toHaveBeenCalled()
		expect(send.error.value).toMatch(/on chain 1/)
	})

	it("a STALE grant (the selection moved) cancels the same way, with its own copy", async () => {
		h.ensureGranted.mockImplementation(async () => "stale")
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(h.runSend).not.toHaveBeenCalled()
		expect(send.error.value).toMatch(/selection changed/)
	})

	it("a public token send journals the record, its hash and its leaf, and reports the L1 stages", async () => {
		const send = useSend()
		const id = await send.send(plan())
		expect(id).toBe("0xtokenhash")
		const rec = recordOf(id)
		expect(rec?.intent).toBe("token")
		expect(rec?.secret).toBe(PUBLIC_SECRET)
		expect(rec?.token?.erc20).toBe(ERC20)
		expect(rec?.depositTxHash).toBe("0xl1tx")
		expect(rec?.leafIndex).toBe("7")
		expect(send.stage.value).toBe("done")
	})

	it("a private token send seals its salt and persists the record BEFORE the signature", async () => {
		const send = useSend()
		const order: string[] = []
		h.sealPrivateRecord.mockImplementation(async () => {
			order.push("seal")
		})
		h.runSend.mockImplementation(async (...args: unknown[]) => {
			order.push("runSend")
			return fakeRunSend()(...(args as Parameters<ReturnType<typeof fakeRunSend>>))
		})
		const id = await send.send(plan({ isPrivate: true }))
		expect(order).toEqual(["seal", "runSend"])
		// The id is the L1-committed hash of the DERIVED secret, known before anything was signed.
		expect(id).toMatch(/^0x[0-9a-f]{64}$/)
		const rec = recordOf(id)
		expect(rec?.isPrivate).toBe(true)
		expect(rec?.secret).toBeUndefined()
		const sealed = h.sealPrivateRecord.mock.calls[0][0] as { binding: { portal: string; bridge: string }; secretStr: string }
		expect(sealed.binding.portal).toBe(PORTAL)
		expect(sealed.binding.bridge).not.toBe(PORTAL)
		// The salt handed to runSend is the one that was sealed.
		const params = h.runSend.mock.calls[0][2] as { claimSalt: { toString(): string } }
		expect(params.claimSalt.toString()).toBe(sealed.secretStr)
	})

	it("token+gas passes the gas leg through, swapped at the slice quoted at send time, and journals its fuel facts", async () => {
		const send = useSend()
		const id = await send.send(plan({ intent: "token+gas", gas: gasLeg }))
		const params = h.runSend.mock.calls[0][2] as { gas?: { fuelAmount: bigint; minFuelOutput: bigint; swapData: string } }
		expect(params.gas?.fuelAmount).toBe(1_000_000n)
		expect(params.gas?.minFuelOutput).toBe(4n)
		expect(params.gas?.swapData).toBe("0x5eed")
		expect(h.sliceSwapData).toHaveBeenCalledWith(expect.anything(), ERC20, gasLeg)
		const rec = recordOf(id)
		// The record's amount is the TOKEN claim: the total minus the slice the swap took.
		expect(rec?.amount).toBe("99000000")
		expect(rec?.fuel?.leafIndex).toBe("8")
		expect(rec?.fuel?.received).toBe("5")
	})

	it("a gas slice the venue no longer prices at the reviewed floor stops before anything is sealed, signed or journaled", async () => {
		h.sliceSwapData.mockImplementation(async () => {
			throw new Error("The gas price moved since you reviewed this send")
		})
		const send = useSend()
		await expect(send.send(plan({ isPrivate: true, intent: "token+gas", gas: gasLeg }))).resolves.toBe("")
		expect(send.error.value).toMatch(/gas price moved/)
		expect(h.sealPrivateRecord).not.toHaveBeenCalled()
		expect(h.ensurePermit2Approval).not.toHaveBeenCalled()
		expect(h.runSend).not.toHaveBeenCalled()
		expect(useBridgeJournal().records.value).toHaveLength(0)
	})

	it("a gas-only send carries no token block and is keyed by its Fee Juice message", async () => {
		const send = useSend()
		connectJournalDeps(fuelClaimDeps(async () => ({ simulate: async () => ({}), send: async () => ({ txHash: "0xfjclaim" }) })))
		const id = await send.send(plan({ intent: "gas", gas: { ...gasLeg, fuelAmount: 100_000_000n } }))
		expect(id).toBe("0xfuelhash")
		const rec = recordOf(id)
		expect(rec?.intent).toBe("gas")
		expect(rec?.token).toBeUndefined()
		// No token means no per-token grant prompt.
		expect(h.ensureGranted).not.toHaveBeenCalled()
	})

	it("a PUBLIC gas-only send claims with the fuel secret it journaled - no top-level copy needed", async () => {
		const claimed: { secretHex?: string } = {}
		const send = useSend()
		connectJournalDeps(
			fuelClaimDeps(async (_rec: SendDepositRecord, secretHex: string) => {
				claimed.secretHex = secretHex
				return { simulate: async () => ({}), send: async () => ({ txHash: "0xfjclaim" }) }
			}),
		)
		const id = await send.send(plan({ intent: "gas", gas: { ...gasLeg, fuelAmount: 100_000_000n } }))

		const rec = recordOf(id) as SendDepositRecord
		expect(rec.secret).toBeUndefined()
		// The claim ran on the block's own secret; nothing was left waiting on a missing record secret.
		expect(claimed.secretHex).toBe(rec.fuel?.secret)
		expect(claimed.secretHex).toBe("0xfuelsecret")
		expect(useBridgeJournal().runtime.value[id]?.attention).toBeUndefined()
	})

	it("every record the send writers produce is a record the backup validator accepts", async () => {
		const send = useSend()
		connectJournalDeps(fuelClaimDeps(async () => ({ simulate: async () => ({}), send: async () => ({ txHash: "0xfjclaim" }) })))
		const ids = [
			await send.send(plan()),
			await send.send(plan({ isPrivate: true })),
			await send.send(plan({ intent: "token+gas", gas: gasLeg })),
			await send.send(plan({ intent: "gas", gas: { ...gasLeg, fuelAmount: 100_000_000n } })),
		]
		for (const id of ids) {
			const rec = recordOf(id)
			expect(rec).toBeDefined()
			expect(() => validateAnyBackupRecord(rec as never)).not.toThrow()
		}
	})

	it("a read-back naming another L2 token rewrites the block and re-raises the grant", async () => {
		const rewritten = readBack({ l2Token: `0x${"d".repeat(64)}`, symbolWord: `0x${"9".repeat(64)}` })
		h.runSend.mockImplementation(fakeRunSend({ token: rewritten }))
		const send = useSend()
		const id = await send.send(plan())
		expect(recordOf(id)?.token?.l2Token).toBe(rewritten.l2Token)
		expect(h.requestHubToken).toHaveBeenCalledWith(expect.objectContaining({ l2Token: rewritten.l2Token }), { pinned: true })
		// One prompt at selection, one for the token the factory actually froze.
		expect(h.ensureGranted).toHaveBeenCalledTimes(2)
	})

	it("a read-back matching the preview neither rewrites nor re-prompts", async () => {
		const send = useSend()
		await send.send(plan())
		expect(h.ensureGranted).toHaveBeenCalledTimes(1)
	})

	it("the deposit hash is journaled the moment it exists, before the receipt is confirmed", async () => {
		let hashAtSend: string | undefined
		h.runSend.mockImplementation(async (...args: unknown[]) => {
			const recovery = args[4] as { onSecrets?: (s: Record<string, unknown>) => void; onSent?: (h: string) => void }
			recovery.onSecrets?.({ tokenClaimValueHex: "0xs", tokenSecretHashHex: "0xtokenhash", isPrivate: false })
			recovery.onSent?.("0xl1tx")
			hashAtSend = recordOf("0xtokenhash")?.depositTxHash
			throw new Error("network died right after the broadcast")
		})
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(hashAtSend).toBe("0xl1tx")
		// The record survives the failure, so the leg is recoverable from its hash.
		expect(recordOf("0xtokenhash")?.depositTxHash).toBe("0xl1tx")
	})

	it("a reverted L1 receipt surfaces as the send's error and leaves the record in place", async () => {
		h.runSend.mockImplementation(fakeRunSend({ throwAfterSend: true }))
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toMatch(/REVERTED/)
		expect(recordOf("0xtokenhash")).toBeDefined()
	})

	it("refuses without a connected wallet on either side, signing nothing", async () => {
		h.address.value = null
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toMatch(/Ethereum wallet/)
		h.address.value = L1_ACCOUNT
		h.selectedAccount.value = null
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toMatch(/Aztec wallet/)
		expect(h.runSend).not.toHaveBeenCalled()
	})

	it("the Permit2 approval is scoped to the plan's own token", async () => {
		const send = useSend()
		await send.send(plan())
		expect(h.ensurePermit2Approval).toHaveBeenCalledWith(expect.any(String), 100_000_000n, expect.any(String), expect.anything(), ERC20)
	})

	it("dispose releases the grant and voids the epoch a late completion would be matched against", async () => {
		const send = useSend()
		const epochs: number[] = []
		h.ensureGranted.mockImplementation(async (_t: unknown, epoch: () => number) => {
			epochs.push(epoch())
			return "granted"
		})
		await send.send(plan())
		send.dispose()
		expect(h.disposeGrant).toHaveBeenCalledTimes(1)
		// Disposing bumps the epoch too, so a wallet completion still in flight for the disposed
		// caller can never be matched against the next send's selection.
		await send.send(plan())
		expect(epochs[1]).toBe(epochs[0] + 2)
	})

	it("boots the journal's own tokens into the grant set once the factory vouches for them", async () => {
		h.readRegistration.mockImplementation(async () => frozenRegistration)
		h.rebuiltL2Token.value = token.l2Token
		addRecord(journalled("0xjournalled", readBack()))
		useSend()
		await flushMicrotasks()
		// Pinned: the journal's own tokens must survive the requested set's browse eviction.
		expect(h.requestHubToken).toHaveBeenCalledWith(expect.objectContaining({ l2Token: token.l2Token }), { pinned: true })
	})

	it("a forged token block is never pinned - it is blocked, and a genuine one is pinned after attestation", async () => {
		h.readRegistration.mockImplementation(async () => frozenRegistration)
		h.rebuiltL2Token.value = token.l2Token
		// The words the factory froze are not these: this block would otherwise reach the wallet as a
		// grant request and a contract registration built from attacker-chosen words.
		addRecord(journalled("0xforgedblock", readBack({ l2Token: `0x${"e".repeat(64)}`, symbolWord: `0x${"9".repeat(64)}` })))
		addRecord(journalled("0xgenuine", readBack()))
		useSend()
		await flushMicrotasks()

		expect(h.requestHubToken).toHaveBeenCalledTimes(1)
		expect(h.requestHubToken).toHaveBeenCalledWith(expect.objectContaining({ l2Token: token.l2Token }), { pinned: true })
		expect(recordOf("0xforgedblock")?.blocked).toMatch(/registration on Ethereum no longer matches/)
		expect(recordOf("0xgenuine")?.blocked).toBeUndefined()
	})

	it("a block the chain cannot answer for is left unpinned, and blocks nothing", async () => {
		h.readRegistration.mockImplementation(async () => {
			throw new Error("RPC unreachable")
		})
		addRecord(journalled("0xunreachable", readBack()))
		useSend()
		await flushMicrotasks()

		expect(h.requestHubToken).not.toHaveBeenCalled()
		expect(recordOf("0xunreachable")?.blocked).toBeUndefined()
	})

	it("a wallet on another chain attests nothing and blocks nothing; switching back attests", async () => {
		// On the wrong chain the factory read answers "no portal" for every genuine block — an
		// answer that must never be judged, because it would be terminal.
		h.chainId.value = 1
		h.readRegistration.mockImplementation(async () => undefined)
		addRecord(journalled("0xgenuine", readBack()))
		useSend()
		await flushMicrotasks()
		expect(h.requestHubToken).not.toHaveBeenCalled()
		expect(recordOf("0xgenuine")?.blocked).toBeUndefined()

		h.readRegistration.mockImplementation(async () => frozenRegistration)
		h.rebuiltL2Token.value = token.l2Token
		h.chainId.value = 31337
		await flushMicrotasks()
		expect(h.requestHubToken).toHaveBeenCalledWith(expect.objectContaining({ l2Token: token.l2Token }), { pinned: true })
		expect(recordOf("0xgenuine")?.blocked).toBeUndefined()
	})

	it("nothing is pinned while no Ethereum wallet is connected to attest with", async () => {
		h.address.value = null
		h.readRegistration.mockImplementation(async () => frozenRegistration)
		h.rebuiltL2Token.value = token.l2Token
		addRecord(journalled("0xnol1", readBack()))
		useSend()
		await flushMicrotasks()
		expect(h.requestHubToken).not.toHaveBeenCalled()

		// The watch re-attests the moment a wallet arrives.
		h.address.value = L1_ACCOUNT
		await flushMicrotasks()
		expect(h.requestHubToken).toHaveBeenCalledWith(expect.objectContaining({ l2Token: token.l2Token }), { pinned: true })
	})

	it("a half-shaped stored record neither crashes the boot nor reaches the wallet grant", async () => {
		h.readRegistration.mockImplementation(async () => frozenRegistration)
		h.rebuiltL2Token.value = token.l2Token
		const good = journalled("0xgood", readBack())
		// A schema-3 row with no token block at all, and one whose words are not field elements.
		const shapeless = { schema: 3, id: "0xshapeless", direction: "deposit", intent: "token" }
		const forged = { ...good, id: "0xforged", token: { ...readBack(), nameWord: "javascript:alert(1)" } }
		localStorage.setItem("unleashed-bridge:journal:v1", JSON.stringify({ schema: 1, records: [shapeless, forged, good] }))

		useSend()
		await flushMicrotasks()

		expect(useBridgeJournal().records.value.map((r) => r.id)).toEqual(["0xgood"])
		expect(h.requestHubToken).toHaveBeenCalledTimes(1)
		expect(h.requestHubToken).toHaveBeenCalledWith(expect.objectContaining({ l2Token: token.l2Token }), { pinned: true })
		// Nothing is deleted: the unreadable rows are parked where they can still be inspected.
		expect(JSON.parse(localStorage.getItem("unleashed-bridge:journal:quarantine") as string).records).toHaveLength(2)
	})

	it("a public first send opens its record BEFORE the approval, so the approve narrates into a real row", async () => {
		const approvedInto: string[] = []
		h.ensurePermit2Approval.mockImplementation(async (_permit2: string, _needed: bigint, recordId: string) => {
			approvedInto.push(recordId)
			// The two channels the real approval narrates through.
			setRecordStep(recordId, "approving", "first time only: approve Permit2 in your Ethereum wallet")
			updateRecord(recordId, { approveTxHash: "0xapprove" })
		})
		const send = useSend()
		const id = await send.send(plan())

		expect(approvedInto[0]).not.toBe("")
		expect(useBridgeJournal().runtime.value[""]).toBeUndefined()
		// The row the approval wrote into is the one the deposit ends up keyed by - one record, and
		// the approve transaction is still on it after the claim hash renames it.
		expect(useBridgeJournal().records.value).toHaveLength(1)
		expect(recordOf(id)?.approveTxHash).toBe("0xapprove")
		expect(id).toBe("0xtokenhash")
	})

	it("records the signing L1 account as the sender on the opened row and again after the rekey", async () => {
		const opened: (string | undefined)[] = []
		h.ensurePermit2Approval.mockImplementation(async (_permit2: string, _needed: bigint, recordId: string) => {
			opened.push(recordOf(recordId)?.sender)
		})
		const id = await useSend().send(plan())

		expect(opened).toEqual([L1_ACCOUNT])
		expect(id).toBe("0xtokenhash")
		expect(recordOf(id)?.sender).toBe(L1_ACCOUNT)
	})

	it("an approval the user rejects leaves no half-started row behind", async () => {
		h.ensurePermit2Approval.mockImplementation(async () => {
			throw new Error("User rejected the request")
		})
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(useBridgeJournal().records.value).toHaveLength(0)
		expect(h.runSend).not.toHaveBeenCalled()
	})

	it("a witness the user refuses discards the row the send had already named, and the review hears the refusal", async () => {
		h.runSend.mockImplementation(async (_l1: unknown, _gen: unknown, p: FakeParams, _s?: unknown, recovery?: FakeRecovery) => {
			recovery?.onSecrets?.(await fakeSecrets(p))
			throw Object.assign(new Error("User rejected the request.\n\nDetails: MetaMask Tx Signature: User denied"), { code: 4001 })
		})
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toBe("Rejected in wallet.")
		expect(useBridgeJournal().records.value).toHaveLength(0)
	})

	it("a failure the chain may hold keeps the named row and names it on the rail", async () => {
		h.runSend.mockImplementation(async (_l1: unknown, _gen: unknown, p: FakeParams, _s?: unknown, recovery?: FakeRecovery) => {
			recovery?.onSecrets?.(await fakeSecrets(p))
			throw new Error("HTTP request failed: fetch failed")
		})
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toMatch(/fetch failed/)
		expect(recordOf("0xtokenhash")).toBeDefined()
		expect(useBridgeJournal().runtime.value["0xtokenhash"]?.attention).toBe("error")
		expect(useBridgeJournal().runtime.value["0xtokenhash"]?.note).toMatch(/fetch failed/)
	})

	it("a stale-anchor envelope from the send shows the chain-desync copy at the display seam", async () => {
		h.runSend.mockImplementation(async (_l1: unknown, _gen: unknown, p: FakeParams, _s?: unknown, recovery?: FakeRecovery) => {
			recovery?.onSecrets?.(await fakeSecrets(p))
			throw new Error(JSON.stringify({ code: -32602, message: "x", data: { walletErrorCode: "PXE_STALE_ANCHOR" } }))
		})
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toBe("Your wallet's view of the network was behind. Try again.")
	})

	it("a contract-not-registered envelope from the send shows its copy at the display seam", async () => {
		h.runSend.mockImplementation(async (_l1: unknown, _gen: unknown, p: FakeParams, _s?: unknown, recovery?: FakeRecovery) => {
			recovery?.onSecrets?.(await fakeSecrets(p))
			throw new Error(JSON.stringify({ code: -32602, message: "x", data: { walletErrorCode: "CONTRACT_NOT_REGISTERED" } }))
		})
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toBe("Couldn't register the app's contracts with your wallet. Reconnect.")
	})

	it("an L1 wallet on another chain refuses before the approval, so nothing is signed and no row survives", async () => {
		h.chainId.value = 1
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toMatch(/on chain 1/)
		expect(h.ensurePermit2Approval).not.toHaveBeenCalled()
		expect(h.runSend).not.toHaveBeenCalled()
		expect(useBridgeJournal().records.value).toHaveLength(0)
	})

	it("the claim asks the hub whether the token is bound, for a public record as much as a private one", async () => {
		h.readRegistration.mockImplementation(async () => frozenRegistration)
		h.rebuiltL2Token.value = token.l2Token
		connectJournalDeps({
			kv: localStorage,
			waitMs: async () => {},
			messageReadiness: async () => ({ checkpoint: 1, anchor: 1 }),
			claimReceiptStatus: async () => "success",
		})
		const registersOf = (call: number) =>
			(h.resolveHubClaimSendOpts.mock.calls as unknown as Array<[{ registers?: boolean }]>)[call]?.[0]?.registers
		await useSend().send(plan({ intent: "token", isPrivate: false }))
		expect(registersOf(0)).toBe(true)
		h.hubToken.value = token.l2Token
		await useSend().send(plan({ intent: "token", isPrivate: false }))
		expect(registersOf(1)).toBe(false)
	})

	it("a hub claim paid from the wallet's own gas that leaves the bridged gas behind fires the standalone Fee Juice claim", async () => {
		h.readRegistration.mockImplementation(async () => frozenRegistration)
		h.rebuiltL2Token.value = token.l2Token
		h.resolveHubClaimSendOpts.mockImplementation(async () => ({
			kind: "opts",
			opts: {},
			standalone: { amount: "1", secret: PUBLIC_SECRET, secretHashHex: "0xfuelhash", minOutput: "1", leafIndex: "8", received: "5" },
		}))
		const send = useSend()
		connectJournalDeps({
			kv: localStorage,
			waitMs: async () => {},
			messageReadiness: async () => ({ checkpoint: 1, anchor: 1 }),
			claimReceiptStatus: async () => "success",
		})
		const id = await send.send(plan({ intent: "token+gas", gas: gasLeg }))
		expect(h.sendStandaloneFjClaim).toHaveBeenCalledTimes(1)
		expect(h.sendStandaloneFjClaim.mock.calls[0][3]).toBe(id)
	})
})

/** The registration the factory froze for this fixture's token — what `validateTokenBlock` compares
 *  a record's block against when a lane resumes. */
const frozenRegistration: Registration = {
	portal: PORTAL,
	decimals: 6,
	registerIndex: 3n,
	nameWord: token.words.nameWord,
	symbolWord: token.words.symbolWord,
	registerKey: `0x${"4".repeat(64)}`,
}

/**
 * A private send's fuel material is derived, journaled and sealed BEFORE the L1 leg moves anything,
 * so these run the real seal (real AES-GCM over a deterministic fake signature) and then reopen the
 * journal with the in-memory cache gone — the only way the claim can proceed is by unsealing.
 */
describe("useSend - private fueled sends seal and journal their gas material", () => {
	const engineFakes = {
		kv: localStorage,
		waitMs: async () => {},
		signL1: async () => SEAL_SIG,
		connectedL1: () => L1_ACCOUNT,
		connectedAztec: () => RECIPIENT,
		validateTokenBlock: async () => null,
		ensureTokenGrant: async () => "granted" as const,
		messageReadiness: async () => ({ checkpoint: 1, anchor: 1 }),
		claimReceiptStatus: async () => "success" as const,
		recoverDepositLeg: async () => "recovered" as const,
	}

	/** A claim that refuses: the send must finish with the record still unclaimed, so the reopened
	 *  journal below has something left to unseal. */
	const refusingClaim = async () => ({
		simulate: async () => {
			throw new Error("not claiming in this phase")
		},
		send: async () => ({ txHash: "0xnever" }),
	})

	beforeEach(() => {
		h.realSeal.on = true
		h.readRegistration.mockImplementation(async () => frozenRegistration)
		h.rebuiltL2Token.value = token.l2Token
	})

	/** Drop every in-memory trace of the send and re-enter the engine over the stored record alone. */
	async function reopenAndClaim(id: string, over: Record<string, unknown>): Promise<void> {
		__resetJournalForTests()
		__resetSendDepsForTests()
		connectJournalDeps({
			...engineFakes,
			sendBinding: () => ({
				factory: GEN.factory,
				implementation: GEN.implementation,
				hub: (HUB as { toString(): string }).toString(),
				feeJuicePortal: FUEL_PORTAL,
			}),
			...over,
		} as never)
		useBridgeJournal()
		await runDepositClaim(id, { interactive: true })
	}

	it("a private GAS-ONLY send journals its whole fuel block and seals the salt the claim needs", async () => {
		const send = useSend()
		connectJournalDeps({ ...engineFakes, claim: refusingClaim } as never)
		const id = await send.send(plan({ isPrivate: true, intent: "gas", gas: { ...gasLeg, fuelAmount: 100_000_000n } }))

		const rec = recordOf(id) as SendDepositRecord
		const salt = rec.fuel?.bridgeSecretSalt as string
		expect(salt).toMatch(/^0x[0-9a-f]{64}$/)
		expect(rec.fuel?.secret).toBe(deriveBridgeSecret(Fr.fromString(salt), AztecAddress.fromStringUnsafe(RECIPIENT)).toString())
		expect(rec.fuel?.secretHashHex).toBe(id)
		expect(rec.fuel?.fpc).toBe(PRIVATE_FPC_ADDRESS)
		expect(rec.sealedEnvelope).toBeTypeOf("string")

		// The envelope carries the salt, so a restore on another device can claim the gas privately.
		const envelope = await openDepositEnvelope(await recoveryKeyFromSignature(SEAL_SIG), rec.sealedEnvelope as string)
		expect(envelope.salt).toBe(salt)
		expect(envelope.secret).toBe(salt)

		let opened: { secretHex: string; salt?: string } | null = null
		await reopenAndClaim(id, {
			claim: async (_rec: DepositJournalRecord, secretHex: string, env?: { salt?: string }) => {
				opened = { secretHex, salt: env?.salt }
				return { simulate: async () => ({}), send: async () => ({ txHash: "0xfjclaim" }) }
			},
		})
		expect(opened).toEqual({ secretHex: salt, salt })
	})

	it("a private TOKEN+GAS send journals the fuel block AND seals both salts", async () => {
		const send = useSend()
		connectJournalDeps({ ...engineFakes, claimSend: refusingClaim } as never)
		const id = await send.send(plan({ isPrivate: true, intent: "token+gas", gas: gasLeg }))

		const rec = recordOf(id) as SendDepositRecord
		const salt = rec.fuel?.bridgeSecretSalt as string
		expect(salt).toMatch(/^0x[0-9a-f]{64}$/)
		expect(rec.fuel?.secret).toBe(deriveBridgeSecret(Fr.fromString(salt), AztecAddress.fromStringUnsafe(RECIPIENT)).toString())
		expect(rec.fuel?.leafIndex).toBe("8")
		expect(rec.secret).toBeUndefined()

		const envelope = await openDepositEnvelope(await recoveryKeyFromSignature(SEAL_SIG), rec.sealedEnvelope as string)
		// The token credential and the gas salt are DIFFERENT secrets, and the envelope holds both.
		expect(envelope.salt).toBe(salt)
		expect(envelope.secret).not.toBe(salt)

		let claimedWith = ""
		await reopenAndClaim(id, {
			claimSend: async (_rec: SendDepositRecord, claimValueHex: string) => {
				claimedWith = claimValueHex
				return { simulate: async () => ({}), send: async () => ({ txHash: "0xhubclaim" }) }
			},
		})
		expect(claimedWith).toBe(envelope.secret)
	})
})

describe("validateTokenBlock", () => {
	const registration: Registration = {
		portal: PORTAL,
		decimals: 6,
		registerIndex: 3n,
		nameWord: `0x${"1".repeat(64)}`,
		symbolWord: `0x${"2".repeat(64)}`,
		registerKey: `0x${"4".repeat(64)}`,
	}
	const DERIVED = `0x${"c".repeat(64)}`

	const block = (over: Partial<JournalTokenBlock> = {}): JournalTokenBlock => ({
		erc20: ERC20,
		portal: PORTAL,
		l2Token: DERIVED,
		nameWord: registration.nameWord,
		symbolWord: registration.symbolWord,
		decimals: 6,
		displaySymbol: "USDC",
		registerKey: registration.registerKey,
		registerIndex: "3",
		...over,
	})

	beforeEach(() => {
		vi.clearAllMocks()
		h.rebuiltL2Token.value = DERIVED
		h.readRegistration.mockImplementation(async () => registration)
	})

	it("passes a block the factory's frozen registration still names", async () => {
		await expect(validateTokenBlock(block())).resolves.toBeNull()
	})

	it.each([
		["nameWord", { nameWord: `0x${"9".repeat(64)}` }],
		["symbolWord", { symbolWord: `0x${"9".repeat(64)}` }],
		["decimals", { decimals: 18 }],
		["registerKey", { registerKey: `0x${"9".repeat(64)}` }],
		["registerIndex", { registerIndex: "4" }],
	])("refuses a block whose %s the registration contradicts", async (_field, over) => {
		await expect(validateTokenBlock(block(over))).resolves.toMatch(/registration on Ethereum no longer matches/)
	})

	it("refuses a block naming an Aztec token the registration does not derive", async () => {
		h.rebuiltL2Token.value = `0x${"d".repeat(64)}`
		await expect(validateTokenBlock(block())).resolves.toMatch(/does not derive/)
	})

	it("refuses when the factory has no registration for the token any more", async () => {
		h.readRegistration.mockImplementation(async () => undefined)
		await expect(validateTokenBlock(block())).resolves.toMatch(/no portal for this token/)
	})

	it("reads through the pinned Ethereum reader, so a wallet left on a source chain still passes", async () => {
		h.chainId.value = 84532
		const reader = { getChainId: async () => 31337 }
		await expect(validateTokenBlock(block(), undefined, reader)).resolves.toBeNull()
		expect(h.readRegistration).toHaveBeenCalledWith(reader, expect.anything(), ERC20)
		await expect(validateTokenBlock(block(), undefined, { getChainId: async () => 1 })).rejects.toThrow(/on chain 1/)
		h.chainId.value = 31337
	})
})
