<script setup lang="ts">
import { ref, toRef, useId } from "vue"
import Icon from "../core/Icon.vue"
import { useFocusTrap } from "./useFocusTrap"

/**
 * The modal shell: static scrim, notched panel, titled header with ×, body, right-aligned footer.
 * Backdrop, Escape and × all mean cancel; the shell never confirms anything. Focus follows
 * `useFocusTrap` (mark the initial target `data-autofocus`, else the panel takes it).
 */
const props = defineProps<{
	open: boolean
	title: string
	/** Id of an element in the body that describes the dialog. */
	describedby?: string
	overlayTestid?: string
	closeTestid?: string
}>()

const emit = defineEmits<{ cancel: [] }>()

defineSlots<{ default?: () => unknown; footer?: () => unknown }>()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()

useFocusTrap(panel, { enabled: toRef(() => props.open), onEscape: () => emit("cancel") })

// The press and the release must both land on the scrim: a text selection dragged out of the panel
// ends there too, and its click reaches the scrim as the common ancestor. Touch and pen capture the
// pointer to the pressed element, so the scrim releases that capture or every release would land on it.
let scrimGesture = false
function onScrimPointer(e: Event): void {
	const onScrim = e.target === e.currentTarget
	if (e.type !== "pointerdown") {
		scrimGesture = scrimGesture && onScrim
		return
	}
	scrimGesture = onScrim
	const scrim = e.currentTarget as Element
	const pointerId = (e as Partial<PointerEvent>).pointerId
	if (onScrim && pointerId !== undefined && scrim.hasPointerCapture?.(pointerId)) scrim.releasePointerCapture(pointerId)
}
function onScrimClick(e: Event): void {
	if (scrimGesture && e.target === e.currentTarget) emit("cancel")
	scrimGesture = false
}
</script>

<template>
	<Teleport to="body">
		<div
			v-if="open"
			class="overlay ul-scrim"
			:data-testid="overlayTestid"
			@pointerdown="onScrimPointer"
			@pointerup="onScrimPointer"
			@click="onScrimClick"
		>
			<div
				ref="panel"
				class="panel ul-notch"
				role="dialog"
				aria-modal="true"
				:aria-labelledby="titleId"
				:aria-describedby="describedby"
				tabindex="-1"
			>
				<header class="head">
					<h2 :id="titleId" class="title">{{ title }}</h2>
					<button type="button" class="close" aria-label="Close" :data-testid="closeTestid" @click="emit('cancel')">
						<Icon name="close" :size="24" />
					</button>
				</header>
				<slot />
				<footer v-if="$slots.footer" class="foot">
					<slot name="footer" />
				</footer>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.overlay {
	z-index: 100;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
}

/* Body content that scrolls does so in its own `min-height: 0` box: the notch fill cannot follow a
   scrolling host. */
.panel {
	--ul-fill: var(--ul-panel);
	--ul-notch: var(--ul-notch-6);
	display: flex;
	flex-direction: column;
	gap: 16px;
	width: 100%;
	max-width: 480px;
	max-height: 100%;
	padding: 24px;
	outline: none;
}

.head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.title {
	font: 700 20px/1.2 var(--ul-font-body);
	letter-spacing: var(--ul-tracking-heading);
	color: var(--ul-ink);
}

.close {
	display: inline-flex;
	flex: none;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	background: transparent;
	color: var(--ul-ink-2);
	cursor: pointer;
}

.close:hover {
	color: var(--ul-ink);
}

.foot {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: 12px;
}

@media (max-width: 760px) {
	.overlay {
		padding: 16px;
	}
}
</style>
