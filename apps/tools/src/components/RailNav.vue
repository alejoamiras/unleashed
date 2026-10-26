<script setup lang="ts">
/** Composables */
import { SECTION_PATHS, type Section, useShell } from "@/composables/useShell"

/** Utils */
import { Icon, type IconName } from "@unleashed/design"
import { TESTIDS } from "@/lib/testids"

/** The left rail: four sections as links, so each can be opened in a new tab or copied. */
const props = defineProps<{ activityCount: number }>()

const shell = useShell()

const ENTRIES: ReadonlyArray<{ key: Section; label: string; icon: IconName; testid: string }> = [
	{ key: "send", label: "Bridge", icon: "arrows-horizontal", testid: TESTIDS.tabSend },
	{ key: "drip", label: "Faucet", icon: "coins", testid: TESTIDS.tabDrip },
	{ key: "activity", label: "Activity", icon: "audio-waveform", testid: TESTIDS.tabActivity },
	{ key: "addresses", label: "Addresses", icon: "info-box", testid: TESTIDS.tabAddresses },
]
</script>

<template>
	<nav class="nav" aria-label="Sections" :data-testid="TESTIDS.tabs">
		<a
			v-for="entry in ENTRIES"
			:key="entry.key"
			:href="SECTION_PATHS[entry.key]"
			class="entry ul-notch"
			:class="{ on: shell.section.value === entry.key }"
			:aria-current="shell.section.value === entry.key ? 'page' : undefined"
			:data-testid="entry.testid"
			@click="shell.follow($event, entry.key)"
		>
			<Icon class="glyph" :name="entry.icon" :size="24" />
			<span>{{ entry.label }}</span>
			<template v-if="entry.key === 'activity' && props.activityCount > 0">
				<span class="count ul-notch" aria-hidden="true">{{ props.activityCount }}</span>
				<span class="sr-only">, {{ props.activityCount }} needs you</span>
			</template>
		</a>
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
