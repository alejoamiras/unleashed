<script setup lang="ts">
/** Components */
import { Icon, useFocusTrap } from "@unleashed/design"
import ActivityRow from "./ActivityRow.vue"
import DockStrip from "./DockStrip.vue"
import EmptyChannel from "./EmptyChannel.vue"

/** Composables */
import { claimFuelStandalone } from "@/composables/fuel-recovery"
import type { ActivityFeed, ActivityRowModel } from "@/composables/useActivityFeed"
import { useBridgeJournal } from "@/composables/useBridgeJournal"
import { useDockState } from "@/composables/useDockState"
import { useMediaQuery } from "@/composables/useMediaQuery"
import { useOpsInFlight } from "@/composables/useOpsInFlight"
import { useShell } from "@/composables/useShell"
import { useToast } from "@/composables/useToast"
import { switchActiveAccount } from "@/composables/useWalletConnection"

/** Utils */
import { computed, nextTick, ref, watch } from "vue"
import type { ActivityAction } from "@/lib/activity"
import { ethereumPrefillOf } from "@/lib/crosschain-activity"
import { userMessage } from "@/lib/errors"
import { TESTIDS } from "@/lib/testids"

/**
 * The side list of every bridge, grouped by what it wants from you; the send the wizard is showing
 * is listed read-only. It dispatches to the same engine entry points the page card does, so a
 * button here can never do something the card would refuse. On the wide layout open or hidden is
 * the user's persisted choice, and the dock opens itself once per record that starts counting as
 * needing you, never for another account's.
 */
const props = defineProps<{ feed: ActivityFeed }>()

const shell = useShell()
const journal = useBridgeJournal()
const dock = useDockState()
const { push } = useToast()
const { busy: opsBusy } = useOpsInFlight()

const PANEL_ID = "tl-activity-panel"
const strip = ref<{ focus(): void } | null>(null)
const panel = ref<HTMLElement | null>(null)

/** Under 1100px the dock opens only from a tap on the strip, over the static scrim, for this visit:
 *  the persisted choice and auto-open belong to the wide layout, where the panel sits in the grid. */
const narrow = useMediaQuery("(max-width: 1100px)")
const overlayOpen = ref(false)
const shown = computed(() => (narrow.value ? overlayOpen.value : dock.open.value))
const overlay = computed(() => narrow.value && overlayOpen.value)
// Runs before the render that drops the wide panel, so it can still see whether focus was inside it.
watch(narrow, async (n) => {
	if (!n) {
		overlayOpen.value = false
		return
	}
	if (!panel.value?.contains(document.activeElement)) return
	await nextTick()
	strip.value?.focus()
})

const groups = computed(() => {
	const g = props.feed.grouped.value
	return [
		{ key: "needs-you", title: "Needs you", rows: g.needsYou },
		{ key: "running", title: "Running", rows: g.running },
		// A send that ended without arriving makes the group read as ended, not done.
		{ key: "done", title: g.done.some((r) => r.word) ? "Ended" : "Done", rows: g.done },
		{ key: "other-account", title: "Other account", rows: g.otherAccount },
	].filter((x) => x.rows.length > 0)
})
const total = computed(() => props.feed.rows.value.length)
const needsYouIds = computed(() => props.feed.grouped.value.needsYou.map((r) => r.id))

/** Hiding on a needs-you record is the answer for that record either way; only the wide layout's
 *  hide is also the persisted choice. */
async function hide(): Promise<void> {
	if (narrow.value) {
		overlayOpen.value = false
		dock.markSeen(needsYouIds.value, props.feed.liveIds.value)
	} else {
		dock.hide(needsYouIds.value, props.feed.liveIds.value)
	}
	await nextTick()
	strip.value?.focus()
}

function toggle(): void {
	if (shown.value) return void hide()
	if (narrow.value) overlayOpen.value = true
	else dock.show()
}

/** Focus moves into the overlay only on the strip's explicit open, and a wallet dialog (picker,
 *  account chooser, verification) keeps the keyboard whether or not it took focus. */
useFocusTrap(panel, {
	enabled: overlay,
	onEscape: () => void hide(),
	shouldYield: () => [...document.querySelectorAll("[aria-modal='true']")].some((m) => m !== panel.value),
})

watch(
	[props.feed.autoOpenIds, narrow],
	([ids, n]) => {
		if (!n) dock.autoOpenFor(ids, props.feed.liveIds.value)
	},
	{ immediate: true },
)

/** Which rows' Claim gas is busy; the entry point itself joins a run already in flight. */
const gasInFlight = ref<ReadonlySet<string>>(new Set())
async function claimGas(id: string): Promise<void> {
	if (gasInFlight.value.has(id)) return
	gasInFlight.value = new Set([...gasInFlight.value, id])
	try {
		await claimFuelStandalone(id)
	} catch (e) {
		push({ kind: "error", lead: "Could not claim your gas.", text: userMessage(e, "Try again from Activity.") })
	} finally {
		gasInFlight.value = new Set([...gasInFlight.value].filter((x) => x !== id))
	}
}

/** The card's Continue from Ethereum, from the row; the wizard takes the prefill from the shell. */
function continueFrom(id: string): void {
	const rec = journal.crossChainRecords.value.find((r) => r.id === id)
	const prefill = rec ? ethereumPrefillOf(rec) : null
	if (!prefill) return void shell.openActivity(id)
	if (narrow.value) void hide()
	shell.continueFromEthereum(prefill)
}

function act(id: string, action: Exclude<ActivityAction, null>): void {
	const row = props.feed.rows.value.find((r) => r.id === id)
	if (!row) return
	if (action === "claim-gas") return void claimGas(id)
	if (action === "continue") return void continueFrom(id)
	if (action === "switch") {
		if (!opsBusy.value && row.switchTarget) switchActiveAccount(row.switchTarget)
		return
	}
	// claim / finish / retry all re-enter the record's own run; the engine's record lock dedups.
	if (row.direction === "deposit") void journal.runDepositClaim(id)
	else void journal.runWithdrawConsume(id)
}

/** The running send's row leads back to its stepper; any other row to its card on Activity, which
 *  unmounts the dock. Send keeps it mounted, so the overlay closes itself first. */
function open(id: string): void {
	if (!props.feed.rows.value.find((r) => r.id === id)?.foreground) return void shell.openActivity(id)
	if (narrow.value) void hide()
	shell.goTo("send")
}

function acting(row: ActivityRowModel): boolean {
	return row.action === "claim-gas" && gasInFlight.value.has(row.id)
}
</script>

<template>
	<DockStrip v-if="!shown || narrow" ref="strip" :class="{ raised: overlay }" :count="feed.count.value" :open="shown" :controls="PANEL_ID" @open="toggle" />
	<div v-if="overlay" class="ul-scrim scrim" aria-hidden="true" :data-testid="TESTIDS.dockScrim" @click="hide" />
	<aside
		v-if="shown"
		:id="PANEL_ID"
		ref="panel"
		class="dock"
		:class="{ overlay }"
		:role="overlay ? 'dialog' : undefined"
		:aria-modal="overlay || undefined"
		aria-label="Activity"
		:data-testid="TESTIDS.dock"
	>
		<div class="head">
			<h2>Activity</h2>
			<button type="button" class="hide ul-notch" data-autofocus aria-expanded="true" :aria-controls="PANEL_ID" :data-testid="TESTIDS.dockHide" @click="hide">Hide <Icon name="chevron-down" :size="12" :rotate="-90" /></button>
		</div>
		<div class="groups">
			<EmptyChannel v-if="total === 0">Bridges you background or lose track of land here.</EmptyChannel>
			<section v-for="g in groups" :key="g.key" class="group" :class="{ ended: g.title === 'Ended' }" :data-testid="TESTIDS.dockGroup" :data-group="g.key">
				<h3>{{ g.title }} · {{ g.rows.length }}</h3>
				<ul role="list">
					<ActivityRow
						v-for="row in g.rows"
						:key="row.id"
						:row="row"
						:acting="acting(row)"
						:switch-locked="opsBusy"
						@open="open"
						@act="act"
					/>
				</ul>
			</section>
		</div>
		<div class="foot">
			<button type="button" class="all" :data-testid="TESTIDS.dockAll" @click="shell.goTo('activity')">All activity</button>
			<span>{{ total }} {{ total === 1 ? "record" : "records" }}</span>
		</div>
	</aside>
</template>

<style scoped>
.dock {
	position: sticky;
	top: 0;
	display: flex;
	flex-direction: column;
	width: 300px;
	max-height: 100vh;
	min-width: 0;
	background: var(--ul-panel);
}

.head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex: none;
	height: 72px;
	padding: 0 16px 0 20px;
}

.head h2 {
	margin: 0;
	font: 700 16px/1 var(--ul-font-body);
	letter-spacing: var(--ul-tracking-heading);
	color: var(--ul-ink);
}

.hide {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 36px;
	padding: 0 8px 0 12px;
	font: 600 14px/1 var(--ul-font-body);
	color: var(--ul-ink);
	cursor: pointer;
}

.hide:hover {
	--ul-fill: var(--ul-line);
}

.all {
	font: 700 13px/1 var(--ul-font-body);
	color: var(--ul-accent-text);
	cursor: pointer;
}

.all:hover {
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.groups {
	display: flex;
	flex-direction: column;
	flex: 1;
	gap: 18px;
	padding: 8px 16px 0;
	overflow-y: auto;
}

.group {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.group ul {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin: 0;
	padding: 0;
	list-style: none;
}

.group h3 {
	margin: 0;
	font: 700 13px/1 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.group[data-group="needs-you"] h3 {
	color: var(--ul-attention);
}

.group[data-group="done"] h3 {
	color: var(--ul-carrier);
}

.group.ended h3 {
	color: var(--ul-ink-2);
}

.group[data-group="other-account"] h3 {
	color: var(--ul-other);
}

.foot {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex: none;
	margin-top: auto;
	padding: 16px 20px 20px;
	font: 400 13px/1 var(--ul-font-mono);
	color: var(--ul-ink-3);
}

.scrim {
	z-index: 19;
}

/* The strip stays lit above the scrim: its chevron is the overlay's visible close. */
.raised {
	z-index: 20;
}

.dock.overlay {
	position: fixed;
	top: 0;
	right: 44px;
	bottom: 0;
	z-index: 20;
	max-height: none;
}
</style>
