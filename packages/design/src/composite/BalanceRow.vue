<script setup lang="ts">
import Icon from "../core/Icon.vue"

/**
 * Presentational balance rows. Receives already-formatted strings + the
 * data-testids to emit; the parent owns the bigint formatting + loading state.
 */
defineProps<{
	publicText: string
	privateText: string
	publicTestId?: string
	privateTestId?: string
}>()
</script>

<template>
	<div class="balances">
		<div class="row ul-notch">
			<Icon name="eye" :size="12" class="glyph" />
			<span class="label">Public</span>
			<span class="value" :data-testid="publicTestId">{{ publicText }}</span>
		</div>
		<div class="row ul-notch">
			<Icon name="eye-off" :size="12" class="glyph private" />
			<span class="label">Private</span>
			<span class="value" :data-testid="privateTestId">{{ privateText }}</span>
		</div>
	</div>
</template>

<style scoped>
.balances {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.row {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: center;
	gap: 10px;
	min-height: 40px;
	padding: 0 14px;
	font: 400 14px/1.2 var(--ul-font-body);
}

.glyph {
	flex: none;
	color: var(--ul-ink-2);
}

.glyph.private {
	color: var(--ul-accent-text);
}

.label {
	flex-grow: 1;
	color: var(--ul-ink-2);
}

.value {
	color: var(--ul-ink);
	font: 400 15px/1.2 var(--ul-font-mono);
}
</style>
