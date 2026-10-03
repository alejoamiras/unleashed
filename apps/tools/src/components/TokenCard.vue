<script setup lang="ts">
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { computed, onBeforeUnmount, ref, useId } from "vue"
import { type DripTarget, useDrip } from "@/composables/useDrip"
import { useAddDripToken } from "@/composables/useAddDripToken"
import { useTokenBalance, type UseTokenBalanceHandle } from "@/composables/useTokenBalance"
import { useToast } from "@/composables/useToast"
import type { DripToken } from "@/constants/tokens"
import { useNow } from "@/lib/clock"
import { explorerTxUrl } from "@/lib/explorer"
import { formatBigInt } from "@/lib/format"
import { formatClock } from "@/lib/phase-clock"
import { TESTIDS } from "@/lib/testids"
import { walletLabel } from "@/lib/wallet-name"
import { BalanceRow, Button, Card, DisclaimerTag, DripButton, Icon, ProgressBar } from "@unleashed/design"

const props = defineProps<{
	token: DripToken
	tokenAddress: AztecAddress
	wallet?: Wallet
	account?: AztecAddress
	/** The connected wallet's remembered name, as claimed; rendered only through `walletLabel`. */
	walletName?: string | null
}>()

// The card is always visible. Composables only activate when both wallet
// and account are present - keys the parent component on connection
// state so the card re-mounts cleanly on connect/disconnect.
const connected = !!(props.wallet && props.account)
const balance: UseTokenBalanceHandle | null =
	connected && props.wallet && props.account ? useTokenBalance(props.wallet, props.tokenAddress, props.account) : null
const drip = connected && props.wallet && props.account ? useDrip(props.wallet, props.account) : null
const addToken = useAddDripToken()
const { push, dismiss } = useToast()
const headingId = useId()

// Hidden once the wallet reports this token registered (fail-open: failures show the button).
const registered = ref(false)
if (connected && props.wallet && props.account) {
	void addToken.isRegistered(props.wallet, props.tokenAddress).then((r) => {
		registered.value = r
	})
}

// Balance display strings. The presentational BalanceRow takes formatted text
// + testids; this card owns the bigint formatting + loading state.
const balanceLoading = computed(() => balance?.loading.value ?? false)
function renderBalance(value: bigint | null): string {
	if (value === null) return balanceLoading.value ? "…" : "-"
	return formatBigInt(value, props.token.decimals)
}
const publicText = computed(() => renderBalance(balance?.publicBalance.value ?? null))
const privateText = computed(() => renderBalance(balance?.privateBalance.value ?? null))

// Per-card "last drip" - single source of recency. Without this, a
// global-keyed lookup like `publicLast ?? privateLast` permanently
// prefers public over private and shows the wrong outcome after a
// later private drip.
interface CardDripState {
	readonly target: DripTarget
	readonly kind: "txHash" | "error"
	readonly value: string
	readonly txUrl: string
	readonly at: number
}
const lastDrip = ref<CardDripState | null>(null)
const emphasized = ref(false)
// The card pushes a toast with a "View tx" link on every successful drip.
// We track its id so that if the user re-drips before the toast TTL, we
// dismiss the prior toast - otherwise its (now-stale) link is still
// clickable during the new inflight state. Closes the toast-path mirror
// of the inline-row stale-link bug.
let lastTxToastId: number | null = null

const publicDripping = computed(() => (drip ? drip.isActive(props.token.symbol, "public") : false))
const privateDripping = computed(() => (drip ? drip.isActive(props.token.symbol, "private") : false))
const dripping = computed(() => publicDripping.value || privateDripping.value)
const buttonsDisabled = computed(() => !connected || (drip?.inflight.value ?? null) !== null)
/** The other card's symbol while its drip holds the one global lock; this card's own drip is not a lock reason. */
const lockedBy = computed(() => {
	const running = drip?.inflight.value
	return running && running.tokenSymbol !== props.token.symbol ? running.tokenSymbol : null
})
const lockReasonId = useId()

const statusKind = computed<"idle" | "dripping" | "ok" | "error">(() => {
	if (dripping.value) return "dripping"
	const last = lastDrip.value
	if (!last) return "idle"
	return last.kind === "txHash" ? "ok" : "error"
})

const statusEmphasized = computed(() => emphasized.value && statusKind.value !== "idle")

const now = useNow()
const elapsed = computed(() => formatClock(now.value - (drip?.inflight.value?.startedAt ?? now.value)))

const statusLabel = computed(() => {
	switch (statusKind.value) {
		case "dripping":
			return privateDripping.value ? "Proving private…" : "Submitting…"
		case "error":
			return lastDrip.value?.value ?? "Failed"
		default:
			return ""
	}
})

async function handleDrip(target: DripTarget) {
	if (!drip || !balance) return
	// Dismiss any still-visible toast from a prior drip so its (now-stale)
	// "View tx" link doesn't sit clickable during this new inflight cycle.
	if (lastTxToastId !== null) {
		dismiss(lastTxToastId)
		lastTxToastId = null
	}
	const result = await drip.drip(props.token, props.tokenAddress, target)
	const txUrl = result.kind === "txHash" ? explorerTxUrl(result.value) : ""
	lastDrip.value = {
		target,
		kind: result.kind,
		value: result.value,
		txUrl,
		at: Date.now(),
	}
	emphasized.value = true

	if (result.kind === "txHash") {
		lastTxToastId = push({
			kind: "ok",
			text: `Dripped ${props.token.displayAmount} ${props.token.symbol} to ${target}`,
			link: txUrl ? { label: "View tx", href: txUrl } : undefined,
		})
		await balance.refresh()
	} else {
		push({ kind: "error", text: result.value })
	}
}

// Single tracked reset timer. Without this, rapid clicks (button only
// disabled during `submitting`) stack untracked setTimeouts - an older
// timer can fire DURING a newer submission and flip the composable back
// to `idle`, defeating the re-entrancy guard in `useAddDripToken`.
// Track + clear before re-setting.
let addTokenResetTimer: ReturnType<typeof setTimeout> | null = null
function scheduleAddTokenReset() {
	if (addTokenResetTimer !== null) clearTimeout(addTokenResetTimer)
	addTokenResetTimer = setTimeout(() => {
		addTokenResetTimer = null
		addToken.reset()
	}, 3_000)
}

async function handleAddToWallet() {
	if (!props.wallet || !props.account) return
	// Cancel any pending reset from a prior cycle so a stale timer can't
	// flip status back to `idle` mid-submission.
	if (addTokenResetTimer !== null) {
		clearTimeout(addTokenResetTimer)
		addTokenResetTimer = null
	}
	await addToken.addToken(props.wallet, props.account.toString(), props.tokenAddress)
	const final = addToken.status.value
	if (final.kind === "ok") {
		registered.value = true
		push({ kind: "ok", text: `${props.token.symbol} added to your wallet.` })
	} else if (final.kind === "error") {
		push({ kind: "error", text: final.error.message })
	} else if (final.kind === "unsupported") {
		push({
			kind: "error",
			text: `Your wallet doesn't support adding tokens. Update ${walletLabel(props.walletName ?? null)} and reload.`,
		})
	}
	// `rejected` is silent: a cancel is not a failure, so no toast.

	scheduleAddTokenReset()
}

onBeforeUnmount(() => {
	if (addTokenResetTimer !== null) {
		clearTimeout(addTokenResetTimer)
		addTokenResetTimer = null
	}
	balance?.dispose()
})
</script>

<template>
	<Card
		:data-testid="TESTIDS.tokenCard"
		:data-symbol="token.symbol"
		:data-connected="connected || undefined"
		:aria-labelledby="headingId"
	>
		<header class="head">
			<h2 :id="headingId" class="symbol">{{ token.symbol }}</h2>
			<DisclaimerTag />
		</header>
		<p class="sub">Fixed drip: <strong class="drip-amount">{{ token.displayAmount }} {{ token.symbol }}</strong></p>
		<BalanceRow
			:public-text="publicText"
			:private-text="privateText"
			:public-test-id="TESTIDS.balancePublic"
			:private-test-id="TESTIDS.balancePrivate"
		/>
		<div class="drips">
			<DripButton
				variant="primary"
				icon="eye-off"
				:loading="privateDripping"
				:disabled="buttonsDisabled && !privateDripping"
				:label="`Get ${token.symbol} (private)`"
				:aria-label="`Get ${token.displayAmount} ${token.symbol} into your private balance`"
				:aria-describedby="lockedBy ? lockReasonId : undefined"
				:data-testid="TESTIDS.btnDripPrivate"
				@click="handleDrip('private')"
			/>
			<DripButton
				icon="eye"
				:loading="publicDripping"
				:disabled="buttonsDisabled && !publicDripping"
				:label="`Get ${token.symbol} (public)`"
				:aria-label="`Get ${token.displayAmount} ${token.symbol} into your public balance`"
				:aria-describedby="lockedBy ? lockReasonId : undefined"
				:data-testid="TESTIDS.btnDripPublic"
				@click="handleDrip('public')"
			/>
		</div>
		<p v-if="lockedBy" :id="lockReasonId" class="lock-reason" :data-testid="TESTIDS.dripLockReason">
			One drip at a time: the {{ lockedBy }} drip is still running.
		</p>
		<div v-if="connected && !registered" class="add-to-wallet">
			<Button
				size="small"
				variant="quiet"
				class="add-to-wallet-btn"
				:loading="addToken.status.value.kind === 'submitting'"
				:disabled="addToken.status.value.kind === 'submitting'"
				:data-testid="TESTIDS.btnAddToWallet"
				:data-add-status="addToken.status.value.kind"
				:aria-label="`Add ${token.symbol} to your wallet`"
				@click="handleAddToWallet"
			>
				<template v-if="addToken.status.value.kind === 'submitting'">Adding</template>
				<template v-else-if="addToken.status.value.kind === 'ok'"><Icon name="check" :size="12" />Added</template>
				<template v-else><Icon name="plus" :size="12" />Add {{ token.symbol }} to wallet</template>
			</Button>
		</div>
		<p v-if="!connected" class="hint bottom">Connect a wallet to drip.</p>
		<div
			v-else-if="statusKind !== 'idle'"
			class="status-row bottom ul-notch"
			role="status"
			:data-testid="TESTIDS.dripStatus"
			:data-drip-status="statusKind"
			:data-emphasized="statusEmphasized || undefined"
		>
			<template v-if="statusKind === 'ok' && lastDrip">
				<Icon name="check" :size="12" class="ok-mark" />
				<span class="status-text">Sent <strong class="sent">{{ token.displayAmount }} {{ token.symbol }}</strong> to {{ lastDrip.target }}</span>
				<a v-if="lastDrip.txUrl" class="status-link" :href="lastDrip.txUrl" target="_blank" rel="noopener noreferrer">View tx<Icon name="external-link" :size="12" /></a>
			</template>
			<template v-else-if="statusKind === 'dripping'">
				<div class="panel-head">
					<strong>{{ statusLabel }}</strong>
					<!-- Hidden so the status region is not re-announced every second. -->
					<span class="clock" aria-hidden="true">{{ elapsed }}</span>
				</div>
				<ProgressBar :label="`${token.symbol} drip progress`" />
				<span class="log">waiting for your wallet to prove and send<span class="cursor" aria-hidden="true">_</span></span>
			</template>
			<span v-else class="status-text">{{ statusLabel }}</span>
		</div>
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

.drip-amount {
	font: 700 14px/1 var(--ul-font-mono);
	color: var(--ul-ink);
}

/* The card stretches to its grid row, so pinning the last child lines both cards' status up. */
.bottom {
	margin-top: auto;
}

.drips {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.lock-reason {
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.add-to-wallet {
	display: flex;
}

/* Scoped, so it outranks the Button module's small padding and gap. */
.add-to-wallet-btn {
	padding: 0 4px;
	gap: 8px;
}

.add-to-wallet-btn[data-add-status="ok"] {
	color: var(--ul-carrier);
}

.hint {
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-3);
}

/* The fill carries the outcome while it is fresh: carrier for a drip that landed, lost for one that
   failed; a drip in flight sits in the well. */
.status-row {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 14px;
	font: 400 14px/1.35 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.status-row[data-drip-status="dripping"] {
	--ul-fill: var(--ul-field);
	flex-direction: column;
	align-items: stretch;
	gap: 8px;
	color: var(--ul-ink);
}

.panel-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
}

.clock,
.log {
	font: 400 12.5px/1.4 var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.cursor {
	color: var(--ul-accent-text);
}

.status-row[data-drip-status="ok"][data-emphasized] {
	--ul-fill: var(--ul-carrier-bg);
	color: var(--ul-ink);
}

.status-row[data-drip-status="error"][data-emphasized] {
	--ul-fill: var(--ul-lost-bg);
	color: var(--ul-lost);
}

.status-text {
	flex-grow: 1;
}

.ok-mark {
	color: var(--ul-carrier);
}

.sent {
	font: 700 14px/1 var(--ul-font-mono);
	white-space: nowrap;
}

.status-link {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	flex: none;
	font: 700 14px/1 var(--ul-font-body);
	color: var(--ul-accent-text);
	text-decoration: none;
	white-space: nowrap;
}

.status-link:hover {
	text-decoration: underline;
	text-underline-offset: 4px;
}
</style>
