// @vitest-environment node
import {
	type CrossChainDiscovery,
	type CrossChainOutcome,
	deriveCrossChainDepositStage,
	openDepositEnvelope,
	recoveryKeyFromSignature,
	recoveryKeyMessage,
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
async function sent(over: Parameters<typeof ask>[0] = {}): Promise<string> {
	const a = ask(over)
	return sendCrossChain({ ask: a, route: await quotedRoute(a), token: DEST_TOKEN, quotedAt: Date.now() }, wallet, reads, { watch: false })
}

const pending: CrossChainDiscovery = { verdict: "pending", extraDeposits: [] }

/** Our execution completed into the router; the token leg landed `tokenAmount` (the swap may leave part of the slice to it). */
const deposited = (tokenAmount: string): CrossChainDiscovery => ({
	verdict: "deposited",
	extraDeposits: [],
	srcTxHash: hashOf(1),
	deposit: {
		depositTxHash: hashOf(77),
		received: OUT.toString(),
		token: { amount: tokenAmount, leafIndex: "7", messageHash: hashOf(78) },
		fuel: { consumed: "490000", received: "490000000000000000", leafIndex: "8", messageHash: hashOf(79) },
	},
	decidedAt: { chainId: SEPOLIA, blockNumber: 210n },
	finalized: { chainId: SEPOLIA, blockNumber: 205n },
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
		const journal = useBridgeJournal()
		await watchCrossChain(id, {
			...w.deps,
			now: () => now,
			wait: async () => {
				steps.push(journal.runtime.value[id]?.step)
				now += 10 * 60_000
			},
		})
		expect(steps).toEqual(["bridging", "bridging-late"])
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

	it("re-seals a private deposit exact while its key is in memory, and claims what this session sent", async () => {
		const id = await sent({ isPrivate: true })
		// The swap consumed less than the slice: the token leg lands inside the sealed window, above its floor.
		const w = watchDeps([deposited("4500000")])
		await watchCrossChain(id, w.deps)
		const rec = currentCrossChainRecord(id)
		const key = crossChainSealKey(id)
		if (!rec?.sealedEnvelope || !key) throw new Error("the record must be sealed with its key in memory")
		const exact = await openDepositEnvelope(key, rec.sealedEnvelope)
		expect([exact.amount, exact.leafIndex, exact.recipient]).toEqual(["4500000", "7", ask().recipient])
		expect(w.claim).toHaveBeenCalledWith(id)
	})

	it("after a reload, the claim's unseal re-seals the window exact; a deposit outside it is refused", async () => {
		const id = await sent({ isPrivate: true })
		const sealedV3 = currentCrossChainRecord(id)?.sealedEnvelope as string
		const rec = () => currentCrossChainRecord(id) as unknown as ClaimRecord
		// The key the claim derives from one signature, as after a reload that lost the in-memory one.
		const binding = { chainId: rec().chainId, portal: rec().portal, bridge: rec().bridge, secretHashHex: id }
		const key = await recoveryKeyFromSignature(signatureOf(recoveryKeyMessage(binding)))
		updateCrossChainRecord(id, { amount: OUT.toString(), leafIndex: "7" })
		expect((await openClaimEnvelope(key, rec(), sealedV3))?.amount).toBe(OUT.toString())
		expect((await openDepositEnvelope(key, rec().sealedEnvelope as string)).leafIndex).toBe("7")
		updateCrossChainRecord(id, { amount: (OUT + 1n).toString() })
		expect(await openClaimEnvelope(key, rec(), sealedV3)).toBeNull()
	})
})
