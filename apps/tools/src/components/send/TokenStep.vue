<script setup lang="ts">
/** Utils */
import { Button, Icon } from "@unleashed/design"
import { computed } from "vue"
import type { LookupState } from "@/composables/useAddressLookup"
import { trimAddress } from "@/lib/format"
import type { Direction, SelectableToken } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import { checksumAddress, safeDisplay, safeSentence } from "@/lib/token-display"

/** Components */
import TokenList from "./TokenList.vue"
import TokenMark from "./TokenMark.vue"

/** Picking a row IS the step: the wizard moves on at once and reads the token behind the amount step. */
const props = defineProps<{
	direction: Direction
	tokens: SelectableToken[]
	search: string
	loading: boolean
	catalogError: string | null
	/** What the search resolved to while it holds an address the list does not have. */
	lookup: LookupState | null
	/** What the catalog said when a looked-up address was added (a duplicate, the zero address, …). */
	addError: string | null
	selected: SelectableToken | null
	/** Why the picked token could not be read; the wizard brings the user back here to see it. */
	selectionError: string | null
	/** Ethereum balances behind the rows, keyed by `logoKey`. */
	rowBalances?: Record<string, bigint>
}>()
const emit = defineEmits<{
	"update:search": [value: string]
	select: [token: SelectableToken]
	add: [address: string]
}>()

// The looked-up strings are whatever the contract answered: clamped and stripped before they render,
// and never shown without the address they belong to.
const found = computed(() => {
	const state = props.lookup
	if (state?.status !== "found") return null
	return {
		symbol: safeDisplay(state.identity.symbol),
		name: safeDisplay(state.identity.name),
		decimals: state.identity.decimals,
		mark: { logoKey: state.logoKey, symbol: state.identity.symbol, source: "pasted" as const },
	}
})

const lookupAddress = computed(() => (props.lookup ? checksumAddress(props.lookup.address) : ""))
const lookupShort = computed(() => (props.lookup ? trimAddress(lookupAddress.value, 8, 6) : ""))
</script>

<template>
	<section class="step" :data-testid="TESTIDS.sendStepToken" :data-direction="direction">
		<label class="search ul-notch">
			<Icon name="search" :size="24" color="tertiary" />
			<input
				class="field"
				type="search"
				aria-label="Search tokens"
				autocomplete="off"
				spellcheck="false"
				placeholder="Search a token, or paste its Ethereum address"
				:value="search"
				:data-testid="TESTIDS.sendTokenSearch"
				@input="emit('update:search', ($event.target as HTMLInputElement).value)"
			/>
		</label>

		<p v-if="catalogError" class="err" aria-live="polite" :data-testid="TESTIDS.sendCatalogError">{{ safeSentence(catalogError) }}</p>
		<p v-if="selectionError" class="err" aria-live="polite" :data-testid="TESTIDS.sendSelectionError">{{ safeSentence(selectionError) }}</p>

		<div v-if="lookup" class="lookup ul-notch" aria-live="polite" :data-testid="TESTIDS.sendTokenLookup" :data-status="lookup.status">
			<template v-if="found">
				<TokenMark :token="found.mark" />
				<span class="ident">
					<span class="symbol">
						{{ found.symbol }}
						<span class="meta">· {{ found.name }} · {{ found.decimals }} decimals</span>
					</span>
					<span class="address" :title="lookupAddress">{{ lookupShort }}</span>
				</span>
				<Button size="small" class="add" :data-testid="TESTIDS.sendLookupAdd" @click="emit('add', lookup.address)">
					<Icon name="plus" :size="12" />
					Add
				</Button>
			</template>
			<span v-else-if="lookup.status === 'reading'" class="note">Reading {{ lookupShort }}…</span>
			<span v-else-if="lookup.status === 'error'" class="err">{{ safeSentence(lookup.message) }}</span>
		</div>
		<p v-if="found" class="note">Not in your list yet. Add it and it stays here, with its address, for next time.</p>
		<p v-if="addError" class="err" aria-live="polite" :data-testid="TESTIDS.sendLookupError">{{ safeSentence(addError) }}</p>

		<TokenList
			v-if="!lookup"
			:tokens="tokens"
			:selected="selected"
			:loading="loading"
			:balances="rowBalances"
			:empty="tokens.length === 0"
			@select="emit('select', $event)"
		/>
	</section>
</template>

<style scoped>
.step {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.search {
	--ul-fill: var(--ul-field);
	--ul-notch: var(--ul-notch-2);
	--edge: var(--ul-ink-3);
	display: flex;
	align-items: center;
	gap: 10px;
	min-height: 48px;
	padding: 0 14px;
	cursor: text;
}

.search::before {
	box-shadow: inset 0 -2px 0 var(--edge);
}

.search:focus-within {
	--edge: var(--ul-focus);
}

.field {
	flex: 1;
	min-width: 0;
	padding: 0;
	color: var(--ul-ink);
	font: 400 15px/1.3 var(--ul-font-body);
}

.field::placeholder {
	color: var(--ul-ink-3);
}

/* The UA's clear glyph is off the pixel set (blue in light). */
.field::-webkit-search-cancel-button {
	-webkit-appearance: none;
	appearance: none;
}

.lookup {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 10px 10px 10px 12px;
}

.ident {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}

.symbol {
	font: 700 15px/1.2 var(--ul-font-body);
	color: var(--ul-ink);
}

.meta {
	font-size: 13px;
	font-weight: 400;
	color: var(--ul-ink-2);
}

.address {
	font: 400 12px/1.2 var(--ul-font-mono);
	color: var(--ul-ink-3);
}

.lookup .add {
	flex: none;
	margin-left: auto;
	padding: 0 14px;
}

.note {
	margin: 0;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.err {
	margin: 0;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-lost);
}
</style>
