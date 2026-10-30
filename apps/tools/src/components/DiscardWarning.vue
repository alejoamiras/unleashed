<script setup lang="ts">
/** Utils */
import { Icon } from "@unleashed/design"
import { IS_MAINNET } from "@/lib/network"
import { TESTIDS } from "@/lib/testids"

/** Shown under an armed button that deletes a private deposit's record, which holds the only copy of its claim secret. */
</script>

<template>
	<p class="discard-warning" :data-testid="TESTIDS.journalDiscardWarning">
		<Icon name="square-alert" :size="12" class="note-icon" />
		<span>
			Discarding destroys the only copy of this claim's sealed recovery secret — the deposited funds become
			unclaimable{{ IS_MAINNET ? " — these are real funds" : "" }}.
		</span>
	</p>
</template>

<style scoped>
.discard-warning {
	display: flex;
	gap: 8px;
	align-items: flex-start;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-lost);
}

.note-icon {
	flex: none;
	margin-top: 1px;
}
</style>
