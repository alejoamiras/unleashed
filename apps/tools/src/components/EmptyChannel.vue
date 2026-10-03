<script setup lang="ts">
import { Icon } from "@unleashed/design"
</script>

<template>
	<div class="empty-channel ul-notch">
		<Icon name="tv" :size="24" class="glyph" />
		<span class="words">
			<strong>Nothing on this channel yet</strong>
			<span class="sub"><slot /></span>
		</span>
	</div>
</template>

<style scoped>
.empty-channel {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: center;
	gap: 14px;
	padding: 14px;
}

.glyph {
	flex: none;
	color: var(--ul-ink-3);
}

.words {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

strong {
	font: 700 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink);
}

.sub {
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}
</style>
