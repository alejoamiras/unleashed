<script setup lang="ts">
/** Components */
import ActivityDock from "./components/ActivityDock.vue"
import ActivityView from "./views/ActivityView.vue"
import AddressesView from "./views/AddressesView.vue"
import AppToastRegion from "./components/AppToastRegion.vue"
import AztecWalletPanel from "./components/AztecWalletPanel.vue"
import BridgeFooter from "./components/BridgeFooter.vue"
import ChooseAccountModal from "./components/ChooseAccountModal.vue"
import ConnectionErrorStrip from "./components/ConnectionErrorStrip.vue"
import DripView from "./views/DripView.vue"
import L1WalletPanel from "./components/L1WalletPanel.vue"
import RailNav from "./components/RailNav.vue"
import SectionHeader from "./components/SectionHeader.vue"
import SendView from "./views/SendView.vue"
import ThemeToggle from "./components/ThemeToggle.vue"
import WalletPickerModal from "./components/WalletPickerModal.vue"

/** Composables */
import { useActivityFeed } from "@/composables/useActivityFeed"
import { useCompletionToasts } from "@/composables/useCompletionToasts"
import { PHONE_QUERY, useMediaQuery } from "@/composables/useMediaQuery"
import { useShell } from "@/composables/useShell"

/** Utils */
import { computed } from "vue"
import { IS_PLACEHOLDER } from "@/contracts/bridge-generation"
import { TESTIDS } from "@/lib/testids"

const shell = useShell()
const section = shell.section
const bridgeForm = shell.bridgeForm

// The one place completion toasts come from, whichever section is visible. A network with no
// bridge generation instantiates none of the journal machinery, here or anywhere: the feed is
// built once and handed to the dock, and its absence is what keeps the dock out of the tree.
if (!IS_PLACEHOLDER) useCompletionToasts()
const feed = IS_PLACEHOLDER ? null : useActivityFeed()
const activityCount = computed(() => feed?.count.value ?? 0)
const phone = useMediaQuery(PHONE_QUERY)

/** States with a dedicated in-panel UI never go to the strip: capability denial has the red morph
 *  everywhere; no-wallet has the install CTA on the faucet only (the others have no CTA, so it shows here). */
const stripExclude = computed(() => (section.value === "drip" ? ["no-wallet", "capability-rejected"] : ["capability-rejected"]))

const HEADERS = {
	send: { title: "Bridge", subline: "Any ERC-20 · Ethereum ↔ Aztec · public or private · arrive with gas" },
	drip: { title: "Faucet", subline: "Alpha-testnet only · fixed amounts · permissionless dripper · no rate limit" },
	activity: { title: "Activity", subline: "Every bridge this browser started or restored, with its next step" },
	addresses: { title: "Addresses", subline: "Every contract this build talks to" },
} as const
const header = computed(() => HEADERS[section.value])

/** The 8×8 mark: dither resolving to a solid signal band in columns 6–7. public/favicon.svg draws the same grid. */
const MARK_INK =
	"M0 0h1v1h-1zM3 0h1v1h-1zM5 0h1v1h-1zM2 1h1v1h-1zM4 1h2v1h-2zM4 2h1v1h-1zM1 3h1v1h-1zM3 3h1v1h-1zM5 3h1v1h-1zM0 4h1v1h-1zM4 4h2v1h-2zM2 5h1v1h-1zM4 5h1v1h-1zM5 6h1v1h-1zM0 7h1v1h-1zM2 7h1v1h-1zM4 7h2v1h-2z"
</script>

<template>
	<div class="shell" :data-testid="TESTIDS.app" :data-section="section">
		<aside class="rail" aria-label="Unleashed">
			<button type="button" class="brand" aria-label="Unleashed home" :data-testid="TESTIDS.brandHome" @click="shell.goTo('send')">
				<svg class="mark" viewBox="0 0 8 8" width="16" height="16" shape-rendering="crispEdges" aria-hidden="true">
					<path :d="MARK_INK" fill="currentColor" />
					<path class="mark-signal" d="M6 0h2v8h-2z" />
				</svg>
				<span class="wordmark">Unleashed</span>
			</button>
			<RailNav :activity-count="activityCount" />
			<div class="rail-foot">
				<ThemeToggle />
			</div>
		</aside>

		<main class="main">
			<SectionHeader :title="header.title" :subline="header.subline">
				<template #wallets>
					<template v-if="section === 'drip'">
						<AztecWalletPanel variant="faucet" />
					</template>
					<template v-else>
						<L1WalletPanel />
						<AztecWalletPanel variant="bridge" />
					</template>
				</template>
			</SectionHeader>

			<div class="body">
				<!-- ONE strip for the shared session, above whichever view is active — the views stay
				     mounted (v-show), so per-view strips would render duplicate alerts/testids with
				     diverging dismissal state. -->
				<ConnectionErrorStrip class="strip-slot" :exclude="stripExclude" />

				<!-- v-show (not v-if): Send and Faucet keep their local state across switches; both read
				     the ONE wallet session singleton. Activity and Addresses have no local state of their own. -->
				<DripView v-show="section === 'drip'" />
				<SendView v-show="section === 'send'" />
				<ActivityView v-if="section === 'activity'" />
				<AddressesView v-if="section === 'addresses'" />
			</div>

			<div class="foot">
				<!-- SendView is v-shown, so its form flag outlives a switch to another section. -->
				<BridgeFooter v-if="section === 'send' && bridgeForm" />
			</div>
		</main>

		<!-- On Activity the page IS the dock, so it is unmounted there, not merely hidden. A phone has
		     no dock at all, whatever was persisted: the rail's count is its signal. -->
		<ActivityDock v-if="feed && section !== 'activity' && !phone" :feed="feed" />

		<AppToastRegion />
		<!-- ONE picker for the shared session — the panels only trigger connect(). -->
		<WalletPickerModal />
		<ChooseAccountModal />
	</div>
</template>

<style scoped>
/* `--shell-rail` also places the toast region beside the rail. */
.shell {
	--shell-rail: 200px;
	display: grid;
	grid-template-columns: var(--shell-rail) minmax(0, 1fr) auto;
	min-height: 100vh;
	color: var(--ul-ink);
}

/* Depth is a fill step: the rail sits in the well, the page on void. */
.rail {
	display: flex;
	flex-direction: column;
	padding: 18px 12px 20px;
	background: var(--ul-well);
}

.brand {
	display: flex;
	align-items: center;
	gap: 10px;
	height: 36px;
	margin-bottom: 14px;
	padding: 0 10px;
}

.mark {
	flex: none;
	width: 20px;
	height: 20px;
}

.mark-signal {
	fill: var(--ul-signal);
}

.wordmark {
	font: 400 12px/1 var(--ul-font-pixel);
}

.rail-foot {
	margin-top: auto;
	padding: 0 2px;
}

.main {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

.body {
	display: flex;
	flex-direction: column;
	gap: 24px;
	flex: 1;
	padding: 28px 36px 40px;
}

.strip-slot:empty {
	display: none;
}

.foot {
	padding: 0 36px;
}

@media (max-width: 760px) {
	.shell {
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: auto minmax(0, 1fr);
	}

	/* Two rows: brand and theme, then the tabs at full width. */
	.rail {
		flex-direction: row;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 12px;
		padding: 8px 16px;
		background: var(--ul-panel);
	}

	.brand {
		margin-bottom: 0;
		padding: 0;
	}

	.rail-foot {
		margin-top: 0;
		margin-left: auto;
	}

	.body {
		padding: 20px 16px 32px;
	}

	.foot {
		padding: 0 16px;
	}
}
</style>
