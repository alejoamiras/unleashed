/**
 * @vitest-environment node
 *
 * Node, not jsdom: the private legs derive real claim material through bb.js poseidon, which does
 * not run under jsdom.
 */
import {
	BridgeError,
	type DepositRecord,
	type DepositSecrets,
	type JournalTokenBlock,
	type RunOptions,
	type TransferEvent,
	type TransferEventBody,
} from "@unleashed/sdk"
import type { ClaimOptions } from "@unleashed/sdk/fuel"
import type { DepositPlan, Registration } from "@unleashed/sdk/internal"
import { WaitForTransactionReceiptTimeoutError } from "viem"
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
	signMessage: vi.fn(async () => `0x${"a".repeat(130)}`),
	writeContract: vi.fn(async (_call: { functionName: string }) => "0xl1tx"),
	chainId: { value: 31337 } as { value: number },
	readRegistration: vi.fn(async () => undefined as Registration | undefined),
	sealPrivateRecord: vi.fn(async (_ctx: Record<string, unknown>) => {}),
	/** Opt-in per case: run the REAL seal (and its real envelope) after the spy records the call. */
	realSeal: { on: false },
	/** The SDK's claim entries: by default each settles the record it is handed. */
	claimToken: vi.fn(),
	claimFuel: vi.fn(),
	depositL1: vi.fn(),
	assertDepositsOpen: vi.fn(async (_net: unknown, _reads: unknown, _intent: string) => {}),
	bridgeNetwork: vi.fn(),
	rebuiltL2Token: { value: "" as string },
	/** The build's pinned Ethereum reader; undefined = the build pins none. */
	pinned: { value: undefined as unknown },
}))

vi.mock("@/contracts/bridge-generation", async () => {
	const { readFileSync } = await import("node:fs")
	const { fileURLToPath } = await import("node:url")
	const protocol = await vi.importActual<typeof import("@unleashed/sdk/protocol")>("@unleashed/sdk/protocol")
	const internal = await vi.importActual<typeof import("@unleashed/sdk/internal")>("@unleashed/sdk/internal")
	const path = fileURLToPath(new URL("../../../../packages/bridge-core/fixtures/sandbox-manifest.json", import.meta.url))
	const manifest = protocol.parseManifestV2(JSON.parse(readFileSync(path, "utf8")))
	const bridge = manifest.bridge as NonNullable<typeof manifest.bridge>
	h.rebuiltL2Token.value = bridge.tokens[0].l2Token
	return {
		MANIFEST: manifest,
		GENERATION: bridge,
		MANIFEST_CHAIN: { l1ChainId: manifest.l1ChainId, walletChainId: manifest.walletChainId },
		IS_PLACEHOLDER: false,
		MANIFEST_TOKENS: bridge.tokens,
		SEND_GENERATION: internal.sendGenerationOf(manifest, bridge),
		HUB: { toString: () => bridge.l2.hub.address },
		TOKEN_CLASS_ID: bridge.l2.tokenClassId,
		FUEL_PORTAL: manifest.feeJuice.portal,
		FUEL_ASSET: manifest.feeJuice.asset,
		FUEL_MIN_FJ: BigInt(manifest.feeJuice.minFj),
		rebuildHubTokenInstance: async () => ({ address: { toString: () => h.rebuiltL2Token.value } }),
		hubArtifact: async () => ({ name: "TokenBridgeHub" }),
		bridgeNetwork: (reads: unknown) => h.bridgeNetwork(reads),
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

// No pinned Ethereum reader by default, so every Ethereum read goes through the mocked wallet below.
vi.mock("./useEthereumReader", async (orig) => ({
	...(await orig<typeof import("./useEthereumReader")>()),
	readClientFor: () => h.pinned.value,
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
		sealPrivateRecord: async (ctx: Parameters<typeof actual.sealPrivateRecord>[0]) => {
			await h.sealPrivateRecord(ctx as unknown as Record<string, unknown>)
			if (h.realSeal.on) await actual.sealPrivateRecord(ctx)
		},
	}
})

vi.mock("@unleashed/sdk/internal", async (importOriginal) => ({
	...(await importOriginal<typeof import("@unleashed/sdk/internal")>()),
	depositL1: h.depositL1,
	assertDepositsOpen: h.assertDepositsOpen,
	readRegistration: h.readRegistration,
}))
vi.mock("@unleashed/sdk/bridge", async (importOriginal) => ({
	...(await importOriginal<typeof import("@unleashed/sdk/bridge")>()),
	claimToken: h.claimToken,
}))
vi.mock("@unleashed/sdk/fuel", async (importOriginal) => ({
	...(await importOriginal<typeof import("@unleashed/sdk/fuel")>()),
	claimFuel: h.claimFuel,
}))

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
	type SendDepositRecord,
	isProvisionalRecordId,
	openDepositEnvelope,
	RecoveryKey,
	validateAnyBackupRecord,
} from "@unleashed/bridge-core"
import { recoveryBindingOf } from "@/lib/send-record"
import { PRIVATE_FPC_ADDRESS, deriveBridgeSecret, deriveTokenClaimSecret, predictPortal } from "@unleashed/sdk/protocol"
import { FUEL_PORTAL, HUB, SEND_GENERATION } from "@/contracts/bridge-generation"
import { __resetPromptQueueForTests, enqueuePrompt, PROMPT_WAIT_MS, PROMPTS_STALLED } from "@/lib/prompt-queue"
import { __resetJournalForTests, addRecord, connectJournalDeps, runDepositClaim, useBridgeJournal } from "./useBridgeJournal"
import { GAS_QUOTE_MOVED } from "./useFuelQuote"
import { __resetSendDepsForTests, BRIDGE_UNCHECKED, DEPOSITS_PAUSED, previewBlock, useSend, validateTokenBlock } from "./useSend"
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
function readBack(over: Partial<JournalTokenBlock> = {}) {
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

interface FakeWallet {
	writeContract(call: { functionName: string }): Promise<`0x${string}`>
	signTypedData(args: unknown): Promise<`0x${string}`>
}

interface Fake {
	/** The block the receipt reads back; the wizard's prediction by default. */
	token?: ReturnType<typeof readBack>
	/** Permit2's allowance is short: the approval is sent, journaled and waited on. */
	approve?: boolean
	/** Runs once the approval has waited a round. */
	afterApproval?: () => void
	/** Thrown once the deposit's hash is journaled. */
	afterSend?: unknown
	/** The receipt never comes: the run waits on its signal past the app's receipt wait, under fake timers. */
	slowReceipt?: boolean
}

/** The SDK's error for a wallet call, as `depositL1` wraps it: EIP-1193's 4001 is a refusal, anything else keeps the
 *  wallet's error as its cause. */
async function sdkCall<T>(call: () => Promise<T>, code: "approval-failed" | "invalid-request" | "deposit-reverted"): Promise<T> {
	try {
		return await call()
	} catch (e) {
		if ((e as { code?: unknown }).code === 4001) throw new BridgeError("user-rejected", "refused", "none", "safe", { cause: e })
		throw new BridgeError(code, "failed", code === "invalid-request" ? "none" : "unknown", "safe", { cause: e })
	}
}

/** A private leg's salts, and the hashes its claims will check. Private hashes are the real derivations, so the id
 *  the app seals under is the one the witness would commit to; a public leg's are stand-ins. */
async function plannedHashes(p: DepositPlan): Promise<{ tokenHash?: string; fuelHash?: string; secrets: DepositSecrets }> {
	const recipient = AztecAddress.fromStringUnsafe(p.recipient)
	const claimSalt = p.isPrivate && p.intent !== "gas" ? Fr.random() : undefined
	const fuelSalt = p.isPrivate && p.gas ? Fr.random() : undefined
	const hashOf = async (secret: Fr) => (await computeSecretHash(secret)).toString()
	const tokenHash = claimSalt ? await hashOf(deriveTokenClaimSecret(claimSalt, recipient)) : "0xtokenhash"
	const fuelHash = fuelSalt ? await hashOf(deriveBridgeSecret(fuelSalt, recipient)) : "0xfuelhash"
	return {
		...(p.intent === "gas" ? {} : { tokenHash }),
		...(p.gas ? { fuelHash } : {}),
		secrets: { ...(claimSalt ? { claimSalt } : {}), ...(fuelSalt ? { fuelSalt } : {}) },
	}
}

/** The record `depositL1` opens with: a public leg's claim material in it, a private leg's salts beside it. */
async function plannedRecord(p: DepositPlan): Promise<{ record: DepositRecord; secrets: DepositSecrets }> {
	const { tokenHash, fuelHash, secrets } = await plannedHashes(p)
	const id = (tokenHash ?? fuelHash) as string
	const fuel = p.gas && {
		amount: p.gas.fuelAmount.toString(),
		...(secrets.fuelSalt ? { fpc: PRIVATE_FPC_ADDRESS } : { secret: "0xfuelsecret" }),
		secretHashHex: fuelHash as string,
		minOutput: p.gas.minFuelOutput.toString(),
	}
	const base = {
		schema: 3 as const,
		id,
		direction: "deposit" as const,
		isPrivate: p.isPrivate,
		amount: (p.amount - (p.intent === "gas" ? 0n : (p.gas?.fuelAmount ?? 0n))).toString(),
		createdAt: 1,
		updatedAt: 1,
		chainId: 31337,
		portal: p.tokenBlock?.portal ?? FUEL_PORTAL,
		bridge: `0x${"b".repeat(64)}`,
		recipient: p.recipient,
		sender: L1_ACCOUNT,
		...(!p.isPrivate && tokenHash ? { secret: PUBLIC_SECRET } : {}),
		secretHashHex: id,
		...(fuel ? { fuel } : {}),
		...(p.registers ? { registers: true as const } : {}),
	}
	const record: DepositRecord =
		p.intent === "gas" ? { ...base, intent: "gas" } : { ...base, intent: p.intent, token: p.tokenBlock as JournalTokenBlock }
	return { record, secrets }
}

/** What the SDK persists once the receipt is in: leaves, the frozen token, and an L2 block this lane never journals. */
const confirmedFacts = (p: DepositPlan, rec: DepositRecord, token = readBack()): Partial<DepositRecord> => ({
	...(p.intent === "gas" ? {} : { leafIndex: "7", messageHash: "0xtokenkey", token, portal: token.portal }),
	...(rec.fuel ? { fuel: { ...rec.fuel, leafIndex: "8", messageHash: "0xfuelkey", received: "5" } } : {}),
	depositL2Block: 100,
})

/** `depositL1` as the app meets it: the record persisted before the first prompt and again with every fact, the
 *  wallet's own prompts in the SDK's order, and each event after the fact it names. */
function fakeDeposit(o: Fake = {}) {
	return async (_net: unknown, _r: unknown, wallet: FakeWallet, p: DepositPlan, run: RunOptions): Promise<DepositRecord> => {
		const { record, secrets } = await plannedRecord(p)
		let rec = record
		let seq = 0
		const emit = (body: TransferEventBody) => run.onEvent?.({ id: rec.id, seq: seq++, ...body } as TransferEvent)
		// The caller's refusal comes back as the SDK's `persist-failed`, the refusal its cause.
		const persist = async (patch: Partial<DepositRecord>, submission: "none" | "submitted" = "none") => {
			rec = { ...rec, ...patch } as DepositRecord
			try {
				await run.persist(rec, secrets)
			} catch (e) {
				throw new BridgeError("persist-failed", "the caller's storage refused the record", submission, "safe", { cause: e })
			}
		}
		await persist({})
		emit({ type: "prepared" })
		if (o.approve) {
			emit({ type: "approval", status: "requested" })
			const hash = await sdkCall(() => wallet.writeContract({ functionName: "approve" }), "approval-failed")
			await persist({ approveTxHash: hash })
			emit({ type: "approval", status: "sent", txHash: hash })
			emit({ type: "approval", status: "waiting", txHash: hash, round: 1 })
			o.afterApproval?.()
			emit({ type: "approval", status: "confirmed", txHash: hash })
		}
		emit({ type: "signature-requested" })
		await sdkCall(() => wallet.signTypedData({}), "invalid-request")
		const txHash = await sdkCall(() => wallet.writeContract({ functionName: "bridgeWithPermit" }), "deposit-reverted")
		await persist({ depositTxHash: txHash }, "submitted")
		if (o.slowReceipt) return waitPastReceipt(run, () => emit({ type: "deposit-sent", txHash }))
		emit({ type: "deposit-sent", txHash })
		if (o.afterSend) throw o.afterSend
		await persist(confirmedFacts(p, rec, o.token), "submitted")
		emit({ type: "deposit-confirmed", leaves: {} })
		return rec
	}
}

/** The receipt wait the app bounds: a tick short of its limit the run still waits, at the limit the app's signal
 *  stops it, and the SDK reports the stop with the signal's reason as its cause. */
function waitPastReceipt(run: RunOptions, sent: () => void): never {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
	try {
		sent()
		vi.advanceTimersByTime(179_999)
		expect(run.signal?.aborted, "still waiting a tick before viem's default").toBe(false)
		vi.advanceTimersByTime(1)
	} finally {
		vi.useRealTimers()
	}
	const stopped = new BridgeError("aborted", "the caller stopped waiting", "submitted", "after-wait", { cause: run.signal?.reason })
	throw new BridgeError("aborted", "the deposit is not confirmed yet", "submitted", "never", { cause: stopped })
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

/** A claim entry that lands and settles the record it is handed, as the SDK's do. */
const settles = async (_net: unknown, _r: unknown, _aztec: unknown, view: DepositRecord, run: ClaimOptions) => {
	const record = { ...view, claimTxHash: `0x${"c".repeat(64)}`, completedAt: Date.now() }
	await run.persist(record, run.secrets)
	return { record, via: "claim" as const }
}

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
		// clearAllMocks keeps implementations, so the cases that install a live registration have to
		// hand the default back or their factory answer leaks into every later send.
		h.readRegistration.mockImplementation(async () => undefined)
		h.rebuiltL2Token.value = MANIFEST_L2_TOKEN
		h.ensureGranted.mockImplementation(async () => "granted")
		h.isGranted.mockImplementation(() => true)
		h.signMessage.mockImplementation(async () => SEAL_SIG)
		h.claimToken.mockImplementation(settles)
		h.claimFuel.mockImplementation(settles)
		h.depositL1.mockImplementation(fakeDeposit())
		h.bridgeNetwork.mockImplementation(async () => ({}))
		h.assertDepositsOpen.mockImplementation(async () => {})
		h.pinned.value = undefined
		h.signTypedData.mockImplementation(async () => "0xsig")
		h.writeContract.mockImplementation(async () => "0xl1tx")
	})

	it("a grant that THROWS is a reported failure, not an escaping exception - no send, no record", async () => {
		h.ensureGranted.mockImplementation(async () => {
			throw new Error("wallet unreachable")
		})
		const send = useSend()
		await expect(send.send(plan())).resolves.toBe("")
		expect(h.depositL1).not.toHaveBeenCalled()
		expect(send.error.value).toContain("wallet unreachable")
		expect(useBridgeJournal().records.value).toHaveLength(0)
	})

	it("refuses with SETUP_PENDING while contracts are still registering - grant ran, nothing sent", async () => {
		h.contractsReady.value = false
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(h.ensureGranted).toHaveBeenCalled()
		expect(h.depositL1).not.toHaveBeenCalled()
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
		expect(h.depositL1, "nothing is signed while the contracts are registering").not.toHaveBeenCalled()
		land()
		expect(await sent).not.toBe("")
		expect(h.depositL1).toHaveBeenCalled()
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
		expect(h.depositL1).not.toHaveBeenCalled()
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
		expect(h.signTypedData).not.toHaveBeenCalled()
		expect(h.depositL1).not.toHaveBeenCalled()
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
			expect(h.signTypedData).not.toHaveBeenCalled()
			expect(h.depositL1, "nothing is sent, before or after the late settle").not.toHaveBeenCalled()
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
		expect(h.depositL1).not.toHaveBeenCalled()
		expect(send.error.value).toBe("Alpha-testnet is not responding. Try again.")
	})

	it("proceeds when connected and contracts are ready", async () => {
		const send = useSend()
		await send.send(plan())
		expect(h.depositL1).toHaveBeenCalled()
	})

	it("a DECLINED grant cancels before anything is signed - no approval, no send, no record", async () => {
		h.ensureGranted.mockImplementation(async () => "declined")
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(h.depositL1).not.toHaveBeenCalled()
		expect(h.signTypedData).not.toHaveBeenCalled()
		expect(send.error.value).toMatch(/didn't grant/)
		expect(useBridgeJournal().records.value).toHaveLength(0)
	})

	it("a wallet on another chain is refused BEFORE the grant prompt - no prompt, no signature", async () => {
		h.chainId.value = 1
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(h.ensureGranted).not.toHaveBeenCalled()
		expect(h.depositL1).not.toHaveBeenCalled()
		expect(send.error.value).toMatch(/on chain 1/)
	})

	it("a STALE grant (the selection moved) cancels the same way, with its own copy", async () => {
		h.ensureGranted.mockImplementation(async () => "stale")
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(h.depositL1).not.toHaveBeenCalled()
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
		// The SDK's L2 block would start a countdown this lane has never narrated.
		expect(rec?.depositL2Block).toBeUndefined()
		expect(send.stage.value).toBe("done")
	})

	it("a private token send seals the salt its id commits to BEFORE the signature", async () => {
		const send = useSend()
		const order: string[] = []
		h.sealPrivateRecord.mockImplementation(async () => {
			order.push("seal")
		})
		h.signTypedData.mockImplementation(async () => {
			order.push("sign")
			return "0xsig"
		})
		const id = await send.send(plan({ isPrivate: true }))
		expect(order).toEqual(["seal", "sign"])
		expect(id).toMatch(/^0x[0-9a-f]{64}$/)
		const rec = recordOf(id)
		expect(rec?.isPrivate).toBe(true)
		expect(rec?.secret).toBeUndefined()
		const sealed = h.sealPrivateRecord.mock.calls[0][0] as { binding: { portal: string; bridge: string }; secretStr: string }
		expect(sealed.binding.portal).toBe(PORTAL)
		expect(sealed.binding.bridge).not.toBe(PORTAL)
		const committed = deriveTokenClaimSecret(Fr.fromString(sealed.secretStr), AztecAddress.fromStringUnsafe(RECIPIENT))
		expect((await computeSecretHash(committed)).toString()).toBe(id)
	})

	it("token+gas hands the SDK the reviewed slice and floor, and journals its fuel facts", async () => {
		const send = useSend()
		const id = await send.send(plan({ intent: "token+gas", gas: gasLeg }))
		const reviewed = h.depositL1.mock.calls[0][3] as DepositPlan
		expect(reviewed.gas).toEqual({ fuelAmount: 1_000_000n, minFuelOutput: 4n })
		expect(reviewed.amount).toBe(100_000_000n)
		const rec = recordOf(id)
		// The record's amount is the TOKEN claim: the total minus the slice the swap took.
		expect(rec?.amount).toBe("99000000")
		expect(rec?.fuel?.leafIndex).toBe("8")
		expect(rec?.fuel?.received).toBe("5")
		expect(rec?.fuel?.secret).toBe("0xfuelsecret")
	})

	it("a gas slice the venue no longer prices at the reviewed floor stops before anything is sealed, signed or journaled", async () => {
		h.depositL1.mockImplementation(async () => {
			throw new BridgeError("quote-moved", "the gas price moved under the reviewed floor; quote again", "none", "safe")
		})
		const send = useSend()
		await expect(send.send(plan({ isPrivate: true, intent: "token+gas", gas: gasLeg }))).resolves.toBe("")
		expect(send.error.value).toBe(GAS_QUOTE_MOVED)
		expect(h.sealPrivateRecord).not.toHaveBeenCalled()
		expect(useBridgeJournal().records.value).toHaveLength(0)
	})

	it("a gas-only send carries no token block and is keyed by its Fee Juice message", async () => {
		const send = useSend()
		const id = await send.send(plan({ intent: "gas", gas: { ...gasLeg, fuelAmount: 100_000_000n } }))
		expect(id).toBe("0xfuelhash")
		const rec = recordOf(id)
		expect(rec?.intent).toBe("gas")
		expect(rec?.token).toBeUndefined()
		// No token means no per-token grant prompt.
		expect(h.ensureGranted).not.toHaveBeenCalled()
	})

	it("a PUBLIC gas-only send claims with the fuel secret it journaled - no top-level copy needed", async () => {
		const send = useSend()
		const id = await send.send(plan({ intent: "gas", gas: { ...gasLeg, fuelAmount: 100_000_000n } }))

		const rec = recordOf(id) as SendDepositRecord
		expect(rec.secret).toBeUndefined()
		// The claim ran on the block's own secret; nothing was left waiting on a missing record secret.
		const view = h.claimFuel.mock.calls[0]?.[3] as DepositRecord
		expect(view.fuel?.secret).toBe("0xfuelsecret")
		expect(useBridgeJournal().runtime.value[id]?.attention).toBeUndefined()
		expect(rec.completedAt).toBeDefined()
	})

	it("every record the send writers produce is a record the backup validator accepts", async () => {
		const send = useSend()
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
		h.depositL1.mockImplementation(fakeDeposit({ token: rewritten }))
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

	it("the deposit hash is journaled the moment it exists, and a failure after it keeps the row", async () => {
		const lost = new Error("network died right after the broadcast")
		h.depositL1.mockImplementation(
			fakeDeposit({
				afterSend: new BridgeError("read-failed", "the Inbox could not be read", "submitted", "never", { cause: lost }),
			}),
		)
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toBe(lost.message)
		// The record survives the failure, so the leg is recoverable from its hash.
		expect(recordOf("0xtokenhash")?.depositTxHash).toBe("0xl1tx")
		expect(useBridgeJournal().runtime.value["0xtokenhash"]?.note).toBe(lost.message)
	})

	it("a reverted L1 receipt surfaces in today's words and leaves the record in place", async () => {
		const reverted = new Error("The Ethereum transaction 0xl1tx reverted on-chain.")
		h.depositL1.mockImplementation(
			fakeDeposit({ afterSend: new BridgeError("deposit-reverted", "reverted", "submitted", "safe", { cause: reverted }) }),
		)
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toBe("bridgeWithPermit() REVERTED (0xl1tx) — no funds moved; inspect the tx and retry")
		expect(recordOf("0xtokenhash")).toBeDefined()
	})

	it("gives up on the deposit's receipt where viem's default wait did, and keeps the row with its hash", async () => {
		h.depositL1.mockImplementation(fakeDeposit({ slowReceipt: true }))
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toBe(new WaitForTransactionReceiptTimeoutError({ hash: "0xl1tx" }).message)
		expect(recordOf("0xtokenhash")?.depositTxHash).toBe("0xl1tx")
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
		expect(h.depositL1).not.toHaveBeenCalled()
	})

	it("hands the SDK the reviewed plan, leaving its own pause read on", async () => {
		await useSend().send(plan())
		expect(h.depositL1.mock.calls[0][3]).toEqual({
			intent: "token",
			token: ERC20,
			amount: 100_000_000n,
			recipient: RECIPIENT,
			isPrivate: false,
			tokenBlock: previewBlock(plan()),
			registers: true,
		})
	})

	const paused = () => new BridgeError("paused", "deposits on sandbox are paused", "none", "after-wait")
	it.each([
		{ name: "a paused route", gate: paused, network: undefined, want: DEPOSITS_PAUSED },
		{ name: "a node that does not answer", gate: undefined, network: () => new Error("fetch failed"), want: BRIDGE_UNCHECKED },
		{
			name: "contracts that are not this release's",
			gate: undefined,
			network: () => new BridgeError("invalid-network", "the deployed contracts are not this release's network: x", "none", "never"),
			want: BRIDGE_UNCHECKED,
		},
		{
			name: "a wallet that moved chain",
			gate: undefined,
			network: () => new BridgeError("wrong-chain", "the Ethereum reads are on chain 1, not 31337", "none", "safe"),
			want: "Your Ethereum wallet is on chain 1, but this bridge lives on chain 31337",
		},
	])("the confirm's check names $name in this app's words", async ({ gate, network, want }) => {
		if (network)
			h.bridgeNetwork.mockImplementation(async () => {
				throw network()
			})
		if (gate)
			h.assertDepositsOpen.mockImplementation(async () => {
				throw gate()
			})
		expect(await useSend().check(plan())).toContain(want)
	})

	it("the confirm's check passes a bridge it read, with the reviewed intent", async () => {
		const net = {}
		h.bridgeNetwork.mockImplementation(async () => net)
		expect(await useSend().check(plan({ intent: "gas" }))).toBeNull()
		expect(h.assertDepositsOpen.mock.calls[0]?.[0]).toBe(net)
		expect(h.assertDepositsOpen.mock.calls[0]?.[2]).toBe("gas")
	})

	const PINNED = { readContract: async () => false, getChainId: async () => 31337 }
	it.each([
		{ name: "a pause it reads", gate: paused, network: undefined, want: DEPOSITS_PAUSED },
		{ name: "a node that does not answer", gate: undefined, network: () => new Error("fetch failed"), want: BRIDGE_UNCHECKED },
		{
			name: "contracts that are not this release's",
			gate: undefined,
			network: () => new BridgeError("invalid-network", "the deployed contracts are not this release's network: x", "none", "never"),
			want: BRIDGE_UNCHECKED,
		},
	])("the cross-chain check refuses $name in this app's words", async ({ gate, network, want }) => {
		h.pinned.value = PINNED
		if (network)
			h.bridgeNetwork.mockImplementation(async () => {
				throw network()
			})
		if (gate)
			h.assertDepositsOpen.mockImplementation(async () => {
				throw gate()
			})
		expect(await useSend().checkCrossChain(plan())).toBe(want)
	})

	it("the cross-chain check reads Ethereum through the pinned reader, never the wallet on the source chain", async () => {
		const net = {}
		h.pinned.value = PINNED
		h.bridgeNetwork.mockImplementation(async () => net)
		expect(await useSend().checkCrossChain(plan({ intent: "gas" }))).toBeNull()
		expect(h.bridgeNetwork.mock.calls[0]?.[0]).toMatchObject({ l1: PINNED })
		expect(h.assertDepositsOpen.mock.calls[0]).toEqual([net, expect.objectContaining({ l1: PINNED }), "gas"])
	})

	it("a build with no pinned Ethereum reader cannot check a cross-chain send, and reads nothing through the wallet", async () => {
		expect(await useSend().checkCrossChain(plan())).toBe(BRIDGE_UNCHECKED)
		expect(h.bridgeNetwork).not.toHaveBeenCalled()
		expect(h.assertDepositsOpen).not.toHaveBeenCalled()
	})

	it("a route the SDK finds paused after the check reads in this app's words", async () => {
		h.depositL1.mockImplementation(async () => {
			throw paused()
		})
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toBe(DEPOSITS_PAUSED)
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

	it("a public first send narrates its approval into a provisional row that the signature names", async () => {
		const seen: { id: string; detail?: string; sender?: string }[] = []
		const only = () => {
			const [row] = useBridgeJournal().records.value as SendDepositRecord[]
			return { id: row.id, detail: useBridgeJournal().runtime.value[row.id]?.stepDetail, sender: row.sender }
		}
		h.writeContract.mockImplementation(async (call: { functionName: string }) => {
			if (call.functionName !== "approve") return "0xl1tx"
			seen.push(only())
			return "0xapprove"
		})
		h.depositL1.mockImplementation(fakeDeposit({ approve: true, afterApproval: () => seen.push(only()) }))
		const id = await useSend().send(plan())

		expect(seen.map((r) => r.detail)).toEqual([
			"first time only: approve Permit2 in your Ethereum wallet",
			"still waiting for the approval (round 1)",
		])
		expect(seen.every((r) => isProvisionalRecordId(r.id) && r.sender === L1_ACCOUNT)).toBe(true)
		// One record: the approve transaction is still on it after the claim hash renames it.
		expect(useBridgeJournal().records.value).toHaveLength(1)
		expect(id).toBe("0xtokenhash")
		expect(recordOf(id)?.approveTxHash).toBe("0xapprove")
		expect(recordOf(id)?.sender).toBe(L1_ACCOUNT)
	})

	it("an approval the user rejects leaves no half-started row behind", async () => {
		h.writeContract.mockImplementation(async () => {
			throw Object.assign(new Error("User rejected the request."), { code: 4001 })
		})
		h.depositL1.mockImplementation(fakeDeposit({ approve: true }))
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toBe("Rejected in wallet.")
		expect(useBridgeJournal().records.value).toHaveLength(0)
		expect(h.signTypedData).not.toHaveBeenCalled()
	})

	it("an approval that fails for another reason leaves a public send no row, and keeps a private send's sealed row", async () => {
		h.writeContract.mockImplementation(async () => {
			throw new Error("HTTP request failed: fetch failed")
		})
		h.depositL1.mockImplementation(fakeDeposit({ approve: true }))
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toMatch(/fetch failed/)
		expect(useBridgeJournal().records.value).toHaveLength(0)

		expect(await send.send(plan({ isPrivate: true }))).toBe("")
		const [kept] = useBridgeJournal().records.value
		expect(kept?.isPrivate).toBe(true)
		expect(useBridgeJournal().runtime.value[kept.id]?.attention).toBe("error")
		expect(useBridgeJournal().runtime.value[kept.id]?.note).toMatch(/fetch failed/)
	})

	it("a private send whose seal the user refuses leaves no row and hears the refusal", async () => {
		h.realSeal.on = true
		h.signMessage.mockImplementation(async () => {
			throw new Error("User rejected the request.")
		})
		const send = useSend()
		expect(await send.send(plan({ isPrivate: true }))).toBe("")
		expect(send.error.value).toBe("Rejected in wallet.")
		expect(useBridgeJournal().records.value).toHaveLength(0)
		expect(h.signTypedData).not.toHaveBeenCalled()
	})

	it("a witness the user refuses discards the row the send had already named, and the review hears the refusal", async () => {
		h.signTypedData.mockImplementation(async () => {
			throw Object.assign(new Error("User rejected the request.\n\nDetails: MetaMask Tx Signature: User denied"), { code: 4001 })
		})
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toBe("Rejected in wallet.")
		expect(useBridgeJournal().records.value).toHaveLength(0)
	})

	it("a failure the chain may hold keeps the named row, with its approval, and names it on the rail", async () => {
		h.writeContract.mockImplementation(async (call: { functionName: string }) => {
			if (call.functionName === "approve") return "0xapprove"
			throw new Error("HTTP request failed: fetch failed")
		})
		h.depositL1.mockImplementation(fakeDeposit({ approve: true }))
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toMatch(/fetch failed/)
		expect(recordOf("0xtokenhash")?.approveTxHash).toBe("0xapprove")
		expect(useBridgeJournal().runtime.value["0xtokenhash"]?.attention).toBe("error")
		expect(useBridgeJournal().runtime.value["0xtokenhash"]?.note).toMatch(/fetch failed/)
	})

	it.each([
		["PXE_STALE_ANCHOR", "Your wallet's view of the network was behind. Try again."],
		["CONTRACT_NOT_REGISTERED", "Couldn't register the app's contracts with your wallet. Reconnect."],
	])("a %s envelope from the send shows its copy at the display seam", async (code, copy) => {
		h.writeContract.mockImplementation(async () => {
			throw new Error(JSON.stringify({ code: -32602, message: "x", data: { walletErrorCode: code } }))
		})
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toBe(copy)
	})

	it("an L1 wallet on another chain refuses before the approval, so nothing is signed and no row survives", async () => {
		h.chainId.value = 1
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toMatch(/on chain 1/)
		expect(h.depositL1).not.toHaveBeenCalled()
		expect(useBridgeJournal().records.value).toHaveLength(0)
	})

	it("a node whose Ethereum reads disagree with the manifest refuses before any prompt, in this app's words", async () => {
		h.bridgeNetwork.mockImplementation(async () => {
			throw new BridgeError("wrong-chain", "the Ethereum reads are on chain 1, not 31337", "none", "safe")
		})
		const send = useSend()
		expect(await send.send(plan())).toBe("")
		expect(send.error.value).toMatch(/Your Ethereum wallet is on chain 1, but this bridge lives on chain 31337/)
		expect(h.depositL1).not.toHaveBeenCalled()
		expect(useBridgeJournal().records.value).toHaveLength(0)
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
	}

	/** A claim that refuses: the send must finish with the record still unclaimed, so the reopened
	 *  journal below has something left to unseal. */
	const refusing = async () => {
		throw new BridgeError("fee-stop", "not claiming in this phase", "submitted", "after-wait", { stop: "fuel-short" })
	}

	/** The salts the reopened claim handed the SDK: only the unsealed envelope can have supplied them. */
	const secretsOf = (entry: typeof h.claimToken) => {
		const run = entry.mock.calls.at(-1)?.[4] as ClaimOptions | undefined
		return { claimSalt: run?.secrets?.claimSalt?.toString(), fuelSalt: run?.secrets?.fuelSalt?.toString() }
	}

	beforeEach(() => {
		h.realSeal.on = true
		h.readRegistration.mockImplementation(async () => frozenRegistration)
		h.rebuiltL2Token.value = token.l2Token
		h.bridgeNetwork.mockImplementation(async () => ({}))
		h.depositL1.mockImplementation(fakeDeposit())
		h.claimToken.mockImplementation(settles)
		h.claimFuel.mockImplementation(settles)
	})

	/** Drop every in-memory trace of the send and re-enter the engine over the stored record alone. */
	async function reopenAndClaim(id: string): Promise<void> {
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
			claimEntries: { token: h.claimToken, fuel: h.claimFuel },
			claimContext: async () => ({ reads: {}, aztec: {}, network: async () => ({}) }),
		} as never)
		useBridgeJournal()
		await runDepositClaim(id, { interactive: true })
	}

	it("a private GAS-ONLY send journals its whole fuel block and seals the salt the claim needs", async () => {
		const send = useSend()
		h.claimFuel.mockImplementationOnce(refusing)
		connectJournalDeps(engineFakes as never)
		const id = await send.send(plan({ isPrivate: true, intent: "gas", gas: { ...gasLeg, fuelAmount: 100_000_000n } }))

		const rec = recordOf(id) as SendDepositRecord
		const salt = rec.fuel?.bridgeSecretSalt as string
		expect(salt).toMatch(/^0x[0-9a-f]{64}$/)
		expect(rec.fuel?.secret).toBe(deriveBridgeSecret(Fr.fromString(salt), AztecAddress.fromStringUnsafe(RECIPIENT)).toString())
		expect(rec.fuel?.secretHashHex).toBe(id)
		expect(rec.fuel?.fpc).toBe(PRIVATE_FPC_ADDRESS)
		expect(rec.sealedEnvelope).toBeTypeOf("string")

		// The envelope carries the salt, so a restore on another device can claim the gas privately.
		const envelope = await openDepositEnvelope(
			await RecoveryKey.derive(async () => SEAL_SIG, recoveryBindingOf(rec, rec.id), "site"),
			rec.sealedEnvelope as string,
		)
		expect(envelope.salt).toBe(salt)
		expect(envelope.secret).toBe(salt)

		await reopenAndClaim(id)
		expect(secretsOf(h.claimFuel)).toEqual({ claimSalt: undefined, fuelSalt: salt })
	})

	it("a private TOKEN+GAS send journals the fuel block AND seals both salts", async () => {
		const send = useSend()
		h.claimToken.mockImplementationOnce(refusing)
		connectJournalDeps(engineFakes as never)
		const id = await send.send(plan({ isPrivate: true, intent: "token+gas", gas: gasLeg }))

		const rec = recordOf(id) as SendDepositRecord
		const salt = rec.fuel?.bridgeSecretSalt as string
		expect(salt).toMatch(/^0x[0-9a-f]{64}$/)
		expect(rec.fuel?.secret).toBe(deriveBridgeSecret(Fr.fromString(salt), AztecAddress.fromStringUnsafe(RECIPIENT)).toString())
		expect(rec.fuel?.leafIndex).toBe("8")
		expect(rec.secret).toBeUndefined()

		const envelope = await openDepositEnvelope(
			await RecoveryKey.derive(async () => SEAL_SIG, recoveryBindingOf(rec, rec.id), "site"),
			rec.sealedEnvelope as string,
		)
		// The token credential and the gas salt are DIFFERENT secrets, and the envelope holds both.
		expect(envelope.salt).toBe(salt)
		expect(envelope.secret).not.toBe(salt)

		await reopenAndClaim(id)
		expect(secretsOf(h.claimToken)).toEqual({ claimSalt: envelope.secret, fuelSalt: salt })
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
