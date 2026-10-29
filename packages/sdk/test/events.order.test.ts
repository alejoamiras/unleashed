import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Address } from "viem"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { depositToken, quoteBridge, resolveToken } from "../src/bridge/index.ts"
import type { TransferEvent } from "../src/events.ts"
import { depositFuel, quoteFuel } from "../src/fuel/index.ts"
import { parseNetwork } from "../src/network.ts"
import { PERMIT_DEADLINE_SECONDS } from "../src/protocol/l1.ts"
import type { DepositRecord } from "../src/records.ts"
import type { DepositSecrets } from "../src/run.ts"
import { allowanceAfterApprove, readsOf, type Step, testnet, walletOf, worldOf } from "./fakes.ts"

vi.mock("../src/protocol/code-hash.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/protocol/code-hash.ts")>()
	const { syntheticPins } = await import("./fakes.ts")
	return { ...real, CODE_PINS: syntheticPins(real.pinOfBuild) }
})
vi.mock("../src/execution/send-flow.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/send-flow.ts")>()),
	confirmSend: async (_l1: unknown, _g: unknown, s: { tok?: unknown; fuel?: unknown }, txHash: string) => ({
		txHash,
		...(s.tok ? { tokenLeafIndex: 3n, tokenMessageHashHex: `0x${"33".repeat(32)}` } : {}),
		...(s.fuel ? { fuelLeafIndex: 4n, fuelMessageHashHex: `0x${"44".repeat(32)}`, fuelReceived: 5n } : {}),
	}),
}))
vi.mock("../src/execution/hub-l2.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/hub-l2.ts")>()),
	hubBindingAt: async () => undefined,
}))

let recipient: string
beforeAll(async () => {
	recipient = (await AztecAddress.random()).toString()
})

type Entry = { persisted: DepositRecord; secrets?: DepositSecrets } | { event: TransferEvent }

/** The facts an event names, as the persisted record must already hold them. */
function namedFacts(ev: TransferEvent, last: DepositRecord | undefined): [unknown, unknown][] {
	if (ev.type === "approval" && ev.status === "sent") return [[last?.approveTxHash, ev.txHash]]
	if (ev.type === "deposit-sent") return [[last?.depositTxHash, ev.txHash]]
	if (ev.type !== "deposit-confirmed") return []
	return [
		...(ev.leaves.token ? [[last?.leafIndex, ev.leaves.token.leafIndex.toString()] as [unknown, unknown]] : []),
		...(ev.leaves.fuel ? [[last?.fuel?.leafIndex, ev.leaves.fuel.leafIndex.toString()] as [unknown, unknown]] : []),
	]
}

/** Every event naming a fact comes after a persist of a record holding it. */
function assertPersistedFirst(entries: Entry[]): void {
	let last: DepositRecord | undefined
	for (const e of entries) {
		if ("persisted" in e) {
			last = e.persisted
			continue
		}
		for (const [held, named] of namedFacts(e.event, last)) expect(held).toBe(named)
		expect(last?.id).toBe(e.event.id)
	}
}

function recorder() {
	const entries: Entry[] = []
	const run = {
		persist: async (record: DepositRecord, secrets?: DepositSecrets) => {
			entries.push({ persisted: structuredClone(record), ...(secrets ? { secrets } : {}) })
		},
		onEvent: (event: TransferEvent) => {
			entries.push({ event })
		},
	}
	const events = () => entries.flatMap((e) => ("event" in e ? [e.event] : []))
	return { entries, run, events }
}

describe("the events of a deposit", () => {
	it("a public gas-only deposit of the fee asset approving Permit2 first: in order, each fact persisted first", async () => {
		const log: Step[] = []
		const w = worldOf(testnet())
		const feeAsset = w.m.feeJuice.asset as Address
		w.reads.set(`${feeAsset.toLowerCase()}:allowance`, allowanceAfterApprove(log))
		const r = readsOf(w)
		const net = await parseNetwork(w.m, r)
		const quote = await quoteFuel(net, r, { token: feeAsset, amount: 40n * 10n ** 18n, recipient, privacy: "public" })
		const { entries, run, events } = recorder()
		const record = await depositFuel(net, r, walletOf(log, net.l1ChainId), quote, run)
		expect(events().map((e) => (e.type === "approval" ? `approval:${e.status}` : e.type))).toEqual([
			"prepared",
			"approval:requested",
			"approval:sent",
			"approval:confirmed",
			"signature-requested",
			"deposit-sent",
			"deposit-confirmed",
		])
		expect(events().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
		assertPersistedFirst(entries)
		expect(record.fuel?.secret).toBeDefined()
		expect(record.intent).toBe("gas")
	})

	it("the Permit2 deadline is drawn at the signature: an approval that outlasts the window cannot expire the witness", async () => {
		const log: Step[] = []
		const w = worldOf(testnet())
		const feeAsset = w.m.feeJuice.asset as Address
		const approved = allowanceAfterApprove(log)
		const later = w.blockTimestamp + 3600n
		w.reads.set(`${feeAsset.toLowerCase()}:allowance`, () => {
			const allowance = approved()
			if (allowance > 0n) w.blockTimestamp = later
			return allowance
		})
		const r = readsOf(w)
		const net = await parseNetwork(w.m, r)
		const quote = await quoteFuel(net, r, { token: feeAsset, amount: 40n * 10n ** 18n, recipient, privacy: "public" })
		await depositFuel(net, r, walletOf(log, net.l1ChainId), quote, recorder().run)
		const signed = log.find((s) => s.kind === "sign")?.detail as { message: { deadline: bigint } }
		expect(signed.message.deadline).toBe(later + PERMIT_DEADLINE_SECONDS)
	})

	it("a private token + gas deposit with Permit2 already allowed: no approval events, the salts with every persist and in no record or event", async () => {
		const log: Step[] = []
		const w = worldOf(testnet())
		const token = w.m.bridge?.tokens.find((t) => t.erc20.toLowerCase() !== w.m.feeJuice.asset.toLowerCase())
		if (!token || !w.m.bridge?.l1.fuelSwapper) throw new Error("the testnet manifest lists a swapped token")
		const factory = w.m.bridge.l1.factory.toLowerCase()
		w.reads.set(`${factory}:registrationOf`, () => ({
			portal: token.portal,
			decimals: token.decimals,
			registerIndex: 1n,
			nameWord: token.nameWord,
			symbolWord: token.symbolWord,
			registerKey: `0x${"ab".repeat(32)}`,
		}))
		w.reads.set(`${w.m.bridge.l1.fuelSwapper.toLowerCase()}:quote`, (args: readonly unknown[]) => (args[1] as bigint) * 10n ** 13n)
		w.reads.set(`${token.erc20.toLowerCase()}:allowance`, () => (1n << 256n) - 1n)
		const r = readsOf(w)
		const net = await parseNetwork(w.m, r)
		const resolved = await resolveToken(net, r, token.erc20 as Address)
		expect(resolved.state).toBe("portal-only")
		const amount = 100n * 10n ** BigInt(token.decimals)
		const quote = await quoteBridge(net, r, {
			token: resolved,
			amount,
			recipient,
			privacy: "private",
			gas: { txTarget: 2, maxFees: { feePerDaGas: 1n, feePerL2Gas: 1n } },
		})
		const { entries, run, events } = recorder()
		// A deposit signs only floors the SDK quoted: an edited gas leg cannot be written, a rebuilt quote is refused.
		expect(() => Object.assign(quote.gas as object, { minFj: 1n })).toThrow(TypeError)
		await expect(depositToken(net, r, walletOf(log, net.l1ChainId), { ...quote }, run)).rejects.toMatchObject({
			code: "invalid-request",
		})
		expect([entries.length, log.length]).toEqual([0, 0])
		const record = await depositToken(net, r, walletOf(log, net.l1ChainId), quote, run)
		expect(events().map((e) => e.type)).toEqual(["prepared", "signature-requested", "deposit-sent", "deposit-confirmed"])
		assertPersistedFirst(entries)
		// Every persist carries the salts, so a store that keeps only the latest pair never loses them.
		const persists = entries.filter((e) => "persisted" in e)
		const secrets = persists.map((e) => ("secrets" in e ? e.secrets : undefined))
		expect(secrets.every((x) => x === secrets[0] && x !== undefined)).toBe(true)
		const salts = [secrets[0]?.claimSalt, secrets[0]?.fuelSalt].map((s) => (s as Fr).toString())
		expect(salts.every((s) => Fr.fromHexString(s) instanceof Fr)).toBe(true)
		const published = JSON.stringify(
			entries.map((e) => ("persisted" in e ? e.persisted : e.event)),
			(_, v) => (typeof v === "bigint" ? v.toString() : v),
		)
		for (const s of salts) expect(published).not.toContain(s.slice(2))
		expect([record.intent, record.registers, record.secret, record.fuel?.secret]).toEqual(["token+gas", true, undefined, undefined])
	})
})
