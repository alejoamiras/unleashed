<script setup lang="ts">
/** Utils */
import { Icon } from "@unleashed/design"
import { computed, ref } from "vue"
import { FEE_JUICE, SWAP } from "@/contracts/bridge-generation"
import { etherscanAddressUrl } from "@/lib/explorer"
import { trimAddress } from "@/lib/format"
import type { ExitPlan, SendPlan } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import { checksumAddress, safeDisplay } from "@/lib/token-display"

/**
 * What the factory answered for this token's portal: the derived address (`verified`), no clone yet
 * (`absent`), a clone at some OTHER address (`mismatch`), or a read that did not come back
 * (`unknown`). Absent and unknown are not interchangeable — only one of them means "this send
 * creates it".
 */
export type PortalState = "verified" | "absent" | "unknown" | "mismatch"

const props = defineProps<{
	plan: SendPlan | ExitPlan
	portalVerified: PortalState
	account: string
	signatureValiditySeconds: number
	slippageBps: number | null
}>()

// Collapsed by design: this panel is the ONE place the wizard names mechanism, and a reader who
// never opens it must still be able to act on the five lines above.
const open = ref(false)

const NATIVE = "0x0000000000000000000000000000000000000000"

/** A pool currency in the user's words: the token they chose, ETH (native or wrapped), Fee Juice. */
function currencyLabel(address: string): string {
	const lower = address.toLowerCase()
	if (lower === props.plan.token.address.toLowerCase()) return safeDisplay(props.plan.token.symbol)
	if (lower === NATIVE || lower === SWAP?.weth.toLowerCase()) return "ETH"
	if (lower === FEE_JUICE.asset.toLowerCase()) return "Fee Juice"
	return trimAddress(checksumAddress(address))
}

/** The currencies the swap walks through, in order: each pool is entered on one side and left on the other. */
function routeHops(route: { path: readonly { currency0: string; currency1: string }[]; zeroForOnes: readonly boolean[] }): string[] {
	const first = route.path[0]
	if (!first) return []
	const entry = route.zeroForOnes[0] ? first.currency0 : first.currency1
	const exits = route.path.map((pool, i) => (route.zeroForOnes[i] ? pool.currency1 : pool.currency0))
	return [entry, ...exits].map(currencyLabel)
}

const routeText = computed(() => {
	if (props.plan.direction === "l2-to-l1") return "Direct: the hub burns your tokens, the portal releases them on Ethereum."
	const route = props.plan.gas?.route
	const pools = route?.path.length ?? 0
	if (!route || pools === 0) return "Direct: no swap, the whole amount is bridged."
	const hops = routeHops(route)
	return `${hops.join(" → ")} on Uniswap v4 (${pools} ${pools === 1 ? "pool" : "pools"}), then the gas leg is bridged.`
})

const slippageText = computed(() => (props.slippageBps === null ? "—" : `${(props.slippageBps / 100).toFixed(2)}%`))

/** A token-only deposit swaps nothing, so it has no route and no slippage to show; a gas leg has
 *  both, and an exit keeps the route line for what a burn-and-release is. */
const buysGas = computed(() => props.plan.direction === "l1-to-l2" && props.plan.gas !== undefined)
const showsRoute = computed(() => props.plan.direction === "l2-to-l1" || buysGas.value)

/** The rows the panel holds, named in its summary — all but the portal, which the summary never names. */
const hint = computed(() =>
	["Token", showsRoute.value && "route", buysGas.value && "slippage", "account", "signature"].filter(Boolean).join(", "),
)

/** The clone the money leaves through — the derived address, and what the factory said about it. */
const portalAddress = computed(() => checksumAddress(props.plan.token.portal))

const portalState = computed(() => {
	const registered = props.plan.token.state.kind === "registered"
	if (props.portalVerified === "absent") return "created by this send"
	if (props.portalVerified === "unknown") return "not readable right now — this send still uses it"
	if (props.portalVerified === "mismatch") return "the factory holds a different address for this token. Do not send until you know why."
	return registered ? "verified" : "verified — this send also registers the token on Aztec"
})

/** In FULL, never trimmed: this is the one line that says which contract the money leaves for, and a
 *  middle-elided address is exactly what an address-lookalike attack survives. */
const tokenAddress = computed(() => checksumAddress(props.plan.token.address))

const validityText = computed(() => {
	const seconds = props.signatureValiditySeconds
	if (seconds < 60) return `${seconds}s`
	return `${Math.round(seconds / 60)} min`
})
</script>

<template>
	<div class="details ul-notch" :data-open="open || undefined">
		<button type="button" class="toggle" :aria-expanded="open" :data-testid="TESTIDS.sendReviewDetailsToggle" @click="open = !open">
			<Icon name="chevron" :size="12" color="secondary" :rotate="open ? 0 : -90" />
			<span>Details</span>
			<span class="hint">{{ hint }}</span>
		</button>
		<dl v-if="open" class="panel" :data-testid="TESTIDS.sendReviewDetails">
			<div class="row" :data-testid="TESTIDS.sendReviewToken">
				<dt>Token</dt>
				<dd class="full">
					<a :href="etherscanAddressUrl(tokenAddress)" target="_blank" rel="noopener noreferrer" :data-testid="TESTIDS.sendReviewTokenLink">
						{{ tokenAddress }}
					</a>
				</dd>
			</div>
			<div v-if="showsRoute" class="row" :data-testid="TESTIDS.sendReviewRoute">
				<dt>Route</dt>
				<dd>{{ routeText }}</dd>
			</div>
			<div v-if="buysGas" class="row" :data-testid="TESTIDS.sendReviewSlippage">
				<dt>Slippage</dt>
				<dd>{{ slippageText }}</dd>
			</div>
			<div class="row" :data-testid="TESTIDS.sendReviewPortal" :data-portal="portalVerified">
				<dt>Portal</dt>
				<dd class="full">
					<a :href="etherscanAddressUrl(portalAddress)" target="_blank" rel="noopener noreferrer" :data-testid="TESTIDS.sendReviewPortalLink">
						{{ portalAddress }}
					</a>
					<span class="state">· {{ portalState }}</span>
				</dd>
			</div>
			<div class="row" :data-testid="TESTIDS.sendReviewAccount">
				<dt>Account</dt>
				<dd :title="account">{{ trimAddress(account) }}</dd>
			</div>
			<div class="row" :data-testid="TESTIDS.sendReviewSignature">
				<dt>Signature</dt>
				<dd>Valid for {{ validityText }}</dd>
			</div>
		</dl>
	</div>
</template>

<style scoped>
.details {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	flex-direction: column;
}

.toggle {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	min-height: 44px;
	padding: 0 14px;
	color: var(--ul-ink);
	font: 700 14px/1.2 var(--ul-font-body);
	text-align: left;
	cursor: pointer;
}

.toggle:focus-visible {
	outline-offset: -2px;
}

.toggle:hover {
	color: var(--ul-accent-text);
}

.hint {
	margin-left: auto;
	font: 400 13px/1.2 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.panel {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin: 0;
	padding: 4px 14px 14px;
}

.row {
	display: grid;
	grid-template-columns: 104px minmax(0, 1fr);
	column-gap: 16px;
	align-items: baseline;
}

dt {
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-3);
}

dd {
	margin: 0;
	min-width: 0;
	font: 400 13px/1.45 var(--ul-font-mono);
	color: var(--ul-ink);
}

/* An address is only useful whole: wrap it rather than clip it. */
.full {
	overflow-wrap: anywhere;
}

.full a {
	color: var(--ul-ink);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.full a:hover {
	color: var(--ul-accent-text);
}

.state {
	color: var(--ul-ink-2);
}

.row[data-portal="mismatch"] dd {
	color: var(--ul-attention);
}

@media (max-width: 760px) {
	.hint {
		display: none;
	}
}
</style>
