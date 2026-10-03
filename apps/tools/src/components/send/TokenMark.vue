<script setup lang="ts">
/** Utils */
import { computed } from "vue"
import { TESTIDS } from "@/lib/testids"
import { type MarkSubject, markOf } from "./token-mark"

const props = defineProps<{ token: MarkSubject }>()

const mark = computed(() => markOf(props.token))

const style = computed(() => {
	const brand = mark.value.brand
	return brand ? { background: brand.fill, color: brand.ink } : undefined
})
</script>

<template>
	<span
		class="mark"
		aria-hidden="true"
		:style="style"
		:data-testid="mark.brand ? TESTIDS.sendTokenLogo : TESTIDS.sendTokenMonogram"
	>{{ mark.letters }}</span>
</template>

<style scoped>
.mark {
	display: flex;
	flex: none;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	clip-path: var(--ul-notch-2);
	background: var(--ul-raised);
	color: var(--ul-ink);
	font: 800 11px/1 var(--ul-font-body);
}
</style>
