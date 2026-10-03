<script setup lang="ts">
/** Composables */
import { type Section, useShell } from "@/composables/useShell"

import { PHONE_QUERY, useMediaQuery } from "@/composables/useMediaQuery"

/** Utils */
import { Icon, type IconName } from "@unleashed/design"
import { useTemplateRef } from "vue"
import { TESTIDS } from "@/lib/testids"

/** The left rail: three sections as one roving tablist (one Tab stop; ↑/↓ and ←/→ move between them). */
const props = defineProps<{ activityCount: number }>()

const shell = useShell()
const rail = useTemplateRef<HTMLElement>("rail")
const topRow = useMediaQuery(PHONE_QUERY)

const ENTRIES: ReadonlyArray<{ key: Section; label: string; icon: IconName; testid: string }> = [
	{ key: "send", label: "Bridge", icon: "arrows-horizontal", testid: TESTIDS.tabSend },
	{ key: "drip", label: "Faucet", icon: "coins", testid: TESTIDS.tabDrip },
	{ key: "activity", label: "Activity", icon: "audio-waveform", testid: TESTIDS.tabActivity },
]

function move(from: number, delta: number): void {
	const next = (from + delta + ENTRIES.length) % ENTRIES.length
	const entry = ENTRIES[next]
	if (!entry) return
	shell.goTo(entry.key)
	rail.value?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus()
}
</script>

<template>
	<nav
		ref="rail"
		class="nav"
		role="tablist"
		aria-label="Sections"
		:aria-orientation="topRow ? 'horizontal' : 'vertical'"
		:data-testid="TESTIDS.tabs"
	>
		<button
			v-for="(entry, index) in ENTRIES"
			:key="entry.key"
			type="button"
			role="tab"
			class="entry ul-notch"
			:class="{ on: shell.section.value === entry.key }"
			:aria-selected="shell.section.value === entry.key"
			:tabindex="shell.section.value === entry.key ? 0 : -1"
			:data-testid="entry.testid"
			:data-index="index"
			@click="shell.goTo(entry.key)"
			@keydown.up.prevent="move(index, -1)"
			@keydown.down.prevent="move(index, 1)"
			@keydown.left.prevent="move(index, -1)"
			@keydown.right.prevent="move(index, 1)"
		>
			<Icon class="glyph" :name="entry.icon" :size="24" />
			<span>{{ entry.label }}</span>
			<template v-if="entry.key === 'activity' && props.activityCount > 0">
				<span class="count ul-notch" aria-hidden="true">{{ props.activityCount }}</span>
				<span class="sr-only">, {{ props.activityCount }} needs you</span>
			</template>
		</button>
	</nav>
</template>

<style scoped>
.nav {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.entry {
	--ul-fill: transparent;
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: center;
	gap: 12px;
	min-height: 44px;
	padding: 0 12px;
	font: 600 15px/1 var(--ul-font-body);
	color: var(--ul-ink-2);
	text-align: left;
	cursor: pointer;
	transition: color var(--ul-tick);
}

.entry:hover {
	--ul-fill: var(--ul-raised);
	color: var(--ul-ink);
}

/* Reverse video marks the current section. */
.entry.on {
	--ul-fill: var(--ul-ink);
	color: var(--ul-bg);
	font-weight: 700;
}

.count {
	--ul-fill: var(--ul-signal);
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	min-width: 24px;
	height: 24px;
	margin-left: auto;
	padding: 0 6px;
	font: 700 13px/1 var(--ul-font-mono);
	color: var(--ul-on-signal);
}

@media (max-width: 760px) {
	.nav {
		order: 1;
		flex: 1 0 100%;
		flex-direction: row;
		gap: 4px;
	}

	.entry {
		flex: 1;
		justify-content: center;
		gap: 8px;
		min-height: 40px;
	}

	.count {
		min-width: 22px;
		height: 22px;
		margin-left: 0;
		font-size: 12px;
	}

	.glyph {
		display: none;
	}
}
</style>
