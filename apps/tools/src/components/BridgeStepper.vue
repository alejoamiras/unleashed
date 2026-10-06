<script setup lang="ts">
/** Services */
import { type AnyJournalRecord, type DepositJournalRecord, isCrossChainRecord, isProvisionalRecordId } from "@unleashed/bridge-core"
import { Button, Icon, ProgressBar } from "@unleashed/design"
import { computed, useId } from "vue"

/** Composables */
import { type RecordRuntime, useBridgeJournal } from "@/composables/useBridgeJournal"

/** Utils */
import { amountQualifier, displayAmountOf, displayAmountText } from "@/lib/asset-label"
import { isTerminalAttention, overallProgress, stepperPhases } from "@/lib/bridge-steps"
import { useNow } from "@/lib/clock"
import { crossChainRoute, sourceAmountText } from "@/lib/crosschain-steps"
import { formatClock } from "@/lib/phase-clock"
import type { Direction } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"

/** Components */
import BridgePhaseRail from "./BridgePhaseRail.vue"
import DirectionSegment from "./send/DirectionSegment.vue"

// `withDefaults`: an absent boolean prop is cast to false, and backgrounding must stay the default.
const props = withDefaults(
	defineProps<{
		record: AnyJournalRecord
		/** Narration for a record the journal does not hold yet (the wizard's permission phase). */
		runtime?: RecordRuntime
		/** False while nothing is running in the journal yet: there is nothing to background. */
		canBackground?: boolean
		/** How the permission step names the user's wallet (a `walletLabel`). */
		walletLabel?: string
		/** Epoch ms the elapsed clock counts from; the record's `createdAt` when absent. The wizard passes
		 *  its submit time, so the clock runs on across the permission prompt's hand-over to the record. */
		startedAt?: number
	}>(),
	{ runtime: undefined, canBackground: true, walletLabel: undefined, startedAt: undefined },
)
/** `new-send`: the user starts over while a source send that never confirmed may still be on its way. */
const emit = defineEmits<{ background: []; backup: [record: AnyJournalRecord]; "new-send": [] }>()
const exportable = computed(() => {
	if (isProvisionalRecordId(props.record.id)) return false
	const r = props.record
	if (r.direction === "deposit" && r.isPrivate && !(r as DepositJournalRecord).sealedEnvelope) return false
	return true
})

const journal = useBridgeJournal()
const now = useNow()
const titleId = useId()
const lockedNoteId = useId()

const rt = computed(() => props.runtime ?? journal.runtime.value[props.record.id] ?? {})
const phases = computed(() => stepperPhases(props.record, rt.value, props.walletLabel))
const overall = computed(() => overallProgress(phases.value))

const failedPhase = computed(() => phases.value.find((p) => p.state === "failed"))

/** Per-phase retry routing: only engine-drivable phases get a RETRY. */
const canRetry = computed(() => {
	const key = failedPhase.value?.key
	if (!key) return false
	// A terminal attention or a persisted block is not re-drivable from any surface — retrying repeats the same failure.
	if (props.record.blocked !== undefined || isTerminalAttention(journal.runtime.value[props.record.id]?.attention)) return false
	if (props.record.direction === "deposit") {
		// SYNC/CLAIM/CONFIRM are engine-driven; the L1 legs are not re-drivable from here.
		return key === "sync" || key === "claim" || key === "confirm"
	}
	return key === "prove" || key === "finish" || key === "confirm"
})

function onRetry() {
	if (props.record.direction === "deposit") void journal.runDepositClaim(props.record.id)
	else void journal.runWithdrawConsume(props.record.id)
}

function onClaim() {
	void journal.runDepositClaim(props.record.id)
}

/** The stepper's copy of the switch answers none of the wizard's selectors. */
const LOCKED_TESTIDS = { root: TESTIDS.stepperDirection }
const direction = computed<Direction>(() => (props.record.direction === "deposit" ? "l1-to-l2" : "l2-to-l1"))
const route = computed(() => {
	const r = props.record
	if (isCrossChainRecord(r)) return crossChainRoute(r)
	return r.direction === "deposit" ? "Ethereum → Aztec" : "Aztec → Ethereum"
})
/** A cross-chain send is headed by what it takes on its source chain. */
const amount = computed(() => {
	const r = props.record
	if (isCrossChainRecord(r)) return sourceAmountText(r) ?? "—"
	const d = displayAmountOf(r)
	return `${displayAmountText(d)} ${d.symbol}`
})
const qualifier = computed(() => {
	const r = props.record
	return isCrossChainRecord(r) ? null : amountQualifier(displayAmountOf(r))
})

const livePhase = computed(() => phases.value[overall.value.index - 1])
const liveName = computed(() => {
	const { state } = overall.value
	if (state === "done") return "Done"
	const label = livePhase.value?.label ?? ""
	if (state === "failed") return `${label} failed`
	return state === "ended" && livePhase.value?.suffix ? `${label} · ${livePhase.value.suffix}` : label
})
const caption = computed(() => {
	const asks = overall.value.state === "running" && livePhase.value?.needsYou ? " · needs you" : ""
	return `${liveName.value} · phase ${overall.value.index} of ${overall.value.total}${asks}`
})
const valuetext = computed(() => `${Math.round(overall.value.fraction * 100)} percent, ${liveName.value}`)
const TONE = { running: "signal", failed: "lost", ended: "signal", done: "carrier" } as const
const clockStart = computed(() => props.startedAt ?? props.record.createdAt)
const elapsed = computed(() => formatClock((props.record.completedAt ?? now.value) - clockStart.value))

/** The permission prompt has no record yet, so nothing to log. The region mounts before its first
 *  row, since a live region added together with its content is not announced. */
const hasLog = computed(() => props.runtime === undefined)
/** The well is a notch host, which cannot scroll, so it shows only the latest rows. */
const LOG_ROWS = 8
const logRows = computed(() => (rt.value.log ?? []).slice(-LOG_ROWS))
const logTitleId = useId()
</script>

<template>
	<section class="stepper ul-notch" :aria-labelledby="titleId" :data-testid="TESTIDS.stepper" :data-id="record.id">
		<div class="locked">
			<DirectionSegment
				class="locked-segment"
				:direction="direction"
				locked
				:testids="LOCKED_TESTIDS"
				:aria-describedby="lockedNoteId"
			/>
			<span :id="lockedNoteId" class="locked-note">Direction is locked while this send runs</span>
		</div>

		<div class="body">
			<header class="head-row">
				<div class="titles">
					<h2 :id="titleId">Bridging</h2>
					<p class="headline">{{ route }} · <span class="amount">{{ amount }}</span>{{ qualifier ? ` ${qualifier}` : "" }} · {{ record.isPrivate ? "private" : "public" }}</p>
				</div>
				<Button
					v-if="exportable"
					size="small"
					variant="secondary"
					class="backup"
					title="Download this bridge's recovery file — restores it on any browser with your Ethereum wallet."
					:data-testid="TESTIDS.stepperBackup"
					@click="emit('backup', record)"
				>
					<Icon name="save" :size="12" />
					Backup
				</Button>
			</header>

			<div class="overall">
				<ProgressBar
					label="Bridge progress"
					:value="overall.fraction"
					:height="18"
					:tone="TONE[overall.state]"
					:aria-valuetext="valuetext"
					:data-testid="TESTIDS.stepperProgress"
				/>
				<p class="caption">
					<span>{{ caption }}</span>
					<span class="elapsed">{{ elapsed }} elapsed</span>
				</p>
			</div>

			<div class="split" :class="{ 'with-log': hasLog }">
				<BridgePhaseRail
					:record="record"
					:runtime="runtime"
					:wallet-label="walletLabel"
					:retryable="canRetry"
					@retry="onRetry"
					@claim="onClaim"
					@new-send="emit('new-send')"
				/>
				<div v-if="hasLog" class="log-panel">
					<p :id="logTitleId" class="log-title">Log <span class="log-sub">· what actually happened</span></p>
					<div class="log ul-notch" role="log" :aria-labelledby="logTitleId" :data-testid="TESTIDS.stepperLog">
						<p v-for="(row, i) in logRows" :key="row.seq" class="row" :class="{ last: i === logRows.length - 1 }">
							<span class="at">{{ formatClock(row.at - clockStart) }}</span>
							<span class="text">{{ row.text }}<span v-if="i === logRows.length - 1" class="cursor" aria-hidden="true">_</span></span>
						</p>
					</div>
				</div>
			</div>
		</div>

		<div v-if="canBackground" class="band ul-notch">
			<button type="button" class="action" :data-testid="TESTIDS.stepperBackground" @click="emit('background')">
				Run in background
			</button>
			<p class="bg-hint">Backgrounding moves this bridge to Activity — it keeps running either way.</p>
		</div>
	</section>
</template>

<style scoped>
/* The body splits by the stepper's own width: beside the app's nav rail and the dock strip it can be
   ~400px on a 768px viewport, where a viewport rule would squeeze the log to a sliver. */
.stepper {
	--ul-fill: var(--ul-panel);
	--ul-notch: var(--ul-notch-4);
	display: flex;
	flex-direction: column;
	container-type: inline-size;
}

.locked {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 12px 16px;
	padding: 20px 24px 0;
}

.locked .locked-segment {
	flex: 0 1 380px;
}

.locked-note {
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.body {
	display: flex;
	flex-direction: column;
	gap: 22px;
	padding: 24px;
}

.head-row {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 16px;
}

.titles {
	display: flex;
	flex-direction: column;
	gap: 8px;
	min-width: 0;
}

.titles h2 {
	margin: 0;
	font: 700 20px/1.2 var(--ul-font-body);
	letter-spacing: -0.015em;
	color: var(--ul-ink);
}

.headline {
	margin: 0;
	font: 400 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
	overflow-wrap: anywhere;
}

.amount {
	font-family: var(--ul-font-mono);
	color: var(--ul-ink);
}

.backup {
	flex: none;
	min-height: 40px;
	padding: 0 14px;
	gap: 8px;
}

.overall {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

/* The fill steps toward a new share instead of gliding; reduced motion lands it at once (base.css). */
.overall :deep([role="progressbar"] > span) {
	transition: width 360ms steps(6);
}

.caption {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: 4px 16px;
	margin: 0;
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.elapsed {
	font-family: var(--ul-font-mono);
}

.split {
	display: flex;
	flex-direction: column;
	gap: 22px;
}

/* 642px leaves the log column its 240px floor: 642 − 48 padding − 330 − 24 gap. */
@container (min-width: 642px) {
	.split.with-log {
		display: grid;
		grid-template-columns: 330px minmax(0, 1fr);
		align-items: start;
		gap: 24px;
	}
}

.log-panel {
	display: flex;
	flex-direction: column;
	gap: 8px;
	min-width: 0;
}

.log-title {
	margin: 0;
	font: 700 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink);
}

.log-sub {
	font-weight: 400;
	color: var(--ul-ink-3);
}

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

/* The card's own bottom steps, so a plain background would square its corners. */
.band {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-4-bottom);
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 16px;
	padding: 14px 24px;
}

.action {
	flex: none;
	height: 40px;
	padding: 0 4px;
	color: var(--ul-ink);
	font: 600 14px/1.2 var(--ul-font-body);
	text-decoration: underline dotted;
	text-underline-offset: 5px;
	cursor: pointer;
}

.action:hover {
	color: var(--ul-accent-text);
}

.bg-hint {
	flex: 1 1 220px;
	margin: 0;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}
</style>
