<script setup lang="ts">
/** Utils */
import { Icon, type IconName } from "@unleashed/design"

/**
 * A boxed state in the send flow: a tinted box, its glyph, a bold line in the tone's colour, a body and at most one
 * action. `lost` is a refusal and is announced at once; `attention` waits for the reader.
 */
const props = defineProps<{
	tone: "attention" | "lost"
	icon: IconName
	title: string
	action?: string
	actionTestid?: string
	/** A glyph before the action's words. */
	actionIcon?: IconName
}>()
const emit = defineEmits<{ act: [] }>()
</script>

<template>
	<div class="notice ul-notch" :role="props.tone === 'lost' ? 'alert' : 'status'" :data-tone="tone">
		<span class="glyph"><Icon :name="icon" :size="24" /></span>
		<span class="body">
			<strong class="title">{{ title }}</strong>
			<span v-if="$slots.default"><slot /></span>
			<button v-if="action" type="button" class="action ul-notch" :data-testid="actionTestid" @click="emit('act')">
				<Icon v-if="actionIcon" :name="actionIcon" :size="12" />{{ action }}
			</button>
		</span>
	</div>
</template>

<style scoped>
.notice {
	--ul-fill: var(--ul-attention-bg);
	--ul-notch: var(--ul-notch-2);
	--tone: var(--ul-attention);
	display: flex;
	align-items: flex-start;
	gap: 12px;
	padding: 12px 14px;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink);
}

.notice[data-tone="lost"] {
	--ul-fill: var(--ul-lost-bg);
	--tone: var(--ul-lost);
}

.glyph {
	display: flex;
	flex: none;
	margin-top: 1px;
	color: var(--tone);
}

.body {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
}

.title {
	font-weight: 700;
	color: var(--tone);
}

.action {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	align-self: flex-start;
	display: inline-flex;
	align-items: center;
	gap: 8px;
	min-height: 36px;
	margin-top: 4px;
	padding: 0 12px;
	font: 600 14px/1 var(--ul-font-body);
	color: var(--ul-ink);
	cursor: pointer;
}
</style>
