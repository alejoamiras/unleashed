<script setup lang="ts">
import { AddressDisplay, Button, Icon } from "@unleashed/design"
import { computed } from "vue"
import { useL1Wallet } from "@/composables/useL1Wallet"
import { appSources, sourceChainIds } from "@/composables/useSourceChain"
import { NETWORK } from "@/lib/network"
import { TESTIDS } from "@/lib/testids"
import { checksumAddress } from "@/lib/token-display"

const { address, chainId, isConnected, isConnecting, connect, disconnect, switchL1Network } = useL1Wallet()

/** One account signs on Ethereum and on every source chain, so the chip counts them all. */
const chains = new Set([NETWORK.l1ChainId, ...sourceChainIds(appSources())])
/** A source chain is a place a send starts, not a wrong chain: only a chain the app never signs on asks for the switch. */
const offChain = computed(() => isConnected.value && chainId.value !== null && !chains.has(chainId.value))
</script>

<template>
	<section class="l1-chip" :data-testid="TESTIDS.l1Status" :data-connected="isConnected">
		<div v-if="isConnected && address" class="chip ul-notch">
			<span class="dot" aria-hidden="true" />
			<span class="identity">
				<span class="label">Ethereum wallet<span v-if="chains.size > 1" class="networks" :data-testid="TESTIDS.l1Networks"> · {{ chains.size }} networks</span></span>
				<AddressDisplay :address="checksumAddress(address ?? '')" :data-testid="TESTIDS.l1Account" />
			</span>
			<button v-if="offChain" class="wrong-chain ul-notch" type="button" :data-testid="TESTIDS.l1SwitchChain" @click="switchL1Network">
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
	gap: 3px;
}

.label {
	font: 400 12px/1 var(--ul-font-body);
	color: var(--ul-ink-caption);
	white-space: nowrap;
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

/* Half the header row beside the Aztec chip, label over address; a wrong chain drops its switch to a
   second line inside the chip. The × keeps its 32px target, so the right inset shrinks to match the
   Aztec chip's glyph. */
@media (max-width: 760px) {
	.l1-chip {
		display: flex;
		flex: 1 1 140px;
	}

	.l1-chip[data-connected="true"] {
		min-width: 0;
	}

	.chip {
		flex: 1;
		flex-wrap: wrap;
		min-width: 0;
		gap: 8px 10px;
		min-height: 44px;
		padding: 6px 2px 6px 12px;
	}

	.identity {
		flex: 1;
		min-width: 0;
	}

	.networks {
		display: none;
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
