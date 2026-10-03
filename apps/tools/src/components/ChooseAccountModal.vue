<script setup lang="ts">
import { Button, Dialog, Icon } from "@unleashed/design"
import { computed, nextTick, ref, watch } from "vue"
import { useOpsInFlight } from "@/composables/useOpsInFlight"
import { useWalletConnection } from "@/composables/useWalletConnection"
import { TESTIDS } from "@/lib/testids"

/**
 * The choose-main-account step. Mounted ONCE at the app root
 * (like WalletPickerModal) and driven entirely by session state: it appears only
 * while the connect flow is paused in `choosing-account` — i.e. the wallet granted
 * more than one account and none was remembered for this wallet. Esc, × and backdrop
 * cancel the CONNECT (same semantics as cancelling verification): abandoning the
 * choice must not leave a half-connected session.
 */

const { status, accounts, hiddenAccountsCount, confirmAccountChoice, cancelAccountChoice } = useWalletConnection()
// A choice forced by a re-grant that dropped the active account waits for the operation that
// captured it: the session refuses the confirm until then, so the button says so instead.
const { busy } = useOpsInFlight()

const open = computed(() => status.value === "choosing-account")

const picked = ref<string | null>(null)
const rowsEl = ref<HTMLElement | null>(null)
// Pre-select the first granted account on open; clear on close so a later session never inherits a
// stale pick. `immediate` covers mounting while the session is ALREADY paused in choosing-account
// (remount/HMR): without it the dialog would open with nothing selected and a dead Continue button.
watch(
	open,
	(isOpen) => {
		picked.value = isOpen ? (accounts.value[0]?.address ?? null) : null
	},
	{ immediate: true },
)

function shortAddress(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`
}
function initials(address: string): string {
	return address.slice(2, 4).toUpperCase()
}

function pick(address: string) {
	picked.value = address
}

async function onContinue() {
	if (!picked.value) return
	await confirmAccountChoice(picked.value)
}

/** Roving radio: arrows move the pick, matching the radiogroup pattern. */
function onRadioKey(evt: KeyboardEvent) {
	const list = accounts.value
	if (list.length === 0) return
	const idx = list.findIndex((a) => a.address === picked.value)
	if (evt.key === "ArrowDown" || evt.key === "ArrowRight") {
		evt.preventDefault()
		pickAndFocus(list[(idx + 1) % list.length].address)
	} else if (evt.key === "ArrowUp" || evt.key === "ArrowLeft") {
		evt.preventDefault()
		pickAndFocus(list[(idx - 1 + list.length) % list.length].address)
	}
}
function pickAndFocus(address: string) {
	picked.value = address
	nextTick(() => {
		rowsEl.value?.querySelector<HTMLElement>(`[data-address="${address}"]`)?.focus()
	})
}
</script>

<template>
	<Dialog
		:open="open"
		title="Choose main account"
		:overlay-testid="TESTIDS.accountChoice"
		:close-testid="TESTIDS.accountChoiceClose"
		@cancel="cancelAccountChoice"
	>
		<p class="body">
			Your wallet shared {{ accounts.length }} accounts. Pick the one this app should use —
			you can switch anytime from the account chip.
		</p>

		<!-- The selected radio is the roving-tabindex entry point, so it takes the initial focus. -->
		<ul ref="rowsEl" class="rows" role="radiogroup" aria-label="Granted accounts" @keydown="onRadioKey">
			<li v-for="a in accounts" :key="a.address">
				<button
					type="button"
					class="row ul-notch"
					:class="{ selected: picked === a.address }"
					role="radio"
					:aria-checked="picked === a.address"
					:tabindex="picked === a.address ? 0 : -1"
					:data-autofocus="picked === a.address || undefined"
					:data-address="a.address"
					:data-testid="TESTIDS.accountChoiceRow"
					@click="pick(a.address)"
				>
					<span class="sq" aria-hidden="true">{{ initials(a.address) }}</span>
					<span class="who">
						<span class="name">{{ a.alias || "—" }}</span>
						<span class="addr">{{ shortAddress(a.address) }}</span>
					</span>
					<Icon v-if="picked === a.address" class="check" name="check" :size="12" />
				</button>
			</li>
		</ul>

		<p v-if="hiddenAccountsCount > 0" class="truncation" :data-testid="TESTIDS.accountChoiceTruncation">
			Showing {{ accounts.length }} of {{ accounts.length + hiddenAccountsCount }} granted accounts.
		</p>

		<p v-if="busy" class="truncation" role="status" :data-testid="TESTIDS.accountChoiceBusy">
			Finish the current operation, then continue.
		</p>

		<template #footer>
			<Button
				variant="primary"
				:disabled="!picked || busy"
				:data-testid="TESTIDS.accountChoiceContinue"
				@click="onContinue"
			>
				Continue
			</Button>
		</template>
	</Dialog>
</template>

<style scoped>
.body {
	font: 400 14px/1.5 var(--ul-font-body);
	color: var(--ul-ink-2);
}

/* The list scrolls, never the notched modal, whose fill would not follow; the 5px inset keeps
   the ring (2px, 3px off) inside the clip. */
.rows {
	display: flex;
	flex-direction: column;
	gap: 8px;
	min-height: 0;
	margin: -5px;
	padding: 5px;
	overflow-y: auto;
	list-style: none;
}

/* Reverse video marks the pick; the square and address keep their own contrast on ink. */
.row {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: center;
	gap: 12px;
	width: 100%;
	padding: 10px 12px;
	border: 0;
	background: none;
	color: var(--ul-ink);
	text-align: left;
	cursor: pointer;
	transition: color var(--ul-tick);
}

.row:hover {
	--ul-fill: var(--ul-line);
}

.row:focus-visible {
	outline: 2px solid var(--ul-ring);
	outline-offset: 3px;
}

.row.selected {
	--ul-fill: var(--ul-ink);
	color: var(--ul-bg);
}

.sq {
	display: grid;
	flex: none;
	place-items: center;
	width: 28px;
	height: 28px;
	background: var(--ul-field);
	font: 700 12px/1 var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.who {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.name {
	overflow: hidden;
	font: 700 14px/1.2 var(--ul-font-body);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.addr {
	font: 400 12.5px/1.2 var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.row.selected .addr {
	color: var(--ul-line);
}

.check {
	flex: none;
}

.truncation {
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-other);
}
</style>
