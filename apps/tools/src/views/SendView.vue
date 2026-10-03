<script setup lang="ts">
/** Components */
import SendWizard from "@/components/send/SendWizard.vue"

/** Utils */
import { IS_PLACEHOLDER } from "@/contracts/bridge-generation"
import { TESTIDS } from "@/lib/testids"

/**
 * `IS_PLACEHOLDER` is per-NETWORK, not per-build: a manifest with no bridge block means this network
 * has no generation to send through yet. The wizard is a child component precisely so that state
 * never instantiates its composables — nothing wires the journal engine to a bridge that isn't there.
 * The wallet chips and the journal live in the shell; this view is the wizard.
 */
</script>

<template>
	<div class="send-view" :data-testid="TESTIDS.sendView">
		<section v-if="IS_PLACEHOLDER" class="placeholder ul-notch" :data-testid="TESTIDS.sendUnavailable">
			<p class="placeholder-title">Bridging is being upgraded</p>
			<p class="sub">Back with the next generation on this network. The faucet keeps working meanwhile.</p>
		</section>
		<SendWizard v-else />
	</div>
</template>

<style scoped>
.send-view {
	display: flex;
	flex-direction: column;
	gap: 28px;
	width: 100%;
	max-width: 900px;
}

.placeholder {
	--ul-fill: var(--ul-well);
	--ul-notch: var(--ul-notch-4);
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 24px;
}

.placeholder-title {
	margin: 0;
	font: 700 16px/1.4 var(--ul-font-body);
	color: var(--ul-ink);
}

.sub {
	max-width: 62ch;
	margin: 0;
	font: 400 15px/1.55 var(--ul-font-body);
	color: var(--ul-ink-2);
}
</style>
