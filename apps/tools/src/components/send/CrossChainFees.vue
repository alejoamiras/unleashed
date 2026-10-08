<script setup lang="ts">
/** Utils */
import { computed } from "vue"
import type { Rail } from "@/lib/chains"
import { approxText, type CrossChainFigures, countdownText, feeLineLabels, feeTotalText } from "@/lib/crosschain-figures"
import type { SendIntent } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"

/** A cross-chain route's fees on the amount step, in the source token's units, with how long the quote stands. */
const props = defineProps<{
	figures: CrossChainFigures | null
	decimals: number
	symbol: string
	srcChainId: number
	rail: Rail
	intent: SendIntent
	/** Milliseconds before the quote is asked again; null while there is none. */
	expiresIn: number | null
}>()

const labels = computed(() => feeLineLabels(props.srcChainId, props.rail))
const total = computed(() => (props.figures ? feeTotalText(props.figures, props.decimals, props.symbol, props.intent) : "—"))
const relay = computed(() => (props.figures ? approxText(props.figures.relayFee, props.decimals, props.symbol) : "—"))
</script>

<template>
	<div class="fees ul-notch" :data-testid="TESTIDS.sendXcFees">
		<div class="head">
			<span class="title">Fees <span class="total" :data-testid="TESTIDS.sendXcFeeTotal">{{ total }}</span></span>
			<span v-if="figures?.fixed" class="age" :data-testid="TESTIDS.sendXcQuoteAge">Fixed testnet terms</span>
			<span v-else-if="figures && expiresIn !== null" class="age" :data-testid="TESTIDS.sendXcQuoteAge">
				Quote refreshes in <span class="clock">{{ countdownText(expiresIn) }}</span>
			</span>
		</div>
		<dl class="lines">
			<div class="line">
				<dt>{{ labels.relay }}</dt>
				<dd class="mono">{{ relay }}</dd>
			</div>
			<div class="line">
				<dt>{{ labels.network }}</dt>
				<dd>network fee</dd>
			</div>
		</dl>
	</div>
</template>

<style scoped>
.fees {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 12px 14px 14px 16px;
}

.head {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	justify-content: space-between;
	gap: 4px 16px;
}

.title {
	font: 700 14px/1.3 var(--ul-font-body);
	color: var(--ul-ink);
}

.total {
	margin-left: 6px;
	font: 400 14px/1.3 var(--ul-font-mono);
}

.age {
	font: 400 12.5px/1.3 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.clock {
	font-family: var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.lines {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin: 0;
	padding: 12px 14px;
	background: var(--ul-panel);
}

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
	font: 400 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink);
	text-align: right;
}

.mono {
	font-family: var(--ul-font-mono);
}
</style>
