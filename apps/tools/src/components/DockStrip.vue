<script setup lang="ts">
/** Utils */
import { Icon } from "@unleashed/design"
import { ref } from "vue"
import { TESTIDS } from "@/lib/testids"

/** The hidden dock: a chevron to reopen it, a vertical label, and one badge that exists only while
 *  a bridge needs you and the dock is closed (open, its buttons are the signal). Running never badges. */
defineProps<{ count: number; open?: boolean; controls: string }>()
const emit = defineEmits<{ open: [] }>()

const openEl = ref<HTMLButtonElement | null>(null)
defineExpose({ focus: () => openEl.value?.focus() })
</script>

<template>
	<aside class="strip" aria-label="Activity" :data-testid="TESTIDS.dockStrip">
		<button
			ref="openEl"
			type="button"
			class="open"
			:aria-expanded="!!open"
			:aria-controls="open ? controls : undefined"
			:data-testid="TESTIDS.dockOpen"
			:aria-label="open ? 'Hide activity' : count > 0 ? `Show activity, ${count} need you` : 'Show activity'"
			@click="emit('open')"
		>
			<Icon name="chevron-down" :size="24" :rotate="open ? -90 : 90" />
			<span v-if="count > 0 && !open" class="badge" aria-hidden="true" :data-testid="TESTIDS.dockBadge">{{ count }}</span>
		</button>
		<span class="lbl" aria-hidden="true">Activity</span>
	</aside>
</template>

<style scoped>
.strip {
	position: sticky;
	top: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	width: 44px;
	max-height: 100vh;
	background: var(--ul-well);
}

.open {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 100%;
	height: 72px;
	color: var(--ul-ink-2);
	cursor: pointer;
	transition: color var(--ul-tick);
}

.open:hover {
	color: var(--ul-ink);
}

.open:focus-visible {
	outline-offset: -2px;
}

/* The one call on the strip: it exists only while a bridge needs you. */
.badge {
	position: absolute;
	top: 10px;
	right: 4px;
	box-sizing: border-box;
	min-width: 16px;
	height: 16px;
	padding: 0 4px;
	background: var(--ul-signal);
	color: var(--ul-on-signal);
	font: 700 11px/16px var(--ul-font-mono);
	text-align: center;
}

.lbl {
	margin-top: 16px;
	writing-mode: vertical-rl;
	font: 400 13px/1 var(--ul-font-body);
	color: var(--ul-ink-3);
}
</style>
