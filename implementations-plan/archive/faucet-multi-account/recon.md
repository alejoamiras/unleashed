# Recon — faucet-multi-account

Phase 0.4 findings, consolidated from 3 parallel read-only subagents (faucet account handling · wallet↔dApp protocol · design system), re-verified against the base branch.

## Verdict on the premise

**Confirmed.** The faucet receives the full granted-accounts array but hardcodes `selectedAccount = granted[0]` and never exposes a setter or picker. Not theoretical: the Nulo wallet's capability approval is a real multi-select — users can grant 2+ accounts today, and the faucet silently drops all but the first.

## What exists (files + purpose)

| File | Purpose |
|---|---|
| `apps/faucet/src/composables/createAztecWalletSession.ts` | Session factory: discover → choose wallet → verify emoji → capabilities → register contracts → connected. Epoch-based cancellation model. `accounts` (array) + `selectedAccount` (hardcoded `granted[0]` at :524). |
| `apps/faucet/src/composables/useWalletConnection.ts` | Module-level singleton session, shared by ALL tabs. |
| `apps/faucet/src/composables/useBridgeWallet.ts` | **Pure re-export** of `useWalletConnection` — Bridge/Fuel read the SAME session. |
| `apps/faucet/src/components/WalletPanel.vue` | Connect button, split-button (▾ caret precedent), connected chip (`AZTEC` label + AddressDisplay + ✕). |
| `apps/faucet/src/components/BridgeWalletPanel.vue` | Bridge-tab twin of the chip. |
| `apps/faucet/src/components/WalletPickerModal.vue` | Row-list modal grammar (icon-square / name / badge / action button) — the template for account rows. |
| `apps/faucet/src/components/VerificationModal.vue` | Overlay+modal grammar (scrim, sharp corners, uppercase title). |
| `apps/faucet/src/composables/useToast.ts` | Toast queue (`push({kind, text})`) for switch feedback. |
| `apps/faucet/src/lib/testids.ts` | Central `fa-*` testid catalog — new IDs go here. |
| `packages/design/src/ui/Popover.vue` | Exported from `@unleashed/design` (index.ts:32). The system's ONE rounded (10px) floating surface. Unused in faucet so far. |

## Protocol facts (wallet ↔ dApp)

- `requestCapabilities()` returns `GrantedAccountsCapability.accounts: Aliased<AztecAddress>[]` — a LIST with per-account `alias` (aztec.js `wallet/capabilities.ts:73-76`). Faucet parses it via `extractGrantedAccounts()` (:639-651), incl. alias. Unit-tested for 2 accounts (`useWalletConnection.test.ts:324-340`).
- Every account-touching RPC takes an explicit per-call `from` (`SendOptionsSchema`/`SimulateOptionsSchema`); the wallet validates `from` against the session's authorized set. **No wallet-side "active account" exists for dApps — selection is purely dApp state.**
- **No `accountsChanged` event** exists at any layer.
- **Re-requesting capabilities never re-opens the account picker** — the wallet compares capability shape only, not the account set. "Request more accounts later" requires wallet changes → OUT of scope.

## Reuse-as-is

- `Popover` (`@unleashed/design`) — the dropdown surface. `AddressDisplay` — truncated address chip w/ copy. `useToast` — switch feedback. `truncateName()` — code-point-safe alias capping. Modal overlay CSS grammar from `WalletPickerModal.vue`/`VerificationModal.vue` (scoped styles are per-component; copy the ~20-line pattern, as those two already do between themselves).
- Persistence pattern: `readPreferred`/`writePreferred`/`clearPreferred` (`createAztecWalletSession.ts:133-162`) — validated JSON in localStorage, best-effort try/catch, capped strings. Clone it for the selected-account memory.
- Pause-for-user-input flow pattern: the emoji-verification step (`confirmVerification`, :384-431) — captured handles + epoch check + synchronous claim. The choose-account step is the same shape.

## Adapt-with-changes

- `ConnectStatus` union (:13) — add `"choosing-account"`. Consumers that branch on status must be swept: `WalletPanel.vue` (`connectLabel`, `showConnectButton`), `BridgeWalletPanel.vue`, `FaucetView.vue`, `BridgeForm.vue:90` (watches `[status, selectedAccount]`), `ConnectionErrorStrip`.
- Chip markup in `WalletPanel.vue:70-82` + `BridgeWalletPanel.vue:55-57` — replaced by one shared `AccountSwitcher.vue`.

## Consumer semantics (why switching is safe)

All action paths read `selectedAccount.value` AT ACTION TIME and capture it for the operation's lifetime: `useWithdraw.ts:190`, `useFuel.ts:72`, `BridgeAddToken.vue:65`, `useDeposit.ts:273,644`, `FaucetView.vue:20` (computed → drip `from:`). An in-flight op keeps its captured account; the next op uses the new one. `BridgeForm.vue:90` already watches `selectedAccount` and resets its form state on change.

## Collision / dedup risks

- Don't build a second modal primitive — reuse the established overlay grammar, not a new Dialog component in `@unleashed/design`.
- Don't add an avatar/identicon system — the design system has none; the row's bordered initials-square (WalletPickerModal `.icon.fallback` pattern) is the sanctioned placeholder.

## Design-system tokens for the new UI

Trigger chip: 0-radius, 1px solid border in the earlier outline token, mono-uppercase net label. Dropdown: `Popover` — `border-radius:10px`, `var(--dropdown-bg)`, its exact shadow recipe. Rows: alias (600/13px) over mono truncated address, mint check for active. Modal: scrim `rgba(0,0,0,.7)`, sharp surface, `SPACE GROTESK` uppercase title, `primary` Button for Continue. Motion: 80ms linear dropdown fade (`.dropdown-enter-active`), 150-200ms eases elsewhere.
