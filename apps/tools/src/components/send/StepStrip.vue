<script setup lang="ts">
/** Utils */
import { Icon } from "@unleashed/design"
import { useTemplateRef } from "vue"
import { TESTIDS } from "@/lib/testids"

export interface Step {
	key: string
	label: string
	/** What the user chose on this step; the vertical rail shows it under a done step's label, the phone strip only
	 *  names it to assistive tech. */
	value?: string
	/** One line under the label; the vertical rail shows it, the horizontal strip has no room. */
	hint?: string
}

const props = withDefaults(
	defineProps<{
		steps: readonly Step[]
		active: number
		/** The furthest step the user may open: the steps before it are done, it and those before it are
		 *  reachable, and everything past it is locked. Reachable is not done: a step the user can open
		 *  but has not passed stays todo. */
		completed: number
		/** Vertical stacks the steps down a rail and moves with ↑/↓ as well as ←/→. */
		orientation?: "horizontal" | "vertical"
	}>(),
	{ orientation: "horizontal" },
)
const emit = defineEmits<{ select: [index: number] }>()

const strip = useTemplateRef<HTMLElement>("strip")

function reachable(index: number): boolean {
	return index <= props.completed
}

function stateOf(index: number): "active" | "done" | "todo" {
	if (index === props.active) return "active"
	return index < props.completed ? "done" : "todo"
}

function doneValue(step: Step, index: number): string | undefined {
	return stateOf(index) === "done" ? step.value || undefined : undefined
}

/** The step keeps its name for assistive tech even where the strip shows only the chosen value. */
function nameOf(step: Step, index: number): string {
	const value = doneValue(step, index)
	return value ? `${step.label}: ${value}` : step.label
}

function choose(index: number): void {
	if (reachable(index)) emit("select", index)
}

// Focus follows the arrow keys across every step (a locked one is still readable), but only a
// reachable step selects — arrowing onto a step the wizard has not unlocked must not jump the user
// ahead of the data the later steps depend on.
function move(from: number, delta: number): void {
	const count = props.steps.length
	if (count === 0) return
	const next = (from + delta + count) % count
	strip.value?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus()
	choose(next)
}
</script>

<template>
	<div
		ref="strip"
		class="strip"
		:class="orientation"
		role="tablist"
		aria-label="Send steps"
		:aria-orientation="orientation"
		:data-testid="TESTIDS.sendStepStrip"
	>
		<template v-for="(step, index) in steps" :key="step.key">
			<span v-if="index > 0 && orientation === 'horizontal'" class="rule" aria-hidden="true" :data-reached="reachable(index) || undefined" />
			<button
				type="button"
				role="tab"
				class="step ul-notch"
				:data-testid="TESTIDS.sendStep"
				:data-step="step.key"
				:data-index="index"
				:data-state="stateOf(index)"
				:data-valued="doneValue(step, index) ? '' : undefined"
				:aria-label="nameOf(step, index)"
				:aria-selected="index === active"
				:aria-disabled="reachable(index) ? undefined : 'true'"
				:tabindex="index === active ? 0 : -1"
				@click="choose(index)"
				@keydown.left.prevent="move(index, -1)"
				@keydown.right.prevent="move(index, 1)"
				@keydown.up.prevent="orientation === 'vertical' && move(index, -1)"
				@keydown.down.prevent="orientation === 'vertical' && move(index, 1)"
				@keydown.enter.prevent="choose(index)"
				@keydown.space.prevent="choose(index)"
			>
				<span class="marker ul-notch" aria-hidden="true">
					<Icon v-if="stateOf(index) === 'done'" name="check" :size="12" />
					<template v-else>{{ index + 1 }}</template>
				</span>
				<template v-if="orientation === 'vertical' && doneValue(step, index)">
					<span class="caption">{{ step.label }}</span>
					<span class="value">{{ doneValue(step, index) }}</span>
				</template>
				<span v-else class="label">{{ step.label }}</span>
				<span v-if="orientation === 'vertical' && step.hint && stateOf(index) !== 'done'" class="hint" aria-hidden="true">{{
					step.hint
				}}</span>
			</button>
		</template>
	</div>
</template>

<style scoped>
.strip {
	display: flex;
	align-items: center;
	gap: 4px;
}

/* Segments sit side by side; a rule between them would be a hairline. */
.rule {
	display: none;
}

.step {
	--ul-fill: transparent;
	--ul-notch: var(--ul-notch-2);
	display: flex;
	flex: 1;
	align-items: center;
	justify-content: center;
	gap: 8px;
	min-height: 36px;
	padding: 0 8px;
	color: var(--ul-ink-2);
	font: 700 13px/1.2 var(--ul-font-body);
	cursor: pointer;
}

.step[aria-disabled="true"] {
	cursor: default;
}

.step[data-state="done"] {
	--ul-fill: var(--ul-raised);
	color: var(--ul-ink);
}

.step[data-state="active"] {
	--ul-fill: var(--ul-signal-tint);
	color: var(--ul-ink);
}

.marker {
	--ul-fill: transparent;
	--ul-notch: var(--ul-notch-2);
	display: flex;
	flex: none;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	font: 800 12px/1 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.marker::before {
	box-shadow: inset 0 0 0 2px var(--ul-line);
}

.step[data-state="done"] .marker {
	--ul-fill: var(--ul-carrier-bg);
	color: var(--ul-carrier);
}

.step[data-state="active"] .marker {
	--ul-fill: var(--ul-signal);
	color: var(--ul-on-signal);
}

.step[data-state="done"] .marker::before,
.step[data-state="active"] .marker::before {
	box-shadow: none;
}

/* A todo marker is an outlined square: the notch would cut its inset line at the corners. */
.step[data-state="todo"] .marker {
	--ul-notch: none;
}

.label,
.value {
	white-space: nowrap;
}

.caption {
	font: 400 12px/1.2 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.value {
	font: 700 13px/1.2 var(--ul-font-mono);
	overflow: hidden;
	text-overflow: ellipsis;
}

/* The phone strip: three equal cells, left-aligned, each named by its label; the tab's aria-label carries the
   chosen value. */
.horizontal .step {
	justify-content: flex-start;
	min-width: 0;
}

.horizontal .step[data-state="done"] {
	--ul-fill: transparent;
	color: var(--ul-ink-2);
}

.horizontal .marker {
	font-size: 11px;
}

.horizontal .label {
	overflow: hidden;
	text-overflow: ellipsis;
}

/* The rail: one step per row, marker beside the label, the hint under it. */
.vertical {
	flex-direction: column;
	align-items: stretch;
	gap: 6px;
	padding: 6px 10px 20px 14px;
}

.vertical .step {
	display: grid;
	flex: none;
	grid-template-columns: 28px minmax(0, 1fr);
	gap: 2px 10px;
	align-items: start;
	justify-content: stretch;
	padding: 8px;
	text-align: left;
}

.vertical .step:focus-visible {
	outline-offset: -2px;
}

.vertical .marker {
	grid-row: span 2;
	width: 28px;
	height: 28px;
	font-size: 13px;
}

.vertical .label {
	font-size: 15px;
	overflow: hidden;
	text-overflow: ellipsis;
}

/* A done value names the source chain too ("USDC on Base Sepolia"), which the rail's width cannot hold on one line. */
.vertical .value {
	white-space: normal;
	overflow-wrap: anywhere;
}

.caption,
.value,
.label,
.hint {
	grid-column: 2;
}

.hint {
	font: 400 13px/1.35 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.step[data-state="active"] .hint {
	color: var(--ul-ink);
}
</style>
