<script setup lang="ts">
import BusyPixels from "./BusyPixels.vue"

const props = withDefaults(
	defineProps<{
		size?: "small" | "medium" | "large"
		variant?: "primary" | "secondary" | "quiet" | "destructive"
		loading?: boolean
		disabled?: boolean
	}>(),
	{ size: "medium", variant: "primary", loading: false, disabled: false },
)

const emit = defineEmits<{ click: [event: MouseEvent] }>()

/** A native button turns Enter and Space into `click`, so refusing here stops the keyboard too. */
function onClick(event: MouseEvent) {
	if (!props.loading && !props.disabled) emit("click", event)
}

defineSlots<{
	default?: () => unknown
	/** Why the button is disabled, shown on the button itself; rendered only while disabled. */
	reason?: () => unknown
}>()
</script>

<template>
	<button
		type="button"
		:class="[
			'ul-notch',
			$style.button,
			$style[size],
			$style[variant],
			{ [$style.loading]: loading, [$style.withReason]: disabled && $slots.reason },
		]"
		:disabled="disabled || undefined"
		:aria-busy="loading || undefined"
		@click="onClick"
	>
		<slot />
		<BusyPixels v-if="loading" aria-hidden="true" />
		<span v-if="disabled && $slots.reason" :class="$style.reason"><slot name="reason" /></span>
	</button>
</template>

<style module>
.button {
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	font-family: var(--ul-font-body);
	font-weight: 700;
	line-height: 1;
	white-space: nowrap;
	cursor: pointer;
	user-select: none;
	transition: transform var(--ul-tick);
}

.small {
	min-height: 36px;
	padding: 0 12px;
	gap: 6px;
	font-size: 14px;
}

.medium {
	min-height: 44px;
	padding: 0 16px;
	font-size: 15px;
}

.large {
	min-height: 48px;
	padding: 0 18px;
	gap: 10px;
	font-size: 16px;
}

.primary {
	--ul-fill: var(--ul-signal);
	color: var(--ul-on-signal);
}

/* Toward white: the text on signal is dark in both themes, so this only raises its contrast. */
.primary:hover:enabled:not(.loading) {
	--ul-fill: color-mix(in srgb, var(--ul-signal) 85%, #fff);
}

.secondary {
	--ul-fill: var(--ul-raised);
	color: var(--ul-ink);
	font-weight: 600;
}

.secondary:hover:enabled:not(.loading) {
	--ul-fill: var(--ul-line);
}

.quiet {
	--ul-fill: transparent;
	color: var(--ul-ink-2);
	font-weight: 600;
	text-decoration: underline dotted;
	text-underline-offset: 5px;
}

.quiet:hover:enabled:not(.loading) {
	color: var(--ul-ink);
}

.destructive {
	--ul-fill: var(--ul-lost-bg);
	color: var(--ul-lost);
}

.button:active:enabled:not(.loading) {
	transform: translateY(1px);
}

/* A busy button keeps its variant's colours, so its label stays readable while it is disabled. */
.button:disabled:not(.loading) {
	--ul-fill: var(--ul-raised);
	color: var(--ul-disabled);
	text-decoration: none;
	cursor: not-allowed;
}

/* Cosmetic: it stops the mouse only. The guard against a second activation is `onClick`. */
.loading {
	pointer-events: none;
}

.primary.loading {
	--ul-fill: var(--ul-signal-tint);
	color: var(--ul-accent-text);
}

.withReason {
	flex-wrap: wrap;
	row-gap: 4px;
	padding-block: 8px;
}

.reason {
	flex-basis: 100%;
	color: var(--ul-ink-2);
	font-size: 13px;
	font-weight: 400;
	line-height: 1.3;
	white-space: normal;
}
</style>
