<script setup lang="ts">
import { AddressDisplay, Button, Icon } from "@unleashed/design"
import { useL1Wallet } from "@/composables/useL1Wallet"
import { NETWORK } from "@/lib/network"
import { TESTIDS } from "@/lib/testids"

const { address, isConnected, wrongChain, isConnecting, connect, disconnect, switchL1Network } = useL1Wallet()
</script>

<template>
	<section class="l1-chip" :data-testid="TESTIDS.l1Status" :data-connected="isConnected">
		<div v-if="isConnected && address" class="chip ul-notch">
			<span class="dot" aria-hidden="true" />
			<span class="identity">
				<span class="label">Ethereum</span>
				<AddressDisplay :address="address ?? ''" :data-testid="TESTIDS.l1Account" />
			</span>
			<button v-if="wrongChain" class="wrong-chain ul-notch" type="button" :data-testid="TESTIDS.l1SwitchChain" @click="switchL1Network">
				<Icon name="warning-diamond" :size="12" />
				Switch to {{ NETWORK.viemChain.name }}
			</button>
			<button class="disconnect" type="button" aria-label="Disconnect Ethereum wallet" title="Disconnect" :data-testid="TESTIDS.l1Disconnect" @click="disconnect">
				<Icon name="close" :size="12" />
			</button>
		</div>

		<Button v-else class="connect" size="large" variant="secondary" :loading="isConnecting" :disabled="isConnecting" :data-testid="TESTIDS.l1Connect" @click="connect">
			Connect Ethereum
		</Button>
	</section>
</template>

<style scoped>
.l1-chip {
	display: inline-flex;
}

.chip {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	gap: 12px;
	min-height: 48px;
	padding: 0 6px 0 14px;
}

/* Carrier means connected, whichever chain. */
.dot {
	flex: none;
	width: 8px;
	height: 8px;
	background: var(--ul-carrier);
}

.identity {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 1px;
}

.label {
	font: 400 12px/1 var(--ul-font-body);
	color: var(--ul-ink-caption);
}

/* One fill per chip: the address keeps its copy-on-click, not its own box. */
.chip :deep(.address),
.chip :deep(.address:hover) {
	--ul-fill: transparent;
	padding: 0;
	font-size: 14px;
}

.wrong-chain {
	--ul-fill: var(--ul-attention-bg);
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	gap: 6px;
	min-height: 28px;
	padding: 0 10px;
	font: 700 13px/1 var(--ul-font-body);
	color: var(--ul-attention);
	cursor: pointer;
}

.disconnect {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	color: var(--ul-ink-3);
	cursor: pointer;
}

.disconnect:hover {
	color: var(--ul-lost);
}

/* One 44px row: the label pushes the address right, and a wrong chain drops its switch to a second
   line inside the chip. The × keeps its 32px target, so the right inset shrinks to match the
   Aztec chip's glyph. */
@media (max-width: 760px) {
	.l1-chip {
		display: flex;
	}

	.chip {
		flex: 1;
		flex-wrap: wrap;
		gap: 8px 12px;
		min-height: 44px;
		padding: 6px 2px 6px 14px;
	}

	.identity {
		flex: 1;
		flex-direction: row;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.label {
		flex: 1;
		font-size: 13px;
	}

	.wrong-chain {
		order: 1;
		flex-basis: 100%;
		margin-right: 12px;
	}

	.connect {
		width: 100%;
	}
}
</style>
