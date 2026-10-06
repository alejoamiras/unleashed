<script setup lang="ts">
/** Utils */
import { Button, Icon } from "@unleashed/design"
import { computed, ref } from "vue"
import type { CrossChainAsk } from "@/composables/useCrossChainRoute"
import { chainBadge, chainLabel, chainTokenUrl, railLabel } from "@/lib/chains"
import {
	approxText,
	type CrossChainFigures,
	countdownText,
	feeLineLabels,
	feeShareText,
	feeTotalText,
	quoteWord,
	waitText,
} from "@/lib/crosschain-figures"
import { formatAmount, formatCompact, formatDisplayAmount, trimAddress } from "@/lib/format"
import { IS_MAINNET, NETWORK } from "@/lib/network"
import { type SendPlan, venueText } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import { checksumAddress, safeDisplay, safeSentence } from "@/lib/token-display"

/** Components */
import CrossChainState, { type CrossChainState as State } from "./CrossChainState.vue"
import WrongChainNotice from "./WrongChainNotice.vue"

/**
 * The review of a send that starts on another chain: what leaves the source chain, what the rail keeps, what lands on
 * Aztec, and the route between them, all frozen with the quote they came from. A state that forbids signing takes
 * Sign and send's place.
 */
const props = defineProps<{
	/** The deposit as the journal files it: the delivered token, the delivery, the gas leg. */
	plan: SendPlan
	ask: CrossChainAsk
	figures: CrossChainFigures
	/** The source token's symbol, as the token step showed it. */
	symbol: string
	/** The Aztec account the deposit is claimed by. */
	account: string
	slippageBps: number | null
	txCovered: number | null
	/** Milliseconds the quote stays signable. */
	expiresIn: number
	/** Why Sign and send cannot be offered; null when it can. */
	state: State | null
	/** The chain the wallet sits on, when it is not the source chain. */
	walletChainId: number | null
	busy: boolean
	error: string | null
}>()
const emit = defineEmits<{ back: []; confirm: []; act: []; "switch-chain": [] }>()

const open = ref(false)
const SEAL = "a free signature that locks the recovery secret on this device (not a transaction, costs nothing), then "

const src = computed(() => props.ask.srcChainId)
const l1 = chainLabel(NETWORK.l1ChainId)
const rail = computed(() => railLabel(props.ask.rail))
const decimals = computed(() => props.ask.srcToken.decimals)
const destSymbol = computed(() => safeDisplay(props.plan.token.symbol))
const sendAmount = computed(() => formatDisplayAmount(props.ask.srcAmount, decimals.value))
const fees = computed(() => feeLineLabels(src.value, props.ask.rail))
const user = computed(() => trimAddress(checksumAddress(props.ask.user)))
const refundWait = computed(() => (props.figures.refundAfterSeconds === null ? null : waitText(props.figures.refundAfterSeconds)))

const limits = computed(() => {
	const l = props.figures.limits
	return l && { min: `≈ ${formatAmount(l.min, decimals.value)}`, max: `≈ ${formatAmount(l.max, decimals.value)}` }
})

const fixedTerms = computed(
	() =>
		`Fixed testnet terms, not a quote: the relay fee is a fixed ${feeShareText(props.figures.feeBps)} and the send waits for a manual fill on ${l1}.`,
)

const gasLine = computed(() => {
	const f = props.figures
	if (f.gasExpected === null) return null
	const n = props.txCovered
	const covers = n === null ? "gas on Aztec" : `gas on Aztec for ≈ ${n} ${n === 1 ? "transaction" : "transactions"}`
	const from =
		props.ask.intent === "token+gas" && f.slice !== null
			? ` · from ${formatDisplayAmount(f.slice, decimals.value)} ${props.symbol}`
			: ""
	return { figure: `≈ ${formatCompact(f.gasExpected, 18)} FJ`, note: `${covers}${from}` }
})

const takes = computed(() => {
	if (props.figures.fixed && refundWait.value)
		return `Up to ${refundWait.value} for a manual fill on ${l1}, a few minutes for Aztec to pick it up, then your claim.`
	if (!IS_MAINNET)
		return `As long as ${rail.value}'s test relayer takes to reach ${l1}, a few minutes for Aztec to pick it up, then your claim.`
	const minutes = Math.max(1, Math.ceil(props.figures.etaSeconds / 60))
	return `About ${minutes} min to reach ${l1}, a few minutes for Aztec to pick it up, then your claim.`
})

const youSign = computed(
	() =>
		`On ${chainLabel(src.value)}: ${props.ask.isPrivate ? SEAL : ""}approve exactly ${sendAmount.value} ${props.symbol}, then send. Later, one prompt on Aztec to claim.`,
)

const routeText = computed(() => {
	const crossing = `${chainLabel(src.value)} → ${l1} through LI.FI (${rail.value}).`
	const g = props.plan.gas
	if (!g?.venue || props.figures.slice === null) return crossing
	const slice = `${formatDisplayAmount(props.figures.slice, decimals.value)} ${destSymbol.value}`
	return `${crossing} On ${l1}, ${slice} → AZTEC through ${venueText(g.venue, safeDisplay)}, then the gas leg is bridged.`
})

const tokenAddress = computed(() => checksumAddress(props.ask.srcToken.address))
const detailsHint = computed(() => (props.plan.gas ? "addresses, slippage, the quote" : "addresses, the quote"))
const slippageText = computed(() => (props.slippageBps === null ? "—" : `${(props.slippageBps / 100).toFixed(2)}%`))
const quoteLine = computed(() => countdownText(props.expiresIn))
const signable = computed(() => props.state === null && props.walletChainId === null)
</script>

<template>
	<section class="step" :data-testid="TESTIDS.sendXcReview">
		<p v-if="!IS_MAINNET && refundWait" class="testnet ul-notch" :data-testid="TESTIDS.sendXcTestnetNotice">
			<span class="glyph"><Icon name="info-box" :size="24" /></span>
			<span
				>Testnet: delivery depends on {{ rail }}'s test relayer. If nobody delivers it within {{ refundWait }}, it is refunded to you on
				{{ chainLabel(src) }}.</span
			>
		</p>

		<dl class="lines">
			<div class="line send ul-notch" :data-testid="TESTIDS.sendReviewSend">
				<dt>Send</dt>
				<dd class="send-dd">
					<span class="amount">{{ sendAmount }}</span>
					<span class="symbol">{{ symbol }}</span>
					<span class="from">from <span class="chip">{{ chainBadge(src) }}</span> {{ chainLabel(src) }}</span>
					<span v-if="figures.fixed" class="limits" :data-testid="TESTIDS.sendXcFixedTerms">{{ fixedTerms }}</span>
					<span v-else-if="!IS_MAINNET && limits" class="limits" :data-testid="TESTIDS.sendXcLimits"
						>{{ rail }}'s testnet limits: at least <span class="mono">{{ limits.min }}</span>, at most
						<span class="mono">{{ limits.max }}</span> {{ symbol }} per send</span
					>
				</dd>
			</div>
			<div class="line" :data-testid="TESTIDS.sendReviewArrives">
				<dt>Arrives</dt>
				<dd class="legs">
					<span v-if="figures.tokenArrives !== null"
						>{{ approxText(figures.tokenArrives, plan.token.decimals, destSymbol) }} <span class="soft">on Aztec</span></span
					>
					<span v-if="gasLine" :data-testid="TESTIDS.sendReviewGas">{{ gasLine.figure }} <span class="soft">{{ gasLine.note }}</span></span>
				</dd>
			</div>
			<div class="line" :data-testid="TESTIDS.sendReviewVisibility" :data-visibility="plan.isPrivate ? 'private' : 'public'">
				<dt>Visibility</dt>
				<dd class="visibility">
					<span class="eye" :data-private="plan.isPrivate || undefined"><Icon :name="plan.isPrivate ? 'eye-off' : 'eye'" :size="12" /></span>
					<strong>{{ plan.isPrivate ? "Private" : "Public" }}</strong>
					<span class="soft">— {{ plan.isPrivate ? "only you can see it" : "visible on Aztec" }}</span>
				</dd>
			</div>
			<div class="line" :data-testid="TESTIDS.sendReviewNetworkFee">
				<dt>Fees</dt>
				<dd class="fees">
					<span class="mono">{{ feeTotalText(figures, decimals, symbol, ask.intent) }}</span>
					<span class="fee-lines">
						<span class="fee-line"
							><span>{{ fees.relay }}</span><span class="mono ink">{{ approxText(figures.relayFee, decimals, symbol) }}</span></span
						>
						<span class="fee-line"><span>{{ fees.network }}</span><span class="ink">network fee</span></span>
					</span>
					<span v-if="IS_MAINNET" class="fee-note">The relay fee also pays the deposit’s Ethereum gas.</span>
				</dd>
			</div>
			<div class="line" :data-testid="TESTIDS.sendReviewRoute">
				<dt>Route</dt>
				<dd class="route" :data-testid="TESTIDS.sendXcRouteLine">
					<span class="chip">{{ chainBadge(src) }}</span><span class="arrow" aria-hidden="true">→</span><span class="chip">ETH</span>
					<span class="soft">via {{ rail }}</span><span class="arrow" aria-hidden="true">→</span><span class="chip aztec">AZTEC</span>
					<span class="sr-only">{{ chainLabel(src) }} to {{ l1 }} via {{ rail }}, then into Aztec.</span>
					<span class="arrow dot" aria-hidden="true">·</span>
					<span class="powered"
						>Powered by
						<a href="https://li.fi" target="_blank" rel="noopener noreferrer" :data-testid="TESTIDS.sendXcLifi">LI.FI</a></span
					>
				</dd>
			</div>
			<div class="line" :data-testid="TESTIDS.sendReviewTakes">
				<dt>Takes</dt>
				<dd class="prose">{{ takes }}</dd>
			</div>
			<div class="line" :data-testid="TESTIDS.sendXcYouSign">
				<dt>You sign</dt>
				<dd class="prose itemised">{{ youSign }}</dd>
			</div>
		</dl>

		<p class="note ul-notch" :data-testid="TESTIDS.sendXcFallback">
			<span class="glyph"><Icon name="info-box" :size="24" /></span>
			<span v-if="IS_MAINNET"
				>If the deposit can’t run on {{ l1 }}, the {{ destSymbol }} goes to your own Ethereum address <span class="mono ink">{{ user }}</span>
				instead. You can continue from Ethereum later; that needs a little ETH there for gas.</span
			>
			<span v-else
				>If the deposit can’t run on {{ l1 }}, the {{ destSymbol }} goes to your own address <span class="mono ink">{{ user }}</span> there
				instead. You can continue from there later; that needs a little test ETH for gas.</span
			>
		</p>

		<div class="details ul-notch">
			<button type="button" class="toggle" :aria-expanded="open" :data-testid="TESTIDS.sendReviewDetailsToggle" @click="open = !open">
				<Icon name="chevron" :size="12" color="secondary" :rotate="open ? 0 : -90" />
				<span>Details</span>
				<span class="hint">{{ detailsHint }}</span>
			</button>
			<dl v-if="open" class="panel" :data-testid="TESTIDS.sendReviewDetails">
				<div class="row" :data-testid="TESTIDS.sendReviewToken">
					<dt>Token</dt>
					<dd class="full">
						<a :href="chainTokenUrl(src, tokenAddress)" target="_blank" rel="noopener noreferrer" :data-testid="TESTIDS.sendReviewTokenLink">{{
							tokenAddress
						}}</a>
					</dd>
				</div>
				<div class="row" :data-testid="TESTIDS.sendReviewRoute">
					<dt>Route</dt>
					<dd>{{ routeText }}</dd>
				</div>
				<div v-if="plan.gas" class="row" :data-testid="TESTIDS.sendReviewSlippage">
					<dt>Slippage</dt>
					<dd>{{ slippageText }}</dd>
				</div>
				<div class="row" :data-testid="TESTIDS.sendReviewAccount">
					<dt>Account</dt>
					<dd :title="account">{{ trimAddress(account) }}</dd>
				</div>
				<div class="row">
					<dt>Fallback</dt>
					<dd>{{ user }} <span class="soft-body">on {{ l1 }}</span></dd>
				</div>
				<div v-if="refundWait" class="row" :data-testid="TESTIDS.sendXcRefund">
					<dt>Refund</dt>
					<dd>{{ user }} <span class="soft-body">on {{ chainLabel(src) }}, after {{ refundWait }} undelivered</span></dd>
				</div>
				<div class="row">
					<dt>Quote</dt>
					<dd>{{ figures.fixed ? "Fixed testnet terms, rebuilt every 60 s" : "Refreshes every 60 s" }}</dd>
				</div>
			</dl>
		</div>

		<WrongChainNotice v-if="walletChainId !== null && !state" :wallet-chain-id="walletChainId" :need-chain-id="src" @switch="emit('switch-chain')" />
		<CrossChainState v-if="state" :state="state" :src-chain-id="src" :send-text="`${sendAmount} ${symbol}`" @act="emit('act')" />
		<p v-if="error" class="error" aria-live="polite" :data-testid="TESTIDS.sendReviewError">
			<Icon name="square-alert" :size="24" />{{ safeSentence(error) }}
		</p>

		<div class="nav">
			<span class="quote-line"
				>{{ quoteWord(figures).valid }} valid for <span class="clock">{{ quoteLine }}</span> · {{ quoteWord(figures).renewed }} before you
				sign</span
			>
			<div class="buttons">
				<Button variant="secondary" size="large" :disabled="busy" :data-testid="TESTIDS.sendReviewBack" @click="emit('back')">Back</Button>
				<Button
					v-if="signable"
					class="sign"
					size="large"
					:disabled="busy"
					:loading="busy"
					:data-testid="TESTIDS.sendReviewConfirm"
					@click="emit('confirm')"
				>
					<Icon v-if="!busy" name="key" :size="24" />
					{{ busy ? "Sending" : "Sign and send" }}
				</Button>
			</div>
		</div>
	</section>
</template>

<style scoped>
.step {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.testnet,
.note {
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: flex-start;
	gap: 12px;
	margin: 0;
	padding: 12px 14px;
	font: 400 14px/1.45 var(--ul-font-body);
}

.testnet {
	--ul-fill: var(--ul-attention-bg);
	color: var(--ul-ink);
}

.testnet .glyph {
	color: var(--ul-attention);
}

.note {
	--ul-fill: var(--ul-raised);
	color: var(--ul-ink-2);
}

.glyph {
	display: flex;
	flex: none;
	margin-top: 1px;
}

.lines {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin: 0;
}

.line {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 4px 16px;
	padding: 11px 16px;
}

.line.send {
	--ul-fill: var(--ul-field);
	--ul-notch: var(--ul-notch-2);
	padding: 14px 16px;
}

dt {
	flex: 0 0 104px;
	font: 400 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink-3);
}

dd {
	flex: 1 1 260px;
	min-width: 0;
	margin: 0;
	font: 400 15px/1.4 var(--ul-font-mono);
	color: var(--ul-ink);
}

.send-dd {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 6px 12px;
}

.amount {
	font: 600 30px/1.1 var(--ul-font-body);
	font-variant-numeric: tabular-nums;
	letter-spacing: -0.01em;
}

.symbol {
	font: 600 15px/1 var(--ul-font-mono);
}

.from {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font: 400 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.chip {
	display: inline-flex;
	align-items: center;
	height: 20px;
	padding: 0 6px;
	clip-path: var(--ul-notch-2);
	background: var(--ul-line);
	color: var(--ul-ink);
	font: 800 11px/1 var(--ul-font-body);
	letter-spacing: 0.06em;
}

.chip.aztec {
	background: var(--ul-signal-tint);
	color: var(--ul-accent-text);
}

.limits {
	flex: 1 0 100%;
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.mono {
	font-family: var(--ul-font-mono);
}

.ink {
	color: var(--ul-ink);
}

.legs {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.soft {
	font-family: var(--ul-font-body);
	color: var(--ul-ink-2);
}

.visibility {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	font-family: var(--ul-font-body);
}

.eye {
	display: inline-flex;
	color: var(--ul-ink-2);
}

.eye[data-private] {
	color: var(--ul-accent-text);
}

.fees {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.fee-lines {
	display: flex;
	flex-direction: column;
	gap: 2px;
	max-width: 480px;
}

.fee-line {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: 2px 16px;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.fee-note {
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.route {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	font-family: var(--ul-font-body);
}

.arrow {
	color: var(--ul-ink-3);
}

.powered {
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-3);
	white-space: nowrap;
}

.powered a {
	font-weight: 700;
	color: var(--ul-ink-2);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.prose {
	font-family: var(--ul-font-body);
}

.itemised {
	font-size: 13px;
	color: var(--ul-ink-3);
}

.details {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	flex-direction: column;
}

.toggle {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	min-height: 44px;
	padding: 0 14px;
	color: var(--ul-ink);
	font: 700 14px/1.2 var(--ul-font-body);
	text-align: left;
	cursor: pointer;
}

.toggle:hover {
	color: var(--ul-accent-text);
}

.hint {
	margin-left: auto;
	font: 400 13px/1.2 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.panel {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin: 0;
	padding: 4px 14px 14px;
}

.row {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 2px 16px;
}

.row dt,
.row dd {
	font-size: 13px;
	line-height: 1.45;
}

.full {
	overflow-wrap: anywhere;
}

.full a {
	color: var(--ul-ink);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.soft-body {
	font-family: var(--ul-font-body);
	color: var(--ul-ink-2);
}

.error {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	margin: 0;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-lost);
}

.nav {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

/* The quote's age lives in the panel's band on a desktop; a phone carries it in this bar. */
.quote-line {
	display: none;
	font: 400 12.5px/1.3 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.clock {
	font-family: var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.buttons {
	display: flex;
	flex-wrap: wrap-reverse;
	justify-content: space-between;
	gap: 8px;
}

@media (max-width: 760px) {
	.step {
		gap: 12px;
	}

	.line {
		padding: 10px 12px;
	}

	.line.send {
		padding: 12px;
	}

	.dot {
		display: none;
	}

	.powered {
		flex: 1 0 100%;
	}

	.nav {
		position: sticky;
		bottom: 0;
		margin: 0 -12px -16px;
		padding: 10px 16px 14px;
		background: var(--ul-panel);
	}

	.quote-line {
		display: block;
	}

	.buttons {
		flex-wrap: nowrap;
	}

	.buttons > .sign {
		flex: 1 1 auto;
	}
}
</style>
