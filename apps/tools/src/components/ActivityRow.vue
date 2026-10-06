<script setup lang="ts">
/** Utils */
import { BusyPixels, Icon, type IconName } from "@unleashed/design"
import { computed } from "vue"
import type { ActivityRowModel } from "@/composables/useActivityFeed"
import type { ActivityAction } from "@/lib/activity"
import { TESTIDS } from "@/lib/testids"

/** A dock row never explains why: the word or button here, the reasons on the card it opens. */
const props = defineProps<{
	row: ActivityRowModel
	/** The row's own action is running. */
	acting?: boolean
	/** Switch is refused while another operation runs — the same gate the card applies. */
	switchLocked?: boolean
}>()

const emit = defineEmits<{
	open: [id: string]
	act: [id: string, action: Exclude<ActivityAction, null>]
}>()

const LABELS: Record<Exclude<ActivityAction, null>, string> = {
	claim: "Claim",
	finish: "Finish",
	retry: "Retry",
	"claim-gas": "Claim gas",
	switch: "Switch",
	continue: "Continue",
}

const action = computed(() => props.row.action)
const disabled = computed(() => props.acting || (action.value === "switch" && props.switchLocked))
const title = computed(() => (action.value === "switch" && props.switchLocked ? "Finish the current operation to switch." : undefined))

/** A claim that needs you is the one filled call; Retry, a done row's gas recovery and Switch stay
 *  secondary, so one screen never shows two filled calls. */
const filled = computed(() => props.row.group === "needs-you" && action.value !== "retry")

/** The second line as route and tail: the route truncates first, since the tail ("this send", the
 *  age) is what tells two rows of one route apart. Beside a button the line has only its own column,
 *  so it drops the visibility. */
const meta = computed<{ route: string; tail: string }>(() => {
	const r = props.row
	if (r.foreground) return { route: r.route, tail: r.detail ?? "this send" }
	if (r.detail) return { route: r.route, tail: r.detail }
	return { route: r.route, tail: action.value ? r.age : `${r.visibility} · ${r.age}` }
})

/** The qualifier and the note share the third line. */
const extra = computed(() => [props.row.qualifier, props.row.note].filter(Boolean).join(" · "))

const SIDE: Record<ActivityRowModel["status"], { word?: string; icon?: IconName }> = {
	lost: { word: "Lost signal", icon: "square-alert" },
	done: { word: "Arrived", icon: "check" },
	"needs-you": { word: "Needs you" },
	running: {},
}
const side = computed(() => {
	if (props.row.word) return { word: props.row.word.text, icon: undefined }
	const s = SIDE[props.row.status]
	return { word: s.word ?? props.row.phase, icon: s.icon }
})

const openLabel = computed(() => {
	const r = props.row
	const what = `${r.amount} ${r.symbol}${r.qualifier ? ` ${r.qualifier}` : ""}`
	const route = r.route.replace(" → ", " to ").replaceAll(" · ", " ")
	if (r.foreground) return `Show this send, ${what}, ${route}${r.word?.spoken ? `, ${r.word.spoken}` : ""}`
	const word = r.word?.spoken ?? r.word?.text.toLowerCase()
	const tail = word && r.detail ? `${word}, ${r.detail}` : `${r.visibility}, ${r.ageSpoken}`
	return `Open ${what}, ${route}, ${tail}${r.note ? `, ${r.note}` : ""}`
})

// Action clicks must not also open Activity.
function onAct(): void {
	if (action.value && !disabled.value) emit("act", props.row.id, action.value)
}
</script>

<template>
	<li
		class="row ul-notch"
		:class="{ 'has-button': !!action, foreground: row.foreground, current: row.current, qualified: !!extra }"
		:aria-current="row.current || undefined"
		:data-testid="TESTIDS.activityRow"
		:data-record-id="row.id"
		:data-group="row.group"
		:data-status="row.status"
		:data-tone="row.word?.tone"
		:data-action="action ?? undefined"
		@click="emit('open', row.id)"
	>
		<span class="dot" aria-hidden="true" />
		<button type="button" class="amt" :aria-label="openLabel" :data-testid="TESTIDS.activityRowOpen" @click.stop="emit('open', row.id)">
			{{ row.amount }} {{ row.symbol }}
		</button>
		<span class="meta second"
			><span class="route">{{ meta.route }}</span><span class="tail">{{ " · " }}{{ meta.tail }}</span></span
		>
		<span v-if="extra" class="meta qualifier" :class="{ note: !row.qualifier }">{{ extra }}</span>
		<button
			v-if="action"
			type="button"
			class="side btn ul-notch"
			:class="{ filled, busy: acting }"
			:disabled="disabled"
			:title="title"
			:aria-busy="acting || undefined"
			:data-testid="TESTIDS.activityRowAction"
			@click.stop="onAct"
		>
			<Icon v-if="action === 'retry'" name="reload" :size="12" />{{ LABELS[action] }}<BusyPixels v-if="acting" aria-hidden="true" />
		</button>
		<span v-else class="side word"><Icon v-if="side.icon" :name="side.icon" :size="12" />{{ side.word }}</span>
	</li>
</template>

<style scoped>
.row {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	position: relative;
	display: grid;
	grid-template-columns: 8px minmax(0, 1fr) auto;
	column-gap: 12px;
	row-gap: 2px;
	align-items: center;
	padding: 10px 12px;
	cursor: pointer;
}

.row[data-status="done"] {
	--ul-fill: transparent;
}

/* A gross amount's qualifier gets a line of its own: beside a word or button, line 2 truncates. */
.row.qualified .dot,
.row.qualified .side {
	grid-row: 1 / 4;
}

.meta.qualifier {
	grid-row: 3;
}

.dot {
	grid-column: 1;
	grid-row: 1 / 3;
	width: 8px;
	height: 8px;
	background: var(--ul-ink);
}

.row[data-status="needs-you"] .dot {
	background: var(--ul-attention);
}

.row[data-status="lost"] .dot {
	background: var(--ul-lost);
}

.row[data-status="done"] .dot {
	background: var(--ul-carrier);
}

/* A cross-chain row's tone words its own colour ("Slow" in attention); this is for the rest. */
.row.foreground[data-status="running"]:not([data-tone]) .dot {
	background: var(--ul-accent-text);
}

.amt {
	grid-column: 2;
	grid-row: 1;
	min-width: 0;
	font: 700 14px/1.3 var(--ul-font-mono);
	color: var(--ul-ink);
	text-align: left;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	cursor: pointer;
}

.meta {
	grid-column: 2;
	grid-row: 2;
	font: 400 12.5px/1.3 var(--ul-font-body);
	color: var(--ul-ink-2);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.side {
	grid-column: 3;
	grid-row: 1 / 3;
	display: inline-flex;
	align-items: center;
	gap: 4px;
	white-space: nowrap;
}

.word {
	font: 400 13px/1 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.row[data-status="needs-you"] .word {
	font-weight: 700;
	color: var(--ul-attention);
}

.row[data-status="lost"] .word {
	font-weight: 700;
	color: var(--ul-lost);
}

.row[data-status="done"] .word {
	color: var(--ul-carrier);
}

.row.foreground[data-status="running"]:not([data-tone]) .word {
	font-weight: 700;
	color: var(--ul-accent-text);
}

.meta.note {
	color: var(--ul-ink-3);
}

.second {
	display: flex;
}

.route {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
}

.tail {
	flex: none;
	white-space: pre;
}

/* A cross-chain phase's tone overrides its status's: an ended row is flat whatever its colour. */
.row[data-tone="lost"],
.row[data-tone="ended"] {
	--ul-fill: transparent;
}

.row[data-tone="run"] .dot {
	background: var(--ul-accent-text);
}

.row[data-tone="run"] .word {
	font-weight: 700;
	color: var(--ul-accent-text);
}

.row[data-tone="need"] .dot {
	background: var(--ul-attention);
}

.row[data-tone="need"] .word {
	font-weight: 700;
	color: var(--ul-attention);
}

.row[data-tone="wait"] .dot,
.row[data-tone="ended"] .dot {
	background: var(--ul-ink-2);
}

.row[data-tone="wait"] .word {
	font-weight: 700;
	color: var(--ul-ink-2);
}

.row[data-tone="lost"] .word {
	font-weight: 400;
}

.row[data-tone="ended"] .word {
	color: var(--ul-ink);
}

/* The send on screen is raised whatever its tone, and an outcome's word on it is bold. */
.row.current[aria-current] {
	--ul-fill: var(--ul-raised);
}

.row.foreground[data-tone] .word {
	font-weight: 700;
}

.btn {
	--ul-fill: var(--ul-line);
	--ul-notch: var(--ul-notch-2);
	gap: 6px;
	min-height: 36px;
	padding: 0 14px;
	font: 700 14px/1 var(--ul-font-body);
	color: var(--ul-ink);
	cursor: pointer;
}

.btn.filled {
	--ul-fill: var(--ul-signal);
	color: var(--ul-on-signal);
}

.btn:disabled {
	--ul-fill: var(--ul-raised);
	color: var(--ul-disabled);
	cursor: not-allowed;
}

.btn.busy:disabled {
	--ul-fill: var(--ul-signal-tint);
	color: var(--ul-accent-text);
	gap: 12px;
	cursor: default;
}
</style>
