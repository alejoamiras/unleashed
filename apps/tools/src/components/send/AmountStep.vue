<script setup lang="ts">
/** Utils */
import { Button, Icon } from "@unleashed/design"
import { computed, onScopeDispose, ref, watch } from "vue"
import { PHONE_QUERY, useMediaQuery } from "@/composables/useMediaQuery"
import { formatCompact, formatDisplayAmount, parseAmountStrict, toDecimalString } from "@/lib/format"
import {
	type AmountToken,
	type Direction,
	GAS_BLOCK_REASON,
	type GasBlock,
	type GasLegPlan,
	type SendIntent,
	type TokenBalances,
	tokenRemainder,
} from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import { safeDisplay } from "@/lib/token-display"
import type { CrossChainNotice } from "@/composables/useCrossChainSend"
import type { Rail } from "@/lib/chains"
import { approxText, type CrossChainFigures, type FeeCeiling, FEE_CEILING_BPS, feeShareText } from "@/lib/crosschain-figures"

/** Components */
import ChoiceCards from "./ChoiceCards.vue"
import CrossChainFees from "./CrossChainFees.vue"
import CrossChainState from "./CrossChainState.vue"
import GasBreakdown from "./GasBreakdown.vue"
import StateNotice from "./StateNotice.vue"

export type RouteKind = "route" | "identity" | "no-route" | "unavailable"

/** What a cross-chain route says about this amount: its figures in the source token, and why it may not go. */
export interface CrossChainAmount {
	srcChainId: number
	rail: Rail
	figures: CrossChainFigures | null
	ceiling: FeeCeiling | null
	notice: CrossChainNotice | null
	/** Milliseconds before the quote is asked again; null while there is none. */
	expiresIn: number | null
}

const props = defineProps<{
	direction: Direction
	token: AmountToken
	/** The chain is still being read behind this step: the field is live, Continue is not. */
	resolving?: boolean
	balances: TokenBalances
	intent: SendIntent
	/** A string model: the field must keep what the user typed, including a trailing separator. */
	amount: string
	isPrivate: boolean
	gas: GasLegPlan | null
	routeKind: RouteKind | null
	routeLoading: boolean
	txTarget: number
	fjPerTx: bigint | null
	/** Fee Juice a gas-only claim sets aside before it pays for any transaction; null while unpriced. */
	gasSetAside?: bigint | null
	gasError: string | null
	/** A refusal decided above the step (an exit on a token the hub has not bound): shown, and Continue stays off. */
	blockedReason?: string | null
	/** Why `token` alone cannot continue (the account holds no gas to claim with): its card says so, and Continue stays off while it is the choice. */
	tokenOnlyBlocked?: string | null
	/** Set for a send that starts on another chain: the route's figures replace the Ethereum-origin ones. */
	crossChain?: CrossChainAmount | null
}>()
const emit = defineEmits<{
	"update:intent": [intent: SendIntent]
	"update:amount": [amount: string]
	"update:isPrivate": [isPrivate: boolean]
	"update:txTarget": [target: number]
	/** This step owns the field's validity; the wizard gates the review on what it reports here. */
	"update:valid": [valid: boolean]
	/** Quote the route again. */
	retry: []
	back: []
	next: []
}>()

const NUMERIC_SHAPE = /^\d*(\.\d*)?$/

/** Referenced by `aria-describedby`: one amount step exists at a time. */
const AMOUNT_ERROR_ID = "send-amount-error"
const PRIVACY_LABEL_ID = "send-privacy-label"
const GAS_BREAKDOWN_ID = "send-gas-breakdown"

const isExit = computed(() => props.direction === "l2-to-l1")

/** An exit spends the balance the privacy choice names; a deposit spends the Ethereum one. */
const spendable = computed(() =>
	isExit.value ? (props.isPrivate ? props.balances.l2Private : props.balances.l2Public) : props.balances.l1,
)

const parsed = computed(() => parseAmountStrict(props.amount, props.token.decimals))

const amountError = computed<string | null>(() => {
	const text = props.amount.trim()
	// Empty, or a separator with nothing after it yet: an amount still being typed, not a wrong one.
	if (text === "" || text.endsWith(".")) return null
	if (parsed.value === null) {
		return NUMERIC_SHAPE.test(props.amount.trim())
			? `${props.token.symbol} has ${props.token.decimals} decimal places — use no more than that.`
			: "Enter the amount as a number."
	}
	if (parsed.value === 0n) return "Enter an amount greater than zero."
	const max = spendable.value
	if (max !== undefined && parsed.value > max) return "That's more than your balance."
	return null
})

/** A red line waits for the user: it shows once the field is left, or once typing pauses — never on
 *  the keystroke that made a half-typed amount momentarily wrong. An amount that arrives already
 *  typed (the balance tap, a re-entered step) is judged at once. */
const SETTLE_MS = 700
const touched = ref(false)
const settled = ref(true)
let settleTimer: ReturnType<typeof setTimeout> | undefined
const shownError = computed(() => (touched.value || settled.value ? amountError.value : null))

/** More decimal places than the token has are cut on the way in, never reported: a typed or pasted
 *  tail the token cannot carry is not a mistake worth a red line. */
function onInput(raw: string): void {
	settled.value = false
	clearTimeout(settleTimer)
	settleTimer = setTimeout(() => {
		settled.value = true
	}, SETTLE_MS)
	const [whole = "", fraction] = raw.split(".")
	const keep = props.token.decimals
	// Decimals still unknown (a pasted token being read) cut nothing: there is no place count to cut to.
	const cut =
		keep < 0 || fraction === undefined || fraction.length <= keep ? raw : keep === 0 ? whole : `${whole}.${fraction.slice(0, keep)}`
	emit("update:amount", cut)
}
onScopeDispose(() => clearTimeout(settleTimer))

/** The block cursor stands in for the caret only while the selection is collapsed at the end of the
 *  value; anywhere else the native caret has to show where an edit lands. */
const caretAtEnd = ref(true)
const amountInput = ref<HTMLInputElement | null>(null)
function syncCaret(): void {
	const input = amountInput.value
	if (input) caretAtEnd.value = input.selectionStart === input.selectionEnd && input.selectionEnd === input.value.length
}
// A held arrow key repeats keydown with no keyup, and the caret moves only after the handler runs.
const syncCaretSoon = (): void => void setTimeout(syncCaret, 0)
watch(() => props.amount, syncCaret, { flush: "post" })

const showGas = computed(() => !isExit.value && props.intent !== "token")

// The route outcomes that close both gas choices; a working route says nothing.
const gasBlock = computed<GasBlock | null>(() =>
	props.routeKind === "no-route" || props.routeKind === "unavailable" ? props.routeKind : null,
)

// Only an outcome is announced; a route still being checked says nothing rather than a spinner line.
const routeLine = computed(() => (isExit.value || props.routeLoading || !gasBlock.value ? null : GAS_BLOCK_REASON[gasBlock.value]))

const phone = useMediaQuery(PHONE_QUERY)
const shownGasError = computed(() => (touched.value || settled.value ? props.gasError : null))

/** On a phone the breakdown folds behind the selected gas row's hint, but never over an error or a
 *  cap note: those hold it open. */
const gasOpen = ref(false)
watch(
	() => props.token,
	() => {
		gasOpen.value = false
	},
)
// The breakdown draws its cap note only for token + gas; a capped gas-only plan has none to show.
const showsCapNote = computed(() => props.intent === "token+gas" && Boolean(props.gas?.capped))
const breakdownHeld = computed(() => shownGasError.value !== null || showsCapNote.value)
const breakdownOpen = computed(() => gasOpen.value || breakdownHeld.value)
// A tap while held would flip a state nobody sees, and decide what shows once the hold ends.
function toggleGas(): void {
	if (!breakdownHeld.value) gasOpen.value = !gasOpen.value
}

/** A cross-chain route that may go: priced, refused by nothing, and not over a ceiling that blocks. */
const crossChainOk = computed(() => {
	const x = props.crossChain
	return !x || (x.figures !== null && x.notice === null && !x.ceiling?.blocks)
})

const canContinue = computed(() => {
	if (props.blockedReason || props.resolving || !crossChainOk.value) return false
	if (!isExit.value && props.intent === "token" && props.tokenOnlyBlocked) return false
	if (amountError.value !== null || parsed.value === null || parsed.value === 0n) return false
	return !showGas.value || props.gas !== null
})

watch(canContinue, (valid) => emit("update:valid", valid), { immediate: true })

const symbolText = computed(() => safeDisplay(props.token.symbol))
const figures = computed(() => props.crossChain?.figures ?? null)

/** What lands on Aztec: the token less the relay fee and the slice, or the gas a gas-only send buys. */
const crossChainArrives = computed(() => {
	const f = figures.value
	if (!f) return { text: "—", sub: "" }
	if (props.intent === "gas") return { text: f.gasExpected === null ? "—" : `≈ ${formatCompact(f.gasExpected, 18)} FJ`, sub: "as gas" }
	return { text: approxText(f.tokenArrives ?? 0n, props.token.decimals, symbolText.value), sub: "" }
})

/** A gas-only send is never refused for its fee, only told when the fee outweighs the gas. */
const feeOverGas = computed(() => {
	const f = figures.value
	if (!f || props.intent !== "gas" || f.relayFee <= f.delivered) return null
	return `Fees ${approxText(f.relayFee, props.token.decimals, symbolText.value)}, more than the gas itself.`
})

const ceilingBox = computed(() => {
	const c = props.crossChain?.ceiling
	const f = figures.value
	if (!c?.over || !f || props.intent === "gas") return null
	const fee = approxText(f.relayFee, props.token.decimals, symbolText.value)
	const minimum = formatDisplayAmount(c.minimum, props.token.decimals)
	return {
		blocks: c.blocks,
		title: `Fees ${fee} are ${feeShareText(f.feeBps)} of this send, over the ${FEE_CEILING_BPS / 100} % limit.`,
		minimum,
		raw: toDecimalString(c.minimum, props.token.decimals),
	}
})

/** What arrives privately, for the veil line: a deposit's token part, once its split is known. A gas-only
 *  send arrives as public gas, so it has none; a cross-chain one arrives less the rail's fee. */
const veiled = computed(() => {
	if (isExit.value || !props.isPrivate || props.intent === "gas") return null
	const crossed = figures.value?.tokenArrives
	if (props.crossChain) return crossed ? `${formatDisplayAmount(crossed, props.token.decimals)} ${symbolText.value}` : null
	if (props.intent === "token+gas" && !props.gas) return null
	if (!parsed.value) return null
	const rest = tokenRemainder(parsed.value, props.intent === "token" ? null : props.gas)
	return rest > 0n ? `${formatDisplayAmount(rest, props.token.decimals)} ${symbolText.value}` : null
})

/** Exact, never cut: the balance line fills the field with this very number (ungrouped, in `onUseAll`). */
const balanceText = computed(() => (spendable.value === undefined ? "—" : formatDisplayAmount(spendable.value, props.token.decimals)))

const balanceTestid = computed(() => {
	if (!isExit.value) return TESTIDS.sendBalanceL1
	return props.isPrivate ? TESTIDS.sendBalanceL2Private : TESTIDS.sendBalanceL2Public
})

function onUseAll(): void {
	const max = spendable.value
	if (max !== undefined) emit("update:amount", toDecimalString(max, props.token.decimals))
}
</script>

<template>
	<section
		class="step"
		:data-testid="TESTIDS.sendStepAmount"
		:data-direction="direction"
		:data-route-loading="routeLoading || undefined"
	>
		<ChoiceCards
			:intent="intent"
			:exit-only="isExit"
			:fee-asset="routeKind === 'identity'"
			:gas-block="gasBlock"
			:token-reason="isExit ? null : (tokenOnlyBlocked ?? null)"
			:tx-target="txTarget"
			:breakdown-id="showGas ? GAS_BREAKDOWN_ID : undefined"
			:breakdown-open="breakdownOpen"
			:breakdown-held="breakdownHeld"
			@update:intent="emit('update:intent', $event)"
			@toggle-gas="toggleGas"
		/>

		<!-- The cards show these reasons in place; this region only announces them. It stays mounted
		     because a live region inserted with its text already in it is not announced. -->
		<div class="sr-only" aria-live="polite">
			<p v-if="routeLine" :data-testid="TESTIDS.sendRouteStatus" :data-route="routeKind ?? undefined">{{ routeLine }}</p>
			<p v-if="!isExit && intent === 'token' && tokenOnlyBlocked" data-route="no-gas" :data-testid="TESTIDS.sendTokenOnlyBlocked">
				{{ tokenOnlyBlocked }}
			</p>
		</div>

		<div class="amount" :class="{ 'with-arrives': crossChain }">
			<!-- The field names itself; this is the phone's visible caption for it. -->
			<span class="amount-label" aria-hidden="true">Amount</span>
			<label
				class="field ul-notch"
				:data-invalid="shownError ? 'true' : undefined"
				:data-caret-at-end="caretAtEnd ? 'true' : undefined"
			>
				<input
					class="input"
					type="text"
					inputmode="decimal"
					autocomplete="off"
					placeholder="0"
					:aria-label="`Amount in ${token.symbol}`"
					:aria-invalid="shownError ? 'true' : undefined"
					:aria-describedby="shownError ? AMOUNT_ERROR_ID : undefined"
					:value="amount"
					:data-testid="TESTIDS.sendAmountInput"
					ref="amountInput"
					@input="onInput(($event.target as HTMLInputElement).value); syncCaret()"
					@keydown="syncCaretSoon"
					@keyup="syncCaret"
					@click="syncCaret"
					@select="syncCaret"
					@selectionchange="syncCaret"
					@focus="syncCaret"
					@blur="touched = true"
				/>
				<span class="cursor" aria-hidden="true" />
				<span class="unit">{{ token.symbol }}</span>
			</label>
			<!-- The balance line IS the max control: tapping it fills the field with the whole balance. -->
			<button
				type="button"
				class="balance-btn"
				aria-label="Use the whole balance"
				:disabled="spendable === undefined"
				:data-testid="TESTIDS.sendAmountMax"
				@click="onUseAll"
			>
				<span class="balance" :data-testid="balanceTestid">
					<span class="balance-k">Balance</span> {{ balanceText }} <span class="balance-unit">{{ token.symbol }}</span>
				</span>
			</button>
			<p v-if="crossChain" class="arrives" :data-testid="TESTIDS.sendXcArrives">
				Arrives on Aztec <span class="arrives-figure">{{ crossChainArrives.text }}</span>
				<template v-if="crossChainArrives.sub"> {{ crossChainArrives.sub }}</template>
			</p>
			<p v-if="shownError" :id="AMOUNT_ERROR_ID" class="err" aria-live="polite" :data-testid="TESTIDS.sendAmountError">
				<Icon name="square-alert" :size="12" />{{ shownError }}
			</p>
		</div>

		<GasBreakdown
			v-if="showGas && intent !== 'token'"
			v-show="!phone || breakdownOpen"
			:id="GAS_BREAKDOWN_ID"
			:token="token"
			:amount="figures?.delivered ?? parsed ?? 0n"
			:intent="intent"
			:gas="gas"
			:tx-target="txTarget"
			:fj-per-tx="fjPerTx"
			:set-aside="gasSetAside"
			:loading="routeLoading"
			:error="shownGasError"
			:approx="Boolean(crossChain)"
			@update:tx-target="emit('update:txTarget', $event)"
		/>

		<template v-if="crossChain">
			<CrossChainState
				v-if="crossChain.notice"
				:state="crossChain.notice"
				:src-chain-id="crossChain.srcChainId"
				:send-text="`${formatDisplayAmount(parsed ?? 0n, token.decimals)} ${symbolText}`"
				@act="emit('retry')"
			/>
			<CrossChainFees
				v-else
				:figures="crossChain.figures"
				:decimals="token.decimals"
				:symbol="symbolText"
				:src-chain-id="crossChain.srcChainId"
				:rail="crossChain.rail"
				:intent="intent"
				:expires-in="crossChain.expiresIn"
			/>
			<p v-if="feeOverGas" class="over-gas ul-notch" :data-testid="TESTIDS.sendXcGasOverFee">
				<Icon name="warning-diamond" :size="24" /><span>{{ feeOverGas }}</span>
			</p>
			<StateNotice
				v-if="ceilingBox"
				:tone="ceilingBox.blocks ? 'lost' : 'attention'"
				icon="square-alert"
				:title="ceilingBox.title"
				:action="ceilingBox.blocks ? `Use ${ceilingBox.minimum} ${symbolText}` : undefined"
				:action-testid="TESTIDS.sendXcUseMinimum"
				:data-testid="TESTIDS.sendXcCeiling"
				:data-blocks="ceilingBox.blocks || undefined"
				@act="emit('update:amount', ceilingBox.raw)"
			>
				<template v-if="ceilingBox.blocks" #default>Send at least ≈ {{ ceilingBox.minimum }} {{ symbolText }}.</template>
			</StateNotice>
		</template>

		<div class="privacy ul-notch" :class="{ on: isPrivate }">
			<div class="privacy-row">
				<button
					type="button"
					role="switch"
					class="toggle ul-notch"
					:class="{ on: isPrivate }"
					:aria-checked="isPrivate"
					aria-label="Private"
					:aria-describedby="PRIVACY_LABEL_ID"
					:data-testid="TESTIDS.sendPrivateToggle"
					@click="emit('update:isPrivate', !isPrivate)"
				>
					<span class="knob" />
				</button>
				<span :id="PRIVACY_LABEL_ID" class="privacy-label">{{ isPrivate ? "Private — only you can see it" : "Public — visible on Aztec" }}</span>
			</div>
			<p v-if="veiled" class="veil-line" :data-testid="TESTIDS.sendPrivacyVeil">
				<span>Others on Aztec see</span>
				<span class="veil-host"><span class="ul-veil veil" role="img" aria-label="hidden amount" /></span>
				<!-- One unit, so a wrapped line never ends on the separator. -->
				<span class="seen"><span class="dot" aria-hidden="true">·</span><span>you see <strong class="veiled">{{ veiled }}</strong></span></span>
			</p>
		</div>

		<p v-if="blockedReason" class="err" aria-live="polite" :data-testid="TESTIDS.sendAmountBlocked">
			<Icon name="square-alert" :size="12" />{{ blockedReason }}
		</p>

		<div class="nav">
			<Button variant="secondary" size="large" :data-testid="TESTIDS.sendAmountBack" @click="emit('back')">Back</Button>
			<Button class="next" size="large" :disabled="!canContinue" :data-testid="TESTIDS.sendAmountNext" @click="emit('next')">
				Continue
				<Icon name="chevron" :size="phone ? 12 : 24" :rotate="-90" />
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

.amount {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	grid-template-areas: "field" "balance";
	gap: 8px;
}

.amount.with-arrives {
	grid-template-columns: minmax(0, 1fr) auto;
	grid-template-areas: "field field" "arrives balance";
	align-items: baseline;
	column-gap: 16px;
}

.arrives {
	grid-area: arrives;
	margin: 0;
	font: 400 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.arrives-figure {
	font-family: var(--ul-font-mono);
	color: var(--ul-ink);
}

.over-gas {
	--ul-fill: var(--ul-attention-bg);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: flex-start;
	gap: 12px;
	margin: 0;
	padding: 12px 14px;
	font: 700 14px/1.45 var(--ul-font-body);
	color: var(--ul-attention);
}

.over-gas > :first-child {
	flex: none;
	margin-top: 1px;
}

.amount-label {
	display: none;
	grid-area: label;
}

/* An implicit row, so an absent error leaves no gap behind. */
.amount > .err {
	grid-column: 1 / -1;
}

.field {
	--ul-fill: var(--ul-field);
	--ul-notch: var(--ul-notch-2);
	--edge: var(--ul-ink-3);
	grid-area: field;
	display: flex;
	align-items: center;
	gap: 12px;
	min-height: 72px;
	padding: 0 18px;
	cursor: text;
}

/* The state edge rides on the clipped fill, so it follows the notch. */
.field::before {
	box-shadow: inset 0 -2px 0 var(--edge);
}

.field:focus-within {
	--edge: var(--ul-focus);
}

.field[data-invalid] {
	--edge: var(--ul-lost);
}

.input {
	flex: 1;
	min-width: 0;
	padding: 0;
	color: var(--ul-ink);
	caret-color: var(--ul-signal);
	font: 600 34px/1.2 var(--ul-font-body);
	font-variant-numeric: tabular-nums;
	letter-spacing: -0.01em;
}

.input::placeholder {
	color: var(--ul-disabled);
}

.cursor {
	display: none;
	flex: none;
	width: 16px;
	height: 32px;
	background: var(--ul-signal);
	animation: blink var(--ul-cursor) infinite;
}

/* The block cursor needs the field to hug its text; without that it would float at the far end. */
@supports (field-sizing: content) {
	.input {
		flex: 0 1 auto;
		field-sizing: content;
		min-width: 1ch;
	}

	.field[data-caret-at-end]:focus-within .input {
		caret-color: transparent;
	}

	.field[data-caret-at-end]:focus-within .cursor {
		display: block;
	}

	.unit {
		margin-left: auto;
	}
}

@keyframes blink {
	50% {
		opacity: 0;
	}
}

.unit {
	padding-left: 8px;
	font: 600 15px/1 var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.balance-btn {
	grid-area: balance;
	justify-self: end;
	cursor: pointer;
}

.balance-btn:disabled {
	cursor: default;
}

.balance {
	font: 400 13px/1.4 var(--ul-font-mono);
	color: var(--ul-ink-2);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.balance-btn:hover:not(:disabled) .balance {
	color: var(--ul-accent-text);
}

.balance-k {
	font-family: var(--ul-font-body);
	color: var(--ul-ink-3);
}

.err {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0;
	font: 400 14px/1.4 var(--ul-font-body);
	color: var(--ul-lost);
}

/* Raised only while private; the padding stays, so the switch never moves under the pointer. */
.privacy {
	--ul-fill: transparent;
	--ul-notch: var(--ul-notch-2);
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 14px 16px;
}

.privacy.on {
	--ul-fill: var(--ul-raised);
}

.privacy-row {
	display: flex;
	align-items: center;
	gap: 14px;
}

.toggle {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	flex: none;
	width: 56px;
	height: 30px;
	padding: 5px;
	cursor: pointer;
}

.toggle::before {
	box-shadow: inset 0 0 0 2px var(--ul-ink-3);
}

.toggle.on {
	--ul-fill: var(--ul-signal);
}

.toggle.on::before {
	box-shadow: none;
}

.knob {
	width: 20px;
	height: 20px;
	background: var(--ul-ink-3);
	transition: transform var(--ul-tick);
}

.toggle.on .knob {
	transform: translateX(26px);
	background: var(--ul-on-signal);
}

.privacy-label {
	font: 700 15px/1.3 var(--ul-font-body);
	color: var(--ul-ink);
}

.veil-line {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 12px;
	margin: 0;
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.seen {
	display: inline-flex;
	align-items: center;
	gap: 12px;
}

/* `.ul-veil` sweeps in by animating its own clip-path, so the notch clips this host instead. */
.veil-host {
	display: inline-flex;
	clip-path: var(--ul-notch-2);
}

/* Starts once the switch has landed. */
.veil {
	inline-size: 104px;
	block-size: 22px;
	animation-delay: 90ms;
}

.dot {
	color: var(--ul-disabled);
}

.veiled {
	font: 700 13px/1.4 var(--ul-font-mono);
	color: var(--ul-ink);
}

.nav {
	display: flex;
	justify-content: space-between;
	gap: 8px;
	padding-top: 4px;
}

.next {
	padding-right: 14px;
}

@media (max-width: 760px) {
	.step {
		gap: 14px;
	}

	.amount,
	.amount.with-arrives {
		grid-template-columns: auto minmax(0, 1fr);
		grid-template-areas: "label balance" "field field";
		align-items: baseline;
		gap: 6px 12px;
	}

	.amount.with-arrives {
		grid-template-areas: "label balance" "field field" "arrives arrives";
	}

	.amount-label {
		display: block;
		font: 700 13px/1.3 var(--ul-font-body);
		color: var(--ul-ink);
	}

	.balance {
		font-size: 12.5px;
	}

	.balance-unit {
		display: none;
	}

	.privacy,
	.privacy.on {
		--ul-fill: transparent;
		padding: 0;
	}

	/* The veil line always wraps here, so the separator would only open the second line. */
	.dot {
		display: none;
	}

	.nav {
		flex-direction: column-reverse;
	}

	.nav > * {
		width: 100%;
	}

	.next {
		padding-right: 0;
	}

	.field {
		gap: 10px;
		min-height: 60px;
		padding: 0 14px;
	}

	.input {
		font-size: 28px;
	}

	.unit {
		font-size: 14px;
	}

	.cursor {
		width: 12px;
		height: 26px;
	}
}
</style>
