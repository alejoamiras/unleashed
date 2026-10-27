<script setup lang="ts">
import { computed, ref } from "vue"

/** Utils */
import type { Direction } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"

const props = defineProps<{
	direction: Direction
	/** True while a send is in flight: switching direction mid-flight would strand the plan on screen. */
	locked: boolean
	/** Replaces the send's testids. Buttons without an id here get none, so a second, locked copy
	 *  never answers the wizard's selectors. */
	testids?: { root: string; deposit?: string; exit?: string }
}>()
const emit = defineEmits<{ "update:direction": [Direction] }>()

const DIRECTIONS = [
	{ value: "l1-to-l2", label: "Into Aztec", key: "deposit" },
	{ value: "l2-to-l1", label: "Out to Ethereum", key: "exit" },
] as const

const SEND_TESTIDS = { root: TESTIDS.sendDirection, deposit: TESTIDS.sendDirectionDeposit, exit: TESTIDS.sendDirectionExit }
const ids = computed(() => props.testids ?? SEND_TESTIDS)

const segment = ref<HTMLElement | null>(null)

function pick(direction: Direction): void {
	if (props.locked || direction === props.direction) return
	emit("update:direction", direction)
}

/** Roving tablist: the segment is ONE Tab stop and ←/→ move both selection and focus, so the two
 *  directions never cost the keyboard user two stops between the header and the first field. */
function onArrow(delta: number): void {
	if (props.locked) return
	const index = DIRECTIONS.findIndex((d) => d.value === props.direction)
	const nextIndex = (index + delta + DIRECTIONS.length) % DIRECTIONS.length
	emit("update:direction", DIRECTIONS[nextIndex].value)
	segment.value?.querySelectorAll<HTMLElement>("[role='tab']")[nextIndex]?.focus()
}
</script>

<template>
	<div
		ref="segment"
		class="segment ul-notch"
		role="tablist"
		aria-label="Send direction"
		:data-testid="ids.root"
		:data-direction="direction"
		:data-locked="locked"
	>
		<button
			v-for="option in DIRECTIONS"
			:key="option.value"
			type="button"
			role="tab"
			class="seg ul-notch"
			:class="{ sel: direction === option.value }"
			:aria-selected="direction === option.value"
			:tabindex="direction === option.value ? 0 : -1"
			:disabled="locked"
			:data-testid="ids[option.key]"
			@click="pick(option.value)"
			@keydown.left.prevent="onArrow(-1)"
			@keydown.right.prevent="onArrow(1)"
		>
			{{ option.label }}
		</button>
	</div>
</template>

<style scoped>
.segment {
	--ul-fill: var(--ul-track);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	flex: 0 1 428px;
	gap: 4px;
	padding: 4px;
}

.seg {
	--ul-fill: transparent;
	--ul-notch: var(--ul-notch-2);
	flex: 1;
	min-height: 38px;
	padding: 0 12px;
	color: var(--ul-ink-2);
	font: 600 14px/1.2 var(--ul-font-body);
	text-align: left;
	cursor: pointer;
}

/* The track's 4px pad and gap fit a ring 1px off, not the global 3px. */
.seg:focus-visible {
	outline-offset: 1px;
}

.seg:hover:not(:disabled) {
	color: var(--ul-ink);
}

.seg.sel,
.seg.sel:hover:not(:disabled) {
	--ul-fill: var(--ul-ink);
	color: var(--ul-bg);
	font-weight: 700;
}

.seg:disabled {
	color: var(--ul-disabled);
	cursor: not-allowed;
}

/* A locked pick keeps reverse video; `.seg:disabled` would paint disabled text on the ink fill. */
.seg.sel:disabled {
	color: var(--ul-bg);
	cursor: not-allowed;
}

/* Full width in a column head: a 428px basis there would be a height. Each label stays one line. */
@media (max-width: 760px) {
	.segment {
		flex: none;
	}

	.seg {
		min-height: 36px;
		padding: 0 8px;
		white-space: nowrap;
	}
}

/* Below this a one-line label outgrows the in-flight stepper's padded locked row; with room it stays one line. */
@media (max-width: 363px) {
	.seg {
		white-space: normal;
	}
}
</style>
