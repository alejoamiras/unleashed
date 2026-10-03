<script setup lang="ts">
</script>

<template>
	<article class="card ul-notch">
		<slot />
	</article>
</template>

<style scoped>
.card {
	--ul-fill: var(--ul-panel);
	--ul-notch: var(--ul-notch-4);
	padding: 24px;
	display: flex;
	flex-direction: column;
	gap: 16px;
}
</style>
