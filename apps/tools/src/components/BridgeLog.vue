<script setup lang="ts">
import { computed } from "vue"
import type { LogRow } from "@/composables/useBridgeJournal"
import { formatClock } from "@/lib/phase-clock"
import { TESTIDS } from "@/lib/testids"

/** The session's log of a record, newest last with a cursor, each row timed from `startedAt`. `links` turns a
 *  short hash a row names into its explorer link. */
const props = defineProps<{
	rows: readonly LogRow[]
	startedAt: number
	labelledby?: string
	links?: readonly { text: string; href: string }[]
}>()

/** The well is a notch host, which cannot scroll, so it shows only the latest rows. */
const LOG_ROWS = 8
const shown = computed(() => props.rows.slice(-LOG_ROWS))

/** A short hash as the log writes it ("0x52d7…d3c8"); the capture keeps it in `split`'s output. */
const SHORT_HASH = /(0x[0-9a-f]{2,}…[0-9a-f]{2,})/i

interface Part {
	text: string
	hash: boolean
	href?: string
}

/** A row's text with every short hash set apart, so it never breaks across lines and can carry its link. */
function partsOf(text: string): Part[] {
	return text
		.split(SHORT_HASH)
		.map(
			(t, i): Part =>
				i % 2 === 1 ? { text: t, hash: true, href: props.links?.find((l) => l.text === t)?.href } : { text: t, hash: false },
		)
		.filter((p) => p.text !== "")
}
</script>

<template>
	<div class="log ul-notch" role="log" :aria-labelledby="labelledby" :data-testid="TESTIDS.stepperLog">
		<p v-for="(row, i) in shown" :key="row.seq" class="row" :class="{ last: i === shown.length - 1 }">
			<span class="at">{{ formatClock(row.at - startedAt) }}</span>
			<span class="text"
				><template v-for="(part, j) in partsOf(row.text)" :key="j"
					><a v-if="part.href" class="hash link" :href="part.href" target="_blank" rel="noopener noreferrer">{{ part.text }}</a
					><span v-else-if="part.hash" class="hash">{{ part.text }}</span
					><template v-else>{{ part.text }}</template></template
				><span v-if="i === shown.length - 1" class="cursor" aria-hidden="true">_</span></span
			>
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

.hash {
	white-space: nowrap;
}

.link {
	color: var(--ul-ink-2);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.cursor {
	color: var(--ul-accent-text);
}
</style>
