<script setup lang="ts">
/** Utils */
import { computed, ref, useTemplateRef } from "vue"
import type { SelectableToken } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"

/** Components */
import TokenTile from "./TokenTile.vue"

const props = defineProps<{
	tokens: SelectableToken[]
	selected: SelectableToken | null
	/** Keyed by `logoKey` — an address alone would collide across chains. */
	balances?: Record<string, bigint>
	loading: boolean
	empty: boolean
}>()
const emit = defineEmits<{ select: [token: SelectableToken] }>()

const list = useTemplateRef<HTMLElement>("list")

// The listbox is ONE tab stop: the row focus last rested on carries it (the selected row, else the
// first), so Tab never walks a list that can hold hundreds of tokens.
const focused = ref<number | null>(null)
const rovingIndex = computed(() => {
	if (focused.value !== null && focused.value < props.tokens.length) return focused.value
	const key = props.selected?.logoKey
	const found = key === undefined ? -1 : props.tokens.findIndex((t) => t.logoKey === key)
	return found === -1 ? 0 : found
})

/** ↑/↓ move focus only: picking a row is the whole step, so the arrows must let the keyboard user
 *  browse the list without committing to every row they pass; Enter or Space on the row picks it. */
function move(from: number, delta: number): void {
	const count = props.tokens.length
	if (count === 0) return
	const next = (from + delta + count) % count
	list.value?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus()
}
</script>

<template>
	<div class="wrap">
		<p v-if="loading" class="note" aria-live="polite" :data-testid="TESTIDS.sendCatalogLoading">Loading tokens…</p>
		<div
			ref="list"
			class="list"
			role="listbox"
			aria-label="Tokens"
			:data-testid="TESTIDS.sendTokenList"
			:data-count="tokens.length"
		>
			<TokenTile
				v-for="(token, index) in tokens"
				:key="token.logoKey"
				:token="token"
				:selected="token.logoKey === selected?.logoKey"
				:balance="balances?.[token.logoKey]"
				:data-index="index"
				:tabindex="index === rovingIndex ? 0 : -1"
				@select="emit('select', token)"
				@focus="focused = index"
				@keydown.down.prevent="move(index, 1)"
				@keydown.up.prevent="move(index, -1)"
			/>
		</div>
		<p v-if="empty && !loading" class="note" :data-testid="TESTIDS.sendCatalogEmpty">
			No token matches that. Paste its Ethereum address to add it.
		</p>
	</div>
</template>

<style scoped>
.wrap {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.list {
	display: flex;
	flex-direction: column;
	gap: 6px;
	/* Five and a half rows, so a longer list shows that it scrolls. */
	max-height: 356px;
	overflow-y: auto;
}

.note {
	margin: 0;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}
</style>
