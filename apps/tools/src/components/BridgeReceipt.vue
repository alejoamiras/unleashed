<script setup lang="ts">
/** Services */
import { Button, Icon } from "@unleashed/design"
import { computed, useId } from "vue"

/** Utils */
import { type AssetBlock, type AssetKind, GROSS_QUALIFIER, assetDecimals, assetSymbol } from "@/lib/asset-label"
import { chainLabel, chainTxUrl } from "@/lib/chains"
import { etherscanTxUrl, explorerTxUrl } from "@/lib/explorer"
import { formatCompact, formatDisplayAmount, isStoredAmount, trimAddress } from "@/lib/format"
import { formatClock, formatElapsed, formatStamp } from "@/lib/phase-clock"
import { TESTIDS } from "@/lib/testids"
import { checksumAddress, safeAddressText, safeDisplay } from "@/lib/token-display"

/** The snapshot is captured at the stepper→receipt transition - a cross-tab discard
 *  or the auto-hide grace cannot blank this view. */
export interface ReceiptSnapshot {
	direction: "deposit" | "withdraw"
	/** The hero figure in base units: the token that arrived, or a gas-only send's gross Fee Juice. */
	amount: string
	/** The hero figure is the signed floor, not the amount the deposit reported. */
	atLeast?: boolean
	isPrivate: boolean
	/** Bridged asset. Absent ⇒ the token bridge (back-compat — bridge receipts omit it). "fee-juice" ⇒ a
	 *  Fuel bridge: the amount IS Fee Juice (18-dec, "FJ"/"Private FJ"), there is no separate token leg. */
	assetKind?: AssetKind
	l1TxHash?: string
	l2TxHash?: string
	/** Persisted facts (createdAt/completedAt) - the end-to-end time always survives reloads. */
	startedAt?: number
	completedAt?: number
	/** A send's own token identity, taken from the record's frozen block. Absent ⇒ the generic "TOKEN"
	 *  symbol at 18 decimals, unless the asset is Fee Juice. */
	token?: AssetBlock
	/** The account the send left from, as the record stored it; absent on records written before it was
	 *  stored. Unverified: an address of the right shape does not prove the transaction came from it. */
	sender?: string
	/** Where it arrived: a deposit's Aztec account, an exit's Ethereum address. */
	recipient: string
	/** The wallet's alias for a deposit's recipient when the snapshot was taken, already sanitised. */
	recipientAlias?: string
	/** The token the review said would arrive, base units at `reviewedDecimals`. */
	reviewedAmount?: string
	/** Captured with the review, never read from the record: the review's units never come from
	 *  persisted metadata, so a storage update cannot rescale what the review said. */
	reviewedDecimals?: number
	/** The review's Fee Juice quote for the gas leg, base units. Gross: claim fees come out of it later. */
	gasQuote?: string
	/** How many transactions the review said the gas covers. */
	txCovered?: number
	/** The L2 token a wallet can be asked to watch. Absent ⇒ no add-token CTA. */
	addTokenLabel?: string
	/** A cross-chain deposit's source leg: the chain it was sent from and, once known, its transaction.
	 *  `sender` is then the account on that chain. */
	source?: { chainId: number; txHash?: string }
	/** Opened again from Activity, where the record already is: no note says it stays there. */
	reopened?: boolean
}

const props = withDefaults(defineProps<{ snapshot: ReceiptSnapshot; ctaLabel?: string; addTokenBusy?: boolean }>(), {
	ctaLabel: "New bridge",
	addTokenBusy: false,
})
const emit = defineEmits<{ "new-bridge": []; "add-token": [] }>()

const titleId = useId()

const isDeposit = computed(() => props.snapshot.direction === "deposit")
/** A direct Fuel bridge: the amount itself is Fee Juice (no token leg, no bought/used split). */
const isFuel = computed(() => props.snapshot.assetKind === "fee-juice")
const sourceChain = computed(() => {
	const source = props.snapshot.source
	return isDeposit.value && source ? chainLabel(source.chainId) : null
})
const route = computed(() => {
	if (sourceChain.value) return `${sourceChain.value} → Aztec`
	return isDeposit.value ? "Ethereum → Aztec" : "Aztec → Ethereum"
})
const privacyWord = computed(() => (props.snapshot.isPrivate ? "private" : "public"))
/** Gas naming by surface: private → "Private FJ", public → "FJ". ($AZTEC is the L1-side name.) */
const gasLabel = computed(() => (props.snapshot.isPrivate ? "Private FJ" : "FJ"))
const heroLabel = "Arrived"

const decimals = computed(() => assetDecimals(props.snapshot.assetKind, props.snapshot.token))
/** Exact and grouped like the review's own figures; an impossible stored string reads as a dash. */
const exact = (raw: string | undefined, places: number | undefined): string =>
	raw !== undefined && places !== undefined && isStoredAmount(raw) ? formatDisplayAmount(BigInt(raw), places) : "—"
const amountDisplay = computed(() => {
	const figure = exact(props.snapshot.amount, decimals.value)
	return props.snapshot.atLeast && figure !== "—" ? `≥ ${figure}` : figure
})
const amountSymbol = computed(() => safeDisplay(assetSymbol(props.snapshot.assetKind, props.snapshot.isPrivate, props.snapshot.token)))
const quote = computed(() => {
	const q = props.snapshot.gasQuote
	return q !== undefined && isStoredAmount(q) ? `≈ ${formatCompact(BigInt(q), 18)}` : null
})
// Only a token deposit carries a separate gas leg: a withdraw never does, and a gas-only send IS the
// gas. The `!isFuel` guard keeps this row and the gas-only hero from both carrying receiptFuel.
const gasLine = computed(() => {
	if (!isDeposit.value || isFuel.value || quote.value === null) return null
	const n = props.snapshot.txCovered
	const covers = n ? ` · ${n} transaction${n === 1 ? "" : "s"}` : ""
	return `${quote.value} ${gasLabel.value}${covers} · ${GROSS_QUALIFIER}`
})

/** A send names its own token, so its hero and gas rows carry the send-specific ids the wizard's
 *  tests select on; the single-token bridge keeps the ids it has always emitted. */
const isSend = computed(() => props.snapshot.token !== undefined)
const heroTestid = computed(() => (isFuel.value ? TESTIDS.receiptFuel : isSend.value ? TESTIDS.sendReceiptToken : undefined))
const gasTestid = computed(() => (isSend.value ? TESTIDS.sendReceiptGas : TESTIDS.receiptFuel))

/** Bare figures, both halves written the same way so the reader can check one against the other.
 *  A gas-only send compares its quote with the gross Fee Juice bridged, which it never calls "got". */
const reviewLine = computed(() => {
	if (isFuel.value) return quote.value ? `${quote.value} · bridged ${amountDisplay.value}` : null
	const { reviewedAmount: said, reviewedDecimals } = props.snapshot
	return said === undefined ? null : `${exact(said, reviewedDecimals)} · you got ${amountDisplay.value}`
})

/** Trimmed for the line, whole in `title`; an Ethereum address in the EIP-55 casing explorers show. */
function addressView(raw: string, ethereum: boolean): { short: string; full: string } {
	const full = ethereum ? checksumAddress(safeAddressText(raw)) : safeAddressText(raw)
	return { short: trimAddress(full, 6, 4), full }
}

const account = computed(() => {
	const at = addressView(props.snapshot.recipient, !isDeposit.value)
	if (!isDeposit.value) return { lead: "On Ethereum", alias: null, ...at }
	const alias = props.snapshot.recipientAlias ? safeDisplay(props.snapshot.recipientAlias) : ""
	return { lead: "In your Aztec account", alias: alias || null, ...at }
})

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i
const AZTEC_ADDRESS = /^0x[0-9a-f]{64}$/i

/** Stored text that is not an address of the sending chain's shape shows no row, never a guess. */
const from = computed(() => {
	const sender = props.snapshot.sender
	const shape = isDeposit.value ? EVM_ADDRESS : AZTEC_ADDRESS
	if (typeof sender !== "string" || !shape.test(sender)) return null
	return { chain: sourceChain.value ?? (isDeposit.value ? "Ethereum" : "Aztec"), ...addressView(sender, isDeposit.value) }
})

/** An exit's release on Ethereum is public either way; `isPrivate` only says which balance it burned. */
const visibility = computed(() => {
	const priv = props.snapshot.isPrivate
	if (isDeposit.value) return priv ? "Private — others on Aztec see static" : "Public — visible on Aztec"
	return priv ? "Sent from your private Aztec balance · arrives publicly on Ethereum" : "Public — visible on Aztec and Ethereum"
})

/** A cross-chain send's total reads as the clock its stepper ran ("7:48"). */
const totalElapsed = computed(() => {
	const { startedAt, completedAt } = props.snapshot
	if (startedAt === undefined || completedAt === undefined || completedAt <= startedAt) return null
	return (sourceChain.value ? formatClock : formatElapsed)(completedAt - startedAt)
})

/** A finite number can still lie outside the range a Date holds, so the Date itself is checked. */
const stamp = computed(() => {
	const at = props.snapshot.completedAt
	return at !== undefined && !Number.isNaN(new Date(at).getTime()) ? formatStamp(at, Date.now()) : null
})

const links = computed(() => {
	const out: { label: string; href: string }[] = []
	const source = props.snapshot.source
	if (isDeposit.value && source?.txHash) out.push({ label: "Send tx", href: chainTxUrl(source.chainId, source.txHash) })
	if (props.snapshot.l1TxHash) {
		out.push({
			label: isDeposit.value ? "Deposit tx" : "Finish tx",
			href: etherscanTxUrl(props.snapshot.l1TxHash),
		})
	}
	if (props.snapshot.l2TxHash) {
		out.push({
			label: isDeposit.value ? "Claim tx" : "Exit tx",
			href: explorerTxUrl(props.snapshot.l2TxHash),
		})
	}
	return out.filter((l) => l.href !== "")
})

/** "Both transactions" only for an Ethereum-origin send whose two links render: a leg another account
 *  finished has only one, and a cross-chain send has three legs. */
const note = computed(() => {
	if (props.snapshot.reopened) return null
	return links.value.length === 2 && !props.snapshot.source
		? "This bridge is finished. Its record stays in Activity with both transactions."
		: "This bridge is finished. Its record stays in Activity."
})
</script>

<template>
	<div class="receipt-col">
		<section class="receipt ul-notch" :aria-labelledby="titleId" :data-testid="TESTIDS.receipt">
			<div class="head">
				<span>{{ route }} · {{ privacyWord }}<template v-if="totalElapsed"> · <span class="mono">{{ totalElapsed }}</span></template></span>
				<span v-if="stamp" class="stamp">{{ stamp }}</span>
			</div>
			<div class="title">
				<Icon class="done" name="check" :size="24" />
				<h2 :id="titleId">{{ heroLabel }}</h2>
			</div>
			<p class="hero" :data-testid="heroTestid">
				<span class="digits" :style="{ '--n': amountDisplay.length }">{{ amountDisplay }}</span> <span class="sym">{{ amountSymbol }}</span>
			</p>
			<p v-if="isFuel" class="caption">bridged · {{ GROSS_QUALIFIER }}</p>
			<div class="scan" aria-hidden="true"><span class="line" /><span class="pass" /></div>
			<p class="account" :data-testid="TESTIDS.sendReceiptAccount">
				{{ account.alias ? `${account.lead} ` : account.lead }}<strong v-if="account.alias">{{ account.alias }}</strong> · <span class="mono" :title="account.full">{{ account.short }}</span>
			</p>

			<dl class="facts">
				<div v-if="gasLine" class="fact">
					<dt>Gas bridged</dt>
					<dd class="mono" :data-testid="gasTestid">{{ gasLine }}</dd>
				</div>
				<div v-if="reviewLine" class="fact">
					<dt>Review said</dt>
					<dd class="mono" :data-testid="TESTIDS.sendReceiptReviewSaid">{{ reviewLine }}</dd>
				</div>
				<div v-if="from" class="fact">
					<dt>From</dt>
					<dd class="mono" :title="from.full" :data-testid="TESTIDS.sendReceiptFrom">{{ from.chain }} · {{ from.short }}</dd>
				</div>
				<div class="fact">
					<dt>Visibility</dt>
					<dd :data-testid="TESTIDS.sendReceiptVisibility">{{ visibility }}</dd>
				</div>
			</dl>

			<div v-if="links.length" class="links">
				<a
					v-for="link in links"
					:key="link.href"
					:href="link.href"
					target="_blank"
					rel="noopener noreferrer"
					:data-testid="TESTIDS.receiptLink"
				>{{ link.label }}<Icon name="external-link" :size="12" /></a>
			</div>
			<div class="ctas">
				<Button size="large" :data-testid="TESTIDS.receiptNewBridge" @click="emit('new-bridge')">
					<Icon name="repeat" :size="24" />{{ ctaLabel }}
				</Button>
				<Button
					v-if="snapshot.addTokenLabel"
					size="large"
					variant="secondary"
					:loading="addTokenBusy"
					:disabled="addTokenBusy"
					:data-testid="TESTIDS.sendReceiptAddToken"
					@click="emit('add-token')"
				>
					<Icon v-if="!addTokenBusy" name="plus" :size="24" />{{ addTokenBusy ? "Adding" : snapshot.addTokenLabel }}
				</Button>
			</div>
		</section>
		<p v-if="note" class="note ul-notch"><Icon class="note-icon" name="info-box" :size="24" /><span>{{ note }}</span></p>
	</div>
</template>

<style scoped>
.receipt-col {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.receipt {
	--ul-fill: var(--ul-panel);
	--ul-notch: var(--ul-notch-4);
	--pad: 32px;
	display: flex;
	flex-direction: column;
	padding: var(--pad);
}

.mono {
	font-family: var(--ul-font-mono);
}

.head {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	align-items: center;
	gap: 4px 16px;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.stamp {
	font: 400 12.5px/1.45 var(--ul-font-mono);
	color: var(--ul-ink-3);
}

.title {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-top: 18px;
}

.title h2 {
	font: 700 17px/1.3 var(--ul-font-body);
	color: var(--ul-ink);
}

.done {
	flex: none;
	color: var(--ul-carrier);
}

.hero {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	column-gap: 14px;
	min-width: 0;
	margin-top: 14px;
	container-type: inline-size;
}

/* Sized so its `--n` characters (grouping commas included) fit the card on one line, the face
   advancing about 0.98em, up to 56px; past the 20px floor an 18-decimal amount wraps. */
.digits {
	min-width: 0;
	font: 400 clamp(20px, calc(100cqi / (var(--n) + 1)), 56px) / 1 var(--ul-font-pixel);
	font-variation-settings: "XELA" 0, "YELA" 0, "SCAN" 0, "BLED" 0;
	color: var(--ul-ink);
	overflow-wrap: anywhere;
	animation: converge var(--ul-converge) both;
}

.sym {
	font: 600 20px/1.2 var(--ul-font-mono);
	color: var(--ul-ink);
}

/* Only the variable axes move: the displayed digits never change. */
@keyframes converge {
	0% {
		font-variation-settings: "XELA" 90, "YELA" -80, "SCAN" 70, "BLED" 60;
		animation-timing-function: steps(3);
	}
	37.5% {
		font-variation-settings: "XELA" 45, "YELA" -38, "SCAN" 40, "BLED" 30;
		animation-timing-function: steps(3);
	}
	75% {
		font-variation-settings: "XELA" 12, "YELA" -10, "SCAN" 10, "BLED" 6;
		animation-timing-function: steps(2);
	}
	100% {
		font-variation-settings: "XELA" 0, "YELA" 0, "SCAN" 0, "BLED" 0;
	}
}

.caption {
	margin-top: 8px;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

/* Bleeds through the card's padding to both edges. */
.scan {
	position: relative;
	height: 12px;
	margin: 14px calc(-1 * var(--pad)) 0;
	overflow: hidden;
}

.scan .line {
	position: absolute;
	inset-inline: 0;
	top: 5px;
	height: 2px;
	background: var(--ul-signal);
	opacity: 0.4;
}

/* One pass once the digits lock, starting and ending outside the band. */
.scan .pass {
	position: absolute;
	inset-inline: 0;
	top: 4px;
	height: 3px;
	background: var(--ul-carrier);
	opacity: 0.5;
	transform: translateX(-100%);
	animation: scan-pass var(--ul-converge) 640ms both;
}

@keyframes scan-pass {
	from {
		transform: translateX(-100%);
	}
	to {
		transform: translateX(100%);
	}
}

.account {
	margin-top: 12px;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.account strong,
.account .mono {
	color: var(--ul-ink);
}

.account strong {
	font-weight: 700;
}

.facts {
	display: flex;
	flex-direction: column;
	gap: 10px;
	margin-top: 28px;
	font: 400 14px/1.45 var(--ul-font-body);
}

.fact {
	display: grid;
	grid-template-columns: 130px minmax(0, 1fr);
}

.fact dt {
	color: var(--ul-ink-2);
}

.fact dd {
	min-width: 0;
	color: var(--ul-ink);
	overflow-wrap: anywhere;
}

.links {
	display: flex;
	flex-wrap: wrap;
	gap: 18px;
	margin-top: 24px;
}

.links a {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font: 700 14px/1 var(--ul-font-body);
	color: var(--ul-accent-text);
	text-decoration: none;
}

.links a:hover {
	text-decoration: underline;
	text-underline-offset: 4px;
}

.ctas {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	margin-top: 28px;
}

.note {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: flex-start;
	gap: 12px;
	padding: 12px 14px;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.note-icon {
	flex: none;
}

@media (max-width: 760px) {
	.receipt {
		--pad: 20px;
	}

	.fact {
		grid-template-columns: minmax(0, 1fr);
	}
}

@media (prefers-reduced-motion: reduce) {
	.digits,
	.scan .pass {
		animation: none !important;
	}
}
</style>
