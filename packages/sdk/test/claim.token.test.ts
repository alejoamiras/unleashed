import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "vitest"
import { claimToken } from "../src/bridge/index.ts"
import { ladderEnvOf, openClaim } from "../src/execution/claim-run.ts"
import type { BridgeError } from "../src/errors.ts"
import type { TransferEvent } from "../src/events.ts"
import type { SendOpts } from "../src/execution/hub-l2.ts"
import { type Network, parseNetwork } from "../src/network.ts"
import type { DepositRecord, JournalTokenBlock } from "../src/records.ts"
import { readsOf, testnet, worldOf } from "./fakes.ts"

vi.mock("../src/protocol/code-hash.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/protocol/code-hash.ts")>()
	const { syntheticPins } = await import("./fakes.ts")
	return { ...real, CODE_PINS: syntheticPins(real.pinOfBuild) }
})
const hub = vi.hoisted(() => ({
	bound: true,
	claimViaHub: undefined as unknown as Mock<(hub: unknown, p: unknown, send: SendOpts) => Promise<unknown>>,
}))
vi.mock("../src/execution/hub-l2.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/hub-l2.ts")>()),
	hubBindingAt: async () => undefined,
	hubAt: () => ({}),
	hubTokenFor: async () => (hub.bound ? "0x01" : undefined),
	probeHubClaim: async () => ({}),
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
const fuelSends = vi.hoisted(() => ({ count: 0, stop: undefined as string | undefined }))
vi.mock("../src/execution/fuel-claim.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/execution/fuel-claim.ts")>()
	const { feeStopInteraction } = await import("../src/execution/fee-stop.ts")
	return {
		...real,
		buildFuelClaimInteraction: async () =>
			fuelSends.stop
				? feeStopInteraction(fuelSends.stop as never)
				: {
						simulate: async () => ({}),
						send: async () => {
							fuelSends.count++
							return { txHash: FUEL_HASH }
						},
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

let account: AztecAddress
beforeAll(async () => {
	account = await AztecAddress.random()
})
afterEach(() => {
	vi.useRealTimers()
	hub.bound = true
	fuelSends.count = 0
	fuelSends.stop = undefined
})

/** A testnet whose node answers the arrival gates at once, and the receipts the test names per transaction. */
async function setup(receipts: Record<string, { status: string }[]> = {}) {
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
		getNullifierMembershipWitness: async () => undefined,
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
		secret: Fr.random().toString(),
		secretHashHex: `0x${"0a".repeat(32)}`,
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
		expect(rec.types()).toEqual(["claimable", "claim-sent", "settled"])
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

	it("resumes a sent claim that landed without sending again", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const rec = recorder()
		const out = await claimToken(net, r, aztec, tokenRecord(net, { claimTxHash: CLAIM_HASH }), rec.run)
		expect([out.txHash, send.mock.calls.length, rec.types()]).toEqual([CLAIM_HASH, 0, ["settled"]])
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
		expect(rec.types()).toEqual(["claimable", "registration-sent", "claim-sent", "settled"])
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

	it("a token claim latched without its hash refuses while it may still land, with nothing sent", async () => {
		const { net, r, aztec } = await setup()
		const send = claims()
		const latched = tokenRecord(net, { claimAttempt: true, claimAttemptAt: Date.now() })
		const e = await failure(claimToken(net, r, aztec, latched, recorder().run))
		expect([e.code, e.retry, send.mock.calls.length]).toEqual(["claim-not-visible", "after-wait", 0])
	})
})
