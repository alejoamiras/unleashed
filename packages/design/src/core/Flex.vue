<script setup lang="ts">
import { computed } from "vue"
import type { FlexDirection, FlexGap, FlexPlacement, FlexWrap } from "../layout-names"

const props = withDefaults(
	defineProps<{
		tag?: string
		direction?: FlexDirection
		align?: FlexPlacement
		justify?: FlexPlacement
		wrap?: FlexWrap
		gap?: FlexGap
	}>(),
	{ tag: "div", direction: "row" },
)

const PLACEMENT: Record<FlexPlacement, string> = {
	start: "flex-start",
	center: "center",
	end: "flex-end",
	between: "space-between",
	around: "space-around",
	evenly: "space-evenly",
}

// Custom properties rather than inline declarations, so a caller's class still overrides any of
// them. Each is always set: custom properties inherit, and a nested Flex must not take its parent's.
const vars = computed(() => ({
	"--flex-direction": props.direction,
	"--flex-align": props.align ? PLACEMENT[props.align] : "normal",
	"--flex-justify": props.justify ? PLACEMENT[props.justify] : "normal",
	"--flex-wrap": props.wrap ?? "nowrap",
	"--flex-gap": `${props.gap ?? 0}px`,
}))
</script>

<template>
	<component :is="tag" :class="$style.flex" :style="vars">
		<slot />
	</component>
</template>

<style module>
.flex {
	display: flex;
	flex-direction: var(--flex-direction);
	align-items: var(--flex-align);
	justify-content: var(--flex-justify);
	flex-wrap: var(--flex-wrap);
	gap: var(--flex-gap);
}
</style>
