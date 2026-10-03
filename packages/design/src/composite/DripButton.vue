<script setup lang="ts">
import Icon, { type IconName } from "../core/Icon.vue"
import Button from "../ui/Button.vue"

withDefaults(
	defineProps<{
		label: string
		ariaLabel?: string
		loading?: boolean
		disabled?: boolean
		variant?: "primary" | "secondary"
		/** Leading 24px glyph, dropped while loading (the busy pixels follow the label). */
		icon?: IconName
	}>(),
	{ loading: false, disabled: false, variant: "secondary", icon: undefined },
)

const emit = defineEmits<{ click: [] }>()

function onClick() {
	emit("click")
}
</script>

<template>
	<!-- `Button` drops clicks while loading but stays enabled, so `disabled || loading` also locks the
	     drip button for the page and assistive tech mid-request. -->
	<Button
		size="large"
		:variant="variant"
		:loading="loading"
		:disabled="disabled || loading"
		:data-loading="loading"
		:aria-label="ariaLabel || label"
		@click="onClick"
	>
		<Icon v-if="icon && !loading" :name="icon" :size="24" />
		{{ label }}
	</Button>
</template>
