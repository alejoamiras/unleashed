/**
 * The copy of the panel that replaces a cross-chain send's stepper once it ends without arriving, or
 * stalls on its rail. Every figure comes from the record or from a read the host passes in; a clause
 * whose figure the app cannot know is left out rather than guessed.
 */
import type { CrossChainDepositRecord } from "@unleashed/bridge-core"
import { agoWords } from "@/lib/activity"
import { chainLabel, chainTxUrl, lifiScanUrl, railLabel } from "@/lib/chains"
import { assetText, crossChainAsset, crossChainPhase, expiryLead, shortAddress } from "@/lib/crosschain-activity"
import { bridgingLate, crossChainRoute, etaRange } from "@/lib/crosschain-steps"
import { formatStoredAmount } from "@/lib/format"
import { formatClock } from "@/lib/phase-clock"

export type OutcomeVariant = "delivered" | "expired" | "not-sent" | "stalled"

/** Which panel the record earns now; null while the stepper is still the right surface. A bridging
 *  send is stalled by the same clock the rail's waiting segment reads. */
export function outcomeVariant(rec: CrossChainDepositRecord, now: number): OutcomeVariant | null {
	const phase = crossChainPhase(rec)
	if (phase?.kind === "delivered" || phase?.kind === "expired" || phase?.kind === "not-sent") return phase.kind
	return phase?.kind === "bridging" && bridgingLate(rec, now) ? "stalled" : null
}

/** Reads and quotes only the host can make. */
export interface OutcomeFigures {
	/** ETH the sender holds on Ethereum, formatted ("0.40"). */
	ethHeld?: string
	/** A fresh Ethereum-origin quote for continuing a delivered send, formatted. */
	continueQuote?: { amount: string; symbol: string; gas?: string }
	/** When discovery last read the chains (ms). */
	checkedAt?: number
}

export type OutcomeTone = "attention" | "lost" | "raised"

export interface OutcomeTx {
	label: string
	/** Short hash, linked when `href` is set. */
	hash?: string
	href?: string
	note: string
	/** A link with no hash: LI.FI's trail. */
	link?: string
}

export interface OutcomeCopy {
	tag: string
	tagTone: OutcomeTone
	title: string
	/** "Base Sepolia → Aztec", the sent amount and visibility go before it on the sub line. */
	when: string
	/** A mono figure inside `when` ("24:10"), set only on a stalled send. */
	clock?: string
	happened: string
	means: string
	/** The "What it means" card's big figure. */
	figure?: { amount: string; symbol: string; where: string; who: string; chain: string }
	next: string
	nextTone: OutcomeTone
	txs: OutcomeTx[]
	band?: string
}

interface Words {
	src: string
	l1: string
	rail: string
	symbol: string
	sent: string
	who: string
}

function wordsOf(rec: CrossChainDepositRecord): Words {
	return {
		src: chainLabel(rec.route.srcChainId),
		l1: chainLabel(rec.chainId),
		rail: railLabel(rec.route.rail),
		symbol: crossChainAsset(rec).symbol,
		sent: assetText(rec, rec.route.srcAmount) ?? "—",
		who: shortAddress(rec.route.srcSender),
	}
}

function sentTx(rec: CrossChainDepositRecord, label: string, note: string): OutcomeTx {
	const hash = rec.route.outcome === "not-sent" ? (rec.route.outcomeTxHash ?? rec.route.srcTxHash) : rec.route.srcTxHash
	return { label, hash: hash ? shortAddress(hash) : undefined, href: chainTxUrl(rec.route.srcChainId, hash ?? "") || undefined, note }
}

function figureOf(rec: CrossChainDepositRecord, raw: string | undefined, where: string, chain: string, w: Words): OutcomeCopy["figure"] {
	if (raw === undefined) return undefined
	return { amount: formatStoredAmount(raw, crossChainAsset(rec).decimals), symbol: w.symbol, where, who: w.who, chain }
}

function deliveredCopy(rec: CrossChainDepositRecord, w: Words, endedAgo: string, f: OutcomeFigures): OutcomeCopy {
	const delivered = assetText(rec, rec.route.outcomeAmount)
	const outcomeTx = rec.route.outcomeTxHash
	const trail = lifiScanUrl(rec.route.srcTxHash ?? "")
	return {
		tag: "Needs you",
		tagTone: "attention",
		title: "Delivered to your Ethereum wallet instead",
		when: `stopped at the deposit, ${endedAgo}`,
		happened: `${w.rail} delivered your ${w.symbol} to ${w.l1}, but the deposit into Aztec didn’t go through. So LI.FI sent the ${w.symbol} to your own Ethereum wallet.`,
		means: `The money is safe and yours, on ${w.l1}. It is not on Aztec yet. The LI.FI fee and the bridge fee are spent; nothing else was taken.`,
		figure: figureOf(rec, rec.route.outcomeAmount, "in", w.l1, w),
		next: `Continue from Ethereum: a new send from your Ethereum wallet. You sign there and pay its gas in ETH.${f.ethHeld === undefined ? "" : ` You hold ${f.ethHeld} ETH on ${w.l1}.`}`,
		nextTone: "attention",
		txs: [
			sentTx(rec, `Sent on ${w.src}`, w.sent),
			{
				label: `Delivered on ${w.l1}`,
				hash: outcomeTx ? shortAddress(outcomeTx) : undefined,
				href: chainTxUrl(rec.chainId, outcomeTx ?? "") || undefined,
				note: delivered ? `${delivered} to your wallet` : "to your wallet",
			},
			...(trail ? [{ label: "Full trail", href: trail, link: "Track on LI.FI", note: "" }] : []),
		],
		band: "Continuing starts a new send from Ethereum, with its own recovery secret.",
	}
}

function expiredCopy(rec: CrossChainDepositRecord, w: Words, endedAgo: string): OutcomeCopy {
	return {
		tag: "Expired",
		tagTone: "raised",
		title: `Refund pending on ${w.src}`,
		when: `expired ${endedAgo}`,
		happened: `${expiryLead(rec, `this transfer to ${w.l1}`)}, so it expired.`,
		means: `Nothing reached ${w.l1} or Aztec, and there is nothing to claim. ${w.rail} refunds the ${w.symbol} to your wallet on ${w.src}; the network fee for the send is not returned.`,
		figure: figureOf(rec, rec.route.srcAmount, "due back in", w.src, w),
		next: "Try again with a new quote; routes change from minute to minute. Or send from another network instead.",
		nextTone: "raised",
		txs: [sentTx(rec, `Sent on ${w.src}`, w.sent), { label: `Refund on ${w.src}`, note: `pending · ${w.sent}` }],
	}
}

function notSentCopy(rec: CrossChainDepositRecord, w: Words, endedAgo: string): OutcomeCopy {
	return {
		tag: "Didn’t go through",
		tagTone: "lost",
		title: "Nothing moved",
		when: endedAgo,
		happened: `${w.src} rejected the transaction, so it never ran.`,
		means: `Your ${w.symbol} never left your wallet. The only cost is the ${w.src} network fee for the attempt.`,
		figure: figureOf(rec, rec.route.srcAmount, "still in", w.src, w),
		next: "Get a new quote and sign again. Your amount, privacy and gas choice are kept.",
		nextTone: "raised",
		txs: [sentTx(rec, `Rejected on ${w.src}`, `reverted, 0 ${w.symbol} moved`)],
	}
}

function stalledCopy(rec: CrossChainDepositRecord, w: Words, now: number): OutcomeCopy {
	const elapsed = Math.max(0, now - rec.createdAt)
	const minutes = Math.floor(elapsed / 60_000)
	return {
		tag: "Slower than usual",
		tagTone: "attention",
		title: "Bridging is taking longer than usual",
		when: `in the bridge, usually ${etaRange(rec.route.etaSeconds)}`,
		clock: formatClock(elapsed),
		happened: `Your ${w.symbol} left ${w.src} ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago. ${w.rail} hasn’t delivered it to ${w.l1} yet.`,
		means: `The money is in the bridge, not lost. When it lands on ${w.l1}, the deposit runs by itself and this page picks up from there.`,
		next: "Nothing yet. You can close this tab; the send keeps going and stays in Activity. If it is still pending tomorrow, contact LI.FI support with the transaction below.",
		nextTone: "attention",
		txs: [],
	}
}

/** The panel's words for `variant`, read from the record at `now`. */
export function outcomeCopy(rec: CrossChainDepositRecord, variant: OutcomeVariant, now: number, f: OutcomeFigures = {}): OutcomeCopy {
	const w = wordsOf(rec)
	const endedAgo = agoWords(rec.completedAt ?? rec.updatedAt, now)
	switch (variant) {
		case "delivered":
			return deliveredCopy(rec, w, endedAgo, f)
		case "expired":
			return expiredCopy(rec, w, endedAgo)
		case "not-sent":
			return notSentCopy(rec, w, endedAgo)
		case "stalled":
			return stalledCopy(rec, w, now)
	}
}

/** "Base Sepolia → Aztec · 5.00 USDC · public": the sub line before `when`. */
export function outcomeLead(rec: CrossChainDepositRecord): { route: string; sent: string; visibility: string } {
	return { route: crossChainRoute(rec), sent: wordsOf(rec).sent, visibility: rec.isPrivate ? "private" : "public" }
}
