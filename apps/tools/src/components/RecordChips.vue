<script setup lang="ts">
import { type AnyJournalRecord, type DepositJournalRecord, assetKindOf } from "@unleashed/bridge-core"
import { Tag } from "@unleashed/design"
import { computed } from "vue"
import type { RecordStatus } from "@/lib/activity"
import { GROSS_QUALIFIER } from "@/lib/asset-label"
import { type CrossChainTone, sendView } from "@/lib/crosschain-activity"
import { formatCompact } from "@/lib/format"

/** A record's chips: visibility, the gas an arrived send brought, and its status. The status is a word, so colour
 *  never carries it alone. */
const props = defineProps<{
	record: AnyJournalRecord
	status: RecordStatus
	/** The running chip's word (`runningWord`). */
	running: string
	/** A cross-chain phase's word and tone, in place of the status's. */
	chip?: { word: string; tone: CrossChainTone } | null
}>()

type ChipTone = "warn" | "ink" | "carrier" | "lost" | "private" | "neutral"

const STATUS: Record<RecordStatus, ChipTone> = {
	"needs-you": "warn",
	running: "ink",
	done: "carrier",
	lost: "lost",
}

const PHASE: Record<CrossChainTone, ChipTone> = {
	run: "private",
	wait: "neutral",
	need: "warn",
	lost: "lost",
	ended: "ink",
}

const statusWord = computed(() => {
	if (props.chip) return props.chip.word
	if (props.status === "needs-you") return "Needs you"
	if (props.status === "done") return "Arrived"
	return props.status === "lost" ? "Lost signal" : props.running
})
const look = computed(() => (props.chip ? PHASE[props.chip.tone] : STATUS[props.status]))

/** An arrived token send's gas; a gas-only record is Fee Juice already, so its amount says it all. */
const gas = computed(() => {
	const r = sendView(props.record)
	if (props.status !== "done" || r.direction !== "deposit" || assetKindOf(r) === "fee-juice") return null
	const received = (r as DepositJournalRecord).fuel?.received
	if (!received || !/^\d+$/.test(received)) return null
	return `+ ≈ ${formatCompact(BigInt(received), 18, 0)} ${r.isPrivate ? "Private FJ" : "FJ"} ${GROSS_QUALIFIER}`
})
</script>

<template>
	<span class="chips">
		<Tag size="small" :tone="record.isPrivate ? 'private' : 'neutral'" :icon="record.isPrivate ? 'eye-off' : 'eye'">{{
			record.isPrivate ? "Private" : "Public"
		}}</Tag>
		<Tag v-if="gas" class="gas" size="small" tone="ink" icon="zap">{{ gas }}</Tag>
		<Tag size="small" :tone="look" :icon="null" :data-status-chip="status" :data-chip-tone="chip?.tone">{{
			statusWord
		}}</Tag>
	</span>
</template>

<style scoped>
/* One unit in the card header: the chips wrap to the next line together, never one by one. */
.chips {
	display: inline-flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}

.gas {
	--ul-fill: var(--ul-ink);
	color: var(--ul-bg);
}
</style>
