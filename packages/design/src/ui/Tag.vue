<script setup lang="ts">
import { computed } from "vue"
import Icon, { type IconName } from "../core/Icon.vue"

type Tone = "neutral" | "ink" | "testnet" | "warn" | "lost" | "carrier" | "private" | "other"

const props = withDefaults(
	defineProps<{
		tone?: Tone
		/** Replaces the tone's default icon; `null` drops it. */
		icon?: IconName | null
		/** `small` is the 24px chip cards carry. */
		size?: "default" | "small"
	}>(),
	{ tone: "neutral", icon: undefined, size: "default" },
)

/** Callers must supply status text; icons are decorative. */
const DEFAULT_ICON: Record<Tone, IconName | null> = {
	neutral: null,
	ink: null,
	testnet: null,
	warn: "warning-diamond",
	lost: "square-alert",
	carrier: "check",
	private: "eye-off",
	other: "wallet",
}
const glyph = computed(() => (props.icon === undefined ? DEFAULT_ICON[props.tone] : props.icon))
</script>

<template>
	<span :class="['tag', 'ul-notch', `tag--${tone}`, { 'tag--small': size === 'small' }]">
		<Icon v-if="glyph" :name="glyph" :size="12" />
		<slot />
	</span>
</template>

<style scoped>
.tag {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	gap: 6px;
	min-height: 28px;
	padding: 0 10px;
	font: 700 13px/1 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.tag--small {
	min-height: 24px;
	padding: 0 8px;
	font-size: 12px;
}

.tag--ink {
	color: var(--ul-ink);
}

.tag--testnet,
.tag--warn {
	--ul-fill: var(--ul-attention-bg);
	color: var(--ul-attention);
}

.tag--lost {
	--ul-fill: var(--ul-lost-bg);
	color: var(--ul-lost);
}

.tag--carrier {
	--ul-fill: var(--ul-carrier-bg);
	color: var(--ul-carrier);
}

.tag--private {
	--ul-fill: var(--ul-signal-tint);
	color: var(--ul-accent-text);
}

.tag--other {
	--ul-fill: var(--ul-other-bg);
	color: var(--ul-other);
}
</style>
