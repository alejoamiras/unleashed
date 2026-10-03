<script setup lang="ts">
import { Icon, type IconName } from "@unleashed/design"
import { computed } from "vue"
import { useTheme } from "@/composables/useTheme"
import { TESTIDS } from "@/lib/testids"

const { mode, cycleTheme } = useTheme()

const ICON: Record<typeof mode.value, IconName> = { dark: "moon", light: "sun", system: "monitor" }
const LABEL = { dark: "Dark", light: "Light", system: "System" } as const

const icon = computed(() => ICON[mode.value])
const label = computed(() => LABEL[mode.value])
</script>

<template>
	<button
		type="button"
		class="theme-toggle"
		:data-testid="TESTIDS.themeToggle"
		:data-theme-mode="mode"
		:aria-label="`Theme: ${label}. Click to change.`"
		:title="`Theme: ${label}`"
		@click="cycleTheme"
	>
		<Icon :name="icon" :size="12" />
		<span class="label">{{ label }}</span>
	</button>
</template>

<style scoped>
.theme-toggle {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	min-height: 36px;
	padding: 0 10px;
	font: 600 14px/1 var(--ul-font-body);
	color: var(--ul-ink-2);
	cursor: pointer;
	transition: color var(--ul-tick);
}

.theme-toggle:hover {
	color: var(--ul-ink);
}
</style>
