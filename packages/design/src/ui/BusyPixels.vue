<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: "Loading" })
</script>

<template>
	<span :class="$style.pixels" role="status" :aria-label="label">
		<span v-for="i in 3" :key="i" :class="$style.pixel" aria-hidden="true" />
	</span>
</template>

<style module>
.pixels {
	display: inline-flex;
	flex: none;
	gap: 3px;
}

.pixel {
	width: 6px;
	height: 6px;
	background: currentColor;
}

.pixel:nth-child(2) {
	opacity: 0.55;
}

.pixel:nth-child(3) {
	opacity: 0.2;
}

/* Three 90ms holds; reduced motion retains the static opacity pattern. */
@media (prefers-reduced-motion: no-preference) {
	.pixel {
		animation: ul-busy-step 270ms infinite;
		animation-timing-function: steps(1, end);
	}

	.pixel:nth-child(2) {
		animation-delay: -180ms;
	}

	.pixel:nth-child(3) {
		animation-delay: -90ms;
	}
}

@keyframes ul-busy-step {
	0% {
		opacity: 1;
	}

	33.333% {
		opacity: 0.2;
	}

	66.667%,
	100% {
		opacity: 0.55;
	}
}
</style>
