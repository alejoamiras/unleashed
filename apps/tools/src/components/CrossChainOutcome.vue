<script setup lang="ts">
/** Services */
import type { BridgeJournalRecord, CrossChainDepositRecord } from "@unleashed/bridge-core"
import { Button } from "@unleashed/design"
import { computed, ref, useId } from "vue"

/** Composables */
import { useEthHeld } from "@/composables/useEthHeld"
import type { EthereumPrefill } from "@/composables/useShell"

/** Utils */
import { ageWords } from "@/lib/activity"
import { lifiScanUrl } from "@/lib/chains"
import { useNow } from "@/lib/clock"
import { ethereumPrefillOf } from "@/lib/crosschain-activity"
import { type OutcomeFigures, outcomeCopy, outcomeLead, outcomeVariant } from "@/lib/crosschain-outcome"
import { TESTIDS } from "@/lib/testids"

/** Components */
import BridgePhaseRail from "./BridgePhaseRail.vue"

/**
 * What a cross-chain send's own surface shows once it ends without arriving (delivered to the wallet,
 * expired, not sent) or stalls on its rail; nothing otherwise. It acts only through its events, so
 * the host decides what a new quote or a dismissal does. The `log` slot sits under a stalled send.
 */
const props = defineProps<{ record: CrossChainDepositRecord; figures?: OutcomeFigures }>()
const emit = defineEmits<{
	continue: [prefill: EthereumPrefill]
	dismiss: []
	"new-quote": []
	"change-send": []
	track: []
}>()

const now = useNow()
const titleId = useId()
const variant = computed(() => outcomeVariant(props.record, now.value))
const ethHeld = useEthHeld(() => (variant.value === "delivered" && !props.figures?.ethHeld ? props.record.route.srcSender : undefined))
const copy = computed(() => {
	const v = variant.value
	return v ? outcomeCopy(props.record, v, now.value, { ethHeld: ethHeld.value, ...props.figures }) : null
})
const lead = computed(() => outcomeLead(props.record))
const prefill = computed(() => (variant.value === "delivered" ? ethereumPrefillOf(props.record) : null))
const trackUrl = computed(() => lifiScanUrl(props.record.route.srcTxHash ?? ""))
const rail = computed(() => props.record as unknown as BridgeJournalRecord)

const checked = computed(() => {
	const at = props.figures?.checkedAt
	if (at === undefined) return null
	return now.value - at < 60_000 ? "Last checked a few seconds ago." : `Last checked ${ageWords(at, now.value)}.`
})

const copied = ref(false)
async function copyTransaction(): Promise<void> {
	try {
		await navigator.clipboard.writeText(props.record.route.srcTxHash ?? "")
		copied.value = true
	} catch {
		// Clipboard denied: LI.FI's page carries the same transaction.
	}
}

function onContinue(): void {
	if (prefill.value) emit("continue", prefill.value)
}
</script>

<template>
	<section
		v-if="copy && variant"
		class="outcome ul-notch"
		:aria-labelledby="titleId"
		:data-testid="TESTIDS.xcOutcome"
		:data-variant="variant"
	>
		<div class="main">
			<div class="head">
				<span class="tag" :data-tone="copy.tagTone">{{ copy.tag }}</span>
				<h2 :id="titleId">{{ copy.title }}</h2>
				<p class="sub">
					{{ lead.route }} · <span class="mono">{{ lead.sent }}</span> · {{ lead.visibility }} ·
					<span v-if="copy.clock" class="mono">{{ copy.clock }}</span>{{ copy.clock ? " " : "" }}{{ copy.when }}
				</p>
			</div>

			<BridgePhaseRail :record="rail" compact />

			<div class="cards">
				<div class="card ul-notch">
					<h3>What happened</h3>
					<p>{{ copy.happened }}</p>
				</div>
				<div class="card ul-notch">
					<h3>What it means</h3>
					<p>{{ copy.means }}</p>
					<p v-if="copy.figure" class="figure">
						<span class="figure-amount">{{ copy.figure.amount }}</span>{{ " " }}<span class="figure-symbol">{{ copy.figure.symbol }}</span
						>{{ " " }}<span class="figure-where"
							>{{ copy.figure.where }} <span class="mono">{{ copy.figure.who }}</span> on {{ copy.figure.chain }}</span
						>
					</p>
				</div>
				<div class="card next ul-notch" :data-tone="copy.nextTone">
					<h3>What to do next</h3>
					<p>{{ copy.next }}</p>
					<p v-if="variant === 'delivered' && figures?.continueQuote" class="lands">
						Lands as <span class="mono">≈ {{ figures.continueQuote.amount }} {{ figures.continueQuote.symbol }}</span
						>, {{ lead.visibility
						}}<template v-if="figures.continueQuote.gas"
							>, plus <span class="mono">≈ {{ figures.continueQuote.gas }}</span> gas</template
						>.
					</p>
				</div>
			</div>

			<div class="actions">
				<template v-if="variant === 'delivered'">
					<Button size="large" :disabled="!prefill" :data-testid="TESTIDS.xcOutcomeContinue" @click="onContinue">
						Continue from Ethereum
					</Button>
					<Button size="large" variant="secondary" :data-testid="TESTIDS.xcOutcomeDismiss" @click="emit('dismiss')">
						Keep it on Ethereum
					</Button>
					<p class="aside">Keeping it closes this send. You can deposit from Ethereum any time later.</p>
				</template>
				<template v-else-if="variant === 'stalled'">
					<a
						v-if="trackUrl"
						class="link-btn ul-notch"
						:href="trackUrl"
						target="_blank"
						rel="noopener noreferrer"
						:data-testid="TESTIDS.xcOutcomeTrack"
						@click="emit('track')"
						>Track on LI.FI</a
					>
					<Button
						v-if="record.route.srcTxHash"
						size="large"
						variant="secondary"
						:data-testid="TESTIDS.xcOutcomeCopy"
						@click="copyTransaction"
					>
						{{ copied ? "Copied" : "Copy transaction" }}
					</Button>
					<p v-if="checked" class="aside">{{ checked }}</p>
				</template>
				<template v-else>
					<Button size="large" :data-testid="TESTIDS.xcOutcomeNewQuote" @click="emit('new-quote')">Get a new quote</Button>
					<Button size="large" variant="secondary" :data-testid="TESTIDS.xcOutcomeChangeSend" @click="emit('change-send')">
						{{ variant === "expired" ? "Pick another balance" : "Change the send" }}
					</Button>
				</template>
			</div>

			<dl v-if="copy.txs.length" class="txs">
				<div v-for="tx in copy.txs" :key="tx.label" class="tx">
					<dt>{{ tx.label }}</dt>
					<dd>
						<a
							v-if="tx.link && tx.href"
							class="trail"
							:href="tx.href"
							target="_blank"
							rel="noopener noreferrer"
							:data-testid="TESTIDS.xcOutcomeTrack"
							@click="emit('track')"
							>{{ tx.link }}</a
						>
						<a
							v-else-if="tx.hash && tx.href"
							class="hash"
							:href="tx.href"
							target="_blank"
							rel="noopener noreferrer"
							:data-testid="TESTIDS.xcOutcomeTx"
							>{{ tx.hash }}</a
						>
						<span v-else-if="tx.hash" class="hash">{{ tx.hash }}</span>
						<span v-if="tx.note" class="tx-note">{{ tx.hash ? " · " : "" }}{{ tx.note }}</span>
					</dd>
				</div>
			</dl>

			<div v-if="variant === 'stalled' && $slots.log" class="log">
				<p class="log-title">Log</p>
				<slot name="log" />
			</div>
		</div>
		<div v-if="copy.band" class="band ul-notch">
			<p>{{ copy.band }}</p>
		</div>
	</section>
</template>

<style scoped>
.outcome {
	--ul-fill: var(--ul-panel);
	--ul-notch: var(--ul-notch-4);
	display: flex;
	flex-direction: column;
	width: 100%;
}

.main {
	display: flex;
	flex-direction: column;
	gap: 22px;
	padding: 24px;
}

.head {
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.tag {
	align-self: flex-start;
	display: inline-flex;
	align-items: center;
	height: 24px;
	padding: 0 8px;
	clip-path: var(--ul-notch-2);
	background: var(--ul-raised);
	color: var(--ul-ink);
	font: 700 13px/1 var(--ul-font-body);
}

.tag[data-tone="attention"] {
	background: var(--ul-attention-bg);
	color: var(--ul-attention);
}

.tag[data-tone="lost"] {
	background: var(--ul-lost-bg);
	color: var(--ul-lost);
}

h2 {
	margin: 0;
	font: 700 24px/1.2 var(--ul-font-body);
	letter-spacing: var(--ul-tracking-heading);
	color: var(--ul-ink);
}

.sub {
	margin: 0;
	font: 400 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.mono {
	font-family: var(--ul-font-mono);
	color: var(--ul-ink);
}

.cards {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.card {
	--ul-fill: var(--ul-field);
	--ul-notch: var(--ul-notch-2);
	flex: 1 1 240px;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 16px;
}

.card h3 {
	margin: 0;
	font: 700 13px/1.3 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.card p {
	margin: 0;
	font: 400 14.5px/1.5 var(--ul-font-body);
	color: var(--ul-ink);
}

.card.next[data-tone="attention"] {
	--ul-fill: var(--ul-attention-bg);
}

.card.next[data-tone="attention"] h3 {
	color: var(--ul-attention);
}

.card.next[data-tone="raised"] {
	--ul-fill: var(--ul-raised);
}

.card.next[data-tone="raised"] h3 {
	color: var(--ul-ink);
}

.card .figure {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 6px 10px;
	margin-top: auto;
}

.figure-amount {
	font: 600 22px/1.1 var(--ul-font-body);
	font-variant-numeric: tabular-nums;
}

.figure-symbol {
	font: 600 14px/1 var(--ul-font-mono);
}

.figure-where {
	font: 400 13px/1.3 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.card .lands {
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 12px;
}

.aside {
	flex: 1 1 200px;
	margin: 0;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.link-btn {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-height: 48px;
	padding: 0 18px;
	font: 600 16px/1 var(--ul-font-body);
	color: var(--ul-ink);
	text-decoration: none;
}

.txs {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin: 0;
	font: 400 13.5px/1.4 var(--ul-font-body);
}

.tx {
	display: flex;
	flex-wrap: wrap;
	gap: 4px 16px;
}

.tx dt {
	flex: 0 0 180px;
	color: var(--ul-ink-3);
}

.tx dd {
	margin: 0;
	color: var(--ul-ink-2);
}

.hash {
	font: 400 13px/1.4 var(--ul-font-mono);
	color: var(--ul-ink-2);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

span.hash {
	text-decoration: none;
}

.tx-note {
	color: var(--ul-ink-3);
}

.trail {
	font: 600 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.log {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.log-title {
	margin: 0;
	font: 700 13px/1.4 var(--ul-font-body);
}

.band {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-4-bottom);
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 16px;
	padding: 14px 24px;
}

.band p {
	margin: 0;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

@media (max-width: 760px) {
	.main {
		padding: 20px 16px;
	}

	.band {
		padding: 14px 16px;
	}

	.tx dt {
		flex-basis: 100%;
	}
}
</style>
