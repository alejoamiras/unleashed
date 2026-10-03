<script setup lang="ts">
/** Utils */
import { computed } from "vue"
import { formatBigInt, trimAddress } from "@/lib/format"
import type { SelectableToken } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import { checksumAddress, safeDisplay } from "@/lib/token-display"

/** Components */
import TokenMark from "./TokenMark.vue"

const props = defineProps<{
	token: SelectableToken
	selected: boolean
	balance?: bigint
	/** Overrides the token's own decimals when the balance is read in a different unit. */
	decimals?: number
}>()
const emit = defineEmits<{ select: [] }>()

// Every string on this row can come from a remote list or a pasted contract; none of it reaches the
// DOM unsanitized, and none of it may grow long enough to push the address out of view.
const symbol = computed(() => safeDisplay(props.token.symbol))
const name = computed(() => safeDisplay(props.token.name))

const added = computed(() => props.token.source === "pasted")

/** Show the address on every row because names and symbols can be copied. */
const checksummed = computed(() => checksumAddress(props.token.address))
const address = computed(() => trimAddress(checksummed.value, 8, 6))

// A pasted token carries `decimals: -1` until the selection step reads them; formatting against that
// sentinel would render a nonsense balance, so the row simply shows none.
const balanceText = computed(() => {
	const decimals = props.decimals ?? props.token.decimals
	if (props.balance === undefined || decimals < 0) return null
	return formatBigInt(props.balance, decimals)
})
</script>

<template>
	<button
		type="button"
		role="option"
		class="tile ul-notch"
		:data-testid="TESTIDS.sendTokenTile"
		:data-key="token.logoKey"
		:data-selected="selected || undefined"
		:aria-selected="selected"
		:title="checksummed"
		@click="emit('select')"
	>
		<TokenMark :token="token" />
		<span class="ident">
			<span class="line">
				<span class="symbol" :data-testid="TESTIDS.sendTokenSymbol">{{ symbol }}</span>
				<span v-if="name && !added" class="name">{{ name }}</span>
			</span>
			<span class="address" :data-testid="TESTIDS.sendTokenAddress" :data-added="added || undefined">
				{{ address }}<template v-if="added"> · added by you</template>
			</span>
		</span>
		<span v-if="balanceText !== null" class="balance" :data-testid="TESTIDS.sendTokenBalance">{{ balanceText }}</span>
	</button>
</template>

<style scoped>
.tile {
	--ul-fill: transparent;
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: center;
	gap: 12px;
	width: 100%;
	min-height: 60px;
	padding: 0 16px 0 12px;
	color: var(--ul-ink);
	text-align: left;
	cursor: pointer;
}

/* The list scrolls, so an outside ring would be cut at its edges. */
.tile:focus-visible {
	outline-offset: -2px;
}

/* The ring sits on the tile, so on the ink pick it takes the page colour to stay visible. */
.tile[data-selected]:focus-visible {
	outline-color: var(--ul-bg);
}

.tile:hover {
	--ul-fill: var(--ul-raised);
}

/* Reverse video marks the pick; secondary text steps down to the line tone, which reads on ink in
   both themes. */
.tile[data-selected],
.tile[data-selected]:hover {
	--ul-fill: var(--ul-ink);
	color: var(--ul-bg);
}

.ident {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}

.line {
	display: flex;
	align-items: baseline;
	gap: 8px;
	min-width: 0;
}

.symbol {
	flex: 0 1 auto;
	min-width: 0;
	font: 700 15px/1.2 var(--ul-font-body);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* A zero basis leaves the name only the room the symbol does not take, so it gives way first. */
.name {
	flex: 1 1 0;
	min-width: 0;
	font: 400 13px/1.2 var(--ul-font-body);
	color: var(--ul-ink-2);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.address {
	font: 400 12px/1.2 var(--ul-font-mono);
	color: var(--ul-ink-3);
}

.tile[data-selected] .name,
.tile[data-selected] .address {
	color: var(--ul-line);
}

.balance {
	flex: none;
	font: 400 15px/1 var(--ul-font-mono);
	white-space: nowrap;
}

.tile[data-selected] .balance {
	font-weight: 600;
}
</style>
