<script setup lang="ts">
import { Icon } from "@unleashed/design"
import { computed, nextTick, onBeforeUnmount, ref } from "vue"
import { useAccountWidening, type WideningOutcome } from "@/composables/useAccountWidening"
import { useOpsInFlight } from "@/composables/useOpsInFlight"
import { switchActiveAccount, useWalletConnection } from "@/composables/useWalletConnection"
import { TESTIDS } from "@/lib/testids"

/**
 * The connected account chip + dropdown switcher. Shared by both AztecWalletPanel variants — both
 * read the SAME session singleton, so switching here drives every section.
 *
 * The trigger is ONE button holding only non-interactive content; the copy
 * affordance lives in the menu rows as a SIBLING of the selection button, so no
 * button ever nests inside another. The menu renders for single-account sessions
 * too — it is where Disconnect lives, and Disconnect must never disappear.
 */

const props = defineProps<{
	/** Panel-specific testid for the chip's address text (tl-account / tl-bridge-l2-account). */
	addressTestid: string
	/** Panel-specific testid for the menu's Disconnect action (keeps the pre-switcher ids alive). */
	disconnectTestid: string
}>()

const { accounts, selectedAccount, hiddenAccountsCount, disconnect } = useWalletConnection()
const { busy } = useOpsInFlight()
const widening = useAccountWidening()

// A decline and "nothing new" both come back as the old grant, so they share one line; a request
// that left the session (the wallet errored or dropped the session) is the only other shape.
const WIDENING_COPY: Record<WideningOutcome["kind"], (o: WideningOutcome) => string> = {
	added: (o) => `Added ${o.kind === "added" ? o.count : 0} account${o.kind === "added" && o.count === 1 ? "" : "s"}`,
	unchanged: () => "No accounts were added",
	busy: () => "Finish the current operation first",
	failed: () => "Couldn't reach your wallet",
}
const wideningStatus = computed(() => (widening.outcome.value ? WIDENING_COPY[widening.outcome.value.kind](widening.outcome.value) : ""))

async function onAddAccounts() {
	await widening.addAccounts()
}

const open = ref(false)
const chipEl = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)

const active = computed(() => accounts.value.find((a) => a.address === selectedAccount.value) ?? null)

function shortAddress(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`
}

const chipLabel = computed(() => {
	const who = [active.value?.alias, selectedAccount.value ? shortAddress(selectedAccount.value) : ""].filter(Boolean)
	return `Aztec account ${[...who, "switch account"].join(", ")}`
})

function toggle() {
	open.value ? close() : openMenu()
}
async function openMenu() {
	open.value = true
	await nextTick()
	menuEl.value?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus()
}
function close(refocus = true) {
	if (!open.value) return
	open.value = false
	if (refocus) chipEl.value?.focus()
}

function onPick(address: string) {
	if (address === selectedAccount.value) {
		close()
		return
	}
	// Shared switch path (selectAccount + toast) — same behavior as the journal cards' switch action.
	if (switchActiveAccount(address)) close()
	// Not applied = blocked (busy) or stale — the rows are disabled while busy, so this is
	// belt-and-braces: keep the menu open, state untouched.
}

async function onDisconnect() {
	close(false)
	await disconnect()
}

/** Per-row copy with transient feedback (the AddressDisplay pattern, as a sibling control). */
const copiedAddress = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
async function onCopy(address: string) {
	try {
		await navigator.clipboard.writeText(address)
		copiedAddress.value = address
		if (copiedTimer) clearTimeout(copiedTimer)
		copiedTimer = setTimeout(() => {
			copiedAddress.value = null
		}, 1200)
	} catch {
		// Clipboard denied: silently no-op — the full address stays visible in the row title.
	}
}

function onMenuKey(evt: KeyboardEvent) {
	if (evt.key === "Escape") {
		close()
		return
	}
	if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
		evt.preventDefault()
		const rows = [...(menuEl.value?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([disabled])') ?? [])]
		if (rows.length === 0) return
		const idx = rows.indexOf(document.activeElement as HTMLElement)
		const next = evt.key === "ArrowDown" ? (idx + 1) % rows.length : (idx - 1 + rows.length) % rows.length
		rows[next].focus()
	}
}

function onDocumentClick(evt: MouseEvent) {
	if (!open.value) return
	const target = evt.target as Node
	if (chipEl.value?.contains(target) || menuEl.value?.contains(target)) return
	close(false)
}
document.addEventListener("click", onDocumentClick)
onBeforeUnmount(() => {
	document.removeEventListener("click", onDocumentClick)
	if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<template>
	<div class="switcher">
		<button
			ref="chipEl"
			type="button"
			class="chip ul-notch"
			aria-haspopup="menu"
			:aria-expanded="open"
			:aria-label="chipLabel"
			:data-testid="TESTIDS.accountChip"
			@click="toggle"
		>
			<span class="dot" aria-hidden="true" />
			<span class="identity">
				<span class="net">Aztec<template v-if="active?.alias"> · {{ active.alias }}</template></span>
				<span v-if="selectedAccount" class="addr" :title="selectedAccount" :data-testid="props.addressTestid">{{ shortAddress(selectedAccount) }}</span>
			</span>
			<Icon class="chev" name="chevron" :size="12" :rotate="open ? 180 : 0" />
		</button>

		<div
			v-if="open"
			ref="menuEl"
			class="menu ul-notch"
			role="menu"
			aria-label="Granted accounts"
			:data-testid="TESTIDS.accountMenu"
			@keydown="onMenuKey"
		>
			<p class="hdr" aria-hidden="true">Granted accounts · {{ accounts.length }}</p>

			<p v-if="busy" class="busy-hint" role="status">Finish the current operation to switch.</p>

			<ul class="rows">
				<li
					v-for="a in accounts"
					:key="a.address"
					role="none"
					class="row-line"
					:class="{ inert: busy && a.address !== selectedAccount, on: a.address === selectedAccount }"
				>
					<button
						type="button"
						class="row"
						role="menuitemradio"
						:aria-checked="a.address === selectedAccount"
						:disabled="busy && a.address !== selectedAccount"
						:data-testid="TESTIDS.accountMenuRow"
						:data-address="a.address"
						@click="onPick(a.address)"
					>
						<span class="who">
							<span class="name">{{ a.alias || "—" }}</span>
							<span class="addr-sub" :title="a.address">{{ shortAddress(a.address) }}</span>
						</span>
					</button>
					<button
						type="button"
						class="copy"
						:aria-label="`Copy address ${a.address}`"
						:data-testid="TESTIDS.accountMenuCopy"
						@click="onCopy(a.address)"
					>
						<Icon :name="copiedAddress === a.address ? 'check' : 'copy'" :size="24" />
					</button>
				</li>
			</ul>

			<p v-if="hiddenAccountsCount > 0" class="truncation" :data-testid="TESTIDS.accountMenuTruncation">
				Showing {{ accounts.length }} of {{ accounts.length + hiddenAccountsCount }} granted accounts.
			</p>

			<p v-if="wideningStatus" class="add-status" role="status" :data-testid="TESTIDS.accountMenuAddStatus">
				{{ wideningStatus }}
			</p>

			<div class="foot">
				<button
					type="button"
					class="add"
					:disabled="widening.busy.value || busy"
					:data-testid="TESTIDS.accountMenuAddAccounts"
					@click="onAddAccounts"
				>
					{{ widening.busy.value ? "Asking your wallet…" : "Add accounts…" }}
				</button>
				<button
					type="button"
					class="disconnect"
					:data-testid="props.disconnectTestid"
					@click="onDisconnect"
				>
					Disconnect
				</button>
			</div>
		</div>
	</div>
</template>

<style scoped>
/* Never a notch host: the menu is absolutely positioned inside it. */
.switcher {
	position: relative;
	display: inline-flex;
}

.chip {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	gap: 12px;
	min-height: 48px;
	padding: 0 12px 0 14px;
	cursor: pointer;
}

.chip:hover,
.chip[aria-expanded="true"] {
	--ul-fill: var(--ul-line);
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
	gap: 1px;
	min-width: 0;
}

.net {
	max-width: 22ch;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font: 400 12px/1 var(--ul-font-body);
	color: var(--ul-ink-caption);
}

.chev {
	flex: none;
	color: var(--ul-ink-caption);
}

/* On the line fill, dark's tertiary caption falls under 4.5:1; secondary holds it in both themes. */
.chip:hover .net,
.chip[aria-expanded="true"] .net {
	color: var(--ul-ink-2);
}

.addr {
	font: 400 14px/1 var(--ul-font-mono);
	color: var(--ul-ink);
	white-space: nowrap;
}

/* The menu is its own notched surface over the page; a fill step, no shadow or hairline. It hangs
   from the chip's right edge because the chip ends the header row; stacked on a phone, from its left. */
.menu {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-4);
	position: absolute;
	top: calc(100% + 6px);
	right: 0;
	z-index: 50;
	min-width: 264px;
	padding: 6px 0;
	display: flex;
	flex-direction: column;
}

.hdr {
	font: 700 13px/1 var(--ul-font-body);
	color: var(--ul-ink-2);
	padding: 8px 14px 8px;
}

.busy-hint {
	color: var(--ul-attention);
	font-size: 13px;
	padding: 2px 14px 6px;
}

.rows {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
}

/* The whole line is ONE hover surface: highlighting only the selection button left the fill
   stopping short of the copy control. */
.row-line {
	display: flex;
	align-items: stretch;
}

.row-line:hover:not(.inert) {
	background: var(--ul-line);
}

.row {
	flex: 1;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 9px 6px 9px 14px;
	cursor: pointer;
	text-align: left;
	min-width: 0;
}

.row:focus-visible {
	background: var(--ul-line);
	outline-offset: -2px;
}

.row:disabled {
	color: var(--ul-disabled);
	cursor: not-allowed;
}

.who {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.name {
	color: var(--ul-ink);
	font-weight: 600;
	font-size: 14px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.row:disabled .name {
	color: inherit;
}

.addr-sub {
	color: var(--ul-ink-2);
	font-family: var(--ul-font-mono);
	font-size: 12px;
}

.copy {
	flex: none;
	align-self: center;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	margin-right: 8px;
	color: var(--ul-ink-2);
	cursor: copy;
}

.copy:hover {
	color: var(--ul-ink);
}

.copy:focus-visible {
	outline-offset: -2px;
}

.row-line.on,
.row-line.on:hover {
	background: var(--ul-ink);
	color: var(--ul-bg);
}

.row-line.on .name,
.row-line.on .addr-sub,
.row-line.on .copy {
	color: inherit;
}

.row-line.on .row:focus-visible,
.row-line.on .copy:focus-visible {
	background: none;
	outline-color: var(--ul-bg);
}

.truncation {
	color: var(--ul-attention);
	font-size: 13px;
	padding: 6px 14px 2px;
}

.add-status {
	color: var(--ul-ink-2);
	font-size: 13px;
	padding: 4px 14px 2px;
}

/* A fill step, not a rule, sets the actions apart. */
.foot {
	margin: 6px 6px 0;
	padding: 8px;
	background: var(--ul-panel);
	display: flex;
	justify-content: space-between;
	gap: 12px;
}

.add,
.disconnect {
	color: var(--ul-ink-2);
	font: 600 14px/1 var(--ul-font-body);
	text-decoration: underline dotted;
	text-underline-offset: 5px;
	padding: 4px 2px;
	cursor: pointer;
}

.add:hover:not(:disabled) {
	color: var(--ul-ink);
}

.add:disabled {
	color: var(--ul-disabled);
	cursor: not-allowed;
}

.disconnect:hover {
	color: var(--ul-lost);
}

@media (max-width: 760px) {
	.menu {
		right: auto;
		left: 0;
	}

	.switcher {
		display: flex;
	}

	/* Half the header row, label over address. Without `min-width: 0` a long wallet-sent alias sizes
	   the chip past its half and the label never ellipsizes. */
	.chip {
		flex: 1;
		min-width: 0;
		min-height: 44px;
		gap: 10px;
		padding: 0 12px;
	}

	.identity {
		flex: 1;
		gap: 3px;
	}

	.net {
		max-width: 100%;
		text-align: left;
	}
}
</style>
