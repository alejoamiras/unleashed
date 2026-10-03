<script setup lang="ts">
/** The cells stay emoji so the grid matches the wallet's; only the frame follows the theme. */
defineProps<{
	cells: string[]
	testId?: string
	cellTestId?: (i: number) => string
}>()
</script>

<template>
	<div class="emoji-grid ul-notch" :data-testid="testId" role="img" aria-label="Verification grid">
		<span
			v-for="(cell, i) in cells"
			:key="i"
			class="cell ul-notch"
			:data-testid="cellTestId ? cellTestId(i) : undefined"
		>{{ cell }}</span>
	</div>
</template>

<style scoped>
.emoji-grid {
	--ul-fill: var(--ul-field);
	--ul-notch: var(--ul-notch-4);
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 8px;
	padding: 16px;
	width: fit-content;
}

.cell {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	width: 56px;
	height: 56px;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 28px;
}
</style>
