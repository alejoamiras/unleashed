<script setup lang="ts">
/** Services */
import type { CrossChainDepositRecord } from "@unleashed/bridge-core"
import { Button, Icon } from "@unleashed/design"
import { computed } from "vue"

/** Composables */
import { useBridgeJournal } from "@/composables/useBridgeJournal"
import { useEthHeld } from "@/composables/useEthHeld"
import { useShell } from "@/composables/useShell"

/** Utils */
import { chainLabel, lifiScanUrl } from "@/lib/chains"
import { assetText, type CrossChainPhase, ethereumPrefillOf, phaseGuide, shortAddress } from "@/lib/crosschain-activity"
import { TESTIDS } from "@/lib/testids"

/** Components */
import LeftoverApproval from "./LeftoverApproval.vue"
import StateNotice from "./send/StateNotice.vue"

/**
 * A cross-chain card's guide and actions while it is not a plain deposit. Only an ended send can be
 * dismissed: before its outcome is final the funds may still be on their way, and the record holds
 * their claim.
 */
const props = defineProps<{ record: CrossChainDepositRecord; phase: CrossChainPhase; exportable: boolean }>()
const emit = defineEmits<{ backup: [] }>()

const journal = useBridgeJournal()
const shell = useShell()

const delivered = computed(() => props.phase.kind === "delivered")
const ethHeld = useEthHeld(() => (delivered.value ? props.record.route.srcSender : undefined))
const guide = computed(() => phaseGuide(props.record, props.phase, { ethHeld: ethHeld.value }))

const final = computed(() => props.phase.kind === "not-sent" || props.phase.kind === "delivered" || props.phase.kind === "expired")
/** A send that never left the wallet reads as the refusal it is, with its own Dismiss. */
const notSent = computed(() => {
	if (props.phase.kind !== "not-sent") return null
	const route = props.record.route
	return { source: chainLabel(route.srcChainId), sent: assetText(props.record, route.srcAmount), who: shortAddress(route.srcSender) }
})
const prefill = computed(() => (delivered.value ? ethereumPrefillOf(props.record) : null))
const trackUrl = computed(() => (props.phase.kind === "bridging" ? lifiScanUrl(props.record.route.srcTxHash ?? "") : ""))

function onContinue(): void {
	if (prefill.value) shell.continueFromEthereum(prefill.value)
}
</script>

<template>
	<div class="xc" :data-testid="TESTIDS.journalXcOutcome" :data-phase="phase.kind">
		<StateNotice
			v-if="notSent"
			tone="lost"
			icon="square-alert"
			title="Not sent"
			action="Dismiss"
			:action-testid="TESTIDS.journalXcDismiss"
			@act="journal.discard(record.id)"
		>
			<span :data-testid="TESTIDS.journalXcGuide"
				>The send reverted on {{ notSent.source }}, so nothing moved. Your <span class="mono">{{ notSent.sent }}</span> is still in
				<span class="mono">{{ notSent.who }}</span>.</span
			>
		</StateNotice>
		<p v-else class="guide-line" :data-testid="TESTIDS.journalXcGuide">{{ guide }}</p>
		<LeftoverApproval v-if="notSent" :record="record" />
		<div class="actions">
			<Button v-if="prefill" size="small" class="card-btn" :data-testid="TESTIDS.journalXcContinue" @click="onContinue">
				Continue from Ethereum
			</Button>
			<Button
				v-if="final && !notSent"
				size="small"
				variant="secondary"
				class="card-btn"
				:data-testid="TESTIDS.journalXcDismiss"
				@click="journal.discard(record.id)"
			>
				Dismiss
			</Button>
			<a v-if="trackUrl" class="track" :href="trackUrl" target="_blank" rel="noopener noreferrer" :data-testid="TESTIDS.journalXcTrack"
				>Track on LI.FI<Icon name="external-link" :size="12"
			/></a>
			<button
				v-if="exportable && !final"
				type="button"
				class="backup ul-notch"
				aria-label="Back up this bridge"
				title="Download this bridge's recovery file — restores it on any browser with your Ethereum wallet."
				:data-testid="TESTIDS.cardBackup"
				@click="emit('backup')"
			>
				<Icon name="save" :size="24" />
			</button>
		</div>
	</div>
</template>

<style scoped>
.xc {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.guide-line {
	margin: 0;
	font: 400 14px/1.5 var(--ul-font-body);
	color: var(--ul-ink);
}

.mono {
	font-family: var(--ul-font-mono);
}

.actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 14px;
}

.actions:empty {
	display: none;
}

.card-btn {
	padding: 0 14px;
}

.track {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font: 600 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.backup {
	--ul-fill: transparent;
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	margin-left: auto;
	padding: 0;
	border: 0;
	background: none;
	color: var(--ul-ink-2);
	cursor: pointer;
	transition: color var(--ul-tick);
}

.backup:hover {
	--ul-fill: var(--ul-raised);
	color: var(--ul-ink);
}

.backup:focus-visible {
	outline: 2px solid var(--ul-ring);
	outline-offset: 3px;
}
</style>
