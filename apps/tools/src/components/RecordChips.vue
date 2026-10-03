<script setup lang="ts">
import { type BridgeJournalRecord, assetKindOf } from "@unleashed/bridge-core"
import { type IconName, Tag } from "@unleashed/design"
import { computed } from "vue"
import type { RecordStatus } from "@/lib/activity"
import { GROSS_QUALIFIER } from "@/lib/asset-label"
import { formatStoredAmount } from "@/lib/format"

/** A record's chips: visibility, the gas that rides along, and its status. Every chip carries an
 *  icon and a word, so colour never carries the status alone. */
const props = defineProps<{
	record: BridgeJournalRecord
	status: RecordStatus
	/** The running chip's word (`runningWord`). */
	running: string
}>()

const STATUS: Record<RecordStatus, { tone: "warn" | "ink" | "carrier" | "lost"; icon?: IconName }> = {
	"needs-you": { tone: "warn" },
	running: { tone: "ink", icon: "hourglass" },
	done: { tone: "carrier" },
	lost: { tone: "lost" },
}

const statusWord = computed(() => {
	if (props.status === "needs-you") return "Needs you"
	if (props.status === "done") return "Arrived"
	return props.status === "lost" ? "Lost signal" : props.running
})

/** A token send's gas slice; a gas-only record is Fee Juice already, so its amount says it all. */
const gas = computed(() => {
	const r = props.record
	if (r.direction !== "deposit" || assetKindOf(r) === "fee-juice" || !r.fuel) return null
	const label = r.isPrivate ? "Private FJ" : "FJ"
	return r.fuel.received ? `+ ${formatStoredAmount(r.fuel.received, 18)} ${label} ${GROSS_QUALIFIER}` : `+ ${label} gas`
})
</script>

<template>
	<Tag size="small" :tone="record.isPrivate ? 'private' : 'neutral'" :icon="record.isPrivate ? 'eye-off' : 'eye'">{{
		record.isPrivate ? "Private" : "Public"
	}}</Tag>
	<Tag v-if="gas" size="small" tone="ink" icon="zap">{{ gas }}</Tag>
	<Tag size="small" :tone="STATUS[status].tone" :icon="STATUS[status].icon" :data-status-chip="status">{{ statusWord }}</Tag>
</template>
