import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { computeSecretHash } from "@aztec-labs/stdlib/hash"
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "vitest"
import { claimToken } from "../src/bridge/index.ts"
import { resolveHubClaimSendOpts } from "../src/execution/fee-ladder.ts"
import { claimFuel } from "../src/fuel/index.ts"
import { ladderEnvOf, openClaim } from "../src/execution/claim-run.ts"
import type { BridgeError } from "../src/errors.ts"
import type { TransferEvent } from "../src/events.ts"
import type { SendOpts } from "../src/execution/hub-l2.ts"
import { consumedMessageNullifier } from "../src/execution/message-nullifier.ts"
import { type Network, parseNetwork } from "../src/network.ts"
import { feeJuiceAddress } from "../src/protocol/fee-juice.ts"
import { tokenClaimSecretHash } from "../src/protocol/claim-secret.ts"
import { deriveBridgeSecret } from "../src/protocol/private-fuel.ts"
import type { DepositRecord, JournalTokenBlock } from "../src/records.ts"
import { readsOf, testnet, worldOf } from "./fakes.ts"

vi.mock("../src/protocol/generation-record.ts", async (importOriginal) =>
	(await import("./fakes.ts")).withSyntheticCode(await importOriginal()),
)
const hub = vi.hoisted(() => ({
	bound: true,
	/** Simulates the hub refuses as not ready yet, before one passes. */
	notReady: 0,
	/** The error every ready simulate throws instead of passing: a spent message's wording. */
	spent: undefined as string | undefined,
	probes: 0,
	claimViaHub: undefined as unknown as Mock<(hub: unknown, p: unknown, send: SendOpts) => Promise<unknown>>,
}))
vi.mock("../src/execution/hub-l2.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/hub-l2.ts")>()),
	hubBindingAt: async () => undefined,
	hubAt: () => ({}),
	hubTokenFor: async () => (hub.bound ? "0x01" : undefined),
	probeHubClaim: async () => {
		hub.probes++
		if (hub.notReady === 0) {
			if (hub.spent) throw new Error(hub.spent)
			return {}
		}
		hub.notReady--
		throw new Error("No L1 to L2 message found")
	},
	claimViaHub: (h: unknown, p: unknown, send: SendOpts) => hub.claimViaHub(h, p, send),
}))
vi.mock("../src/execution/fee-ladder.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/fee-ladder.ts")>()),
	resolveHubClaimSendOpts: vi.fn(async () => ({ kind: "opts", opts: {} })),
}))
vi.mock("../src/execution/factory-registry.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/factory-registry.ts")>()),
	readRegistration: async () => ({ ...fixture.token, registerKey: REGISTER_KEY, registerIndex: 7n }),
}))
/** The token message's nullifier reading: the fixture's message hash is not derived from its facts, so a test that
 *  wants the real derivation sets undefined. */
const tokenMessage = vi.hoisted(() => ({ state: "live" as string | undefined }))
vi.mock("../src/execution/message-nullifier.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/execution/message-nullifier.ts")>()
	return {
		...real,
		hubMessageState: (...args: Parameters<typeof real.hubMessageState>) =>
			tokenMessage.state ? Promise.resolve(tokenMessage.state) : real.hubMessageState(...args),
	}
})
/** The route each leaf recovery read the deposit's event through; `noFuel` makes the event carry no gas leaf. */
const leafReads = vi.hoisted(() => ({ routes: [] as unknown[], noFuel: false }))
vi.mock("../src/execution/send-flow.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/send-flow.ts")>()),
	readSendInbox: async () => "0x0000000000000000000000000000000000000001",
	readSendReceiptLeaves: async (route: unknown) => {
		leafReads.routes.push(route)
		if (leafReads.noFuel) return { tokenLeafIndex: 3n, tokenMessageHashHex: `0x${"03".repeat(32)}` }
		return {
			tokenLeafIndex: 3n,
			tokenMessageHashHex: `0x${"03".repeat(32)}`,
			fuelLeafIndex: 4n,
			fuelMessageHashHex: `0x${"04".repeat(32)}`,
			fuelReceived: 5n * 10n ** 18n,
		}
	},
}))
/** Every gas claim the SDK builds: how it is paid, and with which salt and fee contract. */
const fuelSends = vi.hoisted(() => ({
	count: 0,
	stop: undefined as string | undefined,
	/** The error the gas claim's simulate throws instead of passing. */
	spent: undefined as string | undefined,
	built: [] as { isPrivate: boolean; salt?: string; fpc: string }[],
}))
vi.mock("../src/execution/fuel-claim.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/execution/fuel-claim.ts")>()
	const { feeStopInteraction } = await import("../src/execution/fee-stop.ts")
	return {
		...real,
		buildFuelClaimInteraction: async (rec: { isPrivate: boolean }, deps: { resolvedSalt?: string; privateFpc: string }) => {
			fuelSends.built.push({ isPrivate: rec.isPrivate, salt: deps.resolvedSalt, fpc: deps.privateFpc })
			return fuelSends.stop
				? feeStopInteraction(fuelSends.stop as never)
				: {
						simulate: async () => {
							if (fuelSends.spent) throw new Error(fuelSends.spent)
							return {}
						},
						send: async () => {
							fuelSends.count++
							return { txHash: FUEL_HASH }
						},
					}
		},
	}
})
vi.mock("../src/execution/wallet-fee-budget.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/wallet-fee-budget.ts")>()),
	walletMaxFees: async () => ({ feePerDaGas: 1n, feePerL2Gas: 1n }),
}))
/** The testnet manifest's first token, whose words derive its listed Aztec token. */
const fixture = vi.hoisted(() => ({ token: undefined as unknown as JournalTokenBlock }))
const REGISTER_KEY = `0x${"cc".repeat(32)}`
const CLAIM_HASH = `0x${"0c".repeat(32)}`
const REGISTER_HASH = `0x${"0b".repeat(32)}`
const FUEL_HASH = `0x${"0f".repeat(32)}`
const TOKEN_MESSAGE = `0x${"03".repeat(32)}`
const FUEL_MESSAGE = `0x${"04".repeat(32)}`
/** A private consume's wording, which names the message it found spent; a public consume's names none. */
const spentWording = (messageHash: string) => `No non-nullified L1 to L2 message found for message hash ${messageHash}`
const PUBLIC_SPENT = "Assertion failed: L1-to-L2 message is already nullified"

let account: AztecAddress
/** The token leg's claim values and the secret hashes they derive: a public record's secret, a private one's salt. */
const claimSecret = Fr.random()
const claimSalt = Fr.random()
let publicHash: string
let privateHash: string
beforeAll(async () => {
	account = await AztecAddress.random()
	publicHash = (await computeSecretHash(claimSecret)).toString()
	privateHash = (await tokenClaimSecretHash(claimSalt, account)).toString()
})
afterEach(() => {
	vi.useRealTimers()
	vi.mocked(resolveHubClaimSendOpts).mockClear()
	hub.bound = true
	hub.notReady = 0
	hub.spent = undefined
	hub.probes = 0
	leafReads.routes = []
	leafReads.noFuel = false
	tokenMessage.state = "live"
	fuelSends.count = 0
	fuelSends.stop = undefined
	fuelSends.spent = undefined
	fuelSends.built = []
})

/** A testnet whose node answers the arrival gates at once, the receipts the test names per transaction, and the
 *  nullifiers it names as checkpointed. */
async function setup(receipts: Record<string, { status: string }[]> = {}, nullified: ReadonlySet<string> = new Set()) {
	const w = worldOf(testnet())
	const t = w.m.bridge?.tokens[0]
	if (!t) throw new Error("the testnet manifest lists a token")
	fixture.token = {
		erc20: t.erc20,
		portal: t.portal,
		l2Token: t.l2Token,
		nameWord: t.nameWord,
		symbolWord: t.symbolWord,
		decimals: t.decimals,
		displaySymbol: "TKN",
		registerKey: REGISTER_KEY,
		registerIndex: "7",
	}
	const base = readsOf(w)
	const node = {
		...(base.aztecNode as object),
		getL1ToL2MessageIndex: async () => 0n,
		getBlockData: async () => ({ header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: 1024 } } } }),
		getTxReceipt: async (h: { toString(): string }) => {
			const queue = receipts[h.toString()] ?? [{ status: "checkpointed" }]
			return queue.length > 1 ? queue.shift() : queue[0]
		},
		getNullifierMembershipWitness: async (_at: string, n: Fr) => (nullified.has(n.toString()) ? {} : undefined),
	}
	const r = { ...base, aztecNode: node as never }
	const net = await parseNetwork(w.m, r)
	const wallet = {
		getChainInfo: async () => ({ chainId: new Fr(BigInt(net.l1ChainId)), version: new Fr(BigInt(net.rollupVersion)) }),
	}
	return { net, r, aztec: { wallet: wallet as never, account } }
}

function tokenRecord(net: Network, patch: Partial<DepositRecord> = {}): DepositRecord {
	return {
		schema: 3,
		id: `0x${"0a".repeat(32)}`,
		direction: "deposit",
		intent: "token",
		token: fixture.token,
		isPrivate: false,
		amount: "100",
		createdAt: 1,
		updatedAt: 1,
		chainId: net.l1ChainId,
		portal: fixture.token.portal,
		bridge: net.bridge?.hub as string,
		recipient: account.toString(),
		secret: claimSecret.toString(),
		secretHashHex: patch.isPrivate ? privateHash : publicHash,
		depositTxHash: `0x${"d0".repeat(32)}`,
		leafIndex: "3",
		messageHash: `0x${"03".repeat(32)}`,
		...patch,
	} as DepositRecord
}

type Entry = { persisted: DepositRecord } | { event: TransferEvent }

function recorder() {
	const entries: Entry[] = []
	const run = {
		persist: async (record: DepositRecord) => {
			entries.push({ persisted: structuredClone(record) })
		},
		onEvent: (event: TransferEvent) => {
			entries.push({ event })
		},
	}
	const types = () => entries.flatMap((e) => ("event" in e ? [e.event.type] : []))
	const heldBefore = (type: string) => {
		const i = entries.findIndex((e) => "event" in e && e.event.type === type)
		return entries
			.slice(0, i)
			.flatMap((e) => ("persisted" in e ? [e.persisted] : []))
			.at(-1)
	}
	return { entries, run, types, heldBefore }
}

/** A public gas leg whose message the node has ingested, with its plaintext claim secret. */
function publicFuel() {
	return {
		amount: "1",
		secret: Fr.random().toString(),
		secretHashHex: `0x${"0e".repeat(32)}`,
		minOutput: "1",
		leafIndex: "4",
		messageHash: `0x${"04".repeat(32)}`,
		received: (5n * 10n ** 18n).toString(),
	}
}

/** A hub that claims plainly, or registers first through the seams when `register` is set. */
function claims(register = false) {
	hub.claimViaHub = vi.fn(async (_hub: unknown, _p: unknown, send: SendOpts) => {
		if (register) {
			await send.onRegisterSend?.()
			await send.onRegistered?.(REGISTER_HASH)
		}
		await send.onClaimSend?.()
		return { path: register ? "register,claim" : "claim", claimTxHash: CLAIM_HASH }
	})
	return hub.claimViaHub
}

/** Advances the fake clock until `p` settles, however many waits it starts. */
async function drive<T>(p: Promise<T>): Promise<T> {
	let done = false
	p.then(
		() => {
			done = true
		},
		() => {
			done = true
		},
	)
	while (!done) await vi.advanceTimersByTimeAsync(1000)
	return p
}

const failure = (p: Promise<unknown>) =>
	p.then(
		() => expect.unreachable("the claim resolved"),
		(e: unknown) => e as BridgeError,
	)

describe("claimToken", () => {
	it("claims a registered token: claim-sent after its hash persisted, settled after completion persisted", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const rec = recorder()
		const out = await claimToken(net, r, aztec, tokenRecord(net), rec.run)
		expect([out.via, out.txHash, send.mock.calls.length]).toEqual(["claim", CLAIM_HASH, 1])
		expect(rec.types()).toEqual([
			"arrival",
			"arrival",
			"claimable",
			"claim-requested",
			"claim-sent",
			"claim-waiting",
			"claim-landed",
			"settled",
		])
		expect(rec.heldBefore("claim-sent")?.claimTxHash).toBe(CLAIM_HASH)
		expect(rec.heldBefore("settled")?.completedAt).toBeDefined()
	})

	it("refuses a record whose Aztec token the hub does not derive, before any wallet call", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const elsewhere = { ...fixture.token, l2Token: `0x${"0f".repeat(32)}` }
		const e = await failure(claimToken(net, r, aztec, tokenRecord(net, { token: elsewhere } as Partial<DepositRecord>), recorder().run))
		expect([e.code, e.retry, send.mock.calls.length]).toEqual(["invalid-request", "never", 0])
	})

	it("resumes a sent claim that landed without sending again, once its message's nullifier shows", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const { net, r, aztec } = await setup()
		const send = claims()
		const rec = recorder()
		const readings = ["live", "nullified"]
		tokenMessage.state = undefined
		const nullifier = vi.spyOn(await import("../src/execution/message-nullifier.ts"), "hubMessageState")
		nullifier.mockImplementation(async () => readings.shift() as never)
		const out = await drive(claimToken(net, r, aztec, tokenRecord(net, { claimTxHash: CLAIM_HASH }), rec.run))
		nullifier.mockRestore()
		expect([out.txHash, send.mock.calls.length]).toEqual([CLAIM_HASH, 0])
		const stages = rec.entries.flatMap((e) => ("event" in e && e.event.type === "claim-verifying" ? [e.event.stage] : []))
		expect(stages).toEqual(["checking", "wallet-sync", "checking"])
		expect(rec.types().slice(-2)).toEqual(["claim-landed", "settled"])
	})

	it("a registration that dropped is cleared and registered again", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const { net, r, aztec } = await setup({ [REGISTER_HASH]: Array(3).fill({ status: "dropped" }) })
		hub.bound = false
		const send = claims(true)
		const rec = recorder()
		const run = claimToken(net, r, aztec, tokenRecord(net, { registerTxHash: REGISTER_HASH }), rec.run)
		await drive(run)
		const cleared = rec.entries.findIndex((e) => "persisted" in e && e.persisted.registerTxHash === undefined)
		expect([cleared >= 0, send.mock.calls.length]).toEqual([true, 1])
		expect(rec.types()).toEqual([
			"arrival",
			"arrival",
			"claimable",
			"registration-requested",
			"registration-sent",
			"claim-requested",
			"claim-sent",
			"claim-waiting",
			"claim-landed",
			"settled",
		])
		expect(rec.heldBefore("registration-sent")?.registerTxHash).toBe(REGISTER_HASH)
	})

	it("a registration that mined claims plainly; one still in flight refuses with nothing sent", async () => {
		const mined = await setup()
		const send = claims()
		await claimToken(mined.net, mined.r, mined.aztec, tokenRecord(mined.net, { registerTxHash: REGISTER_HASH }), recorder().run)
		expect(send.mock.calls.length).toBe(1)
		const pending = await setup({ [REGISTER_HASH]: [{ status: "proposed" }] })
		hub.bound = false
		const again = claims(true)
		const rec = tokenRecord(pending.net, { registerTxHash: REGISTER_HASH })
		const e = await failure(claimToken(pending.net, pending.r, pending.aztec, rec, recorder().run))
		expect([e.code, e.retry, again.mock.calls.length]).toEqual(["claim-not-visible", "after-wait", 0])
	})

	it("a private claim without its claim salt refuses before any wallet call", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const e = await failure(claimToken(net, r, aztec, tokenRecord(net, { isPrivate: true, secret: undefined }), recorder().run))
		expect([e.code, send.mock.calls.length]).toEqual(["invalid-request", 0])
	})

	it("the fee ladder reads the caller's sealed fuel salt, and no persisted record holds it", async () => {
		const { net, r, aztec } = await setup()
		const rec = recorder()
		const fuelSalt = Fr.random()
		const record = tokenRecord(net, { intent: "token+gas", isPrivate: true, fuel: publicFuel() } as Partial<DepositRecord>)
		const leg = await openClaim(net, r, aztec, record, { ...rec.run, secrets: { fuelSalt } }, "token")
		const env = ladderEnvOf(leg)
		expect(env.records.current(record.id)?.fuel?.bridgeSecretSalt).toBe(fuelSalt.toString())
		env.records.mergeWhen(
			record.id,
			() => true,
			(cur) => ({ fuel: { ...(cur.fuel as NonNullable<DepositRecord["fuel"]>), claimAttempt: true } }),
		)
		await leg.persisted
		const persisted = rec.entries.flatMap((e) => ("persisted" in e ? [e.persisted] : []))
		expect(persisted.map((p) => [p.fuel?.claimAttempt, p.fuel?.bridgeSecretSalt])).toEqual([[true, undefined]])
	})

	it("a public attempt latched without its hash and aged past landing is lifted, and the gas the claim left lands before the record settles", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const rec = recorder()
		const latched = { ...publicFuel(), claimAttempt: true, claimAttemptAt: Date.now() - 60 * 60_000 }
		await claimToken(net, r, aztec, tokenRecord(net, { intent: "token+gas", fuel: latched } as Partial<DepositRecord>), rec.run)
		expect([send.mock.calls.length, fuelSends.count]).toEqual([1, 1])
		expect(rec.types().filter((t) => t === "claim-sent")).toHaveLength(2)
		const lifted = rec.entries.findIndex((e) => "persisted" in e && e.persisted.fuel?.claimAttempt === false)
		expect(lifted).toBeGreaterThanOrEqual(0)
		expect(rec.heldBefore("settled")?.fuel?.consumed).toBe(true)
	})

	it("a token block the deposit never froze is replaced by the factory's registration, words and all", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const rec = recorder()
		const predicted = { ...fixture.token, nameWord: `0x${"dd".repeat(32)}`, registerKey: undefined, registerIndex: undefined }
		await claimToken(net, r, aztec, tokenRecord(net, { token: predicted } as Partial<DepositRecord>), rec.run)
		expect(send.mock.calls.length).toBe(1)
		const frozen = rec.heldBefore("claim-sent")?.token
		expect([frozen?.nameWord, frozen?.registerKey, frozen?.registerIndex, frozen?.l2Token]).toEqual([
			fixture.token.nameWord,
			REGISTER_KEY,
			"7",
			fixture.token.l2Token,
		])
	})

	it("gas too small to pay for its own claim does not hold a landed token claim open: it settles, saying why", async () => {
		const { net, r, aztec } = await setup()
		claims()
		fuelSends.stop = "below-claim-floor"
		const rec = recorder()
		const out = await claimToken(
			net,
			r,
			aztec,
			tokenRecord(net, { intent: "token+gas", fuel: publicFuel() } as Partial<DepositRecord>),
			rec.run,
		)
		expect([out.via, out.gasLeft?.code, out.gasLeft?.stop, rec.types().at(-1)]).toEqual([
			"claim",
			"fee-stop",
			"below-claim-floor",
			"settled",
		])
	})

	it("a private gas attempt latched without its hash is spent, and the claim paid from credit, only once the gas claim's simulate fails on its message too", async () => {
		const fuelSalt = Fr.random()
		const fuel = { ...publicFuel(), secret: undefined, claimAttempt: true, claimAttemptAt: Date.now() }
		const spent = await consumedMessageNullifier(
			feeJuiceAddress,
			Fr.fromString(fuel.messageHash),
			deriveBridgeSecret(fuelSalt, account),
		)
		const { net, r, aztec } = await setup({}, new Set([spent.toString()]))
		const send = claims()
		const record = tokenRecord(net, { intent: "token+gas", isPrivate: true, fuel } as Partial<DepositRecord>)
		const secrets = { claimSalt, fuelSalt }
		fuelSends.spent = spentWording(FUEL_MESSAGE)
		const agreed = recorder()
		await claimToken(net, r, aztec, record, { ...agreed.run, secrets })
		expect([send.mock.calls.length, fuelSends.count, agreed.heldBefore("claim-sent")?.fuel?.consumed]).toEqual([1, 0, true])

		// The gas simulate passes, or stops on its fee before it reaches the message: the latch stays, nothing is spent.
		for (const unborne of [
			{ spent: undefined, stop: undefined },
			{ spent: undefined, stop: "fee-limit-spiked" },
		]) {
			Object.assign(fuelSends, unborne)
			const rec = recorder()
			await failure(claimToken(net, r, aztec, record, { ...rec.run, secrets }))
			const held = rec.heldBefore("claim-sent")?.fuel
			expect([held?.claimAttempt, held?.consumed, fuelSends.count]).toEqual([true, undefined, 0])
		}
	})

	it("a registration paid from held credit is latched before its prompt, and storage that refuses the latch stops it", async () => {
		const { net, r, aztec } = await setup()
		hub.bound = false
		const prompts: (DepositRecord | undefined)[] = []
		const rec = recorder()
		hub.claimViaHub = vi.fn(async (_hub: unknown, _p: unknown, send: SendOpts) => {
			await send.onRegisterSend?.()
			prompts.push(rec.entries.flatMap((e) => ("persisted" in e ? [e.persisted] : [])).at(-1))
			await send.onRegistered?.(REGISTER_HASH)
			await send.onClaimSend?.()
			return { path: "register,claim", claimTxHash: CLAIM_HASH }
		})
		const secrets = { claimSalt }
		await claimToken(net, r, aztec, tokenRecord(net, { isPrivate: true }), { ...rec.run, secrets })
		expect(prompts.map((p) => p?.claimAttempt)).toEqual([true])
		expect(rec.heldBefore("registration-sent")).toMatchObject({ registerTxHash: REGISTER_HASH, claimAttempt: false })
		prompts.length = 0
		const refusing = { ...rec.run, secrets, persist: async () => Promise.reject(new Error("quota")) }
		const e = await failure(claimToken(net, r, aztec, tokenRecord(net, { isPrivate: true }), refusing))
		expect([e.code, e.retry, prompts.length]).toEqual(["persist-failed", "safe", 0])
	})

	it("a private token another submitter claimed has its gas claimed as private credit before it settles; without the gas salt it stays open", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		tokenMessage.state = "nullified"
		const fuel = { ...publicFuel(), secret: undefined, fpc: net.privateFpc }
		const record = () => tokenRecord(net, { intent: "token+gas", isPrivate: true, fuel } as Partial<DepositRecord>)
		const rec = recorder()
		const fuelSalt = Fr.random()
		hub.spent = spentWording(TOKEN_MESSAGE)
		const out = await claimToken(net, r, aztec, record(), { ...rec.run, secrets: { claimSalt, fuelSalt } })
		expect([out.via, out.gasLeft, send.mock.calls.length, fuelSends.count]).toEqual(["claimed-elsewhere", undefined, 0, 1])
		expect(fuelSends.built).toEqual([{ isPrivate: true, salt: fuelSalt.toString(), fpc: net.privateFpc }])
		expect(rec.types()).toEqual(["arrival", "arrival", "claim-landed", "claim-requested", "claim-sent", "claim-waiting", "settled"])
		expect(rec.heldBefore("claim-landed")?.claimedByOther).toBe(true)
		expect(rec.heldBefore("settled")).toMatchObject({ claimedByOther: true, fuel: { consumed: true, claimTxHash: FUEL_HASH } })

		const open = recorder()
		const e = await failure(claimToken(net, r, aztec, record(), { ...open.run, secrets: { claimSalt } }))
		expect([e.code, e.retry, fuelSends.count, open.types()]).toEqual([
			"invalid-request",
			"safe",
			1,
			["arrival", "arrival", "claim-landed"],
		])
		expect(e.message).toMatch(/the tokens landed; their bridged gas is not claimed yet/)
	})

	it("a private claim its own gas paid, resumed without secrets, settles with its gas spent", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const fuel = { ...publicFuel(), secret: undefined, fpc: net.privateFpc, claimAttempt: true, claimTxHash: CLAIM_HASH }
		const record = tokenRecord(net, { intent: "token+gas", isPrivate: true, fuel, claimTxHash: CLAIM_HASH } as Partial<DepositRecord>)
		const rec = recorder()
		const out = await claimToken(net, r, aztec, record, rec.run)
		expect([out.via, out.gasLeft, send.mock.calls.length, fuelSends.count]).toEqual(["claim", undefined, 0, 0])
		expect(rec.heldBefore("settled")?.fuel?.consumed).toBe(true)
	})

	it.each(["leafIndex", "messageHash", "received"] as const)(
		"a token + gas record holding its token leaf but no gas %s reads the receipt, so its gas is claimed before it settles",
		async (missing) => {
			const { net, r, aztec } = await setup()
			claims()
			const rec = recorder()
			const { [missing]: _, ...unread } = publicFuel()
			await claimToken(net, r, aztec, tokenRecord(net, { intent: "token+gas", fuel: unread } as Partial<DepositRecord>), rec.run)
			expect(rec.types().slice(0, 2)).toEqual(["deposit-recovery", "deposit-confirmed"])
			expect(leafReads.routes).toEqual([net.bridge])
			expect(rec.heldBefore("deposit-confirmed")?.fuel).toMatchObject({
				leafIndex: "4",
				messageHash: `0x${"04".repeat(32)}`,
				received: (5n * 10n ** 18n).toString(),
			})
			expect(fuelSends.count).toBe(1)
			expect(rec.heldBefore("settled")?.fuel?.consumed).toBe(true)
		},
	)

	it("watchOnly sends and simulates nothing, and a spent reading settles nothing there: the claim stops before its fee", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const unsent = await failure(claimToken(net, r, aztec, tokenRecord(net), { ...recorder().run, watchOnly: true }))
		expect([unsent.code, unsent.retry, vi.mocked(resolveHubClaimSendOpts).mock.calls.length]).toEqual(["needs-prompt", "safe", 0])
		tokenMessage.state = "nullified"
		hub.spent = PUBLIC_SPENT
		const fuel = { ...publicFuel(), claimAttempt: true, claimAttemptAt: Date.now() }
		const spent = await consumedMessageNullifier(feeJuiceAddress, Fr.fromString(fuel.messageHash), Fr.fromString(fuel.secret))
		const both = await setup({}, new Set([spent.toString()]))
		const rec = recorder()
		const record = tokenRecord(both.net, { intent: "token+gas", fuel } as Partial<DepositRecord>)
		const watched = await failure(claimToken(both.net, both.r, both.aztec, record, { ...rec.run, watchOnly: true }))
		const persisted = rec.entries.flatMap((e) => ("persisted" in e ? [e.persisted] : []))
		expect([watched.code, rec.types(), persisted]).toEqual(["needs-prompt", [], []])
		expect([send.mock.calls.length, hub.probes, fuelSends.built.length]).toEqual([0, 0, 0])
	})

	it("claimFuel claims a marked token + gas record's gas and writes no completion: the record's own is its token claim's", async () => {
		const { net, r, aztec } = await setup()
		const gasRun = recorder()
		const marked = tokenRecord(net, { intent: "token+gas", fuel: publicFuel(), claimedByOther: true } as Partial<DepositRecord>)
		const gasOut = await claimFuel(net, r, aztec, marked, gasRun.run)
		const written = gasRun.entries.flatMap((e) => ("persisted" in e ? [e.persisted.completedAt] : []))
		expect([gasOut.record.completedAt, written.every((c) => c === undefined), fuelSends.count]).toEqual([undefined, true, 1])
	})

	it("a claimed-by-other marker the chain no longer bears out is dropped before anything is priced", async () => {
		const { net, r, aztec } = await setup()
		claims()
		const rec = recorder()
		const e = await failure(claimToken(net, r, aztec, tokenRecord(net, { claimedByOther: true }), { ...rec.run, watchOnly: true }))
		expect([e.code, rec.entries.at(-1)]).toEqual([
			"needs-prompt",
			{ persisted: expect.objectContaining({ claimedByOther: undefined }) },
		])
	})

	it("a message that is not the record's refuses before any fee or prompt", async () => {
		const { net, r, aztec } = await setup()
		hub.bound = false
		const send = claims()
		tokenMessage.state = "invalid"
		const e = await failure(claimToken(net, r, aztec, tokenRecord(net), recorder().run))
		expect([e.code, e.retry, vi.mocked(resolveHubClaimSendOpts).mock.calls.length, send.mock.calls.length]).toEqual([
			"message-invalid",
			"never",
			0,
			0,
		])
	})

	it("a resumed claim that reverted clears its hash and throws, sending nothing", async () => {
		const { net, r, aztec } = await setup({ [CLAIM_HASH]: [{ status: "checkpointed", executionResult: "reverted" } as never] })
		const send = claims()
		const rec = recorder()
		const e = await failure(claimToken(net, r, aztec, tokenRecord(net, { claimTxHash: CLAIM_HASH }), rec.run))
		expect([e.code, e.retry, send.mock.calls.length, rec.entries.at(-1)]).toEqual([
			"claim-reverted",
			"safe",
			0,
			{ persisted: expect.objectContaining({ claimTxHash: undefined }) },
		])
	})

	it("a record holding its leaves but no deposit hash claims without searching Ethereum", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const rec = recorder()
		await claimToken(net, r, aztec, tokenRecord(net, { depositTxHash: undefined }), rec.run)
		expect([send.mock.calls.length, rec.types().includes("deposit-recovery")]).toEqual([1, false])
	})

	it("withoutGas pays from held gas and settles with the bridged gas open, which claimFuel then claims", async () => {
		const { net, r, aztec } = await setup()
		claims()
		const record = tokenRecord(net, { intent: "token+gas", fuel: publicFuel() } as Partial<DepositRecord>)
		const early = await failure(claimFuel(net, r, aztec, record, recorder().run))
		expect([early.code, early.retry]).toEqual(["invalid-request", "safe"])
		const out = await claimToken(net, r, aztec, record, { ...recorder().run, withoutGas: true })
		expect(vi.mocked(resolveHubClaimSendOpts).mock.calls[0]?.[1]).toMatchObject({ userOverride: true })
		expect([out.record.completedAt !== undefined, out.record.fuel?.consumed, fuelSends.count]).toEqual([true, undefined, 0])
		const rec = recorder()
		const gas = await claimFuel(net, r, aztec, out.record, rec.run)
		expect([gas.txHash, gas.record.fuel?.consumed, gas.record.completedAt, fuelSends.count]).toEqual([
			FUEL_HASH,
			true,
			out.record.completedAt,
			1,
		])
		expect(rec.types()).toEqual(["claim-requested", "claim-sent", "claim-waiting"])
	})

	it("claimFuel recovers a claimed token + gas record's lost gas leaf from its token route, writing no completion", async () => {
		const { net, r, aztec } = await setup()
		const { leafIndex: _l, messageHash: _m, received: _r, ...lost } = publicFuel()
		const record = tokenRecord(net, { intent: "token+gas", fuel: lost, completedAt: 9 } as Partial<DepositRecord>)
		const rec = recorder()
		const out = await claimFuel(net, r, aztec, record, rec.run)
		expect([out.record.fuel?.leafIndex, out.record.fuel?.consumed, out.record.completedAt, fuelSends.count]).toEqual(["4", true, 9, 1])
		expect(rec.types().slice(0, 2)).toEqual(["deposit-recovery", "deposit-confirmed"])
		expect(leafReads.routes).toEqual([net.bridge])
		leafReads.noFuel = true
		const none = await failure(claimFuel(net, r, aztec, record, recorder().run))
		expect([none.code, none.retry, fuelSends.count]).toEqual(["receipt-mismatch", "never", 1])
	})

	it("a claim value that does not derive the record's secret hash refuses before any read, keeping its marker", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const marked = tokenRecord(net, { isPrivate: true, claimedByOther: true })
		const rec = recorder()
		const e = await failure(claimToken(net, r, aztec, marked, { ...rec.run, secrets: { claimSalt: Fr.random() } }))
		expect([e.code, e.retry, send.mock.calls.length, rec.entries.some((x) => "persisted" in x)]).toEqual([
			"invalid-request",
			"never",
			0,
			false,
		])
		const edited = tokenRecord(net, { secret: Fr.random().toString() })
		expect((await failure(claimToken(net, r, aztec, edited, recorder().run))).code).toBe("invalid-request")
	})

	it("an abort from the event that reports a recovered read settles nothing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const { net, r, aztec } = await setup()
		claims()
		const base = r.aztecNode as unknown as { getTxReceipt(h: unknown): Promise<unknown> }
		const reads = vi.fn((h: unknown) => base.getTxReceipt(h))
		reads.mockImplementationOnce(async () => {
			throw new Error("node down")
		})
		const node = { ...r, aztecNode: { ...(base as object), getTxReceipt: reads } as never }
		const stop = new AbortController()
		const rec = recorder()
		const onEvent = (e: TransferEvent) => {
			rec.run.onEvent(e)
			if (e.type === "claim-waiting" && e.poll === 2 && e.unreachable === 0) stop.abort()
		}
		const e = await drive(failure(claimToken(net, node, aztec, tokenRecord(net), { ...rec.run, onEvent, signal: stop.signal })))
		expect([
			e.code,
			rec.types().includes("claim-landed"),
			rec.entries.some((x) => "persisted" in x && x.persisted.completedAt),
		]).toEqual(["aborted", false, false])
	})

	it("an abort while a latch is written opens no prompt and lifts the latch", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const stop = new AbortController()
		const rec = recorder()
		const persist = async (record: DepositRecord) => {
			await rec.run.persist(record)
			if (record.claimAttempt || record.fuel?.claimAttempt) stop.abort()
		}
		const token = await failure(claimToken(net, r, aztec, tokenRecord(net), { ...rec.run, persist, signal: stop.signal }))
		const last = rec.entries.flatMap((x) => ("persisted" in x ? [x.persisted] : [])).at(-1)
		expect([token.code, send.mock.results.length, rec.types().includes("claim-sent"), last?.claimAttempt]).toEqual([
			"aborted",
			1,
			false,
			false,
		])
		const gasStop = new AbortController()
		const gas = recorder()
		const gasPersist = async (record: DepositRecord) => {
			await gas.run.persist(record)
			if (record.fuel?.claimAttempt) gasStop.abort()
		}
		const record = tokenRecord(net, { intent: "token+gas", fuel: publicFuel(), completedAt: 9 } as Partial<DepositRecord>)
		const e = await failure(claimFuel(net, r, aztec, record, { ...gas.run, persist: gasPersist, signal: gasStop.signal }))
		const held = gas.entries.flatMap((x) => ("persisted" in x ? [x.persisted] : [])).at(-1)
		expect([e.code, fuelSends.count, held?.fuel?.claimAttempt]).toEqual(["aborted", 0, false])
	})

	it("an aborted signal stops the leftover gas claim before its latch or prompt", async () => {
		const { net, r, aztec } = await setup()
		const record = tokenRecord(net, { intent: "token+gas", fuel: publicFuel(), completedAt: 9 } as Partial<DepositRecord>)
		const rec = recorder()
		const e = await failure(claimFuel(net, r, aztec, record, { ...rec.run, signal: AbortSignal.abort() }))
		expect([e.code, fuelSends.count, rec.entries.some((x) => "persisted" in x)]).toEqual(["aborted", 0, false])
	})

	it("a resumed token claim that dropped clears its hash and throws, sending nothing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const { net, r, aztec } = await setup({ [CLAIM_HASH]: Array(3).fill({ status: "dropped" }) })
		const send = claims()
		const rec = recorder()
		const e = await drive(failure(claimToken(net, r, aztec, tokenRecord(net, { claimTxHash: CLAIM_HASH }), rec.run)))
		expect([e.code, e.retry, send.mock.calls.length, rec.entries.at(-1)]).toEqual([
			"claim-dropped",
			"safe",
			0,
			{ persisted: expect.objectContaining({ claimTxHash: undefined }) },
		])
	})

	it("a watch stopped from its own event, or during a read, reads and settles nothing more", async () => {
		const { net, r, aztec } = await setup()
		claims()
		const base = r.aztecNode as unknown as { getTxReceipt(h: unknown): Promise<unknown> }
		const reads = vi.fn((h: unknown) => base.getTxReceipt(h))
		const node = { ...r, aztecNode: { ...(base as object), getTxReceipt: reads } as never }
		const stopAt = new AbortController()
		const rec = recorder()
		const onEvent = (e: TransferEvent) => {
			rec.run.onEvent(e)
			if (e.type === "claim-waiting") stopAt.abort()
		}
		const resumed = tokenRecord(net, { claimTxHash: CLAIM_HASH })
		const e = await failure(claimToken(net, node, aztec, resumed, { ...rec.run, onEvent, signal: stopAt.signal }))
		expect([e.code, reads.mock.calls.length, rec.types().includes("settled")]).toEqual(["aborted", 0, false])

		const midRead = new AbortController()
		reads.mockImplementationOnce(async () => {
			midRead.abort()
			return { status: "checkpointed" } as never
		})
		const late = recorder()
		const e2 = await failure(claimToken(net, node, aztec, resumed, { ...late.run, signal: midRead.signal }))
		expect([e2.code, late.types().includes("claim-landed"), late.entries.some((x) => "persisted" in x)]).toEqual([
			"aborted",
			false,
			false,
		])
	})

	it("a resumed claim's live reading drops a stale marker, and its landing settles as this record's own claim", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const { net, r, aztec } = await setup()
		claims()
		const readings = ["live", "nullified"]
		tokenMessage.state = undefined
		const nullifier = vi.spyOn(await import("../src/execution/message-nullifier.ts"), "hubMessageState")
		nullifier.mockImplementation(async () => readings.shift() as never)
		const rec = recorder()
		const marked = tokenRecord(net, { claimTxHash: CLAIM_HASH, claimedByOther: true })
		const out = await drive(claimToken(net, r, aztec, marked, rec.run))
		nullifier.mockRestore()
		const synced = rec.entries.findIndex((e) => "event" in e && e.event.type === "claim-verifying" && e.event.stage === "wallet-sync")
		const held = rec.entries.slice(0, synced).flatMap((e) => ("persisted" in e ? [e.persisted] : []))
		expect([synced > 0, held.length > 0, held.at(-1)?.claimedByOther]).toEqual([true, true, undefined])
		expect([out.via, out.record.claimedByOther]).toEqual(["claim", undefined])
	})

	it("reports the wallet sync before every simulate, not once", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const { net, r, aztec } = await setup()
		claims()
		hub.notReady = 1
		const rec = recorder()
		await drive(claimToken(net, r, aztec, tokenRecord(net), rec.run))
		const syncs = rec.entries.filter((e) => "event" in e && e.event.type === "arrival" && e.event.stage === "wallet-sync")
		expect(syncs).toHaveLength(2)
	})

	it("a resumed landing whose message reads invalid refuses; one still live keeps watching across calls", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const { net, r, aztec } = await setup()
		claims()
		const resumed = tokenRecord(net, { claimTxHash: CLAIM_HASH })
		tokenMessage.state = "invalid"
		const bad = recorder()
		const e = await failure(claimToken(net, r, aztec, resumed, bad.run))
		expect([e.code, e.retry, bad.types().includes("settled")]).toEqual(["message-invalid", "never", false])

		tokenMessage.state = "live"
		const first = new AbortController()
		const call1 = recorder()
		const onEvent = (ev: TransferEvent) => {
			call1.run.onEvent(ev)
			if (ev.type === "claim-waiting" && ev.poll === 2) first.abort()
		}
		const stopped = await failure(drive(claimToken(net, r, aztec, resumed, { ...call1.run, onEvent, signal: first.signal })))
		expect([stopped.code, call1.types().includes("settled")]).toEqual(["aborted", false])
		tokenMessage.state = "nullified"
		const call2 = recorder()
		const out = await claimToken(net, r, aztec, resumed, call2.run)
		expect([out.via, out.txHash, call2.types().slice(-2)]).toEqual(["claim", CLAIM_HASH, ["claim-landed", "settled"]])
	})

	it("a token claim latched without its hash refuses while it may still land, with nothing sent", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const latched = tokenRecord(net, { claimAttempt: true, claimAttemptAt: Date.now() })
		const e = await failure(claimToken(net, r, aztec, latched, recorder().run))
		expect([e.code, e.retry, send.mock.calls.length]).toEqual(["claim-not-visible", "after-wait", 0])
	})

	it.each([
		["the token message's hash", "public", true, spentWording(TOKEN_MESSAGE), "claimed-elsewhere"],
		["the gas message's hash", "public", true, spentWording(FUEL_MESSAGE), "error"],
		["no hash, on a registered token's public claim", "public", true, PUBLIC_SPENT, "claimed-elsewhere"],
		["no hash, on a registration's probe", "public", false, PUBLIC_SPENT, "error"],
		["no hash, on a private claim", "private", true, PUBLIC_SPENT, "error"],
	] as const)(
		"a spent wording naming %s, on a %s record, counts only for the message it names",
		async (_named, privacy, bound, wording, verdict) => {
			const { net, r, aztec } = await setup()
			const send = claims()
			hub.bound = bound
			hub.spent = wording
			tokenMessage.state = "nullified"
			const rec = recorder()
			const record = tokenRecord(net, {
				intent: "token+gas",
				isPrivate: privacy === "private",
				fuel: publicFuel(),
			} as Partial<DepositRecord>)
			const call = claimToken(net, r, aztec, record, { ...rec.run, secrets: { claimSalt, fuelSalt: Fr.random() } })
			const persisted = () => rec.entries.flatMap((e) => ("persisted" in e ? [e.persisted] : []))
			if (verdict === "claimed-elsewhere") {
				const out = await call
				expect([out.via, out.record.claimedByOther, send.mock.calls.length]).toEqual(["claimed-elsewhere", true, 0])
				return
			}
			const e = await failure(call)
			expect(e.message).toContain(wording)
			expect([send.mock.calls.length, persisted().some((p) => p.completedAt !== undefined || p.claimedByOther)]).toEqual([0, false])
		},
	)

	it("a spent reading the wallet's simulate does not bear out sends the claim; one it bears out settles as claimed elsewhere with nothing sent", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		tokenMessage.state = "nullified"
		const forged = recorder()
		const out = await claimToken(net, r, aztec, tokenRecord(net), forged.run)
		const before = forged.entries.slice(
			0,
			forged.entries.findIndex((e) => "event" in e && e.event.type === "claim-sent"),
		)
		const early = before.flatMap((e) => ("persisted" in e ? [e.persisted] : []))
		expect(early.some((p) => p.completedAt !== undefined || p.claimedByOther)).toBe(false)
		expect([out.via, out.txHash, out.record.claimedByOther, send.mock.calls.length]).toEqual(["claim", CLAIM_HASH, undefined, 1])

		// An earlier claim of ours latched without its hash may be what the reading shows: no second send while it may land.
		const latched = tokenRecord(net, { claimAttempt: true, claimAttemptAt: Date.now() })
		const fresh = await failure(claimToken(net, r, aztec, latched, recorder().run))
		expect([fresh.code, send.mock.calls.length]).toEqual(["claim-not-visible", 1])

		hub.spent = PUBLIC_SPENT
		const ours = await claimToken(net, r, aztec, latched, recorder().run)
		expect([ours.via, ours.record.claimedByOther, ours.record.completedAt !== undefined, send.mock.calls.length]).toEqual([
			"claim",
			undefined,
			true,
			1,
		])
	})

	it.each(["live", "unknown"] as const)("a spent wording beside a %s nullifier reading settles nothing", async (reading) => {
		const { net, r, aztec } = await setup()
		const send = claims()
		tokenMessage.state = reading
		hub.spent = spentWording(TOKEN_MESSAGE)
		const rec = recorder()
		const e = await failure(claimToken(net, r, aztec, tokenRecord(net), rec.run))
		const persisted = rec.entries.flatMap((x) => ("persisted" in x ? [x.persisted] : []))
		expect([e.code, send.mock.calls.length, persisted.some((p) => p.completedAt !== undefined || p.claimedByOther)]).toEqual([
			"read-failed",
			0,
			false,
		])
	})

	it("a landed token's gas the node reads spent is claimed when its simulate passes, and marked spent with no send when it fails on that message", async () => {
		const fuel = publicFuel()
		const spent = await consumedMessageNullifier(feeJuiceAddress, Fr.fromString(fuel.messageHash), Fr.fromString(fuel.secret))
		const { net, r, aztec } = await setup({}, new Set([spent.toString()]))
		claims()
		const record = tokenRecord(net, { intent: "token+gas", fuel } as Partial<DepositRecord>)
		const out = await claimToken(net, r, aztec, record, { ...recorder().run, withoutGas: true })
		const landed = out.record
		const claimed = await claimFuel(net, r, aztec, landed, recorder().run)
		expect([claimed.record.fuel?.consumed, claimed.record.fuel?.claimTxHash, fuelSends.count]).toEqual([true, FUEL_HASH, 1])

		fuelSends.spent = spentWording(FUEL_MESSAGE)
		const settled = await claimFuel(net, r, aztec, landed, recorder().run)
		expect([settled.record.fuel?.consumed, settled.record.fuel?.claimTxHash, fuelSends.count]).toEqual([true, undefined, 1])
	})

	it("a watching resume of a gas attempt latched without its hash that reads spent simulates, sends and settles nothing", async () => {
		const fuel = { ...publicFuel(), claimAttempt: true, claimAttemptAt: Date.now() }
		const spent = await consumedMessageNullifier(feeJuiceAddress, Fr.fromString(fuel.messageHash), Fr.fromString(fuel.secret))
		const { net, r, aztec } = await setup({}, new Set([spent.toString()]))
		claims()
		const rec = recorder()
		const marked = tokenRecord(net, { intent: "token+gas", fuel, claimedByOther: true, completedAt: 5 } as Partial<DepositRecord>)
		const e = await failure(claimFuel(net, r, aztec, marked, { ...rec.run, watchOnly: true }))
		const persisted = rec.entries.flatMap((x) => ("persisted" in x ? [x.persisted] : []))
		expect([e.code, persisted, fuelSends.built.length, fuelSends.count]).toEqual(["needs-prompt", [], 0, 0])
	})
})
