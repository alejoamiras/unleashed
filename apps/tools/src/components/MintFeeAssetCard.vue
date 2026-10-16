<script setup lang="ts">
import { Card, DripButton, Icon, Tag } from "@unleashed/design"
import { computed, ref, useId } from "vue"
import { type FeeAssetMint, formatWhole, useFeeAssetMint } from "@/composables/useFeeAssetMint"
import { useL1Wallet } from "@/composables/useL1Wallet"
import { NETWORK } from "@/lib/network"
import { TESTIDS } from "@/lib/testids"

/**
 * The Drip tab's Ethereum faucet for AZTEC. The tab's header carries only the Aztec wallet, so the
 * card connects and switches the Ethereum wallet itself; its one button does whichever comes next.
 */
const l1 = useL1Wallet()
const feeAsset = useFeeAssetMint()
const headingId = useId()
const minted = ref<FeeAssetMint | null>(null)

type Action = "connect" | "switch" | "mint"

const action = computed<Action>(() => {
	if (!l1.isConnected.value) return "connect"
	return l1.wrongChain.value ? "switch" : "mint"
})

const label = computed(() => {
	if (action.value === "connect") return "Connect Ethereum wallet"
	if (action.value === "switch") return `Switch to ${NETWORK.viemChain.name}`
	return feeAsset.amountText.value ? `+${feeAsset.amountText.value} AZTEC` : "Mint AZTEC"
})

const loading = computed(() => feeAsset.minting.value || l1.isConnecting.value)

const error = computed(() => (action.value === "mint" ? feeAsset.error.value : l1.error.value))

const success = computed(() => {
	if (!minted.value || error.value) return null
	const amount = minted.value.amount
	return amount === null ? "Minted." : `Minted ${formatWhole(amount)} AZTEC.`
})

async function onClick(): Promise<void> {
	if (action.value === "connect") return l1.connect()
	if (action.value === "switch") return l1.switchL1Network()
	minted.value = null
	minted.value = await feeAsset.mint()
}
</script>

<template>
	<Card v-if="feeAsset.available" :data-testid="TESTIDS.dripFeeAssetCard" :aria-labelledby="headingId">
		<header class="head">
			<h2 :id="headingId" class="title">AZTEC on Ethereum</h2>
			<Tag tone="testnet">Testnet</Tag>
		</header>
		<p class="sub">
			Free test AZTEC on {{ NETWORK.viemChain.name }}. On Send, pick AZTEC, then Gas: it arrives as Fee Juice, one for one.
		</p>
		<DripButton
			variant="primary"
			:icon="action === 'mint' ? 'download' : 'wallet'"
			:label="label"
			:loading="loading"
			:data-testid="TESTIDS.dripFeeAssetMint"
			:data-action="action"
			@click="onClick"
		/>
		<p class="status" aria-live="polite" :data-testid="TESTIDS.dripFeeAssetStatus" :data-error="error ? 'true' : undefined">
			<template v-if="error">{{ error }}</template>
			<template v-else-if="success"><Icon name="check" :size="12" class="ok" />{{ success }} Bridge it on Send.</template>
		</p>
	</Card>
</template>

<style scoped>
.head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px 12px;
}

.title {
	font: 700 26px/1.15 var(--ul-font-body);
	letter-spacing: var(--ul-tracking-heading);
	color: var(--ul-ink);
}

.sub {
	max-width: 56ch;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.status {
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 1.45em;
	margin: 0;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.status:empty {
	display: none;
}

.status[data-error] {
	color: var(--ul-lost);
}

.ok {
	color: var(--ul-carrier);
}
</style>
