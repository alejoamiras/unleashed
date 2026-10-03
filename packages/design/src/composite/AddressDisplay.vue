<script setup lang="ts">
import { computed, ref } from "vue"

const props = withDefaults(defineProps<{ address: string; head?: number; tail?: number }>(), { head: 6, tail: 4 })

const emit = defineEmits<{ copy: [address: string] }>()

const copied = ref(false)

const short = computed(() => {
	const a = props.address
	if (!a) return "—"
	if (a.length <= props.head + props.tail + 2) return a
	return `${a.slice(0, props.head)}…${a.slice(-props.tail)}`
})

async function onClick() {
	if (!props.address) return
	try {
		await navigator.clipboard.writeText(props.address)
		copied.value = true
		setTimeout(() => {
			copied.value = false
		}, 1200)
		emit("copy", props.address)
	} catch {
		// best-effort; surface a toast at the call site if desired
	}
}
</script>

<template>
	<button
		class="address ul-notch"
		type="button"
		:title="address"
		:aria-label="`Copy address ${address}`"
		@click="onClick"
	>
		<span class="value">{{ short }}</span>
		<span v-if="copied" class="copied-hint">Copied</span>
	</button>
</template>

<style scoped>
.address {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font-family: var(--ul-font-mono);
	font-size: 13px;
	color: var(--ul-ink);
	padding: 6px 10px;
	cursor: pointer;
}

.address:hover {
	--ul-fill: var(--ul-line);
}

.copied-hint {
	color: var(--ul-carrier);
	font: 700 12px/1 var(--ul-font-body);
}

/* Carrier on the hover fill is under 4.5:1 in the light theme. */
.address:hover .copied-hint {
	color: var(--ul-ink);
}
</style>
