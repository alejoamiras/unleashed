/**
 * Watches each cross-chain record from its source signature to an answer, through read clients only, so it needs
 * no wallet and survives the tab that started the send: every round, discovery re-derives where the record stands
 * from both chains and the journal takes its patch. A deposit hands the record to the claim lanes at once; a deposit
 * and an outcome alike are watched until the block that decided them is final, and a private record is re-sealed
 * exact only then, while the seal key is still in memory.
 */
import {
	type CrossChainDepositRecord,
	type CrossChainDiscovery,
	type CrossChainDiscoveryContext,
	type DiscoveryReads,
	discoverCrossChain,
	discoveryPatch,
	type EncryptionKey,
	envelopeV3MatchesRecord,
	lifiBook,
	openDepositEnvelopeV3,
	predictPortal,
	readSendInbox,
	resealExactEnvelope,
} from "@unleashed/bridge-core"
import type { Address } from "viem"
import { SEND_GENERATION } from "@/contracts/bridge-generation"
import { bridgingLate } from "@/lib/crosschain-steps"
import {
	cacheSecret,
	clearRecordError,
	currentCrossChainRecord,
	flagRecordError,
	forgetClaimMaterial,
	isSessionLive,
	markRecordChecked,
	setRecordStep,
	storedCrossChainRecords,
	updateCrossChainRecord,
} from "./useBridgeJournal"
import { readClientFor } from "./useEthereumReader"

const log = (...args: unknown[]) => console.log("[bridge:crosschain]", ...args)

const WATCH_INTERVAL_MS = 15_000
/** Rounds in a row that threw (not `incomplete`, which is retried freely) before the record says so. */
const MAX_FAILED_ROUNDS = 20

export interface CrossChainWatchDeps {
	/** The addresses that authenticate `rec`'s logs, from this build's pins; throws where it pins none. */
	context(rec: CrossChainDepositRecord): Promise<CrossChainDiscoveryContext>
	/** Undefined where this build reads no such chain. */
	reads(rec: CrossChainDepositRecord): DiscoveryReads | undefined
	discover?: typeof discoverCrossChain
	sealKey?(id: string): EncryptionKey | undefined
	/** Starts the claim of a record this session sent. */
	claim(id: string): void
	now(): number
	wait(ms: number): Promise<void>
	intervalMs?: number
}

const watching = new Set<string>()

/** Whether discovery still has something to decide: nothing deposited yet, or a deposit or outcome not yet final. */
export function needsWatch(rec: CrossChainDepositRecord): boolean {
	if (rec.completedAt !== undefined) return false
	return rec.route.outcome !== undefined || rec.route.depositFinal !== true
}

/** The facts a claim is built from: a reorg that re-includes the fill moves at least one of them. */
const depositKey = (r: CrossChainDepositRecord): string =>
	[r.depositTxHash, r.leafIndex, r.messageHash, r.amount, r.fuel?.leafIndex, r.fuel?.messageHash].join("|")

/** With the key still in memory, the claim's secret is cached for the deposit as found (no signature), and a
 *  final deposit inside the sealed window is re-sealed exact; otherwise the claim's unseal does both after one
 *  signature. */
async function useSealKey(rec: CrossChainDepositRecord, key: EncryptionKey | undefined): Promise<void> {
	if (!key || !rec.sealedEnvelope || rec.leafIndex === undefined) return
	const v3 = await openDepositEnvelopeV3(key, rec.sealedEnvelope).catch(() => null)
	if (!v3) return
	const deposited = { recipient: rec.recipient, amount: rec.amount, leafIndex: rec.leafIndex }
	if (!envelopeV3MatchesRecord(v3, deposited)) {
		log("deposit outside its sealed window; the claim will say so", rec.id)
		return
	}
	cacheSecret(rec.id, v3.secret, { v: 2, secret: v3.secret, sealerL1: v3.sealerL1, ...deposited, ...(v3.salt ? { salt: v3.salt } : {}) })
	if (!rec.route.depositFinal) return
	const exact = await resealExactEnvelope(key, v3, deposited)
	updateCrossChainRecord(
		rec.id,
		{ sealedEnvelope: exact },
		(current) => current.sealedEnvelope === rec.sealedEnvelope && depositKey(current) === depositKey(rec),
	)
}

/** A deposit found, or found again elsewhere, starts the claim of what this session sent from the new facts; one
 *  turned final is re-sealed. */
async function afterDeposit(rec: CrossChainDepositRecord, moved: boolean, deps: CrossChainWatchDeps): Promise<void> {
	if (!moved && rec.route.depositFinal !== true) return
	if (rec.isPrivate) await useSealKey(rec, deps.sealKey?.(rec.id))
	if (moved && isSessionLive(rec.id)) deps.claim(rec.id)
}

/** One discovery run and its patch; `again` while discovery has more to decide. */
export async function watchRound(id: string, deps: CrossChainWatchDeps): Promise<"again" | "done"> {
	const rec = currentCrossChainRecord(id)
	if (!rec || !needsWatch(rec)) return "done"
	const reads = deps.reads(rec)
	if (!reads) return "done"
	const d: CrossChainDiscovery = await (deps.discover ?? discoverCrossChain)(rec, await deps.context(rec), reads, { now: deps.now })
	if (d.verdict === "incomplete") {
		log("discovery incomplete", id, d.reason)
		return "again"
	}
	markRecordChecked(id, deps.now())
	// Computed from the copy the write merges into: the claim lanes may have written since this run read.
	const written = updateCrossChainRecord(id, (current) => discoveryPatch(current, d, deps.now()) ?? {})
	if (!written) return "done"
	// The flow flags a send the wallet took without answering; once discovery finds it, it is in flight again.
	if (!handedOver(rec) && handedOver(written)) clearRecordError(id)
	const moved = depositKey(rec) !== depositKey(written)
	// Material unsealed for the deposit before names a leaf the chain may no longer carry.
	if (moved) forgetClaimMaterial(id)
	narrateRail(written, d, deps.now(), moved)
	if (d.verdict === "deposited") await afterDeposit(written, moved, deps)
	return needsWatch(written) ? "again" : "done"
}

/** Anything that shows the send left the wallet: its hash or batch id, its deposit, or an outcome. */
const handedOver = (r: CrossChainDepositRecord): boolean =>
	r.route.srcTxHash !== undefined || r.route.srcBatchId !== undefined || r.leafIndex !== undefined || r.route.outcome !== undefined

/** A proven source send is on its rail, late past its usual time, until a deposit or an outcome answers. A deposit
 *  already found leaves the step to the claim lanes. */
function narrateRail(rec: CrossChainDepositRecord, d: CrossChainDiscovery, now: number, moved: boolean): void {
	if (d.verdict === "pending") {
		if (rec.route.transport && rec.leafIndex === undefined) setRecordStep(rec.id, bridgingLate(rec, now) ? "bridging-late" : "bridging")
	} else if (d.verdict !== "deposited" || moved) setRecordStep(rec.id, undefined)
}

/** Watch `id` until discovery decides it; a second call for a watched record is a no-op. */
export async function watchCrossChain(id: string, deps: CrossChainWatchDeps): Promise<void> {
	if (watching.has(id)) return
	watching.add(id)
	let failed = 0
	try {
		for (;;) {
			let next: "again" | "done"
			try {
				next = await watchRound(id, deps)
				failed = 0
			} catch (e) {
				log("watch round failed", id, e instanceof Error ? e.message : String(e))
				if (++failed >= MAX_FAILED_ROUNDS) {
					flagRecordError(id, "This transfer can't be checked from here right now. Nothing was deleted; reload to try again.")
					return
				}
				next = "again"
			}
			if (next === "done") return
			await deps.wait(deps.intervalMs ?? WATCH_INTERVAL_MS)
		}
	} finally {
		watching.delete(id)
	}
}

/** Resume every record discovery still has to decide: a reload while bridging picks up where it left off. */
export function resumeCrossChainWatches(deps: CrossChainWatchDeps): void {
	for (const rec of storedCrossChainRecords()) {
		if (needsWatch(rec)) void watchCrossChain(rec.id, deps)
	}
}

let inbox: ReturnType<typeof readSendInbox> | undefined

/** This build's pins for `rec`: the generation's router and portals, the derived token portal, the LI.FI book.
 *  A record naming anything else is refused by discovery itself. */
export async function appDiscoveryContext(rec: CrossChainDepositRecord): Promise<CrossChainDiscoveryContext> {
	const g = SEND_GENERATION
	const ethereum = g && readClientFor(g.chainId)
	if (!g || !ethereum) throw new Error("This build reads no deposit router.")
	if (rec.route.rail !== "acrossV4") throw new Error("This build watches only Across transfers.")
	const src = lifiBook(rec.route.srcChainId)
	const dst = lifiBook(g.chainId)
	inbox ??= readSendInbox(ethereum as never, g).catch((e: unknown) => {
		inbox = undefined
		throw e
	})
	return {
		source: { chainId: rec.route.srcChainId, diamond: src.diamond },
		ethereum: {
			chainId: g.chainId,
			router: g.router,
			executor: dst.executor,
			feeJuicePortal: g.feeJuicePortal,
			...(rec.intent === "gas" ? {} : { tokenPortal: predictPortal(g.factory, g.implementation, rec.token.erc20) as Address }),
			inbox: await inbox,
		},
		rail: {
			kind: "acrossV4",
			sourceSpokePool: src.acrossSpokePool,
			destinationSpokePool: dst.acrossSpokePool,
			receiver: dst.receiverAcrossV4,
		},
	}
}
