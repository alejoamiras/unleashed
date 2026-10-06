<script setup lang="ts">
/** Utils */
import { Button, Icon } from "@unleashed/design"
import { computed, ref } from "vue"
import type { LookupState } from "@/composables/useAddressLookup"
import { chainLabel } from "@/lib/chains"
import { trimAddress } from "@/lib/format"
import { NETWORK } from "@/lib/network"
import type { Direction, SelectableToken } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import { checksumAddress, safeDisplay, safeSentence } from "@/lib/token-display"
import { joinWords } from "@/lib/word-list"
import { depositRows, type NetworkFilter, type StepRows } from "./token-rows"

/** Components */
import StateNotice from "./StateNotice.vue"
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
	/** Balances behind the rows: tokens under `logoKey`, native coins under their own key. */
	rowBalances?: Record<string, bigint>
	/** The registry's source tokens; none hides the network chips and the native rows. */
	sources?: readonly SelectableToken[]
	natives?: readonly SelectableToken[]
	/** Source chains where the connected wallet is a contract, so it may not send from them. */
	contractChains?: readonly number[]
}>()
const emit = defineEmits<{
	"update:search": [value: string]
	select: [token: SelectableToken]
	add: [address: string]
	"change-wallet": []
}>()

const deposit = computed(() => props.direction === "l1-to-l2")
/** Everything about other chains shows only where the registry offers one: an Ethereum-only build reads as before. */
const crossChain = computed(() => deposit.value && (props.sources?.length ?? 0) > 0)
const searchLabel = computed(() => (crossChain.value ? "Search tokens on every network" : "Search tokens"))
const placeholder = computed(() => (crossChain.value ? "Search tokens on every network" : "Search a token, or paste its Ethereum address"))

const network = ref<NetworkFilter>("all")
const chips = computed(() => {
	const ids = [...new Set((props.sources ?? []).map((t) => t.chainId)), NETWORK.l1ChainId]
	return [{ key: "all" as const, label: "All" }, ...ids.map((id) => ({ key: id, label: chainLabel(id) }))]
})

const refused = computed(() => (crossChain.value ? [...new Set(props.contractChains ?? [])] : []))
const refusedLine = computed(() => joinWords(refused.value.map(chainLabel), "or"))

const view = computed<StepRows>(() => {
	if (!deposit.value) return { rows: props.tokens, looks: {} }
	return depositRows({
		catalog: props.tokens,
		sources: props.sources ?? [],
		natives: crossChain.value ? (props.natives ?? []) : [],
		refused: refused.value,
		network: network.value,
		search: props.search,
	})
})

/** Under a source chain's chip, the tokens the registry routes from it: nothing else there can be sent. */
const onlyLine = computed(() => {
	const chain = network.value
	if (chain === "all" || chain === NETWORK.l1ChainId) return ""
	const symbols = [...new Set((props.sources ?? []).filter((t) => t.chainId === chain).map((t) => safeDisplay(t.symbol)))]
	return symbols.length > 0 ? `Only ${joinWords(symbols, "and")} can be sent for now.` : ""
})

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
		<p v-if="crossChain" class="from">Send from</p>
		<label class="search ul-notch">
			<Icon name="search" :size="24" color="tertiary" />
			<input
				class="field"
				type="search"
				:aria-label="searchLabel"
				autocomplete="off"
				spellcheck="false"
				:placeholder="placeholder"
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

		<template v-if="!lookup">
			<div v-if="crossChain" class="chips" role="group" aria-label="Network" :data-testid="TESTIDS.sendNetworkChips">
				<button
					v-for="chip in chips"
					:key="chip.key"
					type="button"
					class="chip ul-notch"
					:aria-pressed="network === chip.key"
					:data-chain="chip.key"
					:data-testid="TESTIDS.sendNetworkChip"
					@click="network = chip.key"
				>
					{{ chip.label }}
				</button>
			</div>

			<StateNotice
				v-if="refused.length > 0"
				tone="lost"
				icon="square-alert"
				:title="`This wallet is a smart contract, so it can’t send from ${refusedLine}.`"
				action="Change wallet"
				:action-testid="TESTIDS.sendChangeWallet"
				:data-testid="TESTIDS.sendContractWallet"
				@act="emit('change-wallet')"
			>
				Connect a regular wallet account to send from {{ refused.length === 1 ? "that network" : "those networks" }}.
			</StateNotice>

			<TokenList
				:tokens="view.rows"
				:selected="selected"
				:loading="loading"
				:balances="rowBalances"
				:looks="view.looks"
				:empty="view.rows.length === 0"
				@select="emit('select', $event)"
			/>
			<p v-if="crossChain && onlyLine" class="only" :data-testid="TESTIDS.sendSourceOnly">{{ onlyLine }}</p>
		</template>
	</section>
</template>

<style scoped>
.step {
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.from {
	margin: 0;
	font: 700 13px/1.3 var(--ul-font-body);
	color: var(--ul-ink);
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

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}

.chip {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	min-height: 32px;
	padding: 0 10px;
	font: 600 13px/1 var(--ul-font-body);
	color: var(--ul-ink);
	cursor: pointer;
}

.chip[aria-pressed="true"] {
	--ul-fill: var(--ul-ink);
	font-weight: 700;
	color: var(--ul-bg);
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

.only {
	margin: 0;
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.err {
	margin: 0;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-lost);
}

@media (max-width: 760px) {
	.step {
		gap: 12px;
	}

	.search {
		padding: 0 12px;
	}

	.chip {
		min-height: 36px;
	}
}
</style>
