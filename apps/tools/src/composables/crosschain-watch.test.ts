// @vitest-environment node
import {
	type CrossChainDiscovery,
	type CrossChainOutcome,
	type DepositEnvelopeV2,
	deriveCrossChainDepositStage,
	openDepositEnvelope,
	predictPortal,
	recoveryKeyFromSignature,
	recoveryKeyMessage,
	type SendDepositRecord,
} from "@unleashed/bridge-core"
import type { Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ask, BASE_SEPOLIA, DEST_TOKEN, memoryStorage, OUT, quotedRoute, SEPOLIA, signatureOf, USER } from "@/test/crosschain"
import { type CrossChainReads, type CrossChainWallet, crossChainSealKey, sendCrossChain } from "./crosschain-deposit-flow"
import { type CrossChainWatchDeps, resumeCrossChainWatches, watchCrossChain } from "./crosschain-watch"
import {
	type ClaimRecord,
	__resetJournalForTests,
	connectJournalDeps,
	currentCrossChainRecord,
	openClaimEnvelope,
	runDepositClaim,
	updateCrossChainRecord,
	useBridgeJournal,
} from "./useBridgeJournal"

const hashOf = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`
let storage: Storage

beforeEach(() => {
	__resetJournalForTests()
	storage = memoryStorage()
	connectJournalDeps({ kv: storage })
	vi.stubGlobal("localStorage", memoryStorage())
})
afterEach(() => vi.unstubAllGlobals())

const wallet: CrossChainWallet = {
	account: USER,
	liveAccount: async () => USER,
	chainId: async () => BASE_SEPOLIA,
	signMessage: async (m) => signatureOf(m),
	sendTransaction: async () => hashOf(1),
}
const reads: CrossChainReads = {
	source: {
		readContract: async () => 0n,
		call: async () => ({ data: undefined }),
		getBlockNumber: async () => 100n,
		waitForTransactionReceipt: async () => ({ status: "success" }),
	} as unknown as CrossChainReads["source"],
	ethereum: { getBlockNumber: async () => 200n },
}

/** A send this session made, journaled and on its way. */
async function sent(over: Parameters<typeof ask>[0] = {}, token = DEST_TOKEN): Promise<string> {
	const a = ask(over)
	return sendCrossChain({ ask: a, route: await quotedRoute(a), token, quotedAt: Date.now() }, wallet, reads, { watch: false })
}

/** A send lane the claim engine accepts: the token's clone as this binding's factory derives it, under the hub. */
const LANE = { factory: `0x${"fa".repeat(20)}`, implementation: `0x${"1e".repeat(20)}`, feeJuicePortal: `0x${"fe".repeat(20)}` }
const LANE_TOKEN = { ...DEST_TOKEN, portal: predictPortal(LANE.factory, LANE.implementation, DEST_TOKEN.address) }

const pending: CrossChainDiscovery = { verdict: "pending", extraDeposits: [] }

/** Our execution completed into the router at token leaf `leaf`; the token leg landed `tokenAmount` (the swap may
 *  leave part of the slice to it). Final once Ethereum finalized its block. */
const deposited = (tokenAmount: string, at: { leaf: number; final: boolean } = { leaf: 7, final: true }): CrossChainDiscovery => ({
	verdict: "deposited",
	extraDeposits: [],
	srcTxHash: hashOf(1),
	deposit: {
		depositTxHash: hashOf(70 + at.leaf),
		received: OUT.toString(),
		token: { amount: tokenAmount, leafIndex: String(at.leaf), messageHash: hashOf(71 + at.leaf) },
		fuel: { consumed: "490000", received: "490000000000000000", leafIndex: String(at.leaf + 1), messageHash: hashOf(72 + at.leaf) },
	},
	decidedAt: { chainId: SEPOLIA, blockNumber: 210n },
	finalized: { chainId: SEPOLIA, blockNumber: at.final ? 210n : 205n },
})

/** An outcome decided at block 300 of its deciding chain, final once that chain finalizes it. */
const ended = (outcome: CrossChainOutcome, final: boolean): CrossChainDiscovery => {
	const chainId = outcome === "not-sent" ? BASE_SEPOLIA : SEPOLIA
	return {
		verdict: outcome,
		extraDeposits: [],
		observation: {
			outcome,
			txHash: hashOf(90),
			decidedAt: { chainId, blockNumber: 300n },
			finalized: { chainId, blockNumber: final ? 300n : 299n },
		},
	}
}

function watchDeps(verdicts: CrossChainDiscovery[]) {
	const stages: string[] = []
	const discover = vi.fn(async (rec: Parameters<typeof deriveCrossChainDepositStage>[0]) => {
		stages.push(deriveCrossChainDepositStage(rec))
		const next = verdicts.shift()
		if (!next) throw new Error("no verdict left")
		return next
	})
	const claim = vi.fn()
	const deps: CrossChainWatchDeps = {
		context: async () => ({}) as never,
		reads: () => ({}) as never,
		discover: discover as unknown as CrossChainWatchDeps["discover"],
		sealKey: crossChainSealKey,
		claim,
		now: () => 1_000,
		wait: async () => {},
	}
	return { deps, discover, claim, stages }
}

describe("the cross-chain watcher", () => {
	it("resumes a record that was bridging when the tab reloaded, and leaves its claim to the user", async () => {
		const id = await sent()
		__resetJournalForTests()
		connectJournalDeps({ kv: storage })
		const w = watchDeps([pending, deposited((OUT - OUT / 10n).toString())])
		resumeCrossChainWatches(w.deps)
		await vi.waitFor(() => expect(w.discover).toHaveBeenCalledTimes(2))
		await vi.waitFor(() => expect(currentCrossChainRecord(id)?.leafIndex).toBe("7"))
		const rec = currentCrossChainRecord(id)
		expect(w.stages).toEqual(["bridging", "bridging"])
		expect(rec && deriveCrossChainDepositStage(rec)).toBe("syncing")
		expect(rec).toMatchObject({ depositTxHash: hashOf(77), amount: "4410000", fuel: { leafIndex: "8", messageHash: hashOf(79) } })
		expect(w.claim).not.toHaveBeenCalled()
	})

	it("logs the rail once discovery proves the send, marks it late past its usual time, and ends at the deposit", async () => {
		const id = await sent()
		const proven: CrossChainDiscovery = {
			...pending,
			srcTxHash: hashOf(1),
			transport: { kind: "across", originChainId: BASE_SEPOLIA, depositId: "1", relayHash: hashOf(5) },
		}
		const w = watchDeps([proven, proven, deposited((OUT - OUT / 10n).toString())])
		let now = (currentCrossChainRecord(id)?.createdAt ?? 0) + 60_000
		const steps: unknown[] = []
		const checks: unknown[] = []
		const journal = useBridgeJournal()
		await watchCrossChain(id, {
			...w.deps,
			now: () => now,
			wait: async () => {
				steps.push(journal.runtime.value[id]?.step)
				checks.push(journal.runtime.value[id]?.checkedAt)
				now += 10 * 60_000
			},
		})
		expect(steps).toEqual(["bridging", "bridging-late"])
		expect(checks).toEqual([now - 20 * 60_000, now - 10 * 60_000])
		expect(journal.runtime.value[id]?.step).toBeUndefined()
		expect(journal.runtime.value[id]?.log?.map((row) => row.text).slice(3)).toEqual([
			"Base Sepolia confirmed 0x0000…0001",
			"LI.FI handed it to Across",
			"waiting for Across to deliver on Ethereum · Sepolia",
			"still in Across, longer than usual",
			"Across delivered 4.90 USDC on Ethereum · Sepolia",
			"LI.FI called the deposit · 0.49 USDC into gas",
			"Ethereum · Sepolia confirmed 0x0000…004d",
		])
	})

	it.each(["delivered-to-wallet", "expired-on-source", "not-sent"] as const)(
		"records %s provisionally, then final once its deciding chain finalizes it",
		async (outcome) => {
			const id = await sent()
			const w = watchDeps([ended(outcome, false), ended(outcome, true)])
			await watchCrossChain(id, w.deps)
			expect(w.stages).toEqual(["bridging", outcome])
			const rec = currentCrossChainRecord(id)
			expect(rec?.route).toMatchObject({ outcome, outcomeTxHash: hashOf(90) })
			expect(rec?.completedAt).toBe(1_000)
			expect(rec?.leafIndex).toBeUndefined()
			expect(w.claim).not.toHaveBeenCalled()
		},
	)

	it.each([
		["with the seal key in memory", true],
		["unsealed by a signature, as after a reload", false],
	])("a deposit re-found at another leaf before finality restarts the claim from the new facts (%s)", async (_label, inMemory) => {
		const id = await sent({ isPrivate: true }, LANE_TOKEN)
		const key = crossChainSealKey(id)
		const sealedV3 = currentCrossChainRecord(id)?.sealedEnvelope
		if (!key || !sealedV3) throw new Error("the record must be sealed")
		const hub = currentCrossChainRecord(id)?.bridge as string
		const builtFor: { leafIndex?: string; sealed?: string }[] = []
		const claimSend = vi.fn(async (rec: SendDepositRecord, _value: string, envelope?: DepositEnvelopeV2) => {
			builtFor.push({ leafIndex: rec.leafIndex, sealed: envelope?.leafIndex })
			return { simulate: async () => {}, send: () => new Promise<never>(() => {}) }
		})
		// Only the messages of the deposit at leaf 9 ever reach Aztec: leaf 7's fill was reorged away.
		const messageReadiness = vi.fn(async (h: string) =>
			h === hashOf(80) || h === hashOf(81) ? { checkpoint: 1, anchor: 1 } : { checkpoint: 5, anchor: 0 },
		)
		const gateWaits: (() => void)[] = []
		const signL1 = vi.fn(async (m: string) => signatureOf(m))
		connectJournalDeps({
			kv: storage,
			signL1,
			connectedL1: () => USER,
			connectedAztec: () => ask().recipient,
			sendBinding: () => ({ ...LANE, hub }),
			validateTokenBlock: async () => null,
			ensureTokenGrant: async () => "granted",
			claimSend,
			claimReceiptStatus: async () => "pending",
			messageReadiness,
			waitMs: () => new Promise<void>((r) => gateWaits.push(r)),
		})
		const verdicts = [
			deposited("4500000", { leaf: 7, final: false }),
			deposited("4500000", { leaf: 9, final: false }),
			deposited("4500000", { leaf: 9, final: true }),
		]
		const discover = vi.fn(async () => verdicts.shift() as CrossChainDiscovery)
		const roundWaits: (() => void)[] = []
		const next = async (rounds: number) => {
			for (const r of roundWaits.splice(0)) r()
			await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(rounds))
		}
		const watching = watchCrossChain(id, {
			...watchDeps([]).deps,
			discover: discover as unknown as CrossChainWatchDeps["discover"],
			sealKey: inMemory ? crossChainSealKey : () => undefined,
			claim: (claimed) => void runDepositClaim(claimed),
			wait: () => new Promise<void>((r) => roundWaits.push(r)),
		})

		// The claim starts at the first deposit and waits for leaf 7's message; the envelope keeps its window.
		await vi.waitFor(() => expect(messageReadiness).toHaveBeenCalledWith(hashOf(78)))
		expect(currentCrossChainRecord(id)?.sealedEnvelope).toBe(sealedV3)

		// Discovery finds the fill again at leaf 9: the waiting claim notices and is rebuilt from the new facts, its
		// material included.
		await next(2)
		await vi.waitFor(() => expect(roundWaits).toHaveLength(1))
		for (const r of gateWaits.splice(0)) r()
		await vi.waitFor(() => expect(claimSend).toHaveBeenCalledTimes(2))
		expect(builtFor).toEqual([
			{ leafIndex: "7", sealed: "7" },
			{ leafIndex: "9", sealed: "9" },
		])
		expect(signL1).toHaveBeenCalledTimes(inMemory ? 0 : 2)
		expect(currentCrossChainRecord(id)?.sealedEnvelope).toBe(sealedV3)

		// Final: the watch ends, and the envelope is re-sealed exact at the leaf that held where the key is at hand.
		await next(3)
		await watching
		const rec = currentCrossChainRecord(id)
		expect(rec?.route.depositFinal).toBe(true)
		if (!inMemory) return expect(rec?.sealedEnvelope).toBe(sealedV3)
		const exact = await openDepositEnvelope(key, rec?.sealedEnvelope as string)
		expect([exact.amount, exact.leafIndex, exact.recipient]).toEqual(["4500000", "9", ask().recipient])
	})

	it("after a reload, the claim's unseal reads the window as the deposit found, exact once final; a deposit outside it is refused", async () => {
		const id = await sent({ isPrivate: true })
		const sealedV3 = currentCrossChainRecord(id)?.sealedEnvelope as string
		const rec = () => currentCrossChainRecord(id) as unknown as ClaimRecord
		// The key the claim derives from one signature, as after a reload that lost the in-memory one.
		const binding = { chainId: rec().chainId, portal: rec().portal, bridge: rec().bridge, secretHashHex: id }
		const key = await recoveryKeyFromSignature(signatureOf(recoveryKeyMessage(binding)))
		updateCrossChainRecord(id, { amount: OUT.toString(), leafIndex: "7" })
		expect(await openClaimEnvelope(key, rec(), sealedV3)).toMatchObject({ amount: OUT.toString(), leafIndex: "7" })
		expect(rec().sealedEnvelope, "a deposit not yet final keeps its window").toBe(sealedV3)
		updateCrossChainRecord(id, (current) => ({ route: { ...current.route, depositFinal: true } }))
		await openClaimEnvelope(key, rec(), sealedV3)
		expect((await openDepositEnvelope(key, rec().sealedEnvelope as string)).leafIndex).toBe("7")
		updateCrossChainRecord(id, { amount: (OUT + 1n).toString() })
		expect(await openClaimEnvelope(key, rec(), sealedV3)).toBeNull()
	})
})
