<script setup lang="ts">
/** Utils */
import { Button, Icon } from "@unleashed/design"
import { computed } from "vue"
import { formatCompact, formatDisplayAmount, trimAddress } from "@/lib/format"
import { type ExitPlan, NO_GAS_ROUTE, type SendPlan, tokenRemainder } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import { safeDisplay, safeSentence } from "@/lib/token-display"

/** Components */
import ReviewDetails, { type PortalState } from "./ReviewDetails.vue"
import WrongChainNotice from "./WrongChainNotice.vue"

/** What the view states about the plan, frozen with it: the clock, the fee model, the transaction
 *  count the gas was sized for. Strings and a count, so this step only repeats them. */
export interface ReviewEstimate {
	takes: string
	/** The fee as a figure alone ("≈ 0.42 FJ", "up to ≈ 0.42 FJ"); null when there is no figure to state. */
	networkFee: string | null
	/** Where the fee comes from and what it covers, in prose under the figure. */
	networkFeeNote: string
	/** How many Aztec transactions the gas leg covers; null when the send buys no gas. */
	txCovered: number | null
}

const props = defineProps<{
	plan: SendPlan | ExitPlan
	portalVerified: PortalState
	account: string
	signatureValiditySeconds: number
	slippageBps: number | null
	estimate: ReviewEstimate
	grant: "idle" | "pending" | "declined" | "busy"
	busy: boolean
	error: string | null
	/** Set when a pause refused the exit before anything was authorised; the balance is untouched. */
	paused?: "l1" | "l2" | null
	/** No route could buy gas when the amount step was left, so this send carries none. */
	gasUnavailable?: boolean
	/** The wallet sits on another chain than the one this send signs on: the switch replaces Sign and send. */
	wrongChain?: { walletChainId: number; needChainId: number } | null
}>()
const emit = defineEmits<{ back: []; confirm: []; "switch-chain": [] }>()

const isExit = computed(() => props.plan.direction === "l2-to-l1")

const token = computed(() => props.plan.token)

/** The ticker as it may be rendered: for a listed token this string is publisher-controlled. */
const symbol = computed(() => safeDisplay(token.value.symbol))

/** The token contract contradicts the list that named it. Not fatal — the wizard resolved onto the
 *  contract's own values — but the user chose the row by the name the list published, so the review
 *  has to say the two disagree before anything is signed. */
const conflict = computed(() => token.value.metadataConflict)

const gas = computed(() => (props.plan.direction === "l1-to-l2" ? props.plan.gas : undefined))

// Every token amount on this screen is full precision: a display rounding is a different number
// from the one being signed, and at two places a small send reads as zero. The gas figure is a
// quote, shown compact.
const sendAmount = computed(() => formatDisplayAmount(props.plan.amount, token.value.decimals))
const sendText = computed(() => `${sendAmount.value} ${symbol.value}`)

const tokenArrives = computed(() => {
	if (props.plan.direction === "l2-to-l1") return `${sendText.value} to ${trimAddress(props.plan.recipientL1)} on Ethereum`
	const rest = tokenRemainder(props.plan.amount, gas.value)
	if (rest === 0n) return null
	return `${formatDisplayAmount(rest, token.value.decimals)} ${symbol.value}`
})

/** The choice made on the amount step, in the toggle's own words; gas is always a public balance. */
const visibility = computed(() => {
	if (props.plan.direction !== "l1-to-l2") return null
	return props.plan.isPrivate
		? { word: "Private", note: "only you can see it", icon: "eye-off" as const }
		: { word: "Public", note: "visible on Aztec", icon: "eye" as const }
})

const gasArrives = computed(() => (gas.value ? `≈ ${formatCompact(gas.value.quote, 18)} FJ` : null))

const gasFor = computed(() => {
	const n = props.estimate.txCovered
	if (n === null) return "gas"
	return `gas for ≈ ${n} ${n === 1 ? "transaction" : "transactions"}`
})

const firstTime = computed(() => props.plan.direction === "l1-to-l2" && token.value.state.kind !== "registered")

/** A portal that is neither absent nor the derived one means this send would fund a contract the
 *  wizard cannot account for; nothing may be signed against it. */
const portalMismatch = computed(() => props.portalVerified === "mismatch")

const confirmDisabled = computed(() => props.busy || props.grant === "pending" || portalMismatch.value)
</script>

<template>
	<section class="step" :data-testid="TESTIDS.sendStepReview" :data-direction="plan.direction">
		<dl class="lines">
			<div class="line send ul-notch" :data-testid="TESTIDS.sendReviewSend">
				<dt>Send</dt>
				<dd><span class="amount">{{ sendAmount }}</span> <span class="symbol">{{ symbol }}</span></dd>
			</div>
			<div class="line" :data-testid="TESTIDS.sendReviewArrives">
				<dt>Arrives</dt>
				<dd class="legs">
					<span v-if="tokenArrives" class="leg">{{ tokenArrives }}</span>
					<span v-if="gasArrives" class="leg" :data-testid="TESTIDS.sendReviewGas">{{ gasArrives }} <span class="soft-inline">{{ gasFor }}</span></span>
				</dd>
			</div>
			<div v-if="visibility" class="line" :data-testid="TESTIDS.sendReviewVisibility" :data-visibility="plan.isPrivate ? 'private' : 'public'">
				<dt>Visibility</dt>
				<dd class="visibility">
					<span class="eye" :data-private="plan.isPrivate || undefined"><Icon :name="visibility.icon" :size="12" /></span>
					<strong class="word">{{ visibility.word }}</strong> <span class="soft-inline">— {{ visibility.note }}</span>
				</dd>
			</div>
			<div class="line" :data-testid="TESTIDS.sendReviewNetworkFee">
				<dt>Fee</dt>
				<dd class="fee"><span v-if="estimate.networkFee">{{ estimate.networkFee }}</span> <span class="fee-note">{{ estimate.networkFeeNote }}</span></dd>
			</div>
			<div class="line" :data-testid="TESTIDS.sendReviewTakes">
				<dt>Takes</dt>
				<dd class="prose">{{ estimate.takes }}</dd>
			</div>
		</dl>

		<p v-if="gasUnavailable" class="note attention ul-notch" :data-testid="TESTIDS.sendReviewNoGas">
			<Icon name="warning-diamond" :size="24" />{{ NO_GAS_ROUTE }}
		</p>
		<p v-if="firstTime" class="note soft ul-notch" :data-testid="TESTIDS.sendReviewFirstTime">
			<Icon name="info-box" :size="24" color="secondary" />
			First time for this token here — the send takes a little longer and costs a bit more than the next one will.
		</p>
		<p v-if="conflict" class="note warn" aria-live="polite" :data-testid="TESTIDS.sendReviewMetadataWarning">
			<Icon name="warning-diamond" :size="24" />
			This contract calls itself {{ safeDisplay(conflict.live.symbol) }} ({{ conflict.live.decimals }} decimals), not
			{{ safeDisplay(conflict.listed.symbol) }} ({{ conflict.listed.decimals }} decimals) as the token list said. Check the address in the
			details before you send.
		</p>
		<p v-if="portalMismatch" class="note warn" aria-live="polite" :data-testid="TESTIDS.sendReviewPortalWarning">
			<Icon name="warning-diamond" :size="24" />
			This token's setup on Ethereum is not the one this send derives, so it cannot continue. Open the details below to see what was found.
		</p>
		<p v-if="isExit" class="note soft ul-notch" :data-testid="TESTIDS.sendReviewBurnNote">
			<Icon name="info-box" :size="24" color="secondary" />
			Your tokens leave Aztec as soon as you sign. Ethereum releases them when you finish, which is a separate step.
		</p>

		<ReviewDetails
			:plan="plan"
			:portal-verified="portalVerified"
			:account="account"
			:signature-validity-seconds="signatureValiditySeconds"
			:slippage-bps="slippageBps"
		/>

		<p v-if="grant === 'pending'" class="status" aria-live="polite" :data-testid="TESTIDS.sendGrantPending">
			<span class="dots" aria-hidden="true"><i /><i /><i /></span>Confirm the request in your wallet.
		</p>
		<p v-else-if="grant === 'declined'" class="note warn" aria-live="polite" :data-testid="TESTIDS.sendGrantDeclined">
			<Icon name="warning-diamond" :size="24" />
			Your wallet declined this token. Sign and send again to retry.
		</p>
		<p v-else-if="grant === 'busy'" class="status" aria-live="polite" :data-testid="TESTIDS.sendGrantBusy">
			Your wallet is finishing another request. Try again in a moment.
		</p>
		<p v-if="paused" class="status" aria-live="polite" :data-testid="TESTIDS.sendPausedNotice">
			{{ paused === "l1" ? "Withdrawals to Ethereum are paused right now." : "Exits from Aztec are paused right now." }}
			Your balance is untouched — try again later.
		</p>
		<p v-else-if="error" class="note err" aria-live="polite" :data-testid="TESTIDS.sendReviewError">
			<Icon name="square-alert" :size="24" />{{ safeSentence(error) }}
		</p>

		<WrongChainNotice
			v-if="wrongChain"
			:wallet-chain-id="wrongChain.walletChainId"
			:need-chain-id="wrongChain.needChainId"
			@switch="emit('switch-chain')"
		/>
		<div class="nav">
			<Button variant="secondary" size="large" :disabled="busy" :data-testid="TESTIDS.sendReviewBack" @click="emit('back')">Back</Button>
			<Button
				v-if="!wrongChain"
				size="large"
				:disabled="confirmDisabled"
				:loading="busy"
				:data-testid="TESTIDS.sendReviewConfirm"
				@click="emit('confirm')"
			>
				<Icon v-if="!busy" name="key" :size="24" />
				{{ busy ? "Sending" : "Sign and send" }}
			</Button>
		</div>
	</section>
</template>

<style scoped>
.step {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.lines {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin: 0;
}

.line {
	display: grid;
	grid-template-columns: 104px minmax(0, 1fr);
	gap: 16px;
	align-items: baseline;
	padding: 11px 16px;
}

.line.send {
	--ul-fill: var(--ul-field);
	--ul-notch: var(--ul-notch-2);
	padding: 14px 16px;
}

.send dd {
	display: flex;
	align-items: baseline;
	gap: 12px;
}

dt {
	font: 400 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink-3);
}

dd {
	margin: 0;
	min-width: 0;
	font: 400 15px/1.4 var(--ul-font-mono);
	color: var(--ul-ink);
	overflow-wrap: anywhere;
}

.amount {
	font: 600 30px/1.1 var(--ul-font-body);
	font-variant-numeric: tabular-nums;
	letter-spacing: -0.01em;
}

.symbol {
	font: 600 15px/1 var(--ul-font-mono);
	color: var(--ul-ink);
}

.legs {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.visibility {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	font-family: var(--ul-font-body);
}

/* Icon has no accent colour of its own, so the wrapper sets it. */
.eye {
	display: inline-flex;
	color: var(--ul-ink);
}

.eye[data-private] {
	color: var(--ul-accent-text);
}

.word {
	font-family: var(--ul-font-body);
	font-weight: 700;
}

.fee-note {
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.prose {
	font-family: var(--ul-font-body);
}

.soft-inline {
	font: 400 15px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.note {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	margin: 0;
	font: 400 14px/1.45 var(--ul-font-body);
}

.note > :first-child {
	flex: none;
	margin-top: 2px;
}

.soft {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	padding: 12px 14px;
	color: var(--ul-ink-2);
}

.attention {
	--ul-fill: var(--ul-attention-bg);
	--ul-notch: var(--ul-notch-2);
	padding: 12px 14px;
	color: var(--ul-ink);
}

.attention > :first-child {
	color: var(--ul-attention);
}

.status {
	display: flex;
	align-items: center;
	gap: 12px;
	margin: 0;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink);
}

/* Three signal squares stepping down: the wallet has the request. */
.dots {
	display: inline-flex;
	gap: 3px;
}

.dots i {
	width: 6px;
	height: 6px;
	background: var(--ul-signal);
}

.dots i:nth-child(2) {
	opacity: 0.55;
}

.dots i:nth-child(3) {
	opacity: 0.2;
}

.warn {
	color: var(--ul-attention);
}

.err {
	color: var(--ul-lost);
}

.nav {
	display: flex;
	justify-content: space-between;
	gap: 8px;
}
</style>
