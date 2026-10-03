<script setup lang="ts">
import { Icon } from "@unleashed/design"
import { computed, type PropType, ref, watch } from "vue"
import { useWalletConnection } from "@/composables/useWalletConnection"
import { TESTIDS } from "@/lib/testids"

const props = defineProps({
	/** Error categories the strip must NOT show — states that already own a
	 *  dedicated UI in the wallet panel (denied morph, install CTA). */
	exclude: {
		type: Array as PropType<string[]>,
		default: () => ["capability-rejected"],
	},
})

const { status, error } = useWalletConnection()

const dismissed = ref(false)
watch(error, () => {
	dismissed.value = false
})

const visible = computed(
	() => status.value === "error" && error.value !== null && !props.exclude.includes(error.value.category) && !dismissed.value,
)
</script>

<template>
	<div v-if="visible" class="strip ul-notch" role="alert" :data-testid="TESTIDS.errorStrip">
		<Icon class="icon" name="square-alert" :size="24" label="Error" />
		<span class="msg">{{ error?.message }}</span>
		<button
			class="x"
			type="button"
			aria-label="Dismiss"
			:data-testid="TESTIDS.errorStripDismiss"
			@click="dismissed = true"
		>
			<Icon name="close" :size="12" />
		</button>
	</div>
</template>

<style scoped>
.strip {
	--ul-fill: var(--ul-lost-bg);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 12px 14px;
	font-size: 14px;
	color: var(--ul-ink);
}

.icon {
	color: var(--ul-lost);
}

.msg {
	flex: 1;
	min-width: 0;
}

.x {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	color: var(--ul-ink);
	cursor: pointer;
	flex: none;
}
</style>
