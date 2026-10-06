/**
 * Watches each cross-chain record from its source signature to an answer, through read clients only, so it needs
 * no wallet and survives the tab that started the send: every round, discovery re-derives where the record stands
 * from both chains and the journal takes its patch. A deposit hands the record to the claim lanes, re-sealed exact
 * first while the seal key is still in memory; an outcome is watched until the block that decided it is final.
 */
import {
	type CrossChainDepositRecord,
	type CrossChainDiscovery,
	type CrossChainDiscoveryContext,
	type DiscoveryReads,
	discoverCrossChain,
	discoveryPatch,
	type EncryptionKey,
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
	currentCrossChainRecord,
	flagRecordError,
	isSessionLive,
	setRecordStep,
	storedCrossChainRecords,
	updateCrossChainRecord,
	useBridgeJournal,
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

/** Whether discovery still has something to decide: nothing deposited yet, or an outcome not yet final. */
export function needsWatch(rec: CrossChainDepositRecord): boolean {
	if (rec.completedAt !== undefined) return false
	return rec.route.outcome !== undefined || rec.leafIndex === undefined
}

/** With the key still in memory, a deposit inside the sealed window is re-sealed exact (no signature) and its
 *  secret cached for the claim; otherwise the claim's unseal does the same after one signature. */
async function resealWithKey(rec: CrossChainDepositRecord, key: EncryptionKey | undefined): Promise<void> {
	if (!key || !rec.sealedEnvelope || rec.leafIndex === undefined) return
	const v3 = await openDepositEnvelopeV3(key, rec.sealedEnvelope).catch(() => null)
	if (!v3) return
	const deposited = { recipient: rec.recipient, amount: rec.amount, leafIndex: rec.leafIndex }
	try {
		const exact = await resealExactEnvelope(key, v3, deposited)
		updateCrossChainRecord(rec.id, { sealedEnvelope: exact }, (current) => current.sealedEnvelope === rec.sealedEnvelope)
		cacheSecret(rec.id, v3.secret, {
			v: 2,
			secret: v3.secret,
			sealerL1: v3.sealerL1,
			...deposited,
			...(v3.salt ? { salt: v3.salt } : {}),
		})
	} catch (e) {
		log("deposit outside its sealed window; the claim will say so", rec.id, e instanceof Error ? e.message : String(e))
	}
}

async function afterDeposit(id: string, deps: CrossChainWatchDeps): Promise<void> {
	const rec = currentCrossChainRecord(id)
	if (!rec) return
	if (rec.isPrivate) await resealWithKey(rec, deps.sealKey?.(id))
	if (isSessionLive(id)) deps.claim(id)
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
	// Computed from the copy the write merges into: the claim lanes may have written since this run read.
	const written = updateCrossChainRecord(id, (current) => discoveryPatch(current, d, deps.now()) ?? {})
	if (written && !handedOver(rec) && handedOver(written)) clearSendFlag(id)
	if (written) narrateRail(written, d, deps.now())
	if (d.verdict === "deposited") {
		await afterDeposit(id, deps)
		return "done"
	}
	return written && needsWatch(written) ? "again" : "done"
}

/** Anything that shows the send left the wallet: its hash or batch id, its deposit, or an outcome. */
const handedOver = (r: CrossChainDepositRecord): boolean =>
	r.route.srcTxHash !== undefined || r.route.srcBatchId !== undefined || r.leafIndex !== undefined || r.route.outcome !== undefined

/** The flow flags a send the wallet took without answering; once discovery finds it, it is in flight again. */
function clearSendFlag(id: string): void {
	const { runtime } = useBridgeJournal()
	const rt = runtime.value[id]
	if (rt?.attention === undefined) return
	runtime.value = { ...runtime.value, [id]: { ...rt, attention: undefined, note: undefined } }
}

/** A proven source send is on its rail, late past its usual time, until a deposit or an outcome answers. */
function narrateRail(rec: CrossChainDepositRecord, d: CrossChainDiscovery, now: number): void {
	if (d.verdict !== "pending") setRecordStep(rec.id, undefined)
	else if (rec.route.transport && rec.leafIndex === undefined)
		setRecordStep(rec.id, bridgingLate(rec, now) ? "bridging-late" : "bridging")
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
