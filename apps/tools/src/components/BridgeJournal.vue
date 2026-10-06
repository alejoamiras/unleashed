<script setup lang="ts">
/** Components */
import BridgeJournalCard from "./BridgeJournalCard.vue"
import EmptyChannel from "./EmptyChannel.vue"

/** Composables */
import { useBridgeBackup } from "@/composables/useBridgeBackup"
import { useBridgeJournal } from "@/composables/useBridgeJournal"
import { useToast } from "@/composables/useToast"

/** Utils */
import { assetKindOf } from "@unleashed/bridge-core"
import { Button, Icon } from "@unleashed/design"
import { computed, ref } from "vue"
import { rowStrings } from "@/lib/activity"
import { crossChainPhase, sendView } from "@/lib/crosschain-activity"
import { TESTIDS } from "@/lib/testids"

// `source` picks the record set: `visible` omits the record the wizard is foregrounding (its stepper
// is that record's one surface); `all` is for the Activity page, where no stepper is on screen.
// `kind` scopes the list to one asset kind. Completion toasts are the shell's (`useCompletionToasts`).
const props = withDefaults(
	defineProps<{ kind?: "bridge-token" | "fee-juice"; title?: string; source?: "visible" | "all"; highlightedId?: string | null }>(),
	{ title: "Your bridges", source: "visible", highlightedId: null },
)

const journal = useBridgeJournal()
const backup = useBridgeBackup()
const { push } = useToast()

const restoreInput = ref<HTMLInputElement | null>(null)
const restoring = ref(false)

/** A recovery file is a few KB of JSON. The check is on `size` and comes BEFORE `file.text()`,
 *  because reading is what costs: a multi-gigabyte pick would be decoded whole into memory just to
 *  be rejected by the validator afterwards. */
const MAX_RESTORE_BYTES = 1024 * 1024
const RESTORE_TOO_LARGE = "That file is too large to be a recovery file (the limit is 1 MB)."

const onBackup = backup.exportBridgeWithToast

async function onRestorePick(event: Event) {
	const input = event.target as HTMLInputElement
	const file = input.files?.[0]
	input.value = ""
	if (!file || restoring.value) return
	if (file.size > MAX_RESTORE_BYTES) {
		push({ kind: "error", text: RESTORE_TOO_LARGE })
		return
	}
	restoring.value = true
	try {
		const rec = await backup.restoreFile(await file.text())
		const { amount, symbol, qualifier: q } = rowStrings(rec, crossChainPhase(rec))
		push({
			kind: "ok",
			text: `Restored: ${amount} ${symbol}${q ? ` (${q})` : ""} ${rec.direction === "deposit" ? "to Aztec" : "to Ethereum"}.`,
		})
	} catch (e) {
		push({ kind: "error", text: e instanceof Error ? e.message : "Restore failed." })
	} finally {
		restoring.value = false
	}
}

/** Newest first: the dock is where what needs you ranks first. */
const sorted = computed(() => {
	const all = props.source === "all" ? journal.listedRecords.value : journal.visibleRecords.value
	const recs = props.kind ? all.filter((r) => assetKindOf(sendView(r)) === props.kind) : all
	return [...recs].sort((a, b) => b.createdAt - a.createdAt)
})
</script>

<template>
	<Flex tag="section" direction="column" gap="16" class="journal" :data-testid="TESTIDS.journal">
		<Flex tag="header" align="center" justify="between" gap="12">
			<h2>{{ props.title }}</h2>
			<Button
				size="small"
				variant="secondary"
				class="restore"
				:loading="restoring"
				:disabled="restoring"
				title="Load a bridge from its recovery file (one Ethereum signature)."
				:data-testid="TESTIDS.journalRestore"
				@click="restoreInput?.click()"
			>
				<Icon v-if="!restoring" name="upload" :size="12" />{{ restoring ? "Restoring" : "Restore" }}
			</Button>
			<input
				ref="restoreInput"
				type="file"
				accept="application/json,.json"
				class="hidden-input"
				:data-testid="TESTIDS.journalRestoreInput"
				@change="onRestorePick"
			/>
		</Flex>
		<div v-if="sorted.length === 0" :class="{ 'empty-state ul-notch': $slots.empty }" :data-testid="TESTIDS.journalEmpty">
			<slot name="empty">
				<EmptyChannel>
					Bridges you background or lose track of land here.
					<button
						type="button"
						class="empty-link"
						:data-testid="TESTIDS.journalRestoreLink"
						@click="restoreInput?.click()"
					>Restore</button>
					a saved bridge from its recovery file.
				</EmptyChannel>
			</slot>
		</div>
		<template v-else>
			<ul class="cards" role="list">
				<li v-for="rec in sorted" :key="rec.id">
					<BridgeJournalCard
						:record="rec"
						:class="{ highlighted: rec.id === props.highlightedId }"
						:data-highlighted="rec.id === props.highlightedId || undefined"
						@backup="onBackup"
					/>
				</li>
			</ul>
			<p class="kept">
				<Icon name="info-box" :size="12" />Records live in this browser. Back one up to finish it somewhere else.
			</p>
		</template>
	</Flex>
</template>

<style scoped>
.journal h2 {
	margin: 0;
	font: 700 17px/1.2 var(--ul-font-body);
	letter-spacing: var(--ul-tracking-heading);
	color: var(--ul-ink);
}

.restore {
	gap: 8px;
	min-height: 40px;
	padding: 0 14px;
}

.cards {
	display: flex;
	flex-direction: column;
	gap: 12px;
	margin: 0;
	padding: 0;
	list-style: none;
}

.kept {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 4px 0 0;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.empty-state {
	--ul-fill: var(--ul-well);
	--ul-notch: var(--ul-notch-4);
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 8px;
	padding: 32px 16px;
	text-align: center;
}

/* A real button for native a11y (focusable, Enter/Space), dressed as an inline link. */
.empty-link {
	display: inline;
	padding: 0;
	border: 0;
	background: transparent;
	font: inherit;
	color: var(--ul-ink);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
	cursor: pointer;
}

.empty-link:hover {
	color: var(--ul-accent-text);
}

.hidden-input {
	display: none;
}

/* The record the shell opened Activity for: an ink rule beside the card, no fill, no accent. */
.highlighted {
	box-shadow: -14px 0 0 -12px var(--ul-ink);
}
</style>
