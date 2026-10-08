// Patch WalletSchema before wallet-sdk reads it (the wallet-specific `registerToken`).
// Must be the first import in this module - see @nulo-sh/wallet-sdk-schema-patch.
import "@nulo-sh/wallet-sdk-schema-patch/register"

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { WalletManager } from "@aztec-labs/wallet-sdk/manager"
import type { PendingConnection, WalletProvider } from "@aztec-labs/wallet-sdk/manager"
import { ref, shallowRef } from "vue"
import { readChainInfo } from "@/lib/chain-info"
import { resolveToolsTarget } from "@/lib/network-targets"
import { sanitizeWalletName } from "@/lib/wallet-name"
import { hashToEmoji } from "@/lib/emoji"
import { type NormalizedError, normalizeError } from "@/lib/errors"
import { enqueuePrompt } from "@/lib/prompt-queue"

export type ConnectStatus =
	| "idle"
	| "discovering"
	| "choosing"
	| "verifying"
	| "capability-approval"
	| "choosing-account"
	| "setting-up"
	| "connected"
	| "error"

export interface GrantedAccount {
	readonly address: string
	readonly alias: string
}

/** One-shot UI notification from the selection logic. Emitted by the session at the triggering
 *  moment and DRAINED exactly once by a single UI owner (a module-level watcher in
 *  useWalletConnection) — panels must never infer these from status changes. */
export interface SelectionNotice {
	/** Monotonic per-session key — lets the consumer prove exactly-once handling. */
	readonly key: number
	readonly kind: "auto-remembered" | "grant-truncated"
	readonly alias?: string
	readonly address?: string
	readonly hiddenCount?: number
}

/**
 * A plain-data projection of a discovery announcement, safe for reactive state. `key` is an
 * opaque per-announcement counter — NOT the provider's claimed `id`: any wallet can claim any
 * id/name/icon, so claimed-id collisions render as separate rows instead of deduping the
 * impostor (or the real wallet) away.
 */
export interface DiscoveredWallet {
	readonly key: number
	readonly id: string
	readonly name: string
	readonly type: string
	readonly icon?: string
}

/** Remembered choice: id selects the auto-reconnect candidate, name feeds the idle-state label. */
interface PreferredWallet {
	readonly id: string
	readonly name: string
}

/** Bounded collision-detection window for the remembered path (best-effort). */
const REMEMBERED_AMBIGUITY_WINDOW_MS = 1_000

/** Granted-list bound (DoS resistance). Truncation is DISCLOSED via a SelectionNotice, never
 *  silent — silently hiding account 17 would recreate the hidden-account bug. */
const MAX_GRANTED_ACCOUNTS = 16
/** Same bound for the granted contract list — it is wallet-controlled input too, and the app only
 *  ever asks for a set it can enumerate. */
const MAX_GRANTED_CONTRACTS = 256
/** Per-wallet selected-account memory: most-recent-first, so A→B→A keeps both. */
const MAX_REMEMBERED_WALLETS = 8
/** Bound on stored id/address strings — storage is untrusted input. */
const STORED_STRING_MAX = 256

/**
 * Per-feature config for an Aztec wallet session. The tools app creates ONE session (a
 * module-level singleton in useWalletConnection; useBridgeWallet re-exports it) with a combined
 * capability manifest covering every tab — one connection, one grant, one active account.
 *
 * Account-selection contract for consumers: read `selectedAccount` AT ACTION TIME and capture it
 * for the operation's lifetime; wrap every account-sensitive prompt/send span in
 * `useOpsInFlight.withOperation` so switching is blocked while the operation runs.
 */
export interface AztecWalletSessionConfig {
	readonly appId: string
	/** Build the wallet-sdk capability manifest at connect time (async - needs the SponsoredFPC). */
	// biome-ignore lint/suspicious/noExplicitAny: SDK manifest type is zod-inferred, not exported usably.
	readonly buildManifest: () => Promise<any>
	/** Register the feature's contracts with the wallet's PXE after capabilities are granted. */
	readonly registerContracts: (wallet: Wallet) => Promise<void>
	/** Mutation-boundary guard for account switching: while it returns true, `selectAccount()`
	 *  rejects. Injected (rather than imported) so the factory stays UI-agnostic and the gate is
	 *  unit-testable — the tools app wires it to the ops-in-flight registry. */
	readonly isSwitchBlocked?: () => boolean
}

/**
 * Create an Aztec wallet session: discover → choose (picker) → verify (emoji match) → request
 * capabilities → register contracts → connected. Returns reactive state + the connection
 * methods. Call ONCE per feature at module scope (singleton) - `useWalletConnection` /
 * `useBridgeWallet` wrap it.
 *
 * Concurrency model: a single flow epoch. Every async continuation captures the epoch AND the
 * session handles (provider/pending/wallet) it operates on; cancel/disconnect/dismiss bump the
 * epoch and wipe state SYNCHRONOUSLY before any awaited SDK teardown, so a newer flow can never
 * be clobbered by an older one's cleanup. A stale continuation discards its result AND undoes
 * its own SDK side effects via its CAPTURED handles (never the mutable session fields — those
 * may already belong to a newer flow). The controllers below all take the per-session state
 * object; nothing is module-global, so two sessions never share a flow.
 */
/** The reactive session surface + controllers `createAztecWalletSession` returns. */
export type AztecWalletSession = ReturnType<typeof createAztecWalletSession>

export function createAztecWalletSession(config: AztecWalletSessionConfig) {
	const s = createSessionState(config)
	return {
		status: s.status,
		verificationEmojis: s.verificationEmojis,
		accounts: s.accounts,
		grantedContracts: s.grantedContracts,
		selectedAccount: s.selectedAccount,
		selectionNotices: s.selectionNotices,
		hiddenAccountsCount: s.hiddenAccountsCount,
		contractsReady: s.contractsReady,
		error: s.error,
		wallet: s.wallet,
		discoveredWallets: s.discoveredWallets,
		scanning: s.scanning,
		pickerOpen: s.pickerOpen,
		preferredWalletName: s.preferredWalletName,
		autoReconnectDisabled: s.autoReconnectDisabled,
		connect: (): Promise<void> => connectImpl(s, false),
		/** The split-button caret: a fresh scan that goes straight to the picker,
		 *  IGNORING the remembered wallet for this flow only. The stored preference
		 *  survives a cancel and is overwritten by whichever wallet next connects. */
		connectWithPicker: (): Promise<void> => connectImpl(s, true),
		selectWallet: (key: number): void => selectWallet(s, key),
		cancelChoice: (): void => cancelChoice(s),
		/** Forget the remembered wallet (the "use a different wallet" affordances). */
		forgetPreferredWallet: (): void => clearPreferred(s),
		switchWallet: (): Promise<void> => switchWallet(s),
		confirmVerification: (): Promise<void> => confirmVerification(s),
		cancelVerification: (): Promise<void> => cancelVerification(s),
		confirmAccountChoice: (address: string): Promise<void> => confirmAccountChoice(s, address),
		cancelAccountChoice: (): Promise<void> => cancelAccountChoice(s),
		selectAccount: (address: string): boolean => selectAccount(s, address),
		consumeSelectionNotices: (): SelectionNotice[] => consumeSelectionNotices(s),
		/** False when it did not run because another flow already owns the wallet — not a refusal. */
		retryCapabilities: (): Promise<boolean> => retryCapabilities(s),
		/** Quietly re-register the app's contracts on the current wallet (`retryOnUnregistered`
		 *  calls it after an unregistered-contract error). False when a flow owns the wallet or the
		 *  session went stale mid-flight; rethrows a genuine registration failure after publishing it. */
		reregisterContracts: (): Promise<boolean> => reregisterContracts(s),
		/** Re-read the session's accounts from the wallet (no prompt); see `refreshAccounts`. */
		refreshAccounts: (): Promise<RefreshOutcome> => enqueuePrompt(() => refreshAccounts(s)),
		disconnect: (): Promise<void> => disconnect(s),
		reset: (): void => reset(s),
	}
}

/** Single-use pause token for the choose-account step. Like the verification step's `pending`,
 *  it is CLAIMED synchronously (nulled before any await) by whichever continuation runs first —
 *  double-confirm, confirm-vs-cancel, and racing panels all collapse to one winner. Captures
 *  the flow's own handles so stale cleanup never dereferences the mutable session fields. */
interface PendingAccountChoice {
	flowEpoch: number
	wallet: Wallet
	provider: WalletProvider | null
}

/** One object per session: the reactive surface plus the mutable flow fields the controllers
 *  share. Built in the original declaration order; the storage keys exist BEFORE the ref whose
 *  initializer reads them. */
function createSessionState(config: AztecWalletSessionConfig) {
	const storageKey = `${config.appId}:preferred-wallet`
	/** Per-wallet selected-account memory (MRU pairs, see readRememberedMap). */
	const selectedStorageKey = `${config.appId}:selected-accounts`
	return {
		config,
		storageKey,
		selectedStorageKey,
		status: ref<ConnectStatus>("idle"),
		verificationEmojis: ref<string | null>(null),
		accounts: ref<GrantedAccount[]>([]),
		/** The contracts the app may act on, lowercased: the requested manifest INTERSECTED with the
		 *  wallet's answer, scopes included. A per-token feature reads this to decide whether it still
		 *  owes the user a prompt. */
		grantedContracts: ref<readonly string[]>([]),
		selectedAccount: ref<string | null>(null),
		/** True only while the app's contracts are registered with the connected wallet's PXE. False
		 *  during the register window (initial setup AND a quiet re-grant's re-registration) and
		 *  whenever no wallet is set — a send issued before it is true would fail on an unregistered
		 *  contract, so the send gates read it. */
		contractsReady: ref(false),
		/** Valid accounts dropped by the grant cap — drives the persistent "Showing N of M"
		 *  disclosure rows (the one-shot notice covers only the toast). */
		hiddenAccountsCount: ref(0),
		error: ref<NormalizedError | null>(null),
		// shallowRef: the SDK wallet handle must not be deep-proxied (same rationale as the balance
		// handles - deep reactivity over a class instance is waste and can break identity checks).
		wallet: shallowRef<Wallet | null>(null),
		discoveredWallets: ref<DiscoveredWallet[]>([]),
		/** True while the discovery stream is live (drives the picker's "scanning" hint). */
		scanning: ref(false),
		/** The picker modal's visibility — opened IMMEDIATELY on a fresh connect (before any
		 *  wallet answers: discovery approval in a wallet can gate the first announcement, and the
		 *  user must see the scan happening, not a frozen button). The remembered path keeps it
		 *  closed unless it falls back to a choice. */
		pickerOpen: ref(false),
		preferredWalletName: ref<string | null>(readPreferredFor(storageKey)?.name ?? null),
		provider: null as WalletProvider | null,
		pending: null as PendingConnection | null,
		cancelDiscovery: null as (() => void) | null,
		unsubscribeDisconnect: null as (() => void) | null,
		pendingAccountChoice: null as PendingAccountChoice | null,
		// One-shot UI notices (auto-remembered selection, grant truncation). Drained by the single
		// module-level owner in useWalletConnection — see SelectionNotice.
		selectionNotices: ref<SelectionNotice[]>([]),
		nextNoticeKey: 0,
		// Provider objects carry methods + a MessagePort — they must never enter reactive state.
		providersByKey: new Map<number, WalletProvider>(),
		nextKey: 0,
		// Flow epoch + owning token. `activeFlowEpoch` is the epoch that OWNS the in-flight flow —
		// a stale flow's cleanup releases the lock only if it still owns it, so it can never free a
		// newer flow's.
		epoch: 0,
		activeFlowEpoch: null as number | null,
		// Collision handling: once two announcements claim the remembered id, auto-reconnect stays
		// off until the page reloads — re-running discovery cannot un-ambiguate a spoofed identity.
		// Reactive so the UI can stop promising "Connect <name>" once auto-reconnect is off.
		autoReconnectDisabled: ref(false),
		// True while the in-flight connect chain was entered via the remembered path — its failures
		// clear the stored preference so one bad auto-path can't lock the user out of the picker.
		connectingViaRemembered: false,
		ambiguityTimer: null as ReturnType<typeof setTimeout> | null,
	}
}

type SessionState = ReturnType<typeof createSessionState>

// ---------------------------------------------------------------------------------------------
// Storage controller — localStorage is untrusted input; every read re-validates and bounds.
// ---------------------------------------------------------------------------------------------

function readPreferredFor(storageKey: string | null): PreferredWallet | null {
	if (storageKey === null) return null
	try {
		const raw = localStorage.getItem(storageKey)
		if (!raw) return null
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed !== "object" || parsed === null) return null
		const { id, name } = parsed as { id?: unknown; name?: unknown }
		if (typeof id !== "string" || typeof name !== "string") return null
		return { id, name: sanitizeWalletName(name) }
	} catch {
		return null
	}
}
function readPreferred(s: SessionState): PreferredWallet | null {
	return readPreferredFor(s.storageKey)
}
function writePreferred(s: SessionState, value: PreferredWallet): void {
	// Same write bound as the selected-account map: a hostile provider id must not produce
	// oversized writes. Refusing wholesale also skips the label ref.
	if (value.id.length === 0 || value.id.length > STORED_STRING_MAX) return
	const capped = { id: value.id, name: sanitizeWalletName(value.name) }
	try {
		localStorage.setItem(s.storageKey, JSON.stringify(capped))
	} catch {
		// Best-effort: a throwing storage must never affect an established session.
	}
	s.preferredWalletName.value = capped.name
}
function clearPreferred(s: SessionState): void {
	try {
		localStorage.removeItem(s.storageKey)
	} catch {
		// best-effort
	}
	s.preferredWalletName.value = null
}
/** A fresh pick always persists. The remembered path writes only to refresh the name the same
 *  wallet now reports, so a renamed wallet is not greeted by its old name. */
function shouldPersistPreferred(s: SessionState, provider: WalletProvider): boolean {
	if (!s.connectingViaRemembered) return true
	const stored = readPreferredFor(s.storageKey)
	return stored !== null && stored.id === provider.id && stored.name !== sanitizeWalletName(provider.name)
}

/** Per-wallet selected-account memory: `[walletId, address][]`, most-recent-first. Storage is
 *  untrusted input — the read path re-validates shape, bounds every string, dedupes ids, and
 *  re-caps the list; content is only ever used to PRE-SELECT among the live grant, never to
 *  select an outside address (validation against the grant happens at lookup
 *  sites). */
function readRememberedMap(s: SessionState): Array<[string, string]> {
	try {
		const raw = localStorage.getItem(s.selectedStorageKey)
		if (!raw) return []
		return parseRememberedEntries(JSON.parse(raw))
	} catch {
		return []
	}
}
function parseRememberedEntries(parsed: unknown): Array<[string, string]> {
	if (!Array.isArray(parsed)) return []
	const out: Array<[string, string]> = []
	for (const entry of parsed) {
		const pair = rememberedEntryOf(entry)
		if (pair === null) continue
		if (out.some(([seenId]) => seenId === pair[0])) continue
		out.push(pair)
		if (out.length >= MAX_REMEMBERED_WALLETS) break
	}
	return out
}
/** One stored pair, or null when its shape or bounds are wrong. */
function rememberedEntryOf(entry: unknown): [string, string] | null {
	if (!Array.isArray(entry) || entry.length !== 2) return null
	const [id, address] = entry as [unknown, unknown]
	if (typeof id !== "string" || typeof address !== "string") return null
	if (id.length === 0 || id.length > STORED_STRING_MAX || address.length === 0 || address.length > STORED_STRING_MAX) return null
	return [id, address]
}
function readRememberedAccount(s: SessionState, walletId: string): string | null {
	return readRememberedMap(s).find(([id]) => id === walletId)?.[1] ?? null
}
function writeRememberedAccount(s: SessionState, walletId: string, address: string): void {
	// Bound on WRITE as well as read: a hostile provider id must not produce
	// oversized writes / quota churn.
	if (walletId.length === 0 || walletId.length > STORED_STRING_MAX || address.length > STORED_STRING_MAX) return
	// Atomic rebuild: filter-out + unshift + cap, then ONE setItem.
	const head: [string, string] = [walletId, address]
	const next = [head, ...readRememberedMap(s).filter(([id]) => id !== walletId)].slice(0, MAX_REMEMBERED_WALLETS)
	try {
		localStorage.setItem(s.selectedStorageKey, JSON.stringify(next))
	} catch {
		// Best-effort: a throwing storage must never affect an established session.
	}
}

/** Set the active account and remember it for this wallet. Selection is persisted AT selection
 *  time — before setup — so a setup failure + retry re-applies it without re-prompting. */
function applySelection(s: SessionState, address: string, flowProvider: WalletProvider | null): void {
	s.selectedAccount.value = address
	if (flowProvider) writeRememberedAccount(s, flowProvider.id, address)
}

// ---------------------------------------------------------------------------------------------
// Flow-ownership controller — epoch checks, synchronous wipes, best-effort SDK teardown.
// ---------------------------------------------------------------------------------------------

function pushSelectionNotice(s: SessionState, notice: Omit<SelectionNotice, "key">): void {
	s.selectionNotices.value = [...s.selectionNotices.value, { ...notice, key: s.nextNoticeKey++ }]
}
/** Drain pending notices exactly once (returns them and clears the queue). */
function consumeSelectionNotices(s: SessionState): SelectionNotice[] {
	const drained = s.selectionNotices.value
	if (drained.length > 0) s.selectionNotices.value = []
	return drained
}

function isStale(s: SessionState, flowEpoch: number): boolean {
	return flowEpoch !== s.epoch
}
function releaseFlowIfOwner(s: SessionState, flowEpoch: number): void {
	if (s.activeFlowEpoch === flowEpoch) s.activeFlowEpoch = null
}
function clearAmbiguityTimer(s: SessionState): void {
	if (s.ambiguityTimer !== null) {
		clearTimeout(s.ambiguityTimer)
		s.ambiguityTimer = null
	}
}
function stopDiscovery(s: SessionState): void {
	try {
		s.cancelDiscovery?.()
	} catch {
		// best-effort
	}
	s.cancelDiscovery = null
	s.scanning.value = false
}
function claimantsOf(s: SessionState, id: string): DiscoveredWallet[] {
	return s.discoveredWallets.value.filter((w) => w.id === id)
}

/** Synchronous state wipe + terminal transition. SDK teardown of CAPTURED
 *  handles happens AFTER this, so an overlapping newer flow is never
 *  clobbered by an older teardown's awaits. */
function wipeToIdle(s: SessionState): void {
	s.epoch++
	clearAmbiguityTimer(s)
	stopDiscovery(s)
	cleanupSession(s)
	s.status.value = "idle"
	s.error.value = null
	s.activeFlowEpoch = null
	s.contractsReady.value = false
}

function cleanupSession(s: SessionState): void {
	if (s.unsubscribeDisconnect) {
		try {
			s.unsubscribeDisconnect()
		} catch {
			// best-effort
		}
		s.unsubscribeDisconnect = null
	}
	clearAmbiguityTimer(s)
	s.provider = null
	s.pending = null
	s.cancelDiscovery = null
	s.scanning.value = false
	s.pickerOpen.value = false
	s.providersByKey.clear()
	s.discoveredWallets.value = []
	s.connectingViaRemembered = false
	s.wallet.value = null
	s.accounts.value = []
	s.grantedContracts.value = []
	s.selectedAccount.value = null
	s.verificationEmojis.value = null
	s.pendingAccountChoice = null
	s.selectionNotices.value = []
	s.hiddenAccountsCount.value = 0
}

/** A flow that went stale AFTER the wallet-side session came to exist (post-confirm, or
 *  mid-setup) leaves a live session behind — disconnect it, best-effort. */
async function disconnectStaleSession(flowProvider: WalletProvider | null): Promise<void> {
	try {
		await flowProvider?.disconnect()
	} catch {
		// best-effort
	}
}

// ---------------------------------------------------------------------------------------------
// Discovery controller — scan, remembered auto-path, picker.
// ---------------------------------------------------------------------------------------------

/** Remembered-window fire: a sole claimant of the remembered id auto-connects; otherwise
 *  the picker shows — non-claimant wallets must never sit hidden for the full 60s
 *  discovery timeout. Best-effort detection only — the emoji verification remains the
 *  actual trust anchor. */
function fireRememberedWindow(s: SessionState, preferredId: string, flowEpoch: number): void {
	s.ambiguityTimer = null
	if (isStale(s, flowEpoch) || s.status.value !== "discovering") return
	const cs = claimantsOf(s, preferredId)
	if (cs.length === 1) {
		s.connectingViaRemembered = true
		void proceedWith(s, cs[0].key, flowEpoch)
	} else if (s.discoveredWallets.value.length > 0) {
		s.status.value = "choosing"
		s.pickerOpen.value = true
	}
}

async function connectImpl(s: SessionState, forcePicker: boolean): Promise<void> {
	if (s.activeFlowEpoch !== null || s.status.value === "connected") return
	sweepErroredResidue(s)
	const { flowEpoch, preferred } = openFlow(s, forcePicker)

	try {
		// Web (iframe) wallets exist only on the local target: the browser suite's test wallets. Every
		// shipped target lists none, so the iframe transport is never probed there.
		const webWalletUrls = resolveToolsTarget().webWalletUrls
		const manager = WalletManager.configure({
			extensions: { enabled: true },
			...(webWalletUrls?.length ? { webWallets: { urls: [...webWalletUrls] } } : {}),
		})
		const discovery = manager.getAvailableWallets({
			chainInfo: readChainInfo(),
			appId: s.config.appId,
			timeout: 60_000,
		})
		s.cancelDiscovery = discovery.cancel

		for await (const p of discovery.wallets) {
			// The SDK buffers yields past cancel() — the epoch check, not
			// cancellation, keeps a dismissed/superseded flow from
			// repopulating state. The status check stops the SAME flow's
			// buffered stragglers once a wallet has been selected
			// (verifying and beyond must not grow the list).
			if (isStale(s, flowEpoch) || (s.status.value !== "discovering" && s.status.value !== "choosing")) return
			admitAnnouncement(s, p, preferred, flowEpoch)
		}

		// Natural end of the stream (timeout/exhaustion) — not a cancel (that returns above).
		// The classifier is synchronous: the await and the throw stay here so the picker /
		// no-wallet paths complete in the same continuation they always did.
		const end = settleDiscoveryEnd(s, preferred, flowEpoch)
		if (end.kind === "proceed") {
			await proceedWith(s, end.key, flowEpoch)
			return
		}
		if (end.kind === "no-wallet") throw new Error("No wallet discovered")
	} catch (err) {
		if (isStale(s, flowEpoch)) return
		s.error.value = normalizeError(err)
		s.status.value = "error"
		cleanupSession(s)
		releaseFlowIfOwner(s, flowEpoch)
	}
}

/** Sweep any session residue from a previous ERRORED flow (retained
 *  provider/wallet/subscription): wipe synchronously, then best-effort
 *  disconnect the captured handle. Without this, "Retry connection"
 *  discovery runs over a live wallet session whose stale onDisconnect
 *  could later tear down the replacement. */
function sweepErroredResidue(s: SessionState): void {
	const staleProvider = s.provider
	if (s.provider || s.wallet.value || s.pending) {
		cleanupSession(s)
		if (staleProvider) {
			void staleProvider.disconnect().catch(() => {})
		}
	}
}

/** Claim a fresh flow epoch and reset the discovery state for it. */
function openFlow(s: SessionState, forcePicker: boolean): { flowEpoch: number; preferred: PreferredWallet | null } {
	const flowEpoch = ++s.epoch
	s.activeFlowEpoch = flowEpoch

	s.error.value = null
	s.connectingViaRemembered = false
	s.discoveredWallets.value = []
	s.providersByKey.clear()
	s.status.value = "discovering"
	s.scanning.value = true

	const preferred = forcePicker || s.autoReconnectDisabled.value ? null : readPreferred(s)
	s.pickerOpen.value = preferred === null
	return { flowEpoch, preferred }
}

/** One announcement: register the provider row, then either arm/collapse the remembered
 *  window (preferred path) or open the picker (fresh path). Synchronous. */
function admitAnnouncement(s: SessionState, p: WalletProvider, preferred: PreferredWallet | null, flowEpoch: number): void {
	// The SDK passes an announcement's claimed fields through unchecked, whatever their types say.
	const { id, name, icon }: { id: unknown; name: unknown; icon?: unknown } = p
	if (typeof id !== "string" || typeof name !== "string") return
	const row: DiscoveredWallet = { key: s.nextKey++, id, name, type: p.type, icon: typeof icon === "string" ? icon : undefined }
	s.providersByKey.set(row.key, p)
	s.discoveredWallets.value = [...s.discoveredWallets.value, row]

	if (preferred) {
		const claimants = claimantsOf(s, preferred.id)
		if (claimants.length >= 2) {
			// A second claimant to the remembered identity: fail closed —
			// kill the window, disable auto-reconnect for the session,
			// force the picker.
			clearAmbiguityTimer(s)
			s.autoReconnectDisabled.value = true
			if (s.status.value === "discovering") s.status.value = "choosing"
			s.pickerOpen.value = true
		} else if (s.ambiguityTimer === null && s.status.value === "discovering") {
			// FIRST announcement (claimant or not) opens the bounded
			// window. Discovery stays LIVE during it so buffered + late
			// announcements are seen — see fireRememberedWindow.
			s.ambiguityTimer = setTimeout(() => fireRememberedWindow(s, preferred.id, flowEpoch), REMEMBERED_AMBIGUITY_WINDOW_MS)
		}
	} else if (s.status.value === "discovering") {
		// Fresh path: the picker shows from the first announcement, waitless.
		s.status.value = "choosing"
	}
}

type DiscoveryEnd = { kind: "stale" } | { kind: "done" } | { kind: "proceed"; key: number } | { kind: "choosing" } | { kind: "no-wallet" }

/** Natural end of the discovery stream, classified synchronously (its own side effects
 *  applied): `proceed` hands the caller the sole remembered claimant to bind, `no-wallet` tells
 *  it to throw, `choosing` opened the picker, `done` means a selection already moved the flow on. */
function settleDiscoveryEnd(s: SessionState, preferred: PreferredWallet | null, flowEpoch: number): DiscoveryEnd {
	if (isStale(s, flowEpoch)) return { kind: "stale" }
	s.cancelDiscovery = null
	s.scanning.value = false
	clearAmbiguityTimer(s)

	if (s.status.value !== "discovering") return { kind: "done" }
	// Still no transition: either zero announcements, or the window
	// hadn't fired yet — resolve now.
	const soleClaimant = preferred ? claimantsOf(s, preferred.id) : []
	if (soleClaimant.length === 1) {
		s.connectingViaRemembered = true
		return { kind: "proceed", key: soleClaimant[0].key }
	}
	if (s.discoveredWallets.value.length > 0) {
		s.status.value = "choosing"
		s.pickerOpen.value = true
		return { kind: "choosing" }
	}
	return { kind: "no-wallet" }
}

/** User picks a row. Transitions SYNCHRONOUSLY so a double click (or a second panel's click,
 *  or a racing remembered-window timer) is a no-op. */
function selectWallet(s: SessionState, key: number): void {
	if (s.status.value !== "choosing" && s.status.value !== "discovering") return
	const flowEpoch = s.epoch
	clearAmbiguityTimer(s)
	s.connectingViaRemembered = false
	s.status.value = "verifying" // synchronous transition — closes every double-entry race
	s.pickerOpen.value = false
	void proceedWith(s, key, flowEpoch)
}

/** Shared tail of the remembered auto-path and manual selection: bind to ONE provider and
 *  open the secure channel. */
async function proceedWith(s: SessionState, key: number, flowEpoch: number): Promise<void> {
	const chosen = s.providersByKey.get(key)
	if (!chosen) {
		s.error.value = normalizeError(new Error("No wallet discovered"))
		s.status.value = "error"
		cleanupSession(s)
		releaseFlowIfOwner(s, flowEpoch)
		return
	}
	stopDiscovery(s)
	s.status.value = "verifying"
	s.pickerOpen.value = false
	s.provider = chosen

	try {
		const p = await chosen.establishSecureChannel(s.config.appId)
		if (isStale(s, flowEpoch)) {
			// Stale resolution: discard AND undo the SDK side effect on the
			// CAPTURED handle (the session fields may belong to a newer flow).
			try {
				await p.cancel()
			} catch {
				// best-effort
			}
			return
		}
		s.pending = p
		s.verificationEmojis.value = hashToEmoji(p.verificationHash)
	} catch (err) {
		if (isStale(s, flowEpoch)) return
		// A stale announcement (extension reloaded between announce and pick) fails here:
		// discard every provider object — none is re-usable — and surface a retryable error.
		if (s.connectingViaRemembered) clearPreferred(s)
		s.error.value = normalizeError(err)
		s.status.value = "error"
		cleanupSession(s)
		releaseFlowIfOwner(s, flowEpoch)
	}
}

/** Dismiss the picker: back to idle. An intentional cancel is never a `no-wallet` error.
 *  Valid from `choosing` AND from the open-while-scanning `discovering` state. */
function cancelChoice(s: SessionState): void {
	if (s.status.value !== "choosing" && s.status.value !== "discovering") return
	wipeToIdle(s)
}

// ---------------------------------------------------------------------------------------------
// Verification controller — the emoji match, cancels, disconnects, the switch affordance.
// ---------------------------------------------------------------------------------------------

async function confirmVerification(s: SessionState): Promise<void> {
	if (!s.pending) return
	const flowEpoch = s.epoch
	// Capture the flow's own handles: stale-cleanup must never dereference
	// the mutable session fields (a newer flow may own them by then).
	// `pending` is CLAIMED synchronously — the verification dialog renders
	// in multiple always-mounted panels, and two same-tick confirms would
	// otherwise both call confirm() and race competing wallet wrappers
	// over one MessagePort.
	const flowPending = s.pending
	const flowProvider = s.provider
	s.pending = null
	try {
		const w = await flowPending.confirm()
		if (isStale(s, flowEpoch)) {
			await disconnectStaleSession(flowProvider)
			return
		}
		s.wallet.value = w
		s.verificationEmojis.value = null
		// Subscribe AFTER confirm: before the wallet exists the SDK returns a
		// no-op unsubscriber and the callback never fires (the pre-existing
		// silent bug). The handler is a REMOTE interruption: it must bump the
		// epoch (stale-ify in-flight continuations like registerContracts)
		// and release the flow, or a late continuation could set "connected"
		// over the wiped state.
		s.unsubscribeDisconnect =
			flowProvider?.onDisconnect(() => {
				if (s.connectingViaRemembered) clearPreferred(s)
				wipeToIdle(s)
			}) ?? null
		s.status.value = "capability-approval"
		await requestCapabilities(s, flowEpoch)
	} catch (err) {
		if (isStale(s, flowEpoch)) return
		console.error(`[${s.config.appId}] confirmVerification failed`, err)
		if (s.connectingViaRemembered) clearPreferred(s)
		s.error.value = normalizeError(err)
		s.status.value = "error"
		cleanupSession(s)
		releaseFlowIfOwner(s, flowEpoch)
	}
}

async function cancelVerification(s: SessionState): Promise<void> {
	const stalePending = s.pending
	if (s.connectingViaRemembered) clearPreferred(s)
	wipeToIdle(s)
	// SDK teardown AFTER the synchronous wipe, on the captured handle — an
	// overlapping new flow can no longer be wiped by this await's tail.
	if (stalePending) {
		try {
			await stalePending.cancel()
		} catch {
			// best-effort
		}
	}
}

/** Returns whether the request actually ran: a caller waiting on a grant must be able to tell
 *  "the wallet was busy" from "the wallet answered", or a no-op reads as a refusal. */
async function retryCapabilities(s: SessionState): Promise<boolean> {
	if (!s.wallet.value) return false
	// Flow ownership: while the INITIAL capability request (or any other
	// flow) is live, retry is a no-op — concurrent requestCapabilities runs
	// could interleave grants/contract setup.
	if (s.activeFlowEpoch !== null) return false
	const flowEpoch = s.epoch
	s.activeFlowEpoch = flowEpoch
	s.error.value = null
	// A CONNECTED session asking for one more token stays connected on screen: the wallet's prompt
	// is the caller's own phase to narrate, and a panel that flips to "awaiting permissions" and
	// "setting up" reads as a connection lost and re-made. A retry from an error state walks the
	// statuses as a fresh connect does.
	const quiet = s.status.value === "connected"
	if (!quiet) s.status.value = "capability-approval"
	// A re-grant re-registers contracts; a send that raced the window would hit an unregistered
	// contract, so the readiness flag drops now and finishSetup raises it once registration lands.
	s.contractsReady.value = false
	await requestCapabilities(s, flowEpoch, quiet)
	return true
}

/** Quietly re-register the app's contracts on the current wallet, epoch-fenced exactly like
 *  `finishSetup`. No-op (`false`) when no wallet is set or another flow owns it. A completion that
 *  finds the session moved on returns `false` without publishing into the newer wallet; a genuine
 *  registration failure is published (`status = "error"`) and rethrown for the caller to surface. */
async function reregisterContracts(s: SessionState): Promise<boolean> {
	const flowWallet = s.wallet.value
	if (!flowWallet || s.activeFlowEpoch !== null) return false
	const flowEpoch = s.epoch
	s.activeFlowEpoch = flowEpoch
	s.contractsReady.value = false
	try {
		await s.config.registerContracts(flowWallet)
		if (isStale(s, flowEpoch)) return false
		s.contractsReady.value = true
		releaseFlowIfOwner(s, flowEpoch)
		return true
	} catch (err) {
		if (isStale(s, flowEpoch)) return false
		s.error.value = normalizeError(err)
		s.status.value = "error"
		releaseFlowIfOwner(s, flowEpoch)
		throw err
	}
}

export type RefreshOutcome = "refreshed" | "skipped" | "dropped"

function refreshBlocked(s: SessionState): boolean {
	return s.wallet.value === null || s.status.value !== "connected" || s.activeFlowEpoch !== null || Boolean(s.config.isSwitchBlocked?.())
}

/** Re-read the granted accounts (`getAccounts`, no prompt). A retry or a switch never advances the
 *  flow epoch, so completion is checked by state: the accounts array identity, the selection and
 *  the status must be what they were before the await. */
async function refreshAccounts(s: SessionState): Promise<RefreshOutcome> {
	if (refreshBlocked(s)) return "skipped"
	const wallet = s.wallet.value as Wallet
	const captured = s.accounts.value
	const selected = s.selectedAccount.value
	let raw: unknown
	try {
		raw = await wallet.getAccounts()
	} catch {
		return "skipped"
	}
	if (refreshBlocked(s) || s.accounts.value !== captured || s.selectedAccount.value !== selected) return "dropped"
	const { accounts, hiddenCount } = parseAccountList(Array.isArray(raw) ? raw : null, { keep: selected ?? undefined })
	if (accounts.length === 0) return "skipped"
	s.accounts.value = accounts
	s.hiddenAccountsCount.value = hiddenCount
	if (!accounts.some((a) => a.address === selected)) applySelection(s, accounts[0].address, s.provider)
	return "refreshed"
}

async function disconnect(s: SessionState): Promise<void> {
	const staleProvider = s.provider
	wipeToIdle(s)
	if (staleProvider) {
		try {
			await staleProvider.disconnect()
		} catch {
			// best-effort
		}
	}
}

/** The switch affordances: disconnect (if connected) + a forced-picker scan
 *  in ONE action. The stored preference is KEPT — cancelling the picker
 *  must not cost the user their remembered wallet; completing a connection
 *  overwrites it anyway. */
async function switchWallet(s: SessionState): Promise<void> {
	if (s.status.value === "connected") {
		await disconnect(s)
	}
	await connectImpl(s, true)
}

// ---------------------------------------------------------------------------------------------
// Capability controller — the grant request and the account choice.
// ---------------------------------------------------------------------------------------------

async function requestCapabilities(s: SessionState, flowEpoch: number, quiet = false): Promise<void> {
	const flowWallet = s.wallet.value
	const flowProvider = s.provider
	if (!flowWallet) return
	try {
		const manifest = await s.config.buildManifest()
		if (isStale(s, flowEpoch)) {
			await disconnectStaleSession(flowProvider)
			return
		}
		// SDK uses zod-inferred AppCapabilities; the manifest shape is structurally compatible
		// but the public type is not exported in a usable form. Single typed-boundary cast.
		// biome-ignore lint/suspicious/noExplicitAny: SDK manifest type is zod-inferred
		const result = await flowWallet.requestCapabilities(manifest as any)
		if (isStale(s, flowEpoch)) {
			await disconnectStaleSession(flowProvider)
			return
		}
		const { accounts: granted, hiddenCount } = parseGrantedAccounts(result, quiet ? { keep: s.selectedAccount.value ?? undefined } : {})
		// Published BEFORE the account step: an approval replaces the stored grant wholesale, so the
		// answer is authoritative even when the flow then pauses for a choice.
		s.grantedContracts.value = parseGrantedContracts(manifest, result)
		if (chooseGrantedAccount(s, granted, hiddenCount, flowWallet, flowProvider, flowEpoch, quiet) === "paused") return
	} catch (err) {
		if (isStale(s, flowEpoch)) return
		console.error(`[${s.config.appId}] requestCapabilities failed`, err)
		if (s.connectingViaRemembered) clearPreferred(s)
		s.error.value = normalizeError(err)
		s.status.value = "error"
		releaseFlowIfOwner(s, flowEpoch)
		return
	}
	await finishSetup(s, flowEpoch, flowWallet, flowProvider, quiet)
}

/** Apply the grant synchronously: publish it, reject an empty one (the caller's catch owns the
 *  error), disclose truncation, then either select (single account, or a remembered match) or
 *  pause the flow on the captured token for the choose-account modal. */
function chooseGrantedAccount(
	s: SessionState,
	granted: GrantedAccount[],
	hiddenCount: number,
	flowWallet: Wallet,
	flowProvider: WalletProvider | null,
	flowEpoch: number,
	quiet = false,
): "paused" | "chosen" {
	if (granted.length === 0) {
		throw new Error("No accounts granted by wallet")
	}
	// A re-grant on a CONNECTED session is not a fresh connect: the active account stands while the
	// wallet still grants it (no re-selection, no re-persist, no chooser). A grant that DROPPED it
	// pauses for a choice like a fresh connect — and while an operation holds the switch gate, only
	// the user may make that choice, once the gate opens (`confirmAccountChoice` honours the gate),
	// so the operation keeps the account it captured and nothing new starts under a revoked one.
	const active = s.selectedAccount.value
	if (quiet && active !== null && granted.some((a) => a.address === active)) {
		s.accounts.value = granted
		s.hiddenAccountsCount.value = hiddenCount
		return "chosen"
	}
	const gateHeld = quiet && Boolean(s.config.isSwitchBlocked?.())
	s.accounts.value = granted
	s.hiddenAccountsCount.value = hiddenCount
	if (hiddenCount > 0) {
		pushSelectionNotice(s, { kind: "grant-truncated", hiddenCount })
	}

	if (granted.length === 1 && !gateHeld) {
		applySelection(s, granted[0].address, flowProvider)
		return "chosen"
	}
	const remembered = flowProvider && !gateHeld ? readRememberedAccount(s, flowProvider.id) : null
	const match = remembered ? granted.find((a) => a.address === remembered) : undefined
	if (match) {
		// Remembered choice still in the grant: auto-apply, but SAY so — a visible
		// signal that a stored value picked the account.
		applySelection(s, match.address, flowProvider)
		pushSelectionNotice(s, { kind: "auto-remembered", alias: match.alias, address: match.address })
		return "chosen"
	}
	// Pause for the user. The flow stays OWNED (activeFlowEpoch keeps its value), so
	// retryCapabilities stays a no-op while the modal is up; confirm/cancel resume via the
	// captured token. An operation gate also prevents automatic selection.
	s.pendingAccountChoice = { flowEpoch, wallet: flowWallet, provider: flowProvider }
	s.status.value = "choosing-account"
	return "paused"
}

// ---------------------------------------------------------------------------------------------
// Setup controller — post-approval contract registration, the account modal, switching, reset.
// ---------------------------------------------------------------------------------------------

/** Shared post-selection tail for BOTH the auto path and the choose-account confirm path.
 *  Owns its errors identically for both callers — it never throws. */
async function finishSetup(
	s: SessionState,
	flowEpoch: number,
	flowWallet: Wallet,
	flowProvider: WalletProvider | null,
	/** A re-grant on a session that is already connected: the status stays put throughout. */
	quiet = false,
): Promise<void> {
	s.contractsReady.value = false
	try {
		// The user already clicked Approve - we're now doing post-approval setup (registering
		// contracts with the wallet's PXE). This can take 2-4s, so a dedicated state keeps the
		// UI from saying "Awaiting permissions".
		if (!quiet) s.status.value = "setting-up"
		await s.config.registerContracts(flowWallet)
		if (isStale(s, flowEpoch)) {
			await disconnectStaleSession(flowProvider)
			return
		}

		s.contractsReady.value = true
		s.status.value = "connected"
		// Persist only on full success: a wallet that never completed a connect is never remembered.
		if (flowProvider && shouldPersistPreferred(s, flowProvider)) writePreferred(s, { id: flowProvider.id, name: flowProvider.name })
		s.connectingViaRemembered = false
		releaseFlowIfOwner(s, flowEpoch)
	} catch (err) {
		if (isStale(s, flowEpoch)) return
		console.error(`[${s.config.appId}] finishSetup failed`, err)
		if (s.connectingViaRemembered) clearPreferred(s)
		s.error.value = normalizeError(err)
		s.status.value = "error"
		releaseFlowIfOwner(s, flowEpoch)
	}
}

/** The choose-account modal's Confirm. Claims the pause token SYNCHRONOUSLY (double-confirm
 *  and racing panels are no-ops), validates the address against the LIVE grant, then resumes
 *  the connect flow. The selection is persisted BEFORE setup so a setup failure + retry
 *  auto-applies it instead of re-prompting. */
async function confirmAccountChoice(s: SessionState, address: string): Promise<void> {
	if (s.status.value !== "choosing-account") return
	// The same gate as selectAccount: a choice is a switch, and an operation that started while the
	// chooser was up still owns the account it captured. The chooser stays up; confirm again later.
	if (s.selectedAccount.value !== null && s.config.isSwitchBlocked?.()) return
	const token = s.pendingAccountChoice
	if (!token || isStale(s, token.flowEpoch)) return
	if (!s.accounts.value.some((a) => a.address === address)) return
	s.pendingAccountChoice = null // synchronous claim — closes every double-entry race
	applySelection(s, address, token.provider)
	await finishSetup(s, token.flowEpoch, token.wallet, token.provider)
}

/** Dismiss the choose-account step: abandoning the choice cancels the CONNECT (same semantics
 *  as cancelVerification — a half-connected session must not linger). SDK teardown happens
 *  AFTER the synchronous wipe, on the token's captured handle. */
async function cancelAccountChoice(s: SessionState): Promise<void> {
	if (s.status.value !== "choosing-account") return
	const token = s.pendingAccountChoice
	s.pendingAccountChoice = null
	wipeToIdle(s)
	if (token?.provider) {
		try {
			await token.provider.disconnect()
		} catch {
			// best-effort
		}
	}
}

/** Post-connect account switching. Gated at the MUTATION BOUNDARY: rejects unless
 *  connected, the address is in the live grant, and no tracked operation is in flight. Returns
 *  whether the switch applied — the UI toasts on true. */
function selectAccount(s: SessionState, address: string): boolean {
	if (s.status.value !== "connected") return false
	if (s.config.isSwitchBlocked?.()) return false
	if (!s.accounts.value.some((a) => a.address === address)) return false
	applySelection(s, address, s.provider)
	return true
}

/** Reset all state (test helper + hard reset). Live SDK handles get the
 *  same best-effort teardown as the production paths — a hard reset must
 *  not leak a pending channel or a connected provider session. */
function reset(s: SessionState): void {
	s.autoReconnectDisabled.value = false
	const stalePending = s.pending
	const staleProvider = s.provider
	wipeToIdle(s)
	// Promise.resolve tolerates both promise-returning and void-typed SDK
	// teardown signatures; try/catch covers synchronous throws.
	try {
		if (stalePending) void Promise.resolve(stalePending.cancel()).catch(() => {})
	} catch {
		// best-effort
	}
	try {
		if (staleProvider) void Promise.resolve(staleProvider.disconnect()).catch(() => {})
	} catch {
		// best-effort
	}
}

interface GrantedAccountsCap {
	type: "accounts"
	accounts?: Array<{ alias?: unknown; item?: { toString(): string } | string } | null>
}

export interface ParsedGrantedAccounts {
	readonly accounts: GrantedAccount[]
	/** Valid, deduped accounts dropped by the MAX_GRANTED_ACCOUNTS cap — disclosed to the user. */
	readonly hiddenCount: number
}

/**
 * Hardened grant parsing: the capability result is WALLET-CONTROLLED input.
 * Per entry, inside try/catch: the address must round-trip `AztecAddress.fromStringUnsafe` —
 * syntactic + canonical-form validation ONLY, NOT curve validity (authorization is enforced
 * wallet-side per RPC); a throwing `toString` or malformed entry is skipped, never a crash.
 * Aliases are sanitized (control/bidi strip) and capped; addresses deduped (first wins); the
 * list is bounded with DISCLOSED truncation.
 */
export function parseGrantedAccounts(result: unknown, opts: { keep?: string } = {}): ParsedGrantedAccounts {
	return parseAccountList(findGrantedAccountEntries(result), opts)
}

/** The same hardening over a bare entry list — what `getAccounts` answers (no grant envelope). */
export function parseAccountList(
	entries: NonNullable<GrantedAccountsCap["accounts"]> | null,
	opts: { keep?: string } = {},
): ParsedGrantedAccounts {
	if (!entries) return { accounts: [], hiddenCount: 0 }

	const seen = new Set<string>()
	const accounts: GrantedAccount[] = []
	let hiddenCount = 0
	// The alias is untrusted text: it is only sanitized for an entry that takes a displayed slot.
	const displayed = (entry: { alias?: unknown } | null, address: string): GrantedAccount => {
		const rawAlias = typeof entry?.alias === "string" ? entry.alias : ""
		return { address, alias: sanitizeWalletName(rawAlias) }
	}
	for (const entry of entries) {
		const address = parseEntryAddress(entry)
		if (address === null) continue
		if (seen.has(address)) continue
		seen.add(address)
		if (accounts.length < MAX_GRANTED_ACCOUNTS) {
			accounts.push(displayed(entry, address))
			continue
		}
		hiddenCount++
		// The selected account stays listed even when the cap would drop it: the wallet's ordering
		// must never move the selection out from under the user.
		if (address === opts.keep) accounts[accounts.length - 1] = displayed(entry, address)
	}
	return { accounts, hiddenCount }
}

/** The accounts capability's entry list out of the wallet-controlled result; null when absent
 *  or malformed at any level. */
function findGrantedAccountEntries(result: unknown): NonNullable<GrantedAccountsCap["accounts"]> | null {
	const cap = findGrantedCapability(result, "accounts") as GrantedAccountsCap | null
	if (!cap?.accounts || !Array.isArray(cap.accounts)) return null
	return cap.accounts
}

/** Per-entry address projection: round-trip `AztecAddress.fromStringUnsafe` — syntactic +
 *  canonical-form validation ONLY; a throwing `toString` or malformed entry yields null (skip). */
function parseEntryAddress(entry: { item?: { toString(): string } | string } | null): string | null {
	try {
		const raw = typeof entry?.item === "string" ? entry.item : (entry?.item?.toString() ?? "")
		return AztecAddress.fromStringUnsafe(raw).toString()
	} catch {
		return null
	}
}

/** Back-compat projection of parseGrantedAccounts (existing call sites and tests). */
export function extractGrantedAccounts(result: unknown): GrantedAccount[] {
	return parseGrantedAccounts(result).accounts
}

/** One capability object out of the wallet-controlled result, by type. */
function findGrantedCapability(result: unknown, type: string): Record<string, unknown> | null {
	if (!result || typeof result !== "object") return null
	const granted = (result as { granted?: unknown[] }).granted
	if (!Array.isArray(granted)) return null
	const cap = granted.find((c) => typeof c === "object" && c !== null && (c as { type?: unknown }).type === type)
	return (cap as Record<string, unknown>) ?? null
}

/** A granted contract entry is a plain address (string or address-like); null when it is neither. */
function parseContractAddress(entry: unknown): string | null {
	try {
		const raw = typeof entry === "string" ? entry : ((entry as { toString(): string } | null)?.toString() ?? "")
		return AztecAddress.fromStringUnsafe(raw).toString().toLowerCase()
	} catch {
		return null
	}
}

/** A `"*"` on either side — a whole contract list, a whole scope, or a pattern's own contract or
 *  function. The app never asks for one, so a wildcard is a shape it cannot attribute to any token;
 *  reading it as "everything is granted" would turn an odd answer into a permission upgrade. */
const WILDCARD = "*"

/** Bound on the scope entries kept from ONE side — the answer is wallet-controlled input. Overflow
 *  can only shrink a grant, since a requested scope missing from the answer reads as a refusal. */
const MAX_SCOPE_ENTRIES = 4_096

type ScopeBucket = "transaction" | "simulation.transactions" | "simulation.utilities"

/** One side of the handshake, flattened: the contracts it names, and per contract the
 *  `<bucket>:<function>` scopes it carries. */
interface CapabilityScopes {
	contracts: string[]
	scopes: Map<string, Set<string>>
	wildcard: boolean
	entries: number
}

/** The app's request and the wallet's answer carry the same capability shapes, so ONE reader covers
 *  both sides of the comparison. */
function collectCapabilityScopes(list: unknown): CapabilityScopes {
	const out: CapabilityScopes = { contracts: [], scopes: new Map(), wildcard: false, entries: 0 }
	if (!Array.isArray(list)) return out
	for (const cap of list) {
		const entry = cap as { type?: unknown; contracts?: unknown; scope?: unknown; transactions?: unknown; utilities?: unknown } | null
		if (entry?.type === "contracts") readContractList(entry.contracts, out)
		else if (entry?.type === "transaction") readScope(entry.scope, "transaction", out)
		else if (entry?.type === "simulation") {
			readScope((entry.transactions as { scope?: unknown } | undefined)?.scope, "simulation.transactions", out)
			readScope((entry.utilities as { scope?: unknown } | undefined)?.scope, "simulation.utilities", out)
		}
	}
	return out
}

function readContractList(value: unknown, out: CapabilityScopes): void {
	if (value === WILDCARD) {
		out.wildcard = true
		return
	}
	if (!Array.isArray(value)) return
	for (const entry of value) {
		if (out.contracts.length >= MAX_GRANTED_CONTRACTS) return
		const address = parseContractAddress(entry)
		if (address !== null && !out.contracts.includes(address)) out.contracts.push(address)
	}
}

function readScope(scope: unknown, bucket: ScopeBucket, out: CapabilityScopes): void {
	if (scope === WILDCARD) {
		out.wildcard = true
		return
	}
	if (!Array.isArray(scope)) return
	for (const pattern of scope) {
		if (out.entries >= MAX_SCOPE_ENTRIES) return
		const entry = pattern as { contract?: unknown; function?: unknown } | null
		if (entry?.contract === WILDCARD || entry?.function === WILDCARD) {
			out.wildcard = true
			return
		}
		const address = parseContractAddress(entry?.contract)
		if (address === null || typeof entry?.function !== "string") continue
		const keys = out.scopes.get(address) ?? new Set<string>()
		keys.add(`${bucket}:${entry.function}`)
		out.scopes.set(address, keys)
		out.entries++
	}
}

/** Every scope the request named for one contract must come back. A wallet that grants the contract
 *  but drops its transaction or simulation scopes has not granted what the app needs on it, and a
 *  deposit sent on that answer would only discover the hole at the Aztec claim. */
function scopesSatisfied(address: string, request: CapabilityScopes, answer: CapabilityScopes): boolean {
	const wanted = request.scopes.get(address)
	if (!wanted) return true
	const given = answer.scopes.get(address)
	if (!given) return false
	for (const key of wanted) {
		if (!given.has(key)) return false
	}
	return true
}

function capabilityListOf(source: unknown, key: "capabilities" | "granted"): unknown {
	if (!source || typeof source !== "object") return null
	return (source as Record<string, unknown>)[key]
}

/**
 * The contracts the app may act on: the requested manifest INTERSECTED with the wallet's answer,
 * lowercased, in request order. Membership in the answer's contract list is not enough — a contract
 * counts only when every scope the request named for it came back too. A contract the app never
 * asked for is ignored, and a `"*"` on either side yields nothing at all.
 *
 * Same per-entry hardening as the account list: every address round-trips
 * `AztecAddress.fromStringUnsafe`, and a malformed entry is skipped rather than crashing the connect.
 */
export function parseGrantedContracts(request: unknown, result: unknown): string[] {
	const requested = collectCapabilityScopes(capabilityListOf(request, "capabilities"))
	const answered = collectCapabilityScopes(capabilityListOf(result, "granted"))
	if (requested.wildcard || answered.wildcard) return []
	const granted = new Set(answered.contracts)
	return requested.contracts.filter((address) => granted.has(address) && scopesSatisfied(address, requested, answered))
}
