<script setup lang="ts">
import { computed } from "vue"
import type { TextColorName } from "../color-names"
import { ICONS, type PixelIconName } from "./icons"

/** Pixelarticons by name; `chevron` is kept as the name for `chevron-down`. */
export type IconName = PixelIconName | "chevron"

/** Literal `var()`s, so the undefined-token guard can check each one against base.css. */
const COLORS: Record<TextColorName, string> = {
	primary: "var(--ul-ink)",
	secondary: "var(--ul-ink-2)",
	tertiary: "var(--ul-ink-3)",
	inverse: "var(--ul-bg)",
	white: "var(--ul-on-mark)",
}

/** Supported icon sizes in CSS pixels. */
export type IconSize = 12 | 24 | "12" | "24"

const props = withDefaults(
	defineProps<{
		name: IconName
		size?: IconSize
		/** Defaults to the surrounding text colour. */
		color?: TextColorName
		/** Degrees, clockwise. */
		rotate?: number | `${number}`
		/** Names the icon for assistive tech; without one it is decorative and hidden. */
		label?: string
	}>(),
	{ size: 12, color: undefined, rotate: 0, label: undefined },
)

const glyph = computed(() => ICONS[props.name === "chevron" ? "chevron-down" : props.name])

const style = computed(() => ({
	color: props.color ? COLORS[props.color] : undefined,
	transform: Number(props.rotate) ? `rotate(${props.rotate}deg)` : undefined,
}))
</script>

<template>
	<svg
		:viewBox="glyph.viewBox"
		:width="size"
		:height="size"
		:style="style"
		:class="$style.icon"
		fill="currentColor"
		shape-rendering="crispEdges"
		:role="label ? 'img' : undefined"
		:aria-label="label || undefined"
		:aria-hidden="label ? undefined : 'true'"
		focusable="false"
	>
		<path v-for="(d, i) in glyph.d" :key="i" :d="d" />
	</svg>
</template>

<style module>
.icon {
	flex: none;
	transition: transform var(--ul-tick);
}
</style>
