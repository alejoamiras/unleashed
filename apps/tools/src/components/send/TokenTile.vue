<script setup lang="ts">
/** Utils */
import { computed } from "vue"
import { chainBadge } from "@/lib/chains"
import { formatBigInt, trimAddress } from "@/lib/format"
import type { SelectableToken } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import { checksumAddress, safeDisplay } from "@/lib/token-display"
import type { RowLook } from "./token-rows"

/** Components */
import TokenMark from "./TokenMark.vue"

const props = defineProps<{
	token: SelectableToken
	selected: boolean
	balance?: bigint
	/** Overrides the token's own decimals when the balance is read in a different unit. */
	decimals?: number
	look?: RowLook
}>()
const emit = defineEmits<{ select: [] }>()

// Every string on this row can come from a remote list or a pasted contract; none of it reaches the
// DOM unsanitized, and none of it may grow long enough to push the balance out of view.
const symbol = computed(() => safeDisplay(props.token.symbol))
const badge = computed(() => chainBadge(props.token.chainId))

const added = computed(() => props.token.source === "pasted")
const disabled = computed(() => props.look?.disabled === true)
const withAddress = computed(() => props.look?.withAddress ?? true)

const checksummed = computed(() => (props.look?.native ? "" : checksumAddress(props.token.address)))
const address = computed(() => trimAddress(checksummed.value, 8, 6))

// A pasted token carries `decimals: -1` until the selection step reads them; formatting against that
// sentinel would render a nonsense balance, so the row simply shows none.
const balanceText = computed(() => {
	const decimals = props.decimals ?? props.token.decimals
	if (props.balance === undefined || decimals < 0) return null
	return formatBigInt(props.balance, decimals, props.look?.places)
})

function pick(): void {
	if (!disabled.value) emit("select")
}
</script>

<template>
	<button
		type="button"
		role="option"
		class="tile ul-notch"
		:data-testid="TESTIDS.sendTokenTile"
		:data-key="token.logoKey"
		:data-selected="selected || undefined"
		:data-disabled="disabled || undefined"
		:aria-selected="selected"
		:aria-disabled="disabled || undefined"
		:title="checksummed || undefined"
		@click="pick"
	>
		<TokenMark :token="token" :muted="disabled" />
		<span class="ident">
			<span class="line">
				<span class="symbol" :data-testid="TESTIDS.sendTokenSymbol">{{ symbol }}</span>
				<span class="chip" :data-testid="TESTIDS.sendTokenChain">{{ badge }}</span>
			</span>
			<span class="sub" :data-testid="TESTIDS.sendTokenSub">
				<template v-if="look?.sub">{{ look.sub }}<template v-if="withAddress"> · </template></template>
				<span v-if="withAddress" class="address" :data-testid="TESTIDS.sendTokenAddress" :data-added="added || undefined">
					{{ address }}<template v-if="added"> · added by you</template>
				</span>
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
	flex: none;
	align-items: center;
	gap: 12px;
	width: 100%;
	min-height: 56px;
	padding: 0 12px;
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

.tile[data-disabled],
.tile[data-disabled]:hover {
	--ul-fill: transparent;
	color: var(--ul-ink-3);
	cursor: default;
}

.ident {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
}

.line {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	font: 700 15px/1.2 var(--ul-font-body);
}

.symbol {
	flex: 0 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.chip {
	display: inline-flex;
	flex: none;
	align-items: center;
	height: 18px;
	padding: 0 5px;
	clip-path: var(--ul-notch-2);
	background: var(--ul-line);
	color: var(--ul-ink);
	font: 800 10.5px/1 var(--ul-font-body);
	letter-spacing: 0.06em;
}

.tile[data-disabled] .chip {
	background: var(--ul-raised);
	color: var(--ul-ink-3);
}

.sub {
	font: 400 12.5px/1.3 var(--ul-font-body);
	color: var(--ul-ink-2);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.address {
	font-family: var(--ul-font-mono);
}

.tile[data-selected] .sub {
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

@media (max-width: 760px) {
	.tile {
		padding: 6px 10px;
	}
}
</style>
