<script setup lang="ts">
/** Utils */
import type { IconName } from "@unleashed/design"
import { computed } from "vue"
import type { CrossChainNotice } from "@/composables/useCrossChainSend"
import { chainLabel } from "@/lib/chains"
import { NETWORK } from "@/lib/network"
import { TESTIDS } from "@/lib/testids"
import { safeSentence } from "@/lib/token-display"

/** Components */
import StateNotice from "./StateNotice.vue"

/**
 * Why a cross-chain send cannot go on right now, in a box with the one action that helps. The amount step shows the
 * quote's states; the review shows these in place of Sign and send, plus what signing itself found.
 */
export type CrossChainState =
	| CrossChainNotice
	| { kind: "expired" }
	/** The wallet answers as another account than the one the route was priced for. */
	| { kind: "account"; priced: string }
	/** The account holds contract code on the source chain. */
	| { kind: "contract" }
	/** Whether the account holds contract code there could not be read. */
	| { kind: "unchecked" }

const props = defineProps<{
	state: CrossChainState
	srcChainId: number
	/** "500.00 USDC": what the send takes, for the no-route line. */
	sendText: string
}>()
const emit = defineEmits<{ act: [] }>()

interface Box {
	tone: "attention" | "lost"
	icon: IconName
	title: string
	action?: string
	actionTestid?: string
	actionIcon?: IconName
}

const RETRY = { action: "Try again", actionTestid: TESTIDS.sendXcRetry }
const NEW_QUOTE = { action: "Get a new quote", actionTestid: TESTIDS.sendXcRetry }

const source = computed(() => chainLabel(props.srcChainId))

const box = computed<Box>(() => {
	const s = props.state
	switch (s.kind) {
		case "no-route":
			return { tone: "attention", icon: "warning-diamond", title: "No route for this amount right now.", ...RETRY }
		case "refused":
			return {
				tone: "lost",
				icon: "square-alert",
				title: "This route doesn’t match what we built, so we won’t ask you to sign.",
				...NEW_QUOTE,
			}
		case "expired":
			return {
				tone: "attention",
				icon: "hourglass",
				title: "This quote expired.",
				action: "Refresh quote",
				actionTestid: TESTIDS.sendXcRefresh,
				actionIcon: "reload",
			}
		case "venue":
			return { tone: "attention", icon: "warning-diamond", title: "Gas can’t be priced right now.", ...RETRY }
		case "unavailable":
			return { tone: "attention", icon: "warning-diamond", title: "This network can’t be routed from here yet." }
		case "failed":
			return { tone: "attention", icon: "warning-diamond", title: "The route can’t be priced right now.", ...RETRY }
		case "account":
			return { tone: "attention", icon: "wallet", title: "Your wallet switched accounts.", ...NEW_QUOTE }
		case "contract":
			return {
				tone: "lost",
				icon: "square-alert",
				title: `This wallet is a smart contract, so it can’t send from ${source.value}.`,
				action: "Change wallet",
				actionTestid: TESTIDS.sendXcChangeWallet,
			}
		case "unchecked":
			return {
				tone: "attention",
				icon: "square-alert",
				title: `Your wallet’s account on ${source.value} could not be checked.`,
				...RETRY,
			}
	}
})
</script>

<template>
	<StateNotice
		:tone="box.tone"
		:icon="box.icon"
		:title="box.title"
		:action="box.action"
		:action-testid="box.actionTestid"
		:action-icon="box.actionIcon"
		:data-testid="TESTIDS.sendXcNotice"
		:data-notice="state.kind"
		@act="emit('act')"
	>
		<template v-if="state.kind === 'no-route'">
			LI.FI found no way to bring {{ sendText }} from {{ source }} to Aztec. Routes change often.
		</template>
		<template v-else-if="state.kind === 'refused'">
			<template v-if="state.field">Field that differs: <span class="mono">{{ state.field }}</span>. </template>Nothing was signed and
			nothing moved.
		</template>
		<template v-else-if="state.kind === 'expired'">Fees and amounts may have moved since it was made.</template>
		<template v-else-if="state.kind === 'venue'">
			The gas swap on {{ chainLabel(NETWORK.l1ChainId) }} could not be read. Nothing was signed.
		</template>
		<template v-else-if="state.kind === 'unavailable'">Sending from {{ source }} is not available in this build.</template>
		<template v-else-if="state.kind === 'failed'">{{ safeSentence(state.message) }} Nothing was signed.</template>
		<template v-else-if="state.kind === 'account'">
			This route was priced for <span class="mono">{{ state.priced }}</span>. Nothing was signed and nothing moved.
		</template>
		<template v-else-if="state.kind === 'contract'">Connect a regular wallet account to send from those networks.</template>
		<template v-else>Nothing was signed and nothing moved.</template>
	</StateNotice>
</template>

<style scoped>
.mono {
	font-family: var(--ul-font-mono);
}
</style>
