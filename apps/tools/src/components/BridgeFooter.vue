<script setup lang="ts">
import { IS_MAINNET } from "@/lib/network"
</script>

<template>
	<footer v-if="IS_MAINNET" class="footer">
		<p class="warning">Real funds — keep it small</p>
	</footer>
</template>

<style scoped>
.footer {
	padding: 0 0 22px;
	color: var(--ul-ink-3);
	font: 400 12.5px/1.5 var(--ul-font-body);
}

.warning {
	margin: 0;
}
</style>
