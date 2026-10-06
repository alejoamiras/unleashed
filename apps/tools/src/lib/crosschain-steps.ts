/**
 * The rail of a deposit that starts on another chain: approve and send there, the rail's crossing to Ethereum,
 * then the deposit rail every send shares. Phase states rest on the record's facts; a runtime step only picks the
 * live phase while the source prompt is open. "Confirmed" is said only of what discovery proved: the source event
 * (`transport`) and the router's `Deposited` (`depositTxHash`).
 */
import { type CrossChainDepositRecord, type CrossChainOutcome, deriveSendDepositStage, outcomeFinality } from "@unleashed/bridge-core"
import type { BridgeStep, RecordRuntime } from "@/composables/useBridgeJournal"
import { sourceTokenOf } from "@/composables/useSourceChain"
import {
	type BridgePhase,
	isFailedAttention,
	type PhaseState,
	type RouteWords,
	SYNC_TARGET_MARGIN_BLOCKS,
	UNSEAL_PROMPT,
} from "@/lib/bridge-steps"
import { chainLabel, chainTxUrl, lifiScanUrl, railLabel } from "@/lib/chains"
import { waitText } from "@/lib/crosschain-figures"
import { formatStoredAmount, trimTxHash } from "@/lib/format"
import { safeAddressText, safeDisplay, safeSentence } from "@/lib/token-display"

type Key = "src-approve" | "src-send" | "bridge" | "deposit" | "sync" | "register" | "claim" | "confirm"

interface TokenWords {
	symbol: string
	decimals: number
}

interface Words {
	src: string
	l1: string
	rail: string
	/** What the send takes on its source chain ("5.00 USDC"); absent where this build cannot word it. */
	sent?: string
	/** The delivered token, in whose units every Ethereum and Aztec figure of the record is. */
	token?: TokenWords
}

const TX_HASH = /^0x[0-9a-f]{64}$/i
const short = (hash: string): string => trimTxHash(safeAddressText(hash), 6, 4)

/** This build's routing entry for the source token, else the record's token block: a rail delivers the asset
 *  it takes, and every catalogued source keeps Ethereum's decimals for it. */
function sourceToken(rec: CrossChainDepositRecord): TokenWords | undefined {
	const listed = sourceTokenOf({ chainId: rec.route.srcChainId, address: rec.route.srcToken })?.token
	if (listed) return { symbol: safeDisplay(listed.symbol), decimals: listed.decimals }
	return rec.token && { symbol: safeDisplay(rec.token.displaySymbol), decimals: rec.token.decimals }
}

function deliveredToken(rec: CrossChainDepositRecord): TokenWords | undefined {
	return rec.token ? { symbol: safeDisplay(rec.token.displaySymbol), decimals: rec.token.decimals } : sourceToken(rec)
}

const amountOf = (raw: string, t: TokenWords | undefined): string | undefined =>
	t ? `${formatStoredAmount(raw, t.decimals)} ${t.symbol}` : undefined

function wordsOf(rec: CrossChainDepositRecord): Words {
	return {
		src: chainLabel(rec.route.srcChainId),
		l1: chainLabel(rec.chainId),
		rail: railLabel(rec.route.rail),
		sent: amountOf(rec.route.srcAmount, sourceToken(rec)),
		token: deliveredToken(rec),
	}
}

/** "5.00 USDC": what the send takes on its source chain; undefined where this build cannot word the token. */
export function sourceAmountText(rec: CrossChainDepositRecord): string | undefined {
	return amountOf(rec.route.srcAmount, sourceToken(rec))
}

/** "Base Sepolia → Aztec". */
export function crossChainRoute(rec: CrossChainDepositRecord): string {
	return `${chainLabel(rec.route.srcChainId)} → Aztec`
}

/** The rail's quoted ETA as the minutes the screens show: at least one, and twice that at the top. */
function etaMinutes(seconds: number): [number, number] {
	const lo = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : 1
	return [lo, lo * 2]
}

/** "2–4 min". */
export function etaRange(seconds: number): string {
	const [lo, hi] = etaMinutes(seconds)
	return `${lo}–${hi} min`
}

/** The bridging line the stepper and the card share. A send on fixed terms has no ETA: it waits for a manual fill
 *  until its deadline, and the source chain refunds it after. */
export function bridgingPrompt(rec: CrossChainDepositRecord, symbol: string): string {
	const rail = railLabel(rec.route.rail)
	const l1 = chainLabel(rec.chainId)
	if (rec.route.terms !== "fixed")
		return `${rail} is moving your ${symbol} to ${l1}. Nothing for you to do; usually ${etaRange(rec.route.etaSeconds)}.`
	const src = chainLabel(rec.route.srcChainId)
	return `${rail} holds your ${symbol} until a manual fill on ${l1}. Nothing for you to do; unfilled after ${waitText(rec.route.etaSeconds)}, it is refunded on ${src}.`
}

const LATE_FLOOR_MINUTES = 5

/** Whether a send has been on its rail longer than the top of its range, by a minute and at least five. A send on
 *  fixed terms is never late: it waits for its fill or its refund. */
export function bridgingLate(rec: CrossChainDepositRecord, now: number): boolean {
	if (rec.route.terms === "fixed") return false
	const [, hi] = etaMinutes(rec.route.etaSeconds)
	return now - rec.createdAt > Math.max(LATE_FLOOR_MINUTES, hi + 1) * 60_000
}

// ── where the rail stands ───────────────────────────────────────────────────

interface Cursor {
	key: Key
	state: Exclude<PhaseState, "pending" | "done">
	suffix?: string
	word?: string
	/** Replaces the phase's own detail. */
	detail?: string
	unconfirmed?: boolean
}

/** The steps the send flow holds from its record's first write until the wallet returns the send. */
const SEND_STEPS = new Set<BridgeStep | undefined>(["preparing-source", "sealing", "approving-source", "sending-source"])

/** A provisional outcome keeps its deciding phase live until that chain finalizes it. */
const OUTCOME_CURSOR: Record<CrossChainOutcome, (w: Words, provisional: boolean) => Cursor> = {
	"not-sent": (w, provisional) =>
		provisional
			? { key: "src-send", state: "active", suffix: "finalizing", detail: `Reverted on ${w.src}, waiting for ${w.src} to finalize.` }
			: { key: "src-send", state: "failed", word: "reverted" },
	"expired-on-source": (w, provisional) =>
		provisional
			? { key: "bridge", state: "active", suffix: "finalizing", detail: `Expired on ${w.src}, waiting for ${w.l1} to finalize.` }
			: { key: "bridge", state: "ended", suffix: "expired" },
	"delivered-to-wallet": (w, provisional) =>
		provisional
			? {
					key: "deposit",
					state: "active",
					suffix: "finalizing",
					detail: `Delivered to your Ethereum wallet, waiting for ${w.l1} to finalize.`,
				}
			: { key: "deposit", state: "stopped", suffix: "to your wallet" },
}

/**
 * Nothing sent is known. A prompt that is open is live; a failure the flow flagged after handing the send to the
 * wallet, or a record no flow of this tab is sending, may still have left: it is waiting, not lost. A failure
 * flagged with no send running (the watcher's) is a failure.
 */
function sendCursor(rt: RecordRuntime): Cursor {
	const sending = SEND_STEPS.has(rt.step)
	const flagged = isFailedAttention(rt.attention)
	if (sending && !flagged) return { key: rt.step === "approving-source" ? "src-approve" : "src-send", state: "active" }
	if (flagged && !sending) return { key: "src-send", state: "failed" }
	return { key: "src-send", state: "waiting", suffix: "waiting", word: "not found yet", unconfirmed: true }
}

function bridgingCursor(rec: CrossChainDepositRecord, rt: RecordRuntime): Cursor {
	if (!rec.route.transport) return { key: "src-send", state: "active" }
	if (rt.step === "bridging-late") return { key: "bridge", state: "waiting", suffix: "waiting", word: "still waiting" }
	return { key: "bridge", state: "active" }
}

function claimKey(rec: CrossChainDepositRecord, rt: RecordRuntime, registers: boolean): Key {
	const stage = deriveSendDepositStage(rec, { claimable: rt.claimable })
	if (stage === "claiming" || stage === "done") return "confirm"
	if (stage === "registering") return "claim"
	const next = registers ? "register" : "claim"
	if (stage === "claimable") return next
	return rt.step === "unsealing" || rt.step === "sending" ? next : "sync"
}

const withAttention = (c: Cursor, rt: RecordRuntime): Cursor => (isFailedAttention(rt.attention) ? { key: c.key, state: "failed" } : c)

/** Undefined once every phase is done. An outcome is the record's last word, whatever the runtime says. */
function cursorOf(rec: CrossChainDepositRecord, rt: RecordRuntime, registers: boolean): Cursor | undefined {
	const outcome = rec.route.outcome
	if (outcome) return OUTCOME_CURSOR[outcome](wordsOf(rec), outcomeFinality(rec) === "provisional")
	if (rec.completedAt !== undefined) return undefined
	if (rec.leafIndex !== undefined) return withAttention({ key: claimKey(rec, rt, registers), state: "active" }, rt)
	if (rec.route.srcTxHash || rec.route.srcBatchId) return withAttention(bridgingCursor(rec, rt), rt)
	return sendCursor(rt)
}

const registersOf = (rec: CrossChainDepositRecord): boolean => rec.registers === true || rec.registerTxHash !== undefined

/** Whether the source send was handed to the wallet and nothing has shown it since: sending again may move the
 *  funds twice. */
export function crossChainUnconfirmed(rec: CrossChainDepositRecord, rt: RecordRuntime = {}): boolean {
	return cursorOf(rec, rt, rec.isPrivate && registersOf(rec))?.unconfirmed === true
}

/** Whether the rail is slower than usual: the source send is proven and its watcher marked it late. */
export function crossChainStalled(rec: CrossChainDepositRecord, rt: RecordRuntime = {}): boolean {
	const c = cursorOf(rec, rt, rec.isPrivate && registersOf(rec))
	return c?.key === "bridge" && c.state === "waiting"
}

// ── what each phase says ────────────────────────────────────────────────────

interface PhaseCopy {
	label: string
	prompt: string
	/** The prompt is the drawn line, kept over a runtime step's detail. */
	drawn?: boolean
	eta?: string
	estimate?: string
	signs?: boolean
	compact?: { label: string; weight: number }
	done?: Partial<BridgePhase>
	pending?: Partial<BridgePhase>
	live?: Partial<BridgePhase>
}

function linkOf(href: string, hash: string, lead?: string): Pick<BridgePhase, "link"> {
	return href ? { link: { href, text: short(hash), ...(lead ? { lead } : {}) } } : {}
}

function sourceCopy(rec: CrossChainDepositRecord, w: Words): Record<"src-approve" | "src-send", PhaseCopy> {
	const tx = rec.route.srcTxHash
	const approval = rec.approveTxHash
	const handed = tx !== undefined || rec.route.srcBatchId !== undefined
	const send = w.sent ? `Confirm the send in your wallet. It moves ${w.sent}.` : "Confirm the send in your wallet."
	return {
		"src-approve": {
			label: `Approve on ${w.src}`,
			prompt: w.sent
				? `Approve exactly ${w.sent} in your wallet. No funds move yet.`
				: "Approve the exact amount in your wallet. No funds move yet.",
			eta: "your signature",
			done: approval ? linkOf(chainTxUrl(rec.route.srcChainId, approval), approval) : {},
		},
		"src-send": {
			label: `Send on ${w.src}`,
			prompt: handed ? `Waiting for ${w.src} to confirm the send…` : send,
			...(handed ? {} : { eta: "your signature" }),
			estimate: "your signature",
			signs: true,
			compact: { label: "Send", weight: 1 },
			done: tx ? linkOf(chainTxUrl(rec.route.srcChainId, tx), tx) : {},
		},
	}
}

function bridgeCopy(rec: CrossChainDepositRecord, w: Words): PhaseCopy {
	const tx = rec.route.srcTxHash
	const scan = tx ? lifiScanUrl(tx) : ""
	const fixed = rec.route.terms === "fixed"
	const range = fixed ? waitText(rec.route.etaSeconds) : etaRange(rec.route.etaSeconds)
	return {
		label: `Bridge to ${w.l1}`,
		prompt: bridgingPrompt(rec, w.token?.symbol ?? "funds"),
		eta: fixed ? `manual fill, up to ${range}` : `usually ${range}`,
		estimate: fixed ? `up to ${range}` : `~${range}`,
		compact: { label: "Bridge", weight: 1.6 },
		done: tx ? linkOf(scan, tx, "on LI.FI") : {},
		live: { lifi: true, ...(tx ? linkOf(scan, tx, "Track on LI.FI") : {}) },
	}
}

function depositCopy(rec: CrossChainDepositRecord, w: Words): PhaseCopy {
	const slice = rec.intent === "token+gas" && rec.fuel ? amountOf(rec.fuel.amount, w.token) : undefined
	const gas = rec.fuel?.received
	const tx = rec.depositTxHash
	return {
		label: `Deposit on ${w.l1}`,
		prompt: `Waiting for the deposit on ${w.l1}…`,
		eta: "usually under 1 min",
		estimate: "~1 min",
		compact: { label: "Deposit", weight: 1 },
		done: {
			...(slice && gas ? { note: `${slice} became ≈ ${formatStoredAmount(gas, 18, 0)} FJ of gas` } : {}),
			...(tx ? linkOf(chainTxUrl(rec.chainId, tx), tx) : {}),
		},
		pending: slice ? { note: `+ ${slice} swapped into gas on Aztec` } : {},
	}
}

function claimPrompt(rec: CrossChainDepositRecord, w: Words): string {
	if (rec.intent === "gas") return "Confirm in your Aztec wallet. One transaction claims your gas; the gas pays for it."
	const verb = !rec.isPrivate && registersOf(rec) ? "registers the token and claims" : "claims"
	const amount = amountOf(rec.amount, w.token) ?? "tokens"
	return rec.intent === "token+gas"
		? `Confirm in your Aztec wallet. One transaction ${verb} your ${amount} and your gas; the gas pays for it.`
		: `Confirm in your Aztec wallet. One transaction ${verb} your ${amount}.`
}

/** The sync's progress against the deposit's L2 block plus the margin, else the checkpoints the gate counted. */
function meterOf(rec: CrossChainDepositRecord, rt: RecordRuntime): Partial<BridgePhase> {
	const gauge = (current: number, target: number, meter: "block" | "checkpoint") => ({
		progress: { current, target, fraction: Math.min(current / target, 1) },
		meter,
	})
	if (rec.depositL2Block !== undefined && rt.syncBlock !== undefined) {
		const blocks = Math.min(Math.max(rt.syncBlock - rec.depositL2Block, 0), SYNC_TARGET_MARGIN_BLOCKS)
		return gauge(blocks, SYNC_TARGET_MARGIN_BLOCKS, "block")
	}
	const { checkpointsLeft: left, checkpointSpan: span } = rt
	return left === undefined || !span ? {} : gauge(Math.max(span - left, 0), span, "checkpoint")
}

function aztecCopy(
	rec: CrossChainDepositRecord,
	rt: RecordRuntime,
	w: Words,
): Record<"sync" | "register" | "claim" | "confirm", PhaseCopy> {
	const unsealing = rt.step === "unsealing"
	const asks: Partial<BridgePhase> = { needsYou: true, ...(rt.busy ? {} : { claimAction: true }) }
	return {
		sync: {
			label: "Cross to Aztec",
			prompt: "Aztec picks up deposits every few blocks. Nothing for you to do.",
			drawn: true,
			eta: "usually 1-4 min",
			estimate: "~1–4 min",
			compact: { label: "Cross", weight: 1 },
			live: meterOf(rec, rt),
		},
		register: {
			label: "Register on Aztec",
			prompt: unsealing
				? UNSEAL_PROMPT
				: "Confirm in your Aztec wallet. This first send registers the token; the claim follows on its own.",
			drawn: true,
			eta: "your signature + a few sec",
			estimate: "your signature",
			signs: true,
			live: asks,
		},
		claim: {
			label: "Claim on Aztec",
			prompt: unsealing ? UNSEAL_PROMPT : claimPrompt(rec, w),
			drawn: true,
			eta: "your signature + a few sec",
			estimate: "your signature",
			signs: true,
			compact: { label: "Claim", weight: 1 },
			live: asks,
		},
		confirm: {
			label: "Done",
			prompt: "Confirming on Aztec — no signature needed.",
			eta: "usually 1-2 min",
			estimate: "~1–2 min",
			compact: { label: "Done", weight: 0.7 },
		},
	}
}

function copyOf(rec: CrossChainDepositRecord, rt: RecordRuntime): Record<Key, PhaseCopy> {
	const w = wordsOf(rec)
	return { ...sourceCopy(rec, w), bridge: bridgeCopy(rec, w), deposit: depositCopy(rec, w), ...aztecCopy(rec, rt, w) }
}

function detailOf(c: PhaseCopy, cursor: Cursor, rt: RecordRuntime): Pick<BridgePhase, "detail"> {
	if (cursor.detail) return { detail: cursor.detail }
	// Notes and step details can carry wallet or RPC text: stripped of bidi controls and capped.
	if (cursor.state === "failed") return rt.note ? { detail: safeSentence(rt.note) } : {}
	if (cursor.unconfirmed || (cursor.state !== "active" && cursor.state !== "waiting")) return {}
	return { detail: !c.drawn && rt.stepDetail !== undefined ? safeSentence(rt.stepDetail) : c.prompt }
}

function livePhase(base: BridgePhase, c: PhaseCopy, cursor: Cursor, rt: RecordRuntime): BridgePhase {
	const moving = cursor.state === "active" || cursor.state === "waiting"
	return {
		...base,
		state: cursor.state,
		...(cursor.suffix ? { suffix: cursor.suffix } : {}),
		...(cursor.word ? { word: cursor.word } : {}),
		...(cursor.unconfirmed ? { unconfirmed: true } : {}),
		...detailOf(c, cursor, rt),
		...(moving && !cursor.unconfirmed ? { ...c.live, ...(c.eta ? { eta: c.eta } : {}) } : {}),
	}
}

/**
 * The cross-chain rail: Approve on {source} (only while this run approves, or once an approval was journaled), Send on {source},
 * Bridge to {L1}, Deposit on {L1}, Cross to Aztec, Register on Aztec (a first-time private token), Claim on
 * Aztec, Done. An outcome stops it at its deciding phase; every phase after a stop is pending with no estimate.
 */
export function crossChainPhases(rec: CrossChainDepositRecord, rt: RecordRuntime = {}): BridgePhase[] {
	const registers = rec.isPrivate && registersOf(rec)
	const keys: Key[] = [
		...(rt.step === "approving-source" || rt.approveOutcome === "done" || rec.approveTxHash ? (["src-approve"] as const) : []),
		"src-send",
		"bridge",
		"deposit",
		"sync",
		...(registers ? (["register"] as const) : []),
		"claim",
		"confirm",
	]
	const copy = copyOf(rec, rt)
	const cursor = cursorOf(rec, rt, registers)
	const at = cursor ? keys.indexOf(cursor.key) : keys.length
	const stopped = cursor !== undefined && cursor.state !== "active" && cursor.state !== "waiting"
	return keys.map((key, i): BridgePhase => {
		const c = copy[key]
		const base: BridgePhase = {
			key,
			label: c.label,
			state: "pending",
			...(c.signs ? { signs: true } : {}),
			...(c.compact ? { compact: c.compact } : {}),
		}
		if (i < at) return { ...base, state: "done", ...c.done }
		if (i === at && cursor) return livePhase(base, c, cursor, rt)
		return stopped ? base : { ...base, ...(c.estimate ? { estimate: c.estimate } : {}), ...c.pending }
	})
}

// ── the session log ─────────────────────────────────────────────────────────

/** The words a cross-chain step's log phrase fills in. */
export function crossChainLogWords(rec: CrossChainDepositRecord): RouteWords {
	const w = wordsOf(rec)
	return { amount: w.sent ?? "the amount", src: w.src, rail: w.rail, l1: w.l1 }
}

/** What arrived on Ethereum: the token claim plus the gas slice, or the whole of a gas-only send. */
function deliveredText(rec: CrossChainDepositRecord, w: Words): string | undefined {
	const slice = rec.intent === "token+gas" && rec.fuel ? rec.fuel.amount : "0"
	if (!/^\d{1,78}$/.test(rec.amount) || !/^\d{1,78}$/.test(slice)) return undefined
	return amountOf((BigInt(rec.amount) + BigInt(slice)).toString(), w.token)
}

/**
 * The log rows a record's proven legs earn, keyed so each is written once: the source event discovery
 * authenticated, then the router's `Deposited` it read on Ethereum.
 */
export function crossChainLogFacts(rec: CrossChainDepositRecord): { key: string; lines: string[] }[] {
	const w = wordsOf(rec)
	const rows: { key: string; lines: string[] }[] = []
	const src = rec.route.srcTxHash
	if (rec.route.transport && src && TX_HASH.test(src)) {
		rows.push({ key: `transport:${src.toLowerCase()}`, lines: [`${w.src} confirmed ${short(src)}`, `LI.FI handed it to ${w.rail}`] })
	}
	const tx = rec.depositTxHash
	if (tx && TX_HASH.test(tx)) {
		const delivered = deliveredText(rec, w)
		const slice = rec.intent === "token+gas" && rec.fuel ? amountOf(rec.fuel.amount, w.token) : undefined
		rows.push({
			key: `depositTxHash:${tx.toLowerCase()}`,
			lines: [
				delivered ? `${w.rail} delivered ${delivered} on ${w.l1}` : `${w.rail} delivered it on ${w.l1}`,
				slice ? `LI.FI called the deposit · ${slice} into gas` : "LI.FI called the deposit",
				`${w.l1} confirmed ${short(tx)}`,
			],
		})
	}
	return rows
}

/** The row for a source-chain approval whose receipt the flow saw succeed. */
export function approvalConfirmedLine(srcChainId: number, hash: string): string {
	return `${chainLabel(srcChainId)} confirmed the approval ${short(hash)}`
}
