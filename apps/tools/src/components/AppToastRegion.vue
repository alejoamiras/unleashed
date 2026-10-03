<script setup lang="ts">
import { useToast } from "@/composables/useToast"
import { TESTIDS } from "@/lib/testids"
import { Toast } from "@unleashed/design"

const { toasts, dismiss } = useToast()
</script>

<template>
	<div class="toast-region" aria-live="polite">
		<TransitionGroup name="toast">
			<Toast
				v-for="t in toasts"
				:key="t.id"
				:kind="t.kind"
				:lead="t.lead"
				:text="t.text"
				:link="t.link"
				:ttl-ms="t.ttlMs"
				:data-testid="TESTIDS.toast"
				@dismiss="dismiss(t.id)"
			/>
		</TransitionGroup>
	</div>
</template>

<style scoped>
/* Bottom left, on the page content's edge (36px is the body's gutter): the header's chips and
   Restore sit top right, and the dock fills the right column. */
.toast-region {
	position: fixed;
	bottom: 24px;
	left: calc(var(--shell-rail, 0px) + 36px);
	display: flex;
	flex-direction: column;
	gap: 12px;
	z-index: 1000;
	max-width: calc(100% - 48px);
}

/* A phone has no rail: toasts span the screen at its foot. */
@media (max-width: 760px) {
	.toast-region {
		right: 16px;
		bottom: 16px;
		left: 16px;
		max-width: none;
	}
}
</style>
