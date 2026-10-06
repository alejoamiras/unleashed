<script setup lang="ts">
import { computed } from "vue"
import type { LogRow } from "@/composables/useBridgeJournal"
import { formatClock } from "@/lib/phase-clock"
import { TESTIDS } from "@/lib/testids"

/** The session's log of a record, newest last with a cursor, each row timed from `startedAt`. */
const props = defineProps<{ rows: readonly LogRow[]; startedAt: number; labelledby?: string }>()

/** The well is a notch host, which cannot scroll, so it shows only the latest rows. */
const LOG_ROWS = 8
const shown = computed(() => props.rows.slice(-LOG_ROWS))
</script>

<template>
	<div class="log ul-notch" role="log" :aria-labelledby="labelledby" :data-testid="TESTIDS.stepperLog">
		<p v-for="(row, i) in shown" :key="row.seq" class="row" :class="{ last: i === shown.length - 1 }">
			<span class="at">{{ formatClock(row.at - startedAt) }}</span>
			<span class="text">{{ row.text }}<span v-if="i === shown.length - 1" class="cursor" aria-hidden="true">_</span></span>
		</p>
	</div>
</template>

<style scoped>
.log {
	--ul-fill: var(--ul-field);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 14px 16px;
	font: 400 12.5px/1.5 var(--ul-font-mono);
}

/* Before the first row the region stays mounted for assistive tech but draws nothing. */
.log:empty {
	padding: 0;
}

.row {
	display: flex;
	gap: 14px;
	margin: 0;
	color: var(--ul-ink-2);
}

.row.last {
	color: var(--ul-ink);
}

.at {
	flex: none;
	color: var(--ul-ink-3);
}

.text {
	min-width: 0;
	overflow-wrap: anywhere;
}

.cursor {
	color: var(--ul-accent-text);
}
</style>
