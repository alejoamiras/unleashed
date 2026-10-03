<script setup lang="ts">
/** Services */
import type { BridgeJournalRecord } from "@unleashed/bridge-core"
import { Button, Icon, type IconName } from "@unleashed/design"
import { computed } from "vue"

/** Composables */
import { type RecordRuntime, useBridgeJournal } from "@/composables/useBridgeJournal"

/** Utils */
import { type BridgePhase, stepperPhases } from "@/lib/bridge-steps"
import { useNow } from "@/lib/clock"
import { formatClock, type TimedBridgePhase, trackPhases } from "@/lib/phase-clock"
import { TESTIDS } from "@/lib/testids"

const props = defineProps<{
	record: BridgeJournalRecord
	compact?: boolean
	retryable?: boolean
	/** Narration for a record the journal does not hold yet (the wizard's permission phase). */
	runtime?: RecordRuntime
	/** How the permission step names the user's wallet (a `walletLabel`). */
	walletLabel?: string
}>()
const emit = defineEmits<{ retry: [] }>()

const journal = useBridgeJournal()

// Shared 1s heartbeat (one app-wide interval - N cards must not mean N timers).
const now = useNow()

const rt = computed(() => props.runtime ?? journal.runtime.value[props.record.id] ?? {})
// `now` drives RENDER ticks only; trackPhases stamps with the real clock internally - stamping
// with the shared ref once recorded a stale page-load time as a phase start (SEAL showing 5m
// the instant a bridge began, when the wallet connected long after load).
const phases = computed(() => {
	void now.value // re-evaluate every tick so live timers advance.
	return trackPhases(props.record.id, stepperPhases(props.record, rt.value, props.walletLabel))
})
const activePhase = computed(() => phases.value.find((p) => p.state === "active" || p.state === "failed"))
/** Compact cards narrate only what is LIVE: a failed note, or the engine's running stepDetail -
 *  never the static signing prompt (an idle card must not instruct "confirm in your wallet"). */
const compactDetail = computed(() => {
	const phase = activePhase.value
	if (!phase?.detail) return null
	if (phase.state === "failed") return phase.detail
	return rt.value.stepDetail ? phase.detail : null
})

/** The live phase draws a plain square instead. */
const ICON: Record<Exclude<BridgePhase["state"], "active">, IconName> = {
	pending: "hourglass",
	done: "check",
	failed: "square-alert",
}

/** Spoken in place of the glyph, which carries the state on screen. */
const STATE_WORD: Record<BridgePhase["state"], string> = {
	pending: "pending",
	active: "in progress",
	done: "done",
	failed: "failed",
}

function percent(fraction: number): number {
	return Math.round(Math.min(Math.max(fraction, 0), 1) * 100)
}

function timeOf(phase: TimedBridgePhase): string | undefined {
	if (phase.state === "done" && phase.elapsedMs !== undefined) return formatClock(phase.elapsedMs)
	if (phase.state === "active" && phase.startedAt !== undefined) return formatClock(now.value - phase.startedAt)
	return phase.state === "pending" ? phase.estimate : undefined
}

/** `role="img"` hides the cell's fill from assistive tech, so the label carries its progress. */
function cellLabel(phase: TimedBridgePhase): string {
	const p = phase.progress
	return `${phase.label}, ${STATE_WORD[phase.state]}${p ? `, ${p.current} of ${p.target}` : ""}`
}
</script>

<template>
	<div v-if="compact" class="rail compact" :data-testid="TESTIDS.journalRail" :data-id="record.id">
		<div class="strip">
			<span
				v-for="phase in phases"
				:key="phase.key"
				class="cell"
				:class="[phase.state, { landed: phase.state === 'active' && phase.landed }]"
				role="img"
				:aria-label="cellLabel(phase)"
				:data-testid="TESTIDS.journalPhase"
				:data-phase="phase.key"
				:data-state="phase.state"
				:title="phase.label"
			>
				<span class="seg" :class="{ partial: phase.state === 'active' && phase.progress }"
					><span
						v-if="phase.state === 'active' && phase.progress"
						class="seg-fill"
						:style="{ width: `${percent(phase.progress.fraction)}%` }"
				/></span>
				<span class="seg-label" aria-hidden="true"
					><Icon v-if="phase.state === 'done' || phase.state === 'failed'" :name="ICON[phase.state]" :size="12" />{{
						phase.label
					}}</span
				>
			</span>
		</div>
		<p v-if="compactDetail" class="detail" :data-testid="TESTIDS.journalStep">{{ compactDetail }}</p>
	</div>

	<ol v-else class="rail full" aria-label="Phases">
		<li
			v-for="phase in phases"
			:key="phase.key"
			class="phase"
			:class="phase.state"
			:aria-current="phase.state === 'active' || phase.state === 'failed' ? 'step' : undefined"
			:data-testid="phase.key === 'register' ? TESTIDS.sendStepperRegister : TESTIDS.stepperPhase"
			:data-phase="phase.key"
			:data-state="phase.state"
		>
			<span class="glyph">
				<template v-if="phase.state === 'active'">
					<span class="square" :class="{ landed: phase.landed }" aria-hidden="true" /><span class="sr-only">{{
						STATE_WORD.active
					}}</span>
				</template>
				<Icon v-else :name="ICON[phase.state]" :size="12" :label="STATE_WORD[phase.state]" />
			</span>
			<div class="body">
				<span class="label">{{ phase.label }}</span>
				<p v-if="phase.detail && (phase.state === 'active' || phase.state === 'failed')" class="detail">{{ phase.detail }}</p>
				<Button
					v-if="phase.state === 'failed' && retryable"
					size="small"
					variant="secondary"
					class="retry"
					:data-testid="TESTIDS.stepperRetry"
					@click="emit('retry')"
				>
					<Icon name="reload" :size="12" />Retry
				</Button>
			</div>
			<span v-if="timeOf(phase)" class="time">{{ timeOf(phase) }}</span>
		</li>
	</ol>
</template>

<style scoped>
/* ---------- shared ---------- */
.detail {
	margin: 4px 0 0;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

/* ---------- full rail: the stepper's phase list ---------- */
.rail.full {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.phase {
	display: flex;
	align-items: center;
	gap: 12px;
	min-height: 34px;
}

/* Rows with a detail stack it under the label; the glyph and the time stay on the label's line. */
.phase.active,
.phase.failed {
	align-items: flex-start;
	padding: 10px 0;
}

.phase.active {
	margin: 2px -10px;
	padding: 10px;
	background: var(--ul-signal-tint);
	clip-path: var(--ul-notch-2);
}

.glyph {
	display: flex;
	flex: none;
	align-items: center;
	justify-content: center;
	width: 12px;
	height: 20px;
	color: var(--ul-ink-3);
}

.phase.done .glyph {
	color: var(--ul-carrier);
}

.phase.failed .glyph {
	color: var(--ul-lost);
}

/* Accent text, not signal: on the light tint signal falls under 3:1. */
.square {
	width: 12px;
	height: 12px;
	background: var(--ul-accent-text);
}

/* The quiet flip: once the claim is seen PROPOSED, the live square takes the done colour. */
.square.landed {
	background: var(--ul-carrier);
}

.body {
	display: flex;
	flex: 1 1 auto;
	flex-direction: column;
	align-items: flex-start;
	gap: 4px;
	min-width: 0;
}

.label {
	font: 400 14px/20px var(--ul-font-body);
	color: var(--ul-ink-2);
}

.phase.active .label {
	font-weight: 700;
	color: var(--ul-ink);
}

.phase.pending .label {
	color: var(--ul-ink-3);
}

.phase.failed .label {
	font-weight: 700;
	color: var(--ul-lost);
}

.phase .detail {
	margin: 0;
	line-height: 1.4;
	overflow-wrap: anywhere;
}

.time {
	flex: none;
	font: 400 12.5px/20px var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.phase.pending .time {
	color: var(--ul-ink-3);
}

.phase.active .time {
	color: var(--ul-accent-text);
}

.retry {
	margin-top: 4px;
}

/* ---------- compact rail (journal cards) ---------- */
.rail.compact {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.strip {
	display: flex;
	gap: 4px;
	align-items: flex-start;
}

.cell {
	display: flex;
	flex: 1 1 0;
	flex-direction: column;
	gap: 6px;
	min-width: 0;
}

/* The live segment is signal, a done one carrier; a card that needs the user recolours its live
   segment from outside. A live segment with a real target fills to it, led by an ink edge. */
.seg {
	height: 8px;
	background: var(--ul-line);
}

.cell.active .seg {
	background: var(--ul-signal);
}

.cell.active.landed .seg,
.cell.done .seg {
	background: var(--ul-carrier);
}

.cell.failed .seg {
	background: var(--ul-lost);
}

/* The outline keeps a live segment at 0% distinct from a pending one. */
.cell.active .seg.partial {
	display: flex;
	background: var(--ul-line);
	box-shadow: inset 0 0 0 1px var(--ul-signal);
}

.seg-fill {
	background: var(--ul-signal);
	box-shadow: inset -2px 0 0 var(--ul-ink);
}

.seg-label {
	overflow: hidden;
	font: 400 12px/1.2 var(--ul-font-body);
	color: var(--ul-ink-3);
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* A failed segment is within 1.1:1 of the live one's luminance, so the mark, not the hue, tells
   them apart. */
.seg-label svg {
	margin-right: 4px;
	vertical-align: -1px;
}

.cell.active .seg-label {
	font-weight: 700;
	color: var(--ul-ink);
}

.cell.failed .seg-label {
	font-weight: 700;
	color: var(--ul-lost);
}

/* Six labels do not fit a phone card: only the live one keeps its words, and room to show them. */
@media (max-width: 760px) {
	.cell.active,
	.cell.failed {
		flex-grow: 4;
	}

	.cell:not(.active, .failed) .seg-label {
		visibility: hidden;
	}
}
</style>
