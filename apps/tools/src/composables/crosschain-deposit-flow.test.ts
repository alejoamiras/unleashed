// @vitest-environment node
import { type CrossChainDiscovery, deriveCrossChainDepositStage, ERC20_ABI, openDepositEnvelopeV3 } from "@unleashed/bridge-core"
import { decodeFunctionData, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { stepperPhases } from "@/lib/bridge-steps"
import { crossChainUnconfirmed } from "@/lib/crosschain-steps"
import { ask, BASE_SEPOLIA, DEST_TOKEN, memoryStorage, OUT, quotedRoute, signatureOf, USER } from "@/test/crosschain"
import {
	type CrossChainReads,
	type CrossChainSend,
	type CrossChainWallet,
	crossChainSealKey,
	ROUTE_EXPIRED,
	ROUTE_REFUSED,
	type SourceCall,
	sendCrossChain,
} from "./crosschain-deposit-flow"
import type { CrossChainWatchDeps } from "./crosschain-watch"
import { __resetJournalForTests, currentCrossChainRecord, storedCrossChainRecords, useBridgeJournal } from "./useBridgeJournal"
import { type CrossChainRoute, ROUTE_TTL_MS, routeRecordId } from "./useCrossChainRoute"

const MAX = (1n << 256n) - 1n
const hashOf = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`

beforeEach(() => {
	__resetJournalForTests()
	vi.stubGlobal("localStorage", memoryStorage())
})
afterEach(() => vi.unstubAllGlobals())

/** A wallet that notes, at each source transaction, whether the record was already stored (and sealed). */
function fakeWallet(route: CrossChainRoute, o: { chainId?: number; rejectDeposit?: boolean; batch?: boolean } = {}) {
	const sent: SourceCall[] = []
	const journaledAtSend: boolean[] = []
	const stored = () => currentCrossChainRecord(routeRecordId(route.secrets))
	const wallet: CrossChainWallet = {
		account: USER,
		chainId: async () => o.chainId ?? BASE_SEPOLIA,
		signMessage: async (m) => signatureOf(m),
		sendTransaction: async (call) => {
			const rec = stored()
			journaledAtSend.push(!!rec && (!rec.isPrivate || !!rec.sealedEnvelope))
			sent.push(call)
			if (o.rejectDeposit && call.to === route.tx.to) throw Object.assign(new Error("User rejected the request."), { code: 4001 })
			return hashOf(sent.length)
		},
		...(o.batch
			? {
					batch: {
						atomic: async () => true,
						send: async (calls: readonly SourceCall[]) => {
							sent.push(...calls)
							return "batch-1"
						},
						receipts: async () => [hashOf(42)],
					},
				}
			: {}),
	}
	return { wallet, sent, journaledAtSend }
}

function fakeReads(allowance: bigint, o: { directApprove?: boolean } = {}): CrossChainReads {
	return {
		source: {
			readContract: async () => allowance,
			call: async () => {
				if (o.directApprove === false) throw new Error("execution reverted")
				return { data: undefined }
			},
			getBlockNumber: async () => 100n,
			waitForTransactionReceipt: async () => ({ status: "success" }),
		} as unknown as CrossChainReads["source"],
		ethereum: { getBlockNumber: async () => 200n },
	}
}

const sendOf = (a: ReturnType<typeof ask>, route: CrossChainRoute, quotedAt = Date.now()): CrossChainSend => ({
	ask: a,
	route,
	token: DEST_TOKEN,
	quotedAt,
})

const approvedAmount = (call: SourceCall) => decodeFunctionData({ abi: ERC20_ABI, data: call.data }).args?.[1]

describe("sendCrossChain", () => {
	it("journals and seals before the first source signature, replaces a MAX allowance, then journals the hash", async () => {
		const a = ask({ isPrivate: true })
		const route = await quotedRoute(a)
		const { wallet, sent, journaledAtSend } = fakeWallet(route)
		const id = await sendCrossChain(sendOf(a, route), wallet, fakeReads(MAX), { watch: false })
		expect(journaledAtSend).toEqual([true, true])
		expect(approvedAmount(sent[0])).toBe(5_000_000n)
		expect(sent[1].to).toBe(route.tx.to)
		const rec = currentCrossChainRecord(id)
		if (!rec?.sealedEnvelope) throw new Error("the record must be stored and sealed")
		expect(rec.route.srcTxHash).toBe(hashOf(2))
		expect(deriveCrossChainDepositStage(rec)).toBe("bridging")
		expect([rec.amount, rec.route.srcScanFromBlock, rec.route.scanFromBlock]).toEqual([(OUT - OUT / 10n).toString(), "100", "200"])
		// The private recipient stays out of the plaintext record's claim material; the envelope holds the window.
		expect(rec.secret).toBeUndefined()
		const env = await openDepositEnvelopeV3(crossChainSealKey(id) as never, rec.sealedEnvelope)
		expect([env.minAmount, env.maxAmount]).toEqual([(OUT - OUT / 10n).toString(), OUT.toString()])
	})

	it("refuses a stale, tampered or wrong-chain route before journaling, and drops the record of a refused deposit", async () => {
		const a = ask()
		const route = await quotedRoute(a)
		const { wallet } = fakeWallet(route, { chainId: 1 })
		await expect(sendCrossChain(sendOf(a, route), wallet, fakeReads(0n))).rejects.toThrow(
			/on chain 1, but this route starts on chain 84532/,
		)
		const onChain = fakeWallet(route).wallet
		await expect(sendCrossChain(sendOf(a, route, Date.now() - ROUTE_TTL_MS - 1), onChain, fakeReads(0n))).rejects.toThrow(ROUTE_EXPIRED)
		const tampered = { ...route, tx: { ...route.tx, approval: { ...route.tx.approval, amount: route.tx.approval.amount + 1n } } }
		await expect(sendCrossChain(sendOf(a, tampered), onChain, fakeReads(0n))).rejects.toThrow(ROUTE_REFUSED)
		expect(storedCrossChainRecords()).toEqual([])
		const refusing = fakeWallet(route, { rejectDeposit: true })
		await expect(sendCrossChain(sendOf(a, route), refusing.wallet, fakeReads(0n))).rejects.toThrow(/rejected/)
		expect(refusing.journaledAtSend).toEqual([true, true])
		expect(storedCrossChainRecords()).toEqual([])
	})

	it("sends one atomic batch through a zero allowance first, journals its id then its hash, and starts the watch", async () => {
		const a = ask({ intent: "token" })
		const route = await quotedRoute(a)
		const { wallet, sent } = fakeWallet(route, { batch: true })
		const watch = { context: vi.fn(), reads: vi.fn(() => undefined), claim: vi.fn(), now: Date.now, wait: async () => {} }
		const id = await sendCrossChain(sendOf(a, route), wallet, fakeReads(5n, { directApprove: false }), { wait: async () => {}, watch })
		expect(sent.map((c) => (c.to === route.tx.to ? "deposit" : approvedAmount(c)))).toEqual([0n, 5_000_000n, "deposit"])
		expect(currentCrossChainRecord(id)?.route).toMatchObject({ srcBatchId: "batch-1", srcTxHash: hashOf(42) })
		await vi.waitFor(() => expect(watch.reads).toHaveBeenCalledWith(expect.objectContaining({ id })))
	})

	it("logs the seal, the approval and its receipt, and the send, then leaves the send to discovery", async () => {
		const a = ask({ isPrivate: true })
		const route = await quotedRoute(a)
		const id = await sendCrossChain(sendOf(a, route), fakeWallet(route).wallet, fakeReads(0n), { watch: false })
		const rt = useBridgeJournal().runtime.value[id]
		expect(rt?.log?.map((row) => row.text)).toEqual([
			"sealing the recovery secret on this device",
			"approving 5.00 USDC on Base Sepolia",
			"Base Sepolia confirmed the approval 0x0000…0001",
			"sending on Base Sepolia through LI.FI",
		])
		expect(rt?.step).toBeUndefined()
		expect(rt?.approveOutcome).toBe("done")
		const stored = currentCrossChainRecord(id)
		expect(stored?.approveTxHash).toBe(hashOf(1))
		expect(stored && stepperPhases(stored, {})[0]).toMatchObject({ key: "src-approve", state: "done", link: { text: "0x0000…0001" } })
	})

	it("keeps looking for a send the wallet took without answering, and reads it as in flight once found", async () => {
		const a = ask()
		const route = await quotedRoute(a)
		const { wallet } = fakeWallet(route)
		const silent: CrossChainWallet = {
			...wallet,
			sendTransaction: async (call) => {
				if (call.to === route.tx.to) throw new Error("Request timed out")
				return hashOf(1)
			},
		}
		let find = () => {}
		const searched = new Promise<void>((resolve) => {
			find = resolve
		})
		const found: CrossChainDiscovery = {
			verdict: "pending",
			extraDeposits: [],
			srcTxHash: hashOf(2),
			transport: { kind: "across", originChainId: BASE_SEPOLIA, depositId: "1", relayHash: hashOf(3) },
		}
		const discover = vi.fn(async () => searched.then(() => found))
		const watch: CrossChainWatchDeps = {
			context: async () => ({}) as never,
			reads: () => ({}) as never,
			discover: discover as unknown as CrossChainWatchDeps["discover"],
			claim: vi.fn(),
			now: Date.now,
			// One round is all this test needs.
			wait: () => new Promise(() => {}),
		}
		await expect(sendCrossChain(sendOf(a, route), silent, fakeReads(0n), { watch })).rejects.toThrow(/timed out/)
		const [rec] = storedCrossChainRecords()
		const runtime = useBridgeJournal().runtime
		expect(runtime.value[rec.id]?.attention).toBe("error")
		expect(crossChainUnconfirmed(rec, runtime.value[rec.id])).toBe(true)
		await vi.waitFor(() => expect(discover).toHaveBeenCalledWith(expect.objectContaining({ id: rec.id }), {}, {}, expect.anything()))
		find()
		await vi.waitFor(() => expect(runtime.value[rec.id]?.attention).toBeUndefined())
		const sent = currentCrossChainRecord(rec.id)
		expect(sent?.route.srcTxHash).toBe(hashOf(2))
		expect(sent && stepperPhases(sent, runtime.value[rec.id]).find((p) => p.key === "bridge")?.state).toBe("active")
	})
})
