<script setup lang="ts">
import { computed } from "vue"
import { toGrid } from "@/lib/emoji"
import { TESTIDS } from "@/lib/testids"
import { Button, Dialog, EmojiGrid } from "@unleashed/design"

const props = defineProps<{ emojis: string | null }>()

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const cells = computed(() => (props.emojis ? toGrid(props.emojis) : []))
</script>

<template>
	<Dialog
		:open="!!emojis"
		title="Verify the grid"
		:overlay-testid="TESTIDS.verificationModal"
		:close-testid="TESTIDS.verificationClose"
		@cancel="emit('cancel')"
	>
		<p class="body">Match this grid with the wallet window. If it differs, stop.</p>
		<p class="secondary">This check is for the secure channel. It is not decorative.</p>
		<EmojiGrid :cells="cells" :test-id="TESTIDS.emojiGrid" :cell-test-id="TESTIDS.emojiCell" class="grid" />
		<template #footer>
			<Button variant="secondary" :data-testid="TESTIDS.btnVerifyCancel" @click="emit('cancel')">Cancel</Button>
			<Button variant="primary" :data-testid="TESTIDS.btnVerifyConfirm" @click="emit('confirm')">They match</Button>
		</template>
	</Dialog>
</template>

<style scoped>
.body {
	font: 400 15px/1.5 var(--ul-font-body);
	color: var(--ul-ink);
}

.secondary {
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.grid {
	align-self: center;
	margin: 8px 0;
}
</style>
