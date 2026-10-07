<script setup lang="ts">
/** Services */
import type { CrossChainDepositRecord } from "@unleashed/bridge-core"
import { Icon } from "@unleashed/design"
import { computed, ref, watch } from "vue"

/** Composables */
import { leftoverAllowance, revokeLeftover } from "@/composables/leftover-approval"

/** Utils */
import { chainLabel } from "@/lib/chains"
import { crossChainAsset } from "@/lib/crosschain-activity"
import { userMessage } from "@/lib/errors"
import { formatAmount } from "@/lib/format"
import { TESTIDS } from "@/lib/testids"
import { isUserRejection } from "@/lib/wallet-errors"

/** A failed send's leftover approval, shown only while the LI.FI Diamond can still spend from the wallet. */
const props = defineProps<{ record: CrossChainDepositRecord }>()
/** After every read: whether the approval can still be spent. */
const emit = defineEmits<{ read: [open: boolean] }>()

const allowance = ref(0n)
const revoking = ref(false)
const error = ref<string | null>(null)

async function refresh(): Promise<void> {
	try {
		allowance.value = await leftoverAllowance(props.record)
	} catch {
		// An unread allowance offers nothing: a revoke shown on a guess could be a wasted prompt.
		allowance.value = 0n
	}
	emit("read", allowance.value > 0n)
}
watch(() => props.record.id, refresh, { immediate: true })

const source = computed(() => chainLabel(props.record.route.srcChainId))
const spendable = computed(() => {
	const asset = crossChainAsset(props.record)
	return `${formatAmount(allowance.value, asset.decimals)} ${asset.symbol}`
})

async function onRevoke(): Promise<void> {
	if (revoking.value) return
	revoking.value = true
	error.value = null
	try {
		await revokeLeftover(props.record)
		await refresh()
	} catch (e) {
		if (!isUserRejection(e)) error.value = userMessage(e, "The revoke didn't go through. Try again.")
	} finally {
		revoking.value = false
	}
}
</script>

<template>
	<div v-if="allowance > 0n" class="leftover">
		<div class="notice ul-notch" role="status">
			<span class="glyph"><Icon name="warning-diamond" :size="24" /></span>
			<span class="body">
				<strong class="title"
					>LI.FI’s contract can still spend <span class="mono">{{ spendable }}</span> from your wallet on {{ source }}.</strong
				>
				<span>The send failed after you approved it. Revoke the approval so nothing can use it later.</span>
				<button
					type="button"
					class="action ul-notch"
					:disabled="revoking"
					:aria-busy="revoking || undefined"
					:data-testid="TESTIDS.journalXcRevoke"
					@click="onRevoke"
				>
					Revoke on {{ source }}
				</button>
			</span>
		</div>
		<p v-if="error" class="error" role="alert">{{ error }}</p>
	</div>
</template>

<style scoped>
.leftover {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.notice {
	--ul-fill: var(--ul-attention-bg);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: flex-start;
	gap: 12px;
	padding: 12px 14px;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink);
}

.glyph {
	display: flex;
	flex: none;
	margin-top: 1px;
	color: var(--ul-attention);
}

.body {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
}

.title {
	font-weight: 700;
	color: var(--ul-attention);
}

.mono {
	font-family: var(--ul-font-mono);
}

.action {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	align-self: flex-start;
	display: inline-flex;
	align-items: center;
	min-height: 36px;
	margin-top: 4px;
	padding: 0 12px;
	font: 600 14px/1 var(--ul-font-body);
	color: var(--ul-ink);
	cursor: pointer;
}

.action:disabled {
	color: var(--ul-disabled);
	cursor: default;
}

.error {
	margin: 0;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-lost);
}
</style>
