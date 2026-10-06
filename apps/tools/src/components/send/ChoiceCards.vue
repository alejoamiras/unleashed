<script setup lang="ts">
/** Utils */
import { Icon } from "@unleashed/design"
import { computed, useTemplateRef } from "vue"
import { GAS_BLOCK_REASON, type GasBlock, type SendIntent } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"

const props = defineProps<{
	intent: SendIntent
	/** An exit has one outcome: the token goes back to Ethereum. */
	exitOnly: boolean
	/** The token IS the gas asset, so its gas leg needs no swap. */
	feeAsset: boolean
	/** Why neither gas choice can be taken; null = they can. */
	gasBlock: GasBlock | null
	/** Why the token alone cannot be chosen (the account holds no gas to claim it with); null = it can. */
	tokenReason?: string | null
}>()
const emit = defineEmits<{ "update:intent": [intent: SendIntent] }>()

interface Choice {
	key: SendIntent
	testid: string
	label: string
	desc: string
}

const ID_SLUG: Record<SendIntent, string> = { token: "token", "token+gas": "token-gas", gas: "gas" }
const HEADING_ID = "send-choices-heading"

/** A card is named by its label alone and described by its caption, or by the reason it is blocked:
 *  a name taken from its whole content would say the reason twice. One choice group exists at a time. */
function idOf(choice: Choice, part: "label" | "desc"): string {
	return `send-choice-${ID_SLUG[choice.key]}-${part}`
}

/** The reason a choice is greyed out, or null when it can be taken. */
function reasonOf(choice: Choice): string | null {
	if (choice.key === "token") return props.tokenReason ?? null
	return props.gasBlock ? GAS_BLOCK_REASON[props.gasBlock] : null
}

const choices = computed<Choice[]>(() => {
	const token: Choice = {
		key: "token",
		testid: TESTIDS.sendChoiceToken,
		label: "Token",
		desc: props.exitOnly ? "Your tokens go back to your Ethereum wallet." : "Only the token arrives.",
	}
	if (props.exitOnly) return [token]
	const oneForOne = props.feeAsset ? " One for one." : ""
	return [
		token,
		{ key: "token+gas", testid: TESTIDS.sendChoiceTokenGas, label: "Token + gas", desc: `Part of it arrives as gas.${oneForOne}` },
		{ key: "gas", testid: TESTIDS.sendChoiceGas, label: "Gas", desc: `All of it arrives as gas.${oneForOne}` },
	]
})

function enabled(choice: Choice): boolean {
	return reasonOf(choice) === null
}

const cards = useTemplateRef<HTMLElement>("cards")

function choose(choice: Choice): void {
	if (enabled(choice)) emit("update:intent", choice.key)
}

// In a radio group focus and selection move together, and a disabled choice cannot be selected, so
// the arrow keys step over it.
function move(from: number, delta: number): void {
	const list = choices.value
	const count = list.length
	for (let step = 1; step <= count; step++) {
		const index = (((from + delta * step) % count) + count) % count
		const choice = list[index]
		if (choice && enabled(choice)) {
			cards.value?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus()
			emit("update:intent", choice.key)
			return
		}
	}
}
</script>

<template>
	<div class="choices">
		<span :id="HEADING_ID" class="heading">What arrives</span>
		<!-- aria-disabled, not disabled: a blocked choice that is still the selected one stays the group's tab stop. -->
		<div ref="cards" class="segment" role="radiogroup" :aria-labelledby="HEADING_ID" :data-testid="TESTIDS.sendChoiceCards" :data-count="choices.length">
			<template v-for="(choice, index) in choices" :key="choice.key">
				<button
					type="button"
					role="radio"
					class="cell ul-notch"
					:data-testid="choice.testid"
					:data-index="index"
					:data-selected="choice.key === intent || undefined"
					:aria-checked="choice.key === intent"
					:aria-disabled="enabled(choice) ? undefined : 'true'"
					:aria-labelledby="idOf(choice, 'label')"
					:aria-describedby="idOf(choice, 'desc')"
					:tabindex="choice.key === intent ? 0 : -1"
					@click="choose(choice)"
					@keydown.left.prevent="move(index, -1)"
					@keydown.up.prevent="move(index, -1)"
					@keydown.right.prevent="move(index, 1)"
					@keydown.down.prevent="move(index, 1)"
					@keydown.enter.prevent="choose(choice)"
					@keydown.space.prevent="choose(choice)"
				>
					<span class="box" aria-hidden="true"><Icon v-if="choice.key === intent" name="check" :size="12" /></span>
					<span class="text">
						<span :id="idOf(choice, 'label')" class="label">{{ choice.label }}</span>
						<span :id="idOf(choice, 'desc')" class="desc">{{ reasonOf(choice) ?? choice.desc }}</span>
					</span>
				</button>
			</template>
		</div>
	</div>
</template>

<style scoped>
.choices {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.segment {
	display: grid;
	grid-auto-flow: column;
	grid-auto-columns: minmax(0, 1fr);
	gap: 6px;
}

.cell {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: flex-start;
	gap: 12px;
	padding: 14px 16px;
	color: var(--ul-ink);
	text-align: left;
	cursor: pointer;
}

.cell:hover:not([aria-disabled="true"]) {
	--ul-fill: var(--ul-line);
}

/* Reverse video marks the choice; its caption steps down to the line tone, which reads on ink in both themes. */
.cell[data-selected],
.cell[data-selected]:hover:not([aria-disabled="true"]) {
	--ul-fill: var(--ul-ink);
	color: var(--ul-bg);
}

.cell[aria-disabled="true"] {
	--ul-fill: var(--ul-panel);
	color: var(--ul-ink-3);
	cursor: not-allowed;
}

.cell[aria-disabled="true"]::before {
	box-shadow: inset 0 0 0 2px var(--ul-raised);
}

.box {
	display: grid;
	place-items: center;
	flex: none;
	width: 18px;
	height: 18px;
	margin-top: 1px;
	box-shadow: inset 0 0 0 2px var(--ul-ink-3);
}

.cell[data-selected] .box {
	background: var(--ul-bg);
	box-shadow: none;
	color: var(--ul-ink);
}

.cell[aria-disabled="true"] .box {
	box-shadow: inset 0 0 0 2px var(--ul-line);
}

.text {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
}

.label {
	font: 700 15px/1.2 var(--ul-font-body);
}

.desc {
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.cell[data-selected] .desc {
	color: var(--ul-line);
}

.cell[aria-disabled="true"] .desc {
	color: var(--ul-ink-3);
}

.heading {
	position: absolute;
	width: 1px;
	height: 1px;
	margin: -1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
}

/* The same cards, stacked: the narrow board keeps each card's label and caption. */
@media (max-width: 760px) {
	.segment {
		grid-auto-flow: row;
	}
}
</style>
