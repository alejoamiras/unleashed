<script setup lang="ts">
/** Utils */
import { chainLabel } from "@/lib/chains"
import { TESTIDS } from "@/lib/testids"

/** Components */
import StateNotice from "./StateNotice.vue"

/** The wallet sits on another chain than the one this send signs on; switching is the wallet's own prompt. */
defineProps<{ walletChainId: number; needChainId: number }>()
const emit = defineEmits<{ switch: [] }>()
</script>

<template>
	<StateNotice
		tone="attention"
		icon="wallet"
		:title="`Your wallet is on ${chainLabel(walletChainId)}.`"
		:action="`Switch to ${chainLabel(needChainId)}`"
		:action-testid="TESTIDS.sendWrongChainSwitch"
		:data-testid="TESTIDS.sendWrongChain"
		:data-need="needChainId"
		@act="emit('switch')"
	>
		This send starts on {{ chainLabel(needChainId) }}.
	</StateNotice>
</template>
