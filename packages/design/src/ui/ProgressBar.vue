<script setup lang="ts">
import { computed } from "vue"

const props = withDefaults(
	defineProps<{
		/** The accessible name. */
		label: string
		/** 0–1. Absent means indeterminate: no `aria-valuenow`, and a travelling block that claims no amount. */
		value?: number
		/** CSS pixels. */
		height?: number
		/** The fill's colour; `ended` is a run that stopped short, in secondary ink. */
		tone?: "signal" | "lost" | "carrier" | "ended"
	}>(),
	{ value: undefined, height: 14, tone: "signal" },
)

const percent = computed(() => (props.value === undefined ? null : Math.round(Math.min(1, Math.max(0, props.value || 0)) * 100)))
</script>

<template>
	<div
		:class="[$style.bar, 'ul-notch']"
		role="progressbar"
		:aria-label="label"
		:aria-valuemin="percent === null ? undefined : 0"
		:aria-valuemax="percent === null ? undefined : 100"
		:aria-valuenow="percent ?? undefined"
		:data-tone="tone"
		:style="{ height: `${height}px` }"
	>
		<span v-if="percent === null" :class="[$style.fill, $style.travel]" />
		<span v-else :class="$style.fill" :style="{ width: `${percent}%` }" />
	</div>
</template>

<style module>
/* The whole host is clipped, not only its fill, so the travelling block keeps the stepped corners;
   `overflow: hidden` keeps its off-track frames out of the page's scroll width, which clip-path does not. */
.bar {
	--ul-fill: var(--ul-line);
	--ul-notch: var(--ul-notch-2);
	position: relative;
	overflow: hidden;
	clip-path: var(--ul-notch);
}

/* Border-box: at 0 % only the ink edge shows, marking where the run starts. */
.fill {
	position: absolute;
	inset: 0 auto 0 0;
	box-sizing: border-box;
	border-right: 3px solid var(--ul-ink);
	background: var(--ul-signal);
}

.bar[data-tone="lost"] .fill {
	background: var(--ul-lost);
}

.bar[data-tone="carrier"] .fill {
	background: var(--ul-carrier);
}

.bar[data-tone="ended"] .fill {
	background: var(--ul-ink-2);
}

/* Reduced motion holds the block mid-track, detached from both ends, so it never reads as a fill level. */
.travel {
	width: 25%;
	transform: translateX(150%);
}

@media (prefers-reduced-motion: no-preference) {
	.travel {
		animation: ul-progress-travel 1.6s steps(8) infinite;
	}
}

/* steps(8) never draws the `to` frame, so this range shows the block on every frame: half in at the
   start, flush with the far end on the last. */
@keyframes ul-progress-travel {
	from {
		transform: translateX(-50%);
	}

	to {
		transform: translateX(350%);
	}
}
</style>
