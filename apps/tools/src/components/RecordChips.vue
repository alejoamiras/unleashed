<script setup lang="ts">
import { type AnyJournalRecord, type DepositJournalRecord, assetKindOf } from "@unleashed/bridge-core"
import { type IconName, Tag } from "@unleashed/design"
import { computed } from "vue"
import type { RecordStatus } from "@/lib/activity"
import { GROSS_QUALIFIER } from "@/lib/asset-label"
import { type CrossChainTone, sendView } from "@/lib/crosschain-activity"
import { formatStoredAmount } from "@/lib/format"

/** A record's chips: visibility, the gas that rides along, and its status. Every chip carries an
 *  icon and a word, so colour never carries the status alone. */
const props = defineProps<{
	record: AnyJournalRecord
	status: RecordStatus
	/** The running chip's word (`runningWord`). */
	running: string
	/** A cross-chain phase's word and tone, in place of the status's. */
	chip?: { word: string; tone: CrossChainTone } | null
}>()

type ChipTone = "warn" | "ink" | "carrier" | "lost" | "private" | "neutral"

const STATUS: Record<RecordStatus, { tone: ChipTone; icon?: IconName }> = {
	"needs-you": { tone: "warn" },
	running: { tone: "ink", icon: "hourglass" },
	done: { tone: "carrier" },
	lost: { tone: "lost" },
}

const PHASE: Record<CrossChainTone, { tone: ChipTone; icon?: IconName }> = {
	run: { tone: "private", icon: "hourglass" },
	wait: { tone: "neutral", icon: "hourglass" },
	need: { tone: "warn" },
	lost: { tone: "lost" },
	ended: { tone: "ink", icon: "close" },
}

const statusWord = computed(() => {
	if (props.chip) return props.chip.word
	if (props.status === "needs-you") return "Needs you"
	if (props.status === "done") return "Arrived"
	return props.status === "lost" ? "Lost signal" : props.running
})
const look = computed(() => (props.chip ? PHASE[props.chip.tone] : STATUS[props.status]))

/** A token send's gas slice; a gas-only record is Fee Juice already, so its amount says it all. */
const gas = computed(() => {
	const r = sendView(props.record)
	if (r.direction !== "deposit" || assetKindOf(r) === "fee-juice") return null
	const fuel = (r as DepositJournalRecord).fuel
	if (!fuel) return null
	const label = r.isPrivate ? "Private FJ" : "FJ"
	return fuel.received ? `+ ${formatStoredAmount(fuel.received, 18)} ${label} ${GROSS_QUALIFIER}` : `+ ${label} gas`
})
</script>

<template>
	<Tag size="small" :tone="record.isPrivate ? 'private' : 'neutral'" :icon="record.isPrivate ? 'eye-off' : 'eye'">{{
		record.isPrivate ? "Private" : "Public"
	}}</Tag>
	<Tag v-if="gas" size="small" tone="ink" icon="zap">{{ gas }}</Tag>
	<Tag size="small" :tone="look.tone" :icon="look.icon" :data-status-chip="status" :data-chip-tone="chip?.tone">{{
		statusWord
	}}</Tag>
</template>
