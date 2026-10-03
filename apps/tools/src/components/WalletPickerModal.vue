<script setup lang="ts">
import { Button, Dialog, Icon, Tag } from "@unleashed/design"
import { computed, ref, useId, watch } from "vue"
import { useWalletConnection } from "@/composables/useWalletConnection"
import { TESTIDS } from "@/lib/testids"
import { sanitizeWalletName, walletIdLine, walletTypeLabel } from "@/lib/wallet-name"

/**
 * The wallet picker: a modal overlay, one instance at the app root. Rows are
 * announcement-keyed — a wallet's id/name/icon are CLAIMED,
 * not proven, so two claimants of one identity render as two rows plus a
 * warning strip; the emoji verification on the next step remains the actual
 * trust anchor.
 */

const { discoveredWallets, scanning, pickerOpen, selectWallet, cancelChoice } = useWalletConnection()

// The session owns visibility: open IMMEDIATELY on a fresh connect (empty +
// scanning — wallets may need the user's discovery approval before the first
// row can arrive), closed during a remembered auto-reconnect attempt.
const open = computed(() => pickerOpen.value)

/** Provider-supplied name: claimed, so stripped of invisible and reordering characters and capped
 *  in code, never by CSS. */
function displayName(name: string): string {
	return sanitizeWalletName(name)
}

/** Provider-supplied icon URL: protocol allowlist + source-length cap.
 *  `chrome-extension:` is admitted deliberately — extension wallets serve
 *  their icon from their own extension origin. Anything else
 *  (javascript:, http:, oversized data blobs) falls back to the generic wallet tile. */
const ICON_MAX_LENGTH = 4096
/** Icons that passed the allowlist but FAILED to load (e.g. the deployed
 *  tools app's CSP is `img-src 'self' data:`, which blocks https and
 *  chrome-extension sources) degrade to the generic wallet tile via @error. */
const failedIcons = ref(new Set<number>())
function onIconError(key: number) {
	const next = new Set(failedIcons.value)
	next.add(key)
	failedIcons.value = next
}
function safeIcon(icon: string | undefined): string | null {
	if (!icon || icon.length > ICON_MAX_LENGTH) return null
	try {
		const url = new URL(icon)
		if (url.protocol === "https:" || url.protocol === "chrome-extension:") return icon
		if (url.protocol === "data:" && icon.startsWith("data:image/")) return icon
		return null
	} catch {
		return null
	}
}

/** Two announcements claiming one id — the fail-closed signal the user needs
 *  to see spelled out. */
const hasCollision = computed(() => {
	const seen = new Set<string>()
	for (const w of discoveredWallets.value) {
		if (seen.has(w.id)) return true
		seen.add(w.id)
	}
	return false
})

const descId = useId()
const rowIdBase = useId()
/** The row's id line describes its button, so two rows claiming one name and type still announce apart. */
function idLineId(key: number): string {
	return `${rowIdBase}-id-${key}`
}

/** A second claimant or a newly answering wallet shifts the rows, so a click aimed at one row could
 *  land on another: activation is ignored for this long after either changes. */
const SETTLE_MS = 500
let settledAt = 0
watch(
	[hasCollision, () => discoveredWallets.value.map((w) => w.key).join(",")],
	() => {
		settledAt = performance.now() + SETTLE_MS
	},
	{ immediate: true },
)
function pick(key: number): void {
	if (performance.now() < settledAt) return
	selectWallet(key)
}
</script>

<template>
	<Dialog
		:open="open"
		title="Choose a wallet"
		:describedby="descId"
		:overlay-testid="TESTIDS.walletPicker"
		:close-testid="TESTIDS.walletPickerClose"
		@cancel="cancelChoice"
	>
		<p :id="descId" class="desc">Aztec wallets that answered on this page. Your keys stay in the wallet you pick.</p>

		<p v-if="hasCollision" class="warning ul-notch" role="alert" :data-testid="TESTIDS.walletPickerWarning">
			<Icon class="warning-icon" name="warning-diamond" :size="24" />
			<span>Multiple wallets claim the same identity. Names and icons are self-reported — pick deliberately. The emoji check on the next step verifies only the connection to the wallet you select.</span>
		</p>

		<p v-if="discoveredWallets.length === 0" class="waiting" :data-testid="TESTIDS.walletPickerWaiting">
			No wallets have answered yet. If your wallet asks to allow this site, approve it there.
		</p>

		<ul class="rows" aria-live="polite">
			<li
				v-for="w in discoveredWallets"
				:key="w.key"
				:data-testid="TESTIDS.walletPickerRow"
				:data-wallet-key="w.key"
				:data-wallet-id="w.id"
			>
				<button
					type="button"
					class="row ul-notch"
					:aria-label="`Connect ${displayName(w.name)} (${walletTypeLabel(w.type).label})`"
					:aria-describedby="walletIdLine(w.id) ? idLineId(w.key) : undefined"
					:data-testid="TESTIDS.walletPickerConnect"
					@click="pick(w.key)"
				>
					<span v-if="safeIcon(w.icon) && !failedIcons.has(w.key)" class="tile ul-notch">
						<img
							class="icon"
							:src="safeIcon(w.icon) ?? undefined"
							alt=""
							width="24"
							height="24"
							referrerpolicy="no-referrer"
							@error="onIconError(w.key)"
						/>
					</span>
					<span v-else class="tile fallback ul-notch" aria-hidden="true"><Icon name="wallet" :size="24" /></span>
					<span class="ident">
						<span class="head">
							<span class="name">{{ displayName(w.name) }}</span>
							<Tag class="type" size="small" :title="walletTypeLabel(w.type).title">{{ walletTypeLabel(w.type).label }}</Tag>
						</span>
						<span v-if="walletIdLine(w.id)" :id="idLineId(w.key)" class="id">{{ walletIdLine(w.id) }}</span>
					</span>
					<span class="go" aria-hidden="true">Connect<Icon class="chev" name="chevron-down" :size="12" /></span>
				</button>
			</li>
		</ul>

		<p v-if="scanning" class="scanning" :data-testid="TESTIDS.walletPickerScanning">
			<span class="dot" aria-hidden="true"></span> Scanning for more wallets…
		</p>

		<template #footer>
			<Button variant="secondary" :data-testid="TESTIDS.walletPickerCancel" @click="cancelChoice">Cancel</Button>
		</template>
	</Dialog>
</template>

<style scoped>
.desc {
	margin-top: -6px;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.warning {
	--ul-fill: var(--ul-attention-bg);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	gap: 12px;
	align-items: flex-start;
	padding: 12px 14px;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink);
}

.warning-icon {
	flex: none;
	color: var(--ul-attention);
}

/* The list scrolls, never the notched modal, whose fill would not follow; the 5px inset keeps
   the ring (2px, 3px off) inside the clip. */
.rows {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-height: 0;
	margin: -5px;
	padding: 5px;
	overflow-y: auto;
	list-style: none;
}

.row {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: center;
	gap: 14px;
	width: 100%;
	padding: 12px 14px;
	border: 0;
	background: none;
	color: var(--ul-ink);
	font: inherit;
	text-align: left;
	cursor: pointer;
}

.row:hover {
	--ul-fill: var(--ul-line);
}

.row:hover .id {
	color: var(--ul-ink-2);
}

.row:hover .go {
	color: var(--ul-ink);
}

.tile {
	--ul-fill: var(--ul-well);
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	flex: none;
	align-items: center;
	justify-content: center;
	width: 40px;
	height: 40px;
}

/* No trustworthy icon: a generic glyph that cannot pass for any wallet's mark. */
.tile.fallback {
	--ul-fill: var(--ul-line);
	color: var(--ul-ink-2);
}

.icon {
	width: 24px;
	height: 24px;
	object-fit: contain;
}

.ident {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
}

.head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 8px;
}

/* Names are self-reported and may share a prefix, so the whole name shows (`sanitizeWalletName` bounds it);
   an ellipsis would let two wallets read the same. */
.name {
	min-width: 0;
	font: 700 15px/1.2 var(--ul-font-body);
	overflow-wrap: anywhere;
}

.row .type {
	--ul-fill: var(--ul-panel);
	flex: none;
	min-height: 22px;
}

.id {
	font: 400 12.5px/1.3 var(--ul-font-mono);
	color: var(--ul-ink-3);
	overflow-wrap: anywhere;
}

.go {
	display: inline-flex;
	flex: none;
	align-items: center;
	gap: 4px;
	font: 700 14px/1 var(--ul-font-body);
	color: var(--ul-accent-text);
}

.chev {
	transform: rotate(-90deg);
}

.waiting {
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.scanning {
	display: flex;
	align-items: center;
	gap: 10px;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.dot {
	flex: none;
	width: 6px;
	height: 6px;
	background: var(--ul-attention);
}
</style>
