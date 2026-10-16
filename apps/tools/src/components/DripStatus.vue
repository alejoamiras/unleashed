<script setup lang="ts">
import { Icon, ProgressBar } from "@unleashed/design"
import { TESTIDS } from "@/lib/testids"

/** A faucet card's drip line: the drip in flight with its clock, or how the last one ended. The
 *  default slot words a success; `label` heads a drip in flight and is the whole of a failure. */
defineProps<{
	kind: "dripping" | "ok" | "error"
	/** A fresh outcome: its fill turns carrier or lost. */
	emphasized?: boolean
	label?: string
	elapsed?: string
	progressLabel?: string
	/** What the drip waits on, in the log's voice. */
	log?: string
	txUrl?: string
}>()
</script>

<template>
	<div class="status-row ul-notch" role="status" :data-drip-status="kind" :data-emphasized="emphasized || undefined">
		<template v-if="kind === 'ok'">
			<Icon name="check" :size="12" class="ok-mark" />
			<span class="status-text"><slot /></span>
			<a
				v-if="txUrl"
				class="status-link"
				:href="txUrl"
				target="_blank"
				rel="noopener noreferrer"
				:data-testid="TESTIDS.dripTxLink"
			>View tx<Icon name="external-link" :size="12" /></a>
		</template>
		<template v-else-if="kind === 'dripping'">
			<div class="panel-head">
				<strong>{{ label }}</strong>
				<!-- Hidden so the status region is not re-announced every second. -->
				<span class="clock" aria-hidden="true">{{ elapsed }}</span>
			</div>
			<ProgressBar :label="progressLabel ?? 'Drip progress'" />
			<span class="log">{{ log }}<span class="cursor" aria-hidden="true">_</span></span>
		</template>
		<span v-else class="status-text">{{ label }}</span>
	</div>
</template>

<style scoped>
/* The fill carries the outcome while it is fresh: carrier for a drip that landed, lost for one that
   failed; a drip in flight sits in the well. */
.status-row {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 14px;
	font: 400 14px/1.35 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.status-row[data-drip-status="dripping"] {
	--ul-fill: var(--ul-field);
	flex-direction: column;
	align-items: stretch;
	gap: 8px;
	color: var(--ul-ink);
}

.panel-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
}

.clock,
.log {
	font: 400 12.5px/1.4 var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.cursor {
	color: var(--ul-accent-text);
}

.status-row[data-drip-status="ok"][data-emphasized] {
	--ul-fill: var(--ul-carrier-bg);
	color: var(--ul-ink);
}

.status-row[data-drip-status="error"][data-emphasized] {
	--ul-fill: var(--ul-lost-bg);
	color: var(--ul-lost);
}

.status-text {
	flex-grow: 1;
}

.ok-mark {
	color: var(--ul-carrier);
}

.status-link {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	flex: none;
	font: 700 14px/1 var(--ul-font-body);
	color: var(--ul-accent-text);
	text-decoration: none;
	white-space: nowrap;
}

.status-link:hover {
	text-decoration: underline;
	text-underline-offset: 4px;
}
</style>
