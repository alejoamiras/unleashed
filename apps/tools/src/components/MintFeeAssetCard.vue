<script setup lang="ts">
import { Card, DisclaimerTag, DripButton } from "@unleashed/design"
import { computed, ref, useId, watch } from "vue"
import DripStatus from "@/components/DripStatus.vue"
import { type FeeAssetMint, formatWhole, useFeeAssetMint } from "@/composables/useFeeAssetMint"
import { useL1Wallet } from "@/composables/useL1Wallet"
import { useToast } from "@/composables/useToast"
import { useNow } from "@/lib/clock"
import { etherscanTxUrl } from "@/lib/explorer"
import { NETWORK } from "@/lib/network"
import { formatClock } from "@/lib/phase-clock"
import { TESTIDS } from "@/lib/testids"

/**
 * The Drip tab's Ethereum faucet for AZTEC. The tab's header carries only the Aztec wallet, so the
 * card connects and switches the Ethereum wallet itself; its one button does whichever comes next.
 */
const l1 = useL1Wallet()
const feeAsset = useFeeAssetMint()
const { push, dismiss } = useToast()
const headingId = useId()
const now = useNow()
const minted = ref<FeeAssetMint | null>(null)
/** Set once a mint from another surface starts: this card's last outcome is no longer the latest. */
const superseded = ref(false)
/** When this card's own mint started; the shared lock means no other mint runs beside it. */
let ownRun: number | null = null
let lastToastId: number | null = null

/** A mint in flight dismisses the last success toast, so its link is not live beside it. */
function dropLastToast(): void {
	if (lastToastId !== null) dismiss(lastToastId)
	lastToastId = null
}

watch(feeAsset.startedAt, (started) => {
	if (started === null || started === ownRun) return
	superseded.value = true
	minted.value = null
	dropLastToast()
})

type Action = "connect" | "switch" | "mint"

const action = computed<Action>(() => {
	if (!l1.isConnected.value) return "connect"
	return l1.wrongChain.value ? "switch" : "mint"
})

const label = computed(() => {
	if (action.value === "connect") return "Connect Ethereum wallet"
	if (action.value === "switch") return `Switch to ${NETWORK.viemChain.name}`
	return "Get AZTEC"
})

const ariaLabel = computed(() =>
	action.value === "mint" && feeAsset.amountText.value ? `Get ${feeAsset.amountText.value} AZTEC into your Ethereum wallet` : undefined,
)

const loading = computed(() => feeAsset.minting.value || l1.isConnecting.value)

const error = computed(() => {
	if (action.value !== "mint") return l1.error.value
	return superseded.value ? null : feeAsset.error.value
})

const statusKind = computed(() => {
	if (feeAsset.minting.value) return "dripping"
	if (error.value) return "error"
	return minted.value ? "ok" : null
})

const sentText = computed(() => (minted.value?.amount ? `${formatWhole(minted.value.amount)} AZTEC` : "AZTEC"))

const elapsed = computed(() => formatClock(now.value - (feeAsset.startedAt.value ?? now.value)))

async function mint(): Promise<void> {
	dropLastToast()
	superseded.value = false
	minted.value = null
	// `mint` claims the lock before its first await, so `startedAt` already names this run.
	const pending = feeAsset.mint()
	ownRun = feeAsset.startedAt.value
	const result = await pending
	minted.value = result
	if (result) {
		const href = etherscanTxUrl(result.txHash)
		lastToastId = push({
			kind: "ok",
			text: `Dripped ${sentText.value} to your Ethereum wallet`,
			link: href ? { label: "View tx", href } : undefined,
		})
	} else if (feeAsset.error.value) {
		push({ kind: "error", text: feeAsset.error.value })
	}
}

function onClick(): Promise<void> {
	if (action.value === "connect") return l1.connect()
	if (action.value === "switch") return l1.switchL1Network()
	return mint()
}
</script>

<template>
	<Card v-if="feeAsset.available" :data-testid="TESTIDS.dripFeeAssetCard" :aria-labelledby="headingId">
		<header class="head">
			<h2 :id="headingId" class="symbol">AZTEC</h2>
			<DisclaimerTag />
		</header>
		<p class="sub">
			Fixed drip<template v-if="feeAsset.amountText.value">: <strong class="drip-amount">{{ feeAsset.amountText.value }} AZTEC</strong></template>
			on {{ NETWORK.viemChain.name }}
		</p>
		<DripButton
			variant="primary"
			:icon="action === 'mint' ? undefined : 'wallet'"
			:label="label"
			:aria-label="ariaLabel"
			:loading="loading"
			:data-testid="TESTIDS.dripFeeAssetMint"
			:data-action="action"
			@click="onClick"
		/>
		<DripStatus
			v-if="statusKind"
			:data-testid="TESTIDS.dripFeeAssetStatus"
			:kind="statusKind"
			emphasized
			:label="statusKind === 'dripping' ? 'Submitting…' : (error ?? undefined)"
			:elapsed="elapsed"
			progress-label="AZTEC drip progress"
			log="waiting for your Ethereum wallet, then the block"
			:tx-url="minted ? etherscanTxUrl(minted.txHash) : undefined"
		>
			Sent <strong class="sent">{{ sentText }}</strong> to your Ethereum wallet
		</DripStatus>
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

.symbol {
	font: 700 26px/1.15 var(--ul-font-body);
	letter-spacing: var(--ul-tracking-heading);
	color: var(--ul-ink);
}

.sub {
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.drip-amount,
.sent {
	font: 700 14px/1 var(--ul-font-mono);
	color: var(--ul-ink);
	white-space: nowrap;
}
</style>
