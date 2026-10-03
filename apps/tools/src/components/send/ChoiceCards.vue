<script setup lang="ts">
/** Utils */
import { Icon } from "@unleashed/design"
import { computed, useTemplateRef } from "vue"
import { PHONE_QUERY, useMediaQuery } from "@/composables/useMediaQuery"
import { type ChoiceHint, GAS_BLOCK_REASON, type GasBlock, hintOf, type SendIntent } from "@/lib/send-model"
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
	/** Transactions the token + gas slice is sized for, for its phone hint. */
	txTarget: number
	/** The gas breakdown's element id: on a phone the selected gas row's hint opens and closes it. */
	breakdownId?: string
	breakdownOpen?: boolean
	/** An error or a cap note holds the breakdown open, so its hint cannot close it. */
	breakdownHeld?: boolean
}>()
const emit = defineEmits<{ "update:intent": [intent: SendIntent]; "toggle-gas": [] }>()

interface Choice {
	key: SendIntent
	testid: string
	label: string
	desc: string
}

const ID_SLUG: Record<SendIntent, string> = { token: "token", "token+gas": "token-gas", gas: "gas" }
const HEADING_ID = "send-choices-heading"

const phone = useMediaQuery(PHONE_QUERY)

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

function hint(choice: Choice): ChoiceHint {
	return hintOf(choice.key, {
		exit: props.exitOnly,
		txTarget: props.txTarget,
		gasBlock: props.gasBlock,
		tokenBlocked: Boolean(props.tokenReason),
	})
}

/** Only the selected gas row has a breakdown to open, and only on a phone does it start closed; a
 *  blocked row has no plan behind it, so it keeps its plain hint. */
function discloses(choice: Choice): boolean {
	return phone.value && Boolean(props.breakdownId) && choice.key === props.intent && choice.key !== "token" && enabled(choice)
}

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
			<!-- The hint button is the radio's sibling, never its child: a radio's content is presentational. -->
			<div v-for="(choice, index) in choices" :key="choice.key" class="row" role="none" :data-discloses="discloses(choice) || undefined">
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
					<span class="hint">{{ hint(choice).lead }}<span v-if="hint(choice).count !== undefined" class="n">{{ hint(choice).count }}</span>{{ hint(choice).tail }}</span>
				</button>
				<button
					v-if="discloses(choice)"
					type="button"
					class="disclosure"
					:aria-expanded="breakdownOpen ? 'true' : 'false'"
					:aria-disabled="breakdownHeld ? 'true' : undefined"
					:aria-controls="breakdownId"
					:data-testid="TESTIDS.sendGasDisclosure"
					@click="emit('toggle-gas')"
				>
					<span>{{ hint(choice).lead }}<span v-if="hint(choice).count !== undefined" class="n">{{ hint(choice).count }}</span>{{ hint(choice).tail }}</span>
					<Icon name="chevron" :size="12" :rotate="breakdownOpen ? 180 : 0" />
					<span class="sr-only">, gas breakdown</span>
				</button>
			</div>
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

/* Two cells: the radio spans both, and the hint button, when there is one, lies over the second. */
.row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
}

.cell {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	grid-area: 1 / 1 / 2 / 3;
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

.cell[data-selected] .desc,
.cell[data-selected] .hint,
.disclosure {
	color: var(--ul-line);
}

.cell[aria-disabled="true"] .desc,
.cell[aria-disabled="true"] .hint {
	color: var(--ul-ink-3);
}

.hint {
	display: none;
}

.n {
	font-family: var(--ul-font-mono);
}

.disclosure {
	grid-area: 1 / 2;
	z-index: 1;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 0 12px 0 8px;
	font: 400 12.5px/1.3 var(--ul-font-body);
	white-space: nowrap;
	cursor: pointer;
}

@media (min-width: 761px) {
	.heading {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
}

@media (max-width: 760px) {
	.heading {
		font: 700 13px/1.3 var(--ul-font-body);
		color: var(--ul-ink);
	}

	.segment {
		grid-auto-flow: row;
		gap: 4px;
	}

	.cell {
		align-items: center;
		min-height: 40px;
		padding: 0 12px;
	}

	.box {
		width: 16px;
		height: 16px;
		margin-top: 0;
	}

	.text {
		flex: 1;
	}

	.desc {
		display: none;
	}

	.hint {
		display: block;
		flex: none;
		font: 400 12.5px/1.3 var(--ul-font-body);
		color: var(--ul-ink-2);
	}

	.row[data-discloses] .hint {
		display: none;
	}
}
</style>
