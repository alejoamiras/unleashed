<script setup lang="ts">
/** Services */
import { type AnyJournalRecord, isCrossChainRecord } from "@unleashed/bridge-core"
import { Button, Icon, type IconName } from "@unleashed/design"
import { computed } from "vue"

/** Composables */
import { type RecordRuntime, useBridgeJournal } from "@/composables/useBridgeJournal"

/** Utils */
import { type BridgePhase, compactPhases, stepperPhases } from "@/lib/bridge-steps"
import { chainLabel } from "@/lib/chains"
import { useNow } from "@/lib/clock"
import { formatClock, type TimedBridgePhase, trackPhases } from "@/lib/phase-clock"
import { TESTIDS } from "@/lib/testids"

const props = defineProps<{
	record: AnyJournalRecord
	compact?: boolean
	retryable?: boolean
	/** Narration for a record the journal does not hold yet (the wizard's permission phase). */
	runtime?: RecordRuntime
	/** How the permission step names the user's wallet (a `walletLabel`). */
	walletLabel?: string
}>()
/** `claim`: the user starts a claim nothing is running; `new-send`: the user starts over although the source
 *  send may still be on its way. */
const emit = defineEmits<{ retry: []; claim: []; "new-send": [] }>()

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
const cells = computed(() => compactPhases(phases.value))
const sourceName = computed(() => (isCrossChainRecord(props.record) ? chainLabel(props.record.route.srcChainId) : ""))
const activePhase = computed(() => phases.value.find((p) => p.state === "active" || p.state === "failed"))
/** Compact cards narrate only what is LIVE: a failed note, or the engine's running stepDetail -
 *  never the static signing prompt (an idle card must not instruct "confirm in your wallet"). */
const compactDetail = computed(() => {
	const phase = activePhase.value
	if (!phase?.detail) return null
	if (phase.state === "failed") return phase.detail
	return rt.value.stepDetail ? phase.detail : null
})

type Running = "active" | "waiting"
const isRunning = (state: BridgePhase["state"]): state is Running => state === "active" || state === "waiting"

/** A running phase draws a plain square instead. */
const ICON: Record<Exclude<BridgePhase["state"], Running>, IconName> = {
	pending: "hourglass",
	done: "check",
	failed: "square-alert",
	stopped: "warning-diamond",
	ended: "minus",
}

/** Spoken in place of the glyph, which carries the state on screen. */
const STATE_WORD: Record<BridgePhase["state"], string> = {
	pending: "pending",
	active: "in progress",
	done: "done",
	failed: "failed",
	stopped: "did not go through",
	ended: "ended",
	waiting: "still waiting",
}

function percent(fraction: number): number {
	return Math.round(Math.min(Math.max(fraction, 0), 1) * 100)
}

function timeOf(phase: TimedBridgePhase): string | undefined {
	if (phase.state === "done" && phase.elapsedMs !== undefined) return formatClock(phase.elapsedMs)
	if (isRunning(phase.state) && phase.startedAt !== undefined) return formatClock(now.value - phase.startedAt)
	return phase.state === "pending" ? phase.estimate : undefined
}

const spoken = (phase: BridgePhase): string => phase.word ?? phase.suffix ?? STATE_WORD[phase.state]

/** `role="img"` hides the cell's fill from assistive tech, so the label carries its progress. */
function cellLabel(phase: TimedBridgePhase): string {
	const p = phase.progress
	const label = phase.compact?.label ?? phase.label
	return `${label}, ${spoken(phase)}${p ? `, ${p.current} of ${p.target}` : ""}`
}

const cellText = (phase: BridgePhase): string => {
	const label = phase.compact?.label ?? phase.label
	return phase.suffix ? `${label} · ${phase.suffix}` : label
}
</script>

<template>
	<div v-if="compact" class="rail compact" :data-testid="TESTIDS.journalRail" :data-id="record.id">
		<div class="strip">
			<span
				v-for="phase in cells"
				:key="phase.key"
				class="cell"
				:class="[
					phase.state,
					{ live: phase.state !== 'pending' && phase.state !== 'done', landed: phase.state === 'active' && phase.landed, plain: !phase.compact },
				]"
				:style="phase.compact ? { '--weight': phase.compact.weight } : undefined"
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
					><Icon v-if="!phase.compact && (phase.state === 'done' || phase.state === 'failed')" :name="ICON[phase.state]" :size="12" />{{
						cellText(phase)
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
			:aria-current="phase.state !== 'pending' && phase.state !== 'done' ? 'step' : undefined"
			:data-testid="phase.key === 'register' ? TESTIDS.sendStepperRegister : TESTIDS.stepperPhase"
			:data-phase="phase.key"
			:data-state="phase.state"
		>
			<span class="glyph">
				<template v-if="isRunning(phase.state)">
					<span class="square" :class="{ landed: phase.landed }" aria-hidden="true" /><span class="sr-only">{{
						phase.needsYou ? "needs you" : spoken(phase)
					}}</span>
				</template>
				<Icon v-else :name="ICON[phase.state]" :size="12" :label="spoken(phase)" />
			</span>
			<div class="body">
				<span class="label">{{ phase.label }}</span>
				<p v-if="phase.detail && phase.state !== 'pending' && phase.state !== 'done'" class="detail">{{ phase.detail }}</p>
				<span v-if="phase.note && (phase.state === 'done' || phase.state === 'pending')" class="note" :data-testid="TESTIDS.stepperXcNote">{{
					phase.note
				}}</span>
				<span v-if="phase.meter && phase.progress && isRunning(phase.state)" class="meter" :data-testid="TESTIDS.stepperXcMeter">
					<span
						role="progressbar"
						class="meter-bar"
						:aria-label="phase.meter === 'block' ? 'Aztec blocks' : 'Aztec checkpoints'"
						aria-valuemin="0"
						:aria-valuemax="phase.progress.target"
						:aria-valuenow="phase.progress.current"
						><span class="meter-fill" :style="{ width: `${percent(phase.progress.fraction)}%` }"
					/></span>
					<span class="meter-text">{{ phase.meter }} {{ phase.progress.current }} of {{ phase.progress.target }}</span>
				</span>
				<span v-if="phase.lifi" class="lifi" :data-testid="TESTIDS.stepperXcBridge"
					>Powered by
					<a href="https://li.fi" target="_blank" rel="noopener noreferrer" :data-testid="TESTIDS.stepperXcLifi">LI.FI</a></span
				>
				<a v-if="phase.link" class="link" :href="phase.link.href" target="_blank" rel="noopener noreferrer" :data-testid="TESTIDS.stepperXcLink"
					><span v-if="phase.link.lead" class="lead">{{ phase.link.lead }}</span>{{ phase.link.text }}<Icon name="external-link" :size="12"
				/></a>
				<div v-if="phase.unconfirmed" role="status" class="not-found ul-notch" :data-testid="TESTIDS.stepperXcNotFound">
					<Icon name="search" :size="24" />
					<span class="not-found-body">
						<strong>We haven’t found your send on {{ sourceName }} yet.</strong>
						<span>Your wallet didn’t confirm it, so we keep looking. Sending again may move your funds twice.</span>
						<Button size="small" variant="secondary" class="new-send" :data-testid="TESTIDS.stepperXcNewSend" @click="emit('new-send')"
							>Start a new send anyway</Button
						>
					</span>
				</div>
				<Button v-if="phase.claimAction && phase.state === 'active'" size="small" class="claim" :data-testid="TESTIDS.stepperXcClaim" @click="emit('claim')">
					<Icon name="key" :size="12" />Claim on Aztec
				</Button>
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
			<span v-if="timeOf(phase)" class="time" :class="{ words: phase.state === 'pending' && phase.signs }">{{ timeOf(phase) }}</span>
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

/* A second line (a link, a note, a detail) stacks under the label; the glyph and the time stay on the
   label's line. */
.phase {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	min-height: 34px;
	padding: 7px 0;
}

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

/* ---------- a cross-chain send's own states ---------- */
.phase.waiting {
	align-items: flex-start;
	padding: 10px 0;
}

.phase.waiting .square {
	background: var(--ul-attention);
}

.phase.waiting .label,
.phase.ended .label {
	font-weight: 700;
	color: var(--ul-ink);
}

.phase.stopped .glyph,
.phase.stopped .label {
	font-weight: 700;
	color: var(--ul-attention);
}

.phase.ended .glyph {
	color: var(--ul-ink-2);
}

.phase .detail {
	margin: 0;
	line-height: 1.4;
	overflow-wrap: anywhere;
}

.note,
.lifi {
	font: 400 12.5px/1.4 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.lifi a,
.link {
	color: var(--ul-ink-2);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.lifi a {
	font-weight: 700;
}

.link {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font: 400 12.5px/1.4 var(--ul-font-mono);
}

.link .lead {
	font-family: var(--ul-font-body);
}

.meter {
	display: flex;
	align-self: stretch;
	align-items: center;
	gap: 10px;
}

.meter-bar {
	display: flex;
	flex: 1 1 auto;
	height: 8px;
	background: var(--ul-line);
}

.meter-fill {
	background: var(--ul-signal);
	box-shadow: inset -2px 0 0 var(--ul-ink);
}

.meter-text {
	flex: none;
	font: 400 12.5px/1 var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.not-found {
	--ul-fill: var(--ul-attention-bg);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-self: stretch;
	align-items: flex-start;
	gap: 12px;
	margin-top: 4px;
	padding: 12px 14px;
}

.not-found > svg {
	flex: none;
	margin-top: 1px;
	color: var(--ul-attention);
}

.not-found-body {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink);
}

.not-found-body strong {
	font-weight: 700;
	color: var(--ul-attention);
}

.time {
	flex: none;
	font: 400 12.5px/20px var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.phase.pending .time {
	color: var(--ul-ink-3);
}

.time.words {
	font-family: var(--ul-font-body);
}

.phase.active .time {
	color: var(--ul-accent-text);
}

.retry,
.new-send {
	align-self: flex-start;
	margin-top: 4px;
}

.claim {
	min-height: 40px;
	padding: 0 14px;
	gap: 8px;
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
	flex: var(--weight, 1) 1 0;
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

.cell.stopped .seg {
	background: var(--ul-attention);
}

.cell.ended .seg {
	background: var(--ul-ink-2);
}

/* Striped: still live, and nothing is wrong yet. */
.cell.waiting .seg {
	background: repeating-linear-gradient(90deg, var(--ul-attention) 0 8px, var(--ul-attention-bg) 8px 12px);
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
	font: 400 12px/1.2 var(--ul-font-body);
	color: var(--ul-ink-3);
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

.cell.stopped .seg-label,
.cell.waiting .seg-label {
	font-weight: 700;
	color: var(--ul-attention);
}

.cell.ended .seg-label {
	font-weight: 700;
	color: var(--ul-ink);
}

/* An Ethereum-origin rail's six labels fit a phone card only when each cell takes its label's width
   and a done cell's mark is its carrier segment alone, as the cross-chain strip marks it. */
@media (max-width: 760px) {
	.cell.plain {
		flex: 1 1 auto;
	}

	.cell.plain.done .seg-label svg {
		display: none;
	}
}
</style>
