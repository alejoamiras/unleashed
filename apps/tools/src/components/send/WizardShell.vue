<script setup lang="ts">
import { type ComponentPublicInstance, computed, nextTick, ref, watch } from "vue"

/** Components */
import DirectionSegment from "./DirectionSegment.vue"
import StepStrip, { type Step } from "./StepStrip.vue"

/** Utils */
import { PHONE_QUERY, useMediaQuery } from "@/composables/useMediaQuery"
import type { Direction } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"

const props = defineProps<{
	direction: Direction
	step: 0 | 1 | 2
	completed: number
	/** False while a send is in flight: switching direction mid-flight would strand the plan on screen. */
	canSwitchDirection: boolean
	/** The chosen token and amount, shown on their steps once the user has moved past them. */
	tokenLabel?: string
	amountLabel?: string
}>()
const emit = defineEmits<{ "update:direction": [Direction]; goto: [number] }>()

const CAPTION = {
	token: "what are you sending?",
	amount: "how much, and what should arrive?",
	review: "check it, then sign.",
} as const

const HINT = {
	token: "what are you sending?",
	amount: "how much, what arrives",
	review: "check it, then sign",
} as const

const steps = computed<Step[]>(() => [
	{ key: "token", label: "Token", value: props.tokenLabel, hint: HINT.token },
	{ key: "amount", label: "Amount", value: props.amountLabel, hint: HINT.amount },
	{ key: "review", label: "Review", hint: HINT.review },
])

// A phone has no room for the rail's column: the steps become one row above the panel.
const phone = useMediaQuery(PHONE_QUERY)

const heading = ref<HTMLElement | null>(null)
const rail = ref<ComponentPublicInstance | null>(null)

const position = computed(() => `Step ${props.step + 1} of ${steps.value.length}`)
const current = computed(() => steps.value[props.step])
const caption = computed(() => {
	const key = (["token", "amount", "review"] as const)[props.step]
	return `${position.value}, ${current.value?.label}: ${CAPTION[key]}`
})

// A step swap replaces the whole panel, which would otherwise drop focus to <body> and make the
// keyboard user Tab back in from the top of the page. Not on mount: arriving is not a step change,
// and not while the user arrows along the step rail, whose tab keeps focus.
watch(
	() => props.step,
	async () => {
		await nextTick()
		const strip: unknown = rail.value?.$el
		if (strip instanceof HTMLElement && strip.contains(document.activeElement)) return
		heading.value?.focus()
	},
)
</script>

<template>
	<section class="wizard ul-notch">
		<div class="head">
			<DirectionSegment :direction="direction" :locked="!canSwitchDirection" @update:direction="emit('update:direction', $event)" />
			<span class="position" aria-hidden="true">{{ position }}</span>
		</div>

		<!-- The live caption carries the step's name and hint to assistive tech; sighted users read
		     them off the rail, so it stays out of the layout. -->
		<p class="sr-only" aria-live="polite" :data-testid="TESTIDS.sendStepAnnounce">{{ caption }}</p>

		<div class="body">
			<StepStrip
				ref="rail"
				class="rail"
				:steps="steps"
				:active="step"
				:completed="completed"
				:orientation="phone ? 'horizontal' : 'vertical'"
				@select="emit('goto', $event)"
			/>
			<div class="panel" :data-testid="TESTIDS.sendStepPanel">
				<h2 ref="heading" class="sr-only step-heading" tabindex="-1" :data-testid="TESTIDS.sendStepHeading">{{ current?.label }}</h2>
				<slot v-if="step === 0" name="token" />
				<slot v-else-if="step === 1" name="amount" />
				<slot v-else name="review" />
			</div>
		</div>
	</section>
</template>

<style scoped>
.wizard {
	--ul-fill: var(--ul-panel);
	--ul-notch: var(--ul-notch-4);
	width: 100%;
}

.head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	padding: 14px 20px 14px 14px;
}

.position {
	flex: none;
	font: 400 13px/1 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.body {
	display: grid;
	grid-template-columns: 168px minmax(0, 1fr);
}

.panel {
	padding: 6px 24px 24px 20px;
	min-width: 0;
}

.step-heading:focus {
	outline: none;
}

@media (max-width: 760px) {
	.head {
		flex-direction: column;
		align-items: stretch;
		gap: 10px;
		padding: 12px 12px 0;
	}

	/* Hidden, not removed: the live caption still announces the position. */
	.position {
		display: none;
	}

	.body {
		grid-template-columns: minmax(0, 1fr);
	}

	.rail {
		padding: 10px 12px 0;
	}

	.panel {
		padding: 16px 12px;
	}
}
</style>
