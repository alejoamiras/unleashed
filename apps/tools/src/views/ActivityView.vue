<script setup lang="ts">
/** Components */
import BridgeJournal from "@/components/BridgeJournal.vue"

/** Composables */
import { useBridgeJournal } from "@/composables/useBridgeJournal"
import { useShell } from "@/composables/useShell"

/** Utils */
import { Icon } from "@unleashed/design"
import { computed } from "vue"
import { IS_PLACEHOLDER } from "@/contracts/bridge-generation"
import { TESTIDS } from "@/lib/testids"

/**
 * Every bridge as its full card. On this section the wizard's stepper is off screen, so the list
 * reads ALL records, the foregrounded one included. A first visit gets the two verbs instead of an
 * empty box; the restore control stays the journal's own (its size cap and guards with it).
 */
const shell = useShell()
const journal = IS_PLACEHOLDER ? null : useBridgeJournal()
const firstVisit = computed(() => (journal?.listedRecords.value.length ?? 0) === 0)
</script>

<template>
	<div class="activity" :data-testid="TESTIDS.activityView">
		<section v-if="IS_PLACEHOLDER" class="placeholder ul-notch" :data-testid="TESTIDS.activityUnavailable">
			<p class="placeholder-title">Bridging is being upgraded</p>
			<p class="sub">Back with the next generation on this network. The faucet keeps working meanwhile.</p>
		</section>
		<BridgeJournal v-else source="all" title="Your bridges" :highlighted-id="shell.highlightedId.value">
			<template v-if="firstVisit" #empty>
				<div class="first" :data-testid="TESTIDS.activityFirstVisit">
					<span class="eb">First time here</span>
					<h2>Move any ERC-20 between Ethereum and Aztec, and arrive with gas to spend.</h2>
					<p class="lede">Public or private. A send you background or lose track of lands on this page, with its next step.</p>
					<div class="tiles">
						<button type="button" class="tile primary ul-notch" :data-testid="TESTIDS.activityTileSend" @click="shell.goTo('send')">
							<b>Bridge tokens</b><span>Ethereum ↔ Aztec · any ERC-20 · public or private</span><Icon class="go" name="arrow-right" :size="24" />
						</button>
						<button type="button" class="tile ul-notch" :data-testid="TESTIDS.activityTileDrip" @click="shell.goTo('drip')">
							<b>Get test tokens</b><span>SIGNAL · NOISE · fixed drip · no rate limit</span><Icon class="go" name="arrow-right" :size="24" />
						</button>
					</div>
				</div>
			</template>
		</BridgeJournal>
	</div>
</template>

<style scoped>
.activity {
	display: flex;
	flex-direction: column;
	gap: 24px;
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

.first {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 16px;
	max-width: 560px;
	padding: 8px 0;
	text-align: left;
}

.eb {
	font: 700 13px/1 var(--ul-font-body);
	color: var(--ul-accent-text);
}

.first h2 {
	margin: 0;
	font: 700 28px/1.1 var(--ul-font-body);
	letter-spacing: var(--ul-tracking-heading);
	color: var(--ul-ink);
}

.lede {
	margin: 0;
	font: 400 15px/1.55 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.tiles {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 12px;
	width: 100%;
	margin-top: 8px;
}

/* The primary verb carries a signal edge; hover lifts either tile one fill step. */
.tile {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-4);
	--edge: transparent;
	display: grid;
	grid-template-columns: 1fr auto;
	gap: 6px 14px;
	align-items: center;
	padding: 18px 20px;
	border: 0;
	background: none;
	color: var(--ul-ink);
	text-align: left;
	cursor: pointer;
}

.tile::before {
	box-shadow: inset 4px 0 0 var(--edge);
}

.tile.primary {
	--edge: var(--ul-signal);
}

.tile:hover {
	--ul-fill: var(--ul-line);
}

.tile:focus-visible {
	outline: 2px solid var(--ul-ring);
	outline-offset: 3px;
}

.tile b {
	grid-column: 1;
	font: 700 16px/1.2 var(--ul-font-body);
}

.tile span {
	grid-column: 1;
	font: 400 12.5px/1.5 var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.tile .go {
	grid-column: 2;
	grid-row: 1 / 3;
}

@media (max-width: 760px) {
	.tiles {
		grid-template-columns: 1fr;
	}
}
</style>
