<script setup lang="ts">
/** Utils */
import { Icon } from "@unleashed/design"
import { computed } from "vue"
import { formatCompact, formatDisplayAmount } from "@/lib/format"
import { type AmountToken, type GasLegPlan, type SendIntent, tokenRemainder } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import { safeSentence } from "@/lib/token-display"

const props = defineProps<{
	token: AmountToken
	amount: bigint
	/** `token+gas` sizes a slice for a number of transactions; `gas` spends the whole amount. */
	intent: Extract<SendIntent, "token+gas" | "gas">
	gas: GasLegPlan | null
	/** How many Aztec transactions the proposed slice is sized for. */
	txTarget: number
	/** What one Aztec transaction costs on this network, for saying what a gas-only send is enough for. */
	fjPerTx: bigint | null
	/** Fee Juice the claim sets aside first; "Enough for" counts only what remains, and nothing while
	 *  it is unpriced (null). */
	setAside?: bigint | null
	loading: boolean
	error: string | null
	/** The token figure is a route's estimate, not the exact split of what leaves the wallet. */
	approx?: boolean
}>()
const emit = defineEmits<{ "update:txTarget": [target: number] }>()

const MAX_TX = 999

/** The split the send is signed against, at full precision: a token remainder shown rounded is a
 *  different number from the one leaving the wallet. */
const tokenArrives = computed(
	() => `${props.approx ? "≈ " : ""}${formatDisplayAmount(tokenRemainder(props.amount, props.gas), props.token.decimals)}`,
)

const sliceText = computed(() => (props.gas ? formatDisplayAmount(props.gas.fuelAmount, props.token.decimals) : "—"))

// The gas figures are a quote, read at a glance; the floor the send is signed against is the
// engine's business and the review's slippage line.
const gasArrives = computed(() => (props.gas ? `≈ ${formatCompact(props.gas.quote, 18)} FJ` : "—"))

/** Whole transactions the quote covers; null below one — "≈ 0 transactions" would be a lie about a
 *  send that still lands, so the line is simply absent. */
const enoughFor = computed(() => {
	if (!props.gas || !props.fjPerTx || props.fjPerTx <= 0n || props.setAside === null) return null
	const usable = props.gas.quote - (props.setAside ?? 0n)
	const whole = usable > 0n ? Number(usable / props.fjPerTx) : 0
	return whole >= 1 ? whole : null
})

const CAPPED_NOTE = {
	min: "The slice was raised to the smallest amount that buys usable gas.",
	half: "The slice was capped at half your amount.",
} as const

const cappedNote = computed(() => (props.gas?.capped ? CAPPED_NOTE[props.gas.capped] : null))

function setTarget(next: number): void {
	if (Number.isFinite(next) && next >= 1 && next <= MAX_TX && next !== props.txTarget) emit("update:txTarget", next)
}

function onTarget(event: Event): void {
	const field = event.target as HTMLInputElement
	const next = Number.parseInt(field.value, 10)
	// A blank or junk field is a half-typed edit, not an instruction to size the slice for zero txs —
	// and the field snaps back to the target the slice IS sized for, so it never shows another.
	if (Number.isFinite(next) && next >= 1 && next <= MAX_TX) setTarget(next)
	else field.value = String(props.txTarget)
}
</script>

<template>
	<div
		class="card ul-notch"
		:data-testid="TESTIDS.sendGasBreakdown"
		:data-intent="intent"
		:data-loading="loading || undefined"
		:data-capped="gas?.capped ?? undefined"
	>
		<div v-if="intent === 'token+gas'" class="head">
			<span class="eyebrow"><Icon name="zap" :size="12" color="secondary" />Gas for</span>
			<div class="stepper" role="group" aria-label="Transactions to size the gas for">
				<button
					type="button"
					class="nudge ul-notch"
					aria-label="One transaction fewer"
					:disabled="txTarget <= 1"
					:data-testid="TESTIDS.sendGasTxFewer"
					@click="setTarget(txTarget - 1)"
				>
					<Icon name="minus" :size="24" />
				</button>
				<label class="count">
					<input
						class="count-input"
						type="text"
						inputmode="numeric"
						autocomplete="off"
						aria-label="Transactions to size the gas for"
						:value="txTarget"
						:data-testid="TESTIDS.sendGasTxTarget"
						@change="onTarget"
					/>
					<span class="count-unit">{{ txTarget === 1 ? "transaction" : "transactions" }}</span>
				</label>
				<button
					type="button"
					class="nudge ul-notch"
					aria-label="One transaction more"
					:disabled="txTarget >= MAX_TX"
					:data-testid="TESTIDS.sendGasTxMore"
					@click="setTarget(txTarget + 1)"
				>
					<Icon name="plus" :size="24" />
				</button>
			</div>
		</div>

		<dl class="lines">
			<div v-if="intent === 'token+gas'" class="line" :data-testid="TESTIDS.sendGasBreakdownToken">
				<dt>Arrives as {{ token.symbol }}</dt>
				<dd>{{ tokenArrives }} {{ token.symbol }}</dd>
			</div>
			<div class="line" :data-testid="TESTIDS.sendGasBreakdownFuel">
				<dt>Arrives as gas</dt>
				<dd>
					<template v-if="loading">—</template>
					<template v-else-if="intent === 'gas'">{{ gasArrives }}</template>
					<template v-else
						>{{ gasArrives }}<span class="sr-only">{{ " " }}</span
						><span class="from" :data-testid="TESTIDS.sendGasShare">from {{ sliceText }} {{ token.symbol }}</span></template
					>
				</dd>
			</div>
			<div v-if="intent === 'gas' && enoughFor !== null" class="line" :data-testid="TESTIDS.sendGasEnough">
				<dt>Enough for</dt>
				<dd>≈ {{ enoughFor }} {{ enoughFor === 1 ? "transaction" : "transactions" }}</dd>
			</div>
		</dl>

		<p v-if="intent === 'token+gas' && cappedNote" class="sub">{{ cappedNote }}</p>
		<p v-if="error" class="err" aria-live="polite">{{ safeSentence(error) }}</p>
	</div>
</template>

<style scoped>
.card {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 12px 14px 14px 16px;
}

.head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
}

.eyebrow {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font: 700 14px/1.3 var(--ul-font-body);
	color: var(--ul-ink);
}

.stepper {
	display: flex;
	align-items: stretch;
	gap: 4px;
}

.nudge {
	--ul-fill: var(--ul-panel);
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 40px;
	height: 40px;
	color: var(--ul-ink);
	cursor: pointer;
}

.nudge:hover:not(:disabled) {
	color: var(--ul-accent-text);
}

.nudge:disabled {
	--ul-fill: var(--ul-raised);
	color: var(--ul-disabled);
	cursor: not-allowed;
}

.count {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	min-width: 148px;
	height: 40px;
	padding: 0 10px;
	background: var(--ul-field);
	font: 400 15px/1 var(--ul-font-body);
	color: var(--ul-ink);
}

.count-input {
	width: 3ch;
	padding: 0;
	color: var(--ul-ink);
	font: 700 15px/1 var(--ul-font-mono);
	text-align: center;
}

.count-input:focus {
	text-decoration: underline;
	text-decoration-color: var(--ul-focus);
	text-decoration-thickness: 2px;
	text-underline-offset: 4px;
}

.count-unit {
	white-space: nowrap;
}

.lines {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin: 0;
	padding: 12px 14px;
	background: var(--ul-panel);
}

/* A value too long for the label's line drops whole under it. */
.line {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	align-items: baseline;
	gap: 4px 16px;
}

dt {
	font: 400 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
}

dd {
	margin: 0;
	font: 400 14px/1.4 var(--ul-font-mono);
	color: var(--ul-ink);
	text-align: right;
}

.from {
	margin-left: 6px;
	color: var(--ul-ink-3);
}

.sub {
	margin: 0;
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.err {
	margin: 0;
	font: 400 14px/1.4 var(--ul-font-body);
	color: var(--ul-lost);
}

@media (max-width: 760px) {
	.head {
		flex-wrap: wrap;
		gap: 8px;
	}

	.stepper {
		flex: 1 0 100%;
	}

	.count {
		flex: 1;
		min-width: 0;
	}
}
</style>
