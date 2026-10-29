/**
 * The SDK's public entries driven against the booted sandbox the way an integrator drives them: `parseNetwork` over
 * the deployed manifest, a deposit signed from an Ethereum wallet, a claim sent from the actor's Aztec wallet. The
 * harness only funds the depositor, deploys fresh ERC-20s, keeps L2 blocks coming, teaches the wallet the contracts a
 * user's wallet already holds and reads balances; no bridge-core send helper is on the path under test.
 */
import { TxHash } from "@aztec-labs/aztec.js/tx"
import {
	type DepositRecord,
	type DepositSecrets,
	type JournalTokenBlock,
	type Leaves,
	type Network,
	type Privacy,
	parseNetwork,
	type Reads,
	type TransferEvent,
} from "@unleashed/sdk"
import { type BridgeQuote, claimToken, depositToken, quoteBridge, resolveToken } from "@unleashed/sdk/bridge"
import { type ClaimOutcome, claimFuel, depositFuel, type FuelQuote, quoteFuel } from "@unleashed/sdk/fuel"
import { type Address, erc20Abi, type WalletClient } from "viem"
import { beforeAll, describe, expect, it } from "vitest"
import type { L2Ctx } from "../../scripts/generation"
import { MIN_FJ } from "../../scripts/sandbox/constants"
import { balanceOf, privateCreditOf, privateFpc, settled } from "../../scripts/sandbox/context"
import { freshToken, mint, mintFeeAsset } from "../../scripts/sandbox/l1"
import { l2CtxFor, withBlockHeartbeat } from "../../scripts/sandbox/l2"
import { type ActorContext, freshActor, INTEGRATION, sandbox } from "./sandbox"

// ─── The network, as an integrator holds it ──────────────────────────────────

interface Integrator {
	net: Network
	reads: Reads
	/** The depositor's Ethereum wallet. */
	l1: WalletClient
	depositor: Address
	/** This network builds a block only when a transaction arrives, so a message never becomes claimable while a
	 *  claim waits on a chain that stands still; the relayer's no-ops keep it moving without touching any actor. */
	blocks: L2Ctx
}

let cached: Promise<Integrator> | undefined

function integrator(): Promise<Integrator> {
	cached ??= (async () => {
		const { clients, manifest } = await sandbox()
		const reads: Reads = { l1: clients.l1.pub, aztecNode: clients.l2.node }
		return {
			net: await parseNetwork(manifest, reads),
			reads,
			l1: clients.l1.wallet,
			depositor: clients.l1.account.address,
			blocks: l2CtxFor(clients.l2, clients.l2.relayer),
		}
	})()
	return cached
}

async function fundDepositor(token: Address, amount: bigint): Promise<void> {
	const { clients } = await sandbox()
	const { net } = await integrator()
	const to = clients.l1.account.address
	if (token.toLowerCase() === net.fuel.feeAsset.toLowerCase()) await mintFeeAsset(clients.l1, token, to, amount)
	else await mint(clients.l1, token, to, amount)
}

// ─── What a run reports, and in which order ──────────────────────────────────

type Entry = { persisted: DepositRecord } | { event: TransferEvent }

/** Every persist and event of one SDK call, in the order they happened. `held` is what the caller stored before it. */
function recorder(held?: DepositRecord) {
	const entries: Entry[] = held ? [{ persisted: structuredClone(held) }] : []
	let secrets: DepositSecrets | undefined
	const run = {
		persist: async (record: DepositRecord, s?: DepositSecrets) => {
			entries.push({ persisted: structuredClone(record) })
			secrets ??= s
		},
		onEvent: (event: TransferEvent) => {
			entries.push({ event })
		},
	}
	return {
		run,
		entries,
		events: () => entries.flatMap((e) => ("event" in e ? [e.event] : [])),
		last: () => entries.flatMap((e) => ("persisted" in e ? [e.persisted] : [])).at(-1),
		secrets: () => secrets,
	}
}

type Fact = [name: string, stored: unknown, named: unknown]

function leafFacts(leaves: Leaves, held: DepositRecord | undefined): Fact[] {
	const { token, fuel } = leaves
	const tokenFacts: Fact[] = token
		? [
				["leafIndex", held?.leafIndex, token.leafIndex.toString()],
				["messageHash", held?.messageHash, token.messageHash],
			]
		: []
	const fuelFacts: Fact[] = fuel
		? [
				["fuel.leafIndex", held?.fuel?.leafIndex, fuel.leafIndex.toString()],
				["fuel.messageHash", held?.fuel?.messageHash, fuel.messageHash],
				["fuel.received", held?.fuel?.received, fuel.received.toString()],
			]
		: []
	return [...tokenFacts, ...fuelFacts]
}

/** A gas-only claim's hash lives in its fuel block, a token claim's on the record; a claim the fuel paid for also
 *  latches its hash in the fuel block. */
function claimFacts(txHash: string, payer: string | undefined, held: DepositRecord | undefined): Fact[] {
	const gasOnly = held?.intent === "gas"
	return [
		...(gasOnly ? [] : [["claimTxHash", held?.claimTxHash, txHash] as Fact]),
		...(gasOnly || payer === "fuel" ? [["fuel.claimTxHash", held?.fuel?.claimTxHash, txHash] as Fact] : []),
	]
}

/** The facts an event names, each beside what the last persisted record holds for it. */
function namedFacts(ev: TransferEvent, held: DepositRecord | undefined): Fact[] {
	switch (ev.type) {
		case "approval":
			return ev.status === "sent" ? [["approveTxHash", held?.approveTxHash, ev.txHash]] : []
		case "deposit-sent":
			return [["depositTxHash", held?.depositTxHash, ev.txHash]]
		case "deposit-confirmed":
			return leafFacts(ev.leaves, held)
		case "registration-sent":
			return [["registerTxHash", held?.registerTxHash, ev.txHash]]
		case "claim-sent":
			return claimFacts(ev.txHash, ev.payer, held)
		case "settled":
			return [["completedAt", held?.completedAt !== undefined, true], ...(ev.txHash ? claimFacts(ev.txHash, undefined, held) : [])]
		default:
			return []
	}
}

/** Every event naming a fact comes after a persist of a record holding it, and names that record. */
function assertPersistedFirst(entries: Entry[]): void {
	let held: DepositRecord | undefined
	for (const e of entries) {
		if ("persisted" in e) {
			held = e.persisted
			continue
		}
		expect(e.event.id, `${e.event.type} names the record`).toBe(held?.id)
		for (const [name, stored, named] of namedFacts(e.event, held))
			expect(stored, `${e.event.type}: ${name} persisted first`).toEqual(named)
	}
}

/** The salts a private transfer is claimed with reach no record and no event, across the deposit and its claim. */
function assertSaltsUnpublished(entries: Entry[], secrets: DepositSecrets | undefined): void {
	const salts = [secrets?.claimSalt, secrets?.fuelSalt].flatMap((s) => (s ? [s.toString().slice(2).toLowerCase()] : []))
	expect(salts.length).toBeGreaterThan(0)
	const published = JSON.stringify(
		entries.map((e) => ("persisted" in e ? e.persisted : e.event)),
		(_, v) => (typeof v === "bigint" ? v.toString() : v),
	).toLowerCase()
	for (const salt of salts) expect(published.includes(salt), "a salt reached a persisted record or an event").toBe(false)
}

/** The run's event types in order, after checking their seqs count up from zero. */
function scriptOf(events: TransferEvent[]): string {
	expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
	return events.map((e) => (e.type === "approval" ? `approval:${e.status}` : e.type)).join(" ")
}

/** A claim's fixed script. Arrival readings come once per change in the chain's progress, and a claim reads as
 *  proposed only when a receipt poll lands between proposal and checkpoint: both vary with timing, nothing else does. */
const CLAIM_SCRIPT = /^(arrival )*claimable claim-sent (claim-proposed )?settled$/
/** A record that lost its deposit's hash and leaves reports the leaves it recovered before anything else. */
const RESUMED_CLAIM_SCRIPT = /^deposit-confirmed (arrival )*claimable claim-sent (claim-proposed )?settled$/
/** A private first claim registers the token in a transaction of its own, reported once its hash is stored. */
const REGISTERING_CLAIM_SCRIPT = /^(arrival )*claimable registration-sent claim-sent (claim-proposed )?settled$/

// ─── Deposits and claims through the public entries ──────────────────────────

const GAS_ONLY = 20n * MIN_FJ
const SWAPPED_WHOLE_UNITS = 30n
/** Covers a first-time private claim's two ceilings with room to spare at the sandbox's fees. */
const CREDIT_FUNDING = 100n * MIN_FJ
const TOKEN_DECIMALS = 6
const TOKEN_ONLY_AMOUNT = 10n * 10n ** BigInt(TOKEN_DECIMALS)
const TOKEN_PLUS_GAS_WHOLE_UNITS = 100n
/** Sizes the gas slice for this many ordinary transactions: well inside the half-of-the-deposit cap. */
const TX_TARGET = 10

interface Deposited {
	record: DepositRecord
	secrets?: DepositSecrets
	entries: Entry[]
	/** The Fee Juice the router's `Deposited` reports: what a claim of the gas consumes. Zero without gas. */
	received: bigint
}

/** Runs one deposit and checks its fixed script. Approval events come only when Permit2's allowance is short. */
async function deposit(token: Address, amount: bigint, send: (run: ReturnType<typeof recorder>["run"]) => Promise<DepositRecord>) {
	const { net, reads, depositor } = await integrator()
	await fundDepositor(token, amount)
	const allowance = await reads.l1.readContract({
		address: token,
		abi: erc20Abi,
		functionName: "allowance",
		args: [depositor, net.fuel.permit2],
	})
	const rec = recorder()
	const record = await send(rec.run)
	const approval = allowance < amount ? ["approval:sent", "approval:confirmed"] : []
	expect(scriptOf(rec.events())).toBe(["prepared", ...approval, "signature-requested", "deposit-sent", "deposit-confirmed"].join(" "))
	assertPersistedFirst(rec.entries)
	expect(rec.last()).toEqual(record)
	const secrets = rec.secrets()
	return { record, entries: rec.entries, received: BigInt(record.fuel?.received ?? 0), ...(secrets ? { secrets } : {}) }
}

async function depositGas(a: ActorContext, token: Address, amount: bigint, privacy: Privacy): Promise<Deposited & { quote: FuelQuote }> {
	const { net, reads, l1 } = await integrator()
	const quote = await quoteFuel(net, reads, { token, amount, recipient: a.actor.address.toString(), privacy })
	const d = await deposit(token, amount, (run) => depositFuel(net, reads, l1, quote, run))
	expect(d.received).toBeGreaterThanOrEqual(quote.minFj)
	return { ...d, quote }
}

async function depositTokenOf(
	a: ActorContext,
	erc20: Address,
	amount: bigint,
	privacy: Privacy,
	gas?: { txTarget: number },
): Promise<Deposited & { quote: BridgeQuote }> {
	const { net, reads, l1 } = await integrator()
	const token = await resolveToken(net, reads, erc20)
	const quote = await quoteBridge(net, reads, { token, amount, recipient: a.actor.address.toString(), privacy, ...(gas ? { gas } : {}) })
	const d = await deposit(erc20, amount, (run) => depositToken(net, reads, l1, quote, run))
	expect([d.record.intent, d.record.amount]).toEqual([gas ? "token+gas" : "token", quote.tokenAmount.toString()])
	if (quote.gas) expect(d.received).toBeGreaterThanOrEqual(quote.gas.minFj)
	return { ...d, quote }
}

interface Claimed {
	outcome: ClaimOutcome
	script: string
	payer: string | undefined
	entries: Entry[]
	/** What the claim transaction was charged. */
	fee: bigint
}

async function claimWith(claim: typeof claimFuel, a: ActorContext, record: DepositRecord, secrets?: DepositSecrets): Promise<Claimed> {
	const { net, reads, blocks } = await integrator()
	const rec = recorder(record)
	const signer = { wallet: a.s.l2.wallet, account: a.actor.address }
	const run = { ...rec.run, ...(secrets ? { secrets } : {}) }
	const outcome = await withBlockHeartbeat(blocks, () => claim(net, reads, signer, record, run))
	const events = rec.events()
	assertPersistedFirst(rec.entries)
	expect(outcome.via).toBe("claim")
	expect(outcome.txHash).toBeDefined()
	const sent = events.flatMap((e) => (e.type === "claim-sent" ? [e] : []))
	expect(sent.map((e) => e.txHash)).toEqual([outcome.txHash])
	expect(outcome.record).toEqual(rec.last())
	const receipt = await reads.aztecNode.getTxReceipt(TxHash.fromString(outcome.txHash as string))
	return { outcome, script: scriptOf(events), payer: sent[0]?.payer, entries: rec.entries, fee: receipt.transactionFee ?? 0n }
}

const publicFeeJuiceOf = (a: ActorContext) => () => balanceOf(a.s.feeJuiceL2, a.actor.address, "public")

/** The actor's credit at the PrivateFPC, which the wallet holds locally the way a user's wallet does. */
async function privateCreditReader(a: ActorContext): Promise<() => Promise<bigint>> {
	const fpc = await privateFpc(a.s)
	return () => privateCreditOf(a.s, fpc)
}

/** A credit claim leaves the received Fee Juice less the ceiling the PrivateFPC keeps, which is never below the charge. */
function expectCreditFrom(gained: bigint, received: bigint, fee: bigint): void {
	expect(gained).toBeGreaterThan(0n)
	expect(gained).toBeLessThanOrEqual(received - fee)
}

/** A public claim of gas only pays its own fee out of the Fee Juice it claims: the balance rises by the rest, exactly. */
async function claimGasPublic(a: ActorContext, d: Deposited, script: RegExp, record = d.record): Promise<Claimed> {
	const read = publicFeeJuiceOf(a)
	const before = await read()
	const c = await claimWith(claimFuel, a, record)
	expect([c.payer, c.outcome.record.fuel?.consumed]).toEqual(["fuel", true])
	expect(c.script).toMatch(script)
	const after = await settled(read, (v) => v !== before, "the public Fee Juice after the claim")
	expect(c.fee).toBeGreaterThan(0n)
	expect(after - before).toBe(d.received - c.fee)
	return c
}

async function claimGasPrivate(a: ActorContext, d: Deposited): Promise<Claimed> {
	const read = await privateCreditReader(a)
	const before = await read()
	expect(d.secrets?.fuelSalt).toBeDefined()
	const c = await claimWith(claimFuel, a, d.record, d.secrets)
	expect([c.payer, c.outcome.record.fuel?.consumed]).toEqual(["fuel", true])
	expect(c.script).toMatch(CLAIM_SCRIPT)
	const after = await settled(read, (v) => v > before, "the private credit after the claim")
	expectCreditFrom(after - before, d.received, c.fee)
	return c
}

const tokenBlockOf = (r: DepositRecord): JournalTokenBlock => {
	if (r.intent === "gas") throw new Error("a gas-only record carries no token")
	return r.token
}

/** Claims a token deposit and checks the token leg landed whole in the balance the deposit's privacy names. */
async function claimTokenOf(a: ActorContext, d: Deposited & { quote: BridgeQuote }, script: RegExp, payer: string): Promise<Claimed> {
	const kind = d.record.isPrivate ? "private" : "public"
	// A first claim enqueues the derived Token's constructor, which a wallet builds only for an instance it holds.
	const l2Token = await a.s.l2TokenOf(tokenBlockOf(d.record))
	const read = () => balanceOf(l2Token, a.actor.address, kind)
	// A first-time token's instance is deployed by the claim's registration: there is nothing to read before it.
	const before = d.quote.token.state === "registered" ? await read() : 0n
	const c = await claimWith(claimToken, a, d.record, d.secrets)
	expect(c.script).toMatch(script)
	expect(c.payer).toBe(payer)
	const after = await settled(read, (v) => v !== before, `the ${kind} token balance after the claim`)
	expect(after - before).toBe(BigInt(d.record.amount))
	return c
}

/** Token-only claims pay from gas the account already holds, and nothing is sponsored: the actor first bridges gas into
 *  PrivateFPC credit through the SDK itself, the one held-gas source a wallet without dApp-named payers can use. */
async function holdPrivateCredit(a: ActorContext): Promise<void> {
	const { net } = await integrator()
	await claimGasPrivate(a, await depositGas(a, net.fuel.feeAsset, CREDIT_FUNDING, "private"))
}

/** An ERC-20 with no portal yet: its first deposit creates the portal and its first claim registers it at the hub. */
async function firstTimeToken(symbol: string): Promise<Address> {
	const { clients } = await sandbox()
	return freshToken(clients.l1, { name: `First ${symbol}`, symbol, decimals: TOKEN_DECIMALS }, [], 0n)
}

/** The record as persisted before the deposit's hash: no hash, no leaves, no L2 block read at confirmation. */
function crashedAfterSignature(r: DepositRecord): DepositRecord {
	const omit = <T extends object>(o: T, keys: readonly string[]): T =>
		Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) as T
	if (!r.fuel) throw new Error("a gas-only record carries a fuel block")
	return {
		...omit(r, ["depositTxHash", "leafIndex", "depositL2Block"]),
		fuel: omit(r.fuel, ["leafIndex", "messageHash", "received"]),
	}
}

async function usdt(): Promise<{ erc20: Address; unit: bigint }> {
	const { usdt } = await sandbox()
	return { erc20: usdt.erc20 as Address, unit: 10n ** BigInt(usdt.decimals) }
}

describe.skipIf(!INTEGRATION)("the SDK's entries on the sandbox", () => {
	beforeAll(async () => {
		await integrator()
	})

	it("gas only through the fee asset's identity route, public", async () => {
		const a = await freshActor()
		const { net } = await integrator()
		const d = await depositGas(a, net.fuel.feeAsset, GAS_ONLY, "public")
		expect([d.quote.venue, d.received]).toEqual(["identity", GAS_ONLY])
		await claimGasPublic(a, d, CLAIM_SCRIPT)
	})

	it("gas only through the fee asset's identity route, private credit at the PrivateFPC", async () => {
		const a = await freshActor()
		const { net } = await integrator()
		const d = await depositGas(a, net.fuel.feeAsset, GAS_ONLY, "private")
		expect([d.quote.venue, d.received]).toEqual(["identity", GAS_ONLY])
		const c = await claimGasPrivate(a, d)
		assertSaltsUnpublished([...d.entries, ...c.entries], d.secrets)
	})

	it("gas only through a token the fuel swapper prices, public", async () => {
		const a = await freshActor()
		const { erc20, unit } = await usdt()
		const d = await depositGas(a, erc20, SWAPPED_WHOLE_UNITS * unit, "public")
		expect([d.quote.venue, d.received]).toEqual(["testnetSwapper", d.quote.expectedFj])
		await claimGasPublic(a, d, CLAIM_SCRIPT)
	})

	it("gas only through a token the fuel swapper prices, private credit at the PrivateFPC", async () => {
		const a = await freshActor()
		const { erc20, unit } = await usdt()
		const d = await depositGas(a, erc20, SWAPPED_WHOLE_UNITS * unit, "private")
		expect([d.quote.venue, d.received]).toEqual(["testnetSwapper", d.quote.expectedFj])
		const c = await claimGasPrivate(a, d)
		assertSaltsUnpublished([...d.entries, ...c.entries], d.secrets)
	})

	it("a gas-only record that died right after the signature finds its deposit on Ethereum and claims", async () => {
		const a = await freshActor()
		const { net } = await integrator()
		const d = await depositGas(a, net.fuel.feeAsset, GAS_ONLY, "public")
		const c = await claimGasPublic(a, d, RESUMED_CLAIM_SCRIPT, crashedAfterSignature(d.record))
		const fuel = d.record.fuel
		expect(c.outcome.record).toMatchObject({
			depositTxHash: d.record.depositTxHash,
			fuel: { leafIndex: fuel?.leafIndex, messageHash: fuel?.messageHash, received: fuel?.received },
		})
	})

	it("a first-time token, public: the claim registers it inside itself, paid from held credit", async () => {
		const a = await freshActor()
		await holdPrivateCredit(a)
		const d = await depositTokenOf(a, await firstTimeToken("FPUB"), TOKEN_ONLY_AMOUNT, "public")
		expect([d.quote.token.state, d.record.registers]).toEqual(["first-time", true])
		await claimTokenOf(a, d, CLAIM_SCRIPT, "own-gas")
	})

	it("a first-time token, private: a registration of its own, then the claim, both paid from held credit", async () => {
		const a = await freshActor()
		await holdPrivateCredit(a)
		const d = await depositTokenOf(a, await firstTimeToken("FPRV"), TOKEN_ONLY_AMOUNT, "private")
		expect([d.quote.token.state, d.record.registers]).toEqual(["first-time", true])
		const c = await claimTokenOf(a, d, REGISTERING_CLAIM_SCRIPT, "fpc-credit")
		assertSaltsUnpublished([...d.entries, ...c.entries], d.secrets)
	})

	it("token + gas, public: the claim pays for itself from the Fee Juice it lands", async () => {
		const a = await freshActor()
		const { erc20, unit } = await usdt()
		const d = await depositTokenOf(a, erc20, TOKEN_PLUS_GAS_WHOLE_UNITS * unit, "public", { txTarget: TX_TARGET })
		expect(d.quote.token.state).toBe("registered")
		const readFj = publicFeeJuiceOf(a)
		const fjBefore = await readFj()
		const c = await claimTokenOf(a, d, CLAIM_SCRIPT, "fuel")
		const fjAfter = await settled(readFj, (v) => v !== fjBefore, "the public Fee Juice after the claim")
		expect(c.fee).toBeGreaterThan(0n)
		expect(fjAfter - fjBefore).toBe(d.received - c.fee)
	})

	it("token + gas, private: the PrivateFPC pays the claim from the fuel and keeps the rest as credit", async () => {
		const a = await freshActor()
		const { erc20, unit } = await usdt()
		const d = await depositTokenOf(a, erc20, TOKEN_PLUS_GAS_WHOLE_UNITS * unit, "private", { txTarget: TX_TARGET })
		expect(d.quote.token.state).toBe("registered")
		const readCredit = await privateCreditReader(a)
		const creditBefore = await readCredit()
		const c = await claimTokenOf(a, d, CLAIM_SCRIPT, "fuel")
		const creditAfter = await settled(readCredit, (v) => v > creditBefore, "the private credit after the claim")
		expectCreditFrom(creditAfter - creditBefore, d.received, c.fee)
		assertSaltsUnpublished([...d.entries, ...c.entries], d.secrets)
	})
})
