## Outcome

Archived. Seeds retired.

# Plan — faucet-multi-account (v4 FINAL, post codex rounds 1–3 — VERDICT: conditional approve, conditions folded)

> **APPROVED by user (unconditional).** Scope, tier, validation layers, and the four folded judgment calls (D-6, D-8, D-24, D-11/D-12 residual) all confirmed as planned. Seeds below are FINAL.

**Tier**: `/blueprint light` (rubric: 0 HIGH — no novelty [SDK-documented pattern], contained blast radius [one app], nothing irreversible, no migrations, no new external coupling, moderate-not-high security sensitivity [testnet assets]).
**UX direction**: Proposal D (choose-on-connect + quiet dropdown), selected by the user from four proposals.
**eli5_mode**: Artifact (session has the Artifact tool; plan is not sensitive).

## Summary

The wallet can grant the faucet several accounts; today the app silently uses `granted[0]` and hides the rest. This plan adds: (1) a **choose-main-account step** in the connect flow, shown only when >1 account is granted and no valid remembered choice exists; (2) a **chip dropdown switcher** available while connected, with toast feedback; (3) **per-wallet persistence** of the choice (bounded map — A→B→A remembers both). The selected account drives **all tabs** (one shared session singleton). dApp-side only; no wallet/protocol/design-package changes.

## User decisions (Phase 0 answers)

- UX: **Proposal D**, incl. the always-available "change afterwards" path (chip dropdown).
- Scope: **All tabs** — one session, one active account.
- Persistence: **Remember per wallet** (localStorage).
- Validation: **typecheck + lint + unit on every phase gate**; **`audit:faucet` aggregate** final. (Faucet e2e suite not selected.)
- Post-impl hardening: not scheduled.

## Architecture & Implementation

### Shape

State logic lands in the existing session factory (`apps/faucet/src/composables/createAztecWalletSession.ts`) — the singleton propagates everywhere. Two new components + one tiny shared busy-registry composable in `apps/faucet/src/`. No `@unleashed/design` changes (see Popover decision in the ledger).

### Session layer (`createAztecWalletSession.ts`)

1. **`ConnectStatus` gains `"choosing-account"`** — entered from `requestCapabilities()` when `granted.length > 1` and no valid remembered choice; exited by `confirmAccountChoice(address)` → `"setting-up"` → `"connected"`, or `cancelAccountChoice()` → idle.

2. **Explicit single-use pause token** (codex R1): non-reactive module var `pendingAccountChoice: { flowEpoch: number; wallet: Wallet; provider: WalletProvider | null } | null`, mirroring the verification step's `pending` claim discipline:
   - On pause: `requestCapabilities` sets the token, sets `status = "choosing-account"`, and RETURNS — `activeFlowEpoch` stays owned (concurrent `retryCapabilities` stays a no-op).
   - `confirmAccountChoice(address)`: no-ops unless `status === "choosing-account"` AND the token exists AND `address ∈ accounts.value`. Claims the token SYNCHRONOUSLY (null it, set `"setting-up"`) before any await — double-confirm and racing panels are no-ops — then runs the shared setup tail with the token's captured handles, stale-checking on `flowEpoch`.
   - `cancelAccountChoice()`: claims the token, `wipeToIdle()`, then best-effort `provider.disconnect()` on the CAPTURED handle (post-wipe, per the file's teardown ordering rule).
   - Shared tail `finishSetup(flowEpoch, flowWallet, flowProvider)`: registerContracts → `"connected"` → persist preferred wallet (success only, existing behavior) → release flow. Used by BOTH the auto path and the confirm path. **finishSetup owns error handling for both callers identically** (codex R2): catch → stale-check → `normalizeError`, `status = "error"`, `clearPreferred()` if `connectingViaRemembered`, `releaseFlowIfOwner`. **Selection ordering (fixes v2's contradiction): `selectedAccount` is set AND the selection persisted at selection time — auto-select or confirm click — BEFORE `finishSetup` runs.** If the confirm path fails in setup, `retryCapabilities` re-grants and the now-remembered selection auto-applies — the user is never re-prompted by the modal for a setup failure.
   - `cleanupSession()` nulls the token (a wallet-side disconnect during the modal already routes through `onDisconnect → wipeToIdle`, which bumps the epoch and closes the modal via status).

3. **Grant-resolution logic** (replaces `granted[0]`):
   - 0 valid accounts → error (existing path).
   - 1 → auto-select, persist, `finishSetup`.
   - >1: remembered lookup by the connected provider's id; hit AND address ∈ granted → auto-select, persist (refresh recency), `finishSetup`, and fire a "Using account …" toast from the UI layer (visible signal that a remembered auto-selection happened — codex R1 storage-tamper mitigation). Miss → pause as above.

4. **`selectAccount(address): boolean`** — requires `status === "connected"`, `address ∈ accounts.value`, AND `!config.isSwitchBlocked?.()` (codex R2 — **the busy gate is enforced at the mutation boundary**, not only in the UI: the session config gains an optional `isSwitchBlocked?: () => boolean`, wired by `useWalletConnection` to the ops-in-flight registry; the factory stays generic and the gate is unit-testable via DI). Valid → set `selectedAccount`, persist, return `true`; else `false`, state untouched.

5. **Hardened grant parsing** (codex R1+R2): `extractGrantedAccounts` validates per entry inside try/catch — address must round-trip via `AztecAddress.fromStringUnsafe(s).toString()` (**the codebase's actual API — 45 call sites; `fromString` does not exist in this Aztec version.** Validation level, stated precisely per codex R3 condition 3: **syntactic + canonical form ONLY — this does NOT prove curve validity**; a syntactically valid, curve-invalid address can pass. The wallet's per-RPC `from` check proves AUTHORIZATION, not note-receivability. Acceptable residual for a testnet faucet selecting among WALLET-PROVIDED addresses; parser acceptance of a PROVABLY curve-invalid address (0x…03, `isValid() === false`) is unit-tested — the RPC-level rejection path itself is not separately tested [codex-noted residual, D-41]). Skip invalid / throwing `toString`; alias must be a string, else `""`; strip control + bidi-override characters; cap alias via `truncateName(alias, 48)` at parse time; dedupe by address (first wins); cap the list at `MAX_GRANTED_ACCOUNTS = 16` — **truncation is DISCLOSED, not silent** (codex R2): a warning toast on connect + a non-interactive "Showing 16 of N granted accounts" row in both the choice modal and the switcher menu. Zero valid entries → the existing "No accounts granted" error.

6. **Per-wallet persistence map** (codex R1 — single record fails A→B→A): key `` `${config.appId}:selected-accounts` ``, value an array of `[walletId, address]` pairs, most-recent-first, capped at 8 (LRU by re-insertion). **Both read AND write paths cap the list, dedupe wallet ids, and bound string lengths; writes rebuild the array atomically (filter-out + unshift + slice) before one `setItem`** (codex R2). Read path validates JSON shape and NEVER trusts content beyond pre-selection: the address must be in the CURRENT grant and the walletId must equal the CONNECTED provider's id at lookup time. Written on every successful selection (incl. auto-single — see ledger D-6). Not cleared on disconnect.

### Consumer correctness under switching (codex R1 CRITICAL — new Phase 2)

Verified consumer semantics at base:
- `TokenCard.vue:25-28` computes `connected` ONCE at setup and creates `useTokenBalance`/`useFaucetDrip` with the mount-time account; `FaucetView.vue:51` keys cards on `` `${symbol}:${on|off}` `` only → **a switch would leave drips bound to the OLD account while the chip shows the new one**.
- `BridgeForm.vue:90` watcher only disposes/recreates the L2 balance handle — amount/stage/receipt survive an account change.
- The bridge journal's `connectedAztec` is a LIVE getter (`useDeposit.ts:273`) — journal scoping follows the current account; deposit-leg recovery is record-based (`rec.depositTxHash`).

Fixes:
1. **FaucetView card key includes the account**: `` `${symbol}:${accountAddress ?? "off"}` `` — the existing "key flips for a clean remount" design, extended. Switch = clean remount per account.
2. **BridgeForm resets transient form state on ACCOUNT change** (amount, stage, receipt/settled display, errors) — **routed through the existing ownership-release path, not ad-hoc field zeroing** (codex R2): `journal.releaseForeground(ownedId)` + `ownedId = null` (the same sequence the form's adopt/dismiss paths use at `BridgeForm.vue:320-335`), so foreground suppression is never stranded on a record the form no longer owns.
3. **Switching is disabled while an operation is in flight** (codex R1 ask, option chosen): new module-scope composable `useOpsInFlight` exposing **`withOperation<T>(fn: () => Promise<T>)`** — acquire before, release in `finally`, idempotent per invocation (codex R2: helper, not raw counter calls) — plus a `busy` computed. **Wrap sites (the invariant: every account-sensitive wallet prompt/send span): drip (`useFaucetDrip`), deposit, withdraw, fuel claim, faucet add-token (`useFaucetAddToken`), bridge add-token (`BridgeAddToken`), journal-card retry/claim actions, and the SPAWNED journal continuations — each `runDepositClaim`/`runWithdrawConsume` promise individually, NOT the synchronous fire-and-forget `resumeSessionWork()` dispatcher, which would release immediately (codex R3 condition 1). Mid-operation switch rejection is tested across this matrix.** Implementation includes a grep sweep over `apps/faucet/src` for wallet RPC call sites to prove coverage (logged in lessons). Enforcement is TWO-layer: `AccountSwitcher` renders rows disabled with hint copy "Finish the current operation to switch" (UX), AND `selectAccount` itself rejects via the injected `isSwitchBlocked` (session boundary — codex R2). In-flight ops always complete under their captured account; journal records carry their recipient.
4. **Journal characterization test**: switching accounts re-scopes the visible journal to the new account (live-getter semantics, consistent with the wallet's account-siloing precedent) and recovery still works record-based after a switch.

### UI layer

1. **`ChooseAccountModal.vue`** (new) — mounted ONCE at app level in `App.vue` (like WalletPickerModal); rendered when `status === "choosing-account"`. Overlay grammar of the existing modals. Title `CHOOSE MAIN ACCOUNT`; sub "Your wallet shared N accounts. Pick the one this app should use — you can switch anytime from the account chip."; rows = radiogroup (`role="radiogroup"`/`role="radio"`, roving tabindex, first row initially focused + pre-selected), each row: initials-square (first 2 hex chars), alias or `—`, truncated mono address; `Continue` primary button confirms; Esc/backdrop → `cancelAccountChoice()` (abandoning the choice cancels the connect — matches cancelVerification). `aria-labelledby` the title; focus returns to the connect area on close (match VerificationModal's handling).
2. **`AccountSwitcher.vue`** (new, shared by both panels) — replaces chip markup in `WalletPanel.vue` + `BridgeWalletPanel.vue`. Trigger: ONE `<button aria-expanded aria-haspopup="menu">` chip — `AZTEC` label + alias + truncated address as PLAIN TEXT (no nested interactive elements; codex R1 — `AddressDisplay` is itself a button) + `▾`. Menu: **local dropdown** (scoped CSS reproducing the design system's Popover recipe: 10px radius, `var(--dropdown-bg)`, its exact shadow, 80ms fade; absolutely positioned under the chip inside a `position:relative` wrapper — no teleport). Header `GRANTED ACCOUNTS · N`; rows: each `<li>` is a flex WRAPPER containing a selection `<button role="menuitemradio">` (mint ✓ on active, alias + plain-text truncated address, flex:1) and a SIBLING copy icon-button — **never a button inside a button** (codex R2; same fix as the trigger). Footer `Disconnect` (red hover). **The menu renders for single-account sessions too** (one checked row + Disconnect) — Disconnect must never disappear (codex R1). Row click → `selectAccount` (busy-gated at both layers) → close + toast `Active account: <alias or short-addr>` fired by the CLICKED switcher instance; the remembered-auto-selection and grant-truncation toasts have a SINGLE owner — a module-level watcher in `useWalletConnection.ts` (one module instance) — so the three always-mounted panels can't triple-fire them (codex R2). **The watcher does NOT infer from status changes: the session exposes an explicit one-shot `selectionNotice` ref — `{ key: number (monotonic); kind: "auto-remembered" | "grant-truncated"; alias?: string; address?: string; hiddenCount?: number } | null` — set by the session at the triggering moment, consumed exactly once by key, cleared in `cleanupSession()`; exactly-once emission and reset are unit-tested (codex R3 condition 2).** Menu a11y detail: `<li>` wrappers get `role="none"`; copy buttons sit outside the menuitemradio roving-tabindex model and are reachable via Tab, documented in the component (codex R3 LOW). Esc closes; click-outside closes; focus back to chip.
3. **Status-branch sweep** — `"choosing-account"` handled at every status branch: `WalletPanel.connectLabel` ("Choose your account"), `showConnectButton` excludes it, `BridgeWalletPanel` equivalents, `ConnectionErrorStrip`, `FaucetView` (cards stay unmounted until `"connected"`), `BridgeForm` watcher unaffected (fires on `selectedAccount` change only after connect).
4. **testids** (`lib/testids.ts`): `accountChoice`, `accountChoiceRow`, `accountChoiceContinue`, `accountChip`, `accountMenu`, `accountMenuRow`, `accountMenuDisconnect`. The choice modal is app-level-mounted exactly once → no duplicate-testid ambiguity; `accountChip` appears once per panel (existing chips already duplicate `fa-account` across panels — e2e selectors scope by tab).

### Data & control flow (critical path)

Connect: grant parsed/hardened → [1 valid → auto | remembered(walletId) valid → auto + toast | else `"choosing-account"` → user picks → `confirmAccountChoice`] → persist → `finishSetup` (register contracts) → `"connected"`. Switch: chip → row → busy-gate → `selectAccount` → `selectedAccount` updates → FaucetView cards remount on new key, BridgeForm resets + re-handles, journal re-scopes via live getter → persist → toast.

### File-level change map

| File | Change |
|---|---|
| `apps/faucet/src/composables/createAztecWalletSession.ts` | Status union, pause token + finishSetup tail, grant hardening, persistence map, selectAccount |
| `apps/faucet/src/composables/useOpsInFlight.ts` | NEW (~30 lines) |
| `apps/faucet/src/components/ChooseAccountModal.vue` | NEW |
| `apps/faucet/src/components/AccountSwitcher.vue` | NEW (local dropdown per Popover recipe) |
| `apps/faucet/src/components/WalletPanel.vue` | Chip → AccountSwitcher; status sweep |
| `apps/faucet/src/components/BridgeWalletPanel.vue` | Chip → AccountSwitcher; status sweep |
| `apps/faucet/src/views/FaucetView.vue` | Card `:key` includes account |
| `apps/faucet/src/components/BridgeForm.vue` | Account-change form reset |
| `apps/faucet/src/composables/{useFaucetDrip,useDeposit,useWithdraw,useFuel}.ts` | acquire/release busy spans |
| `apps/faucet/src/App.vue` | Mount ChooseAccountModal; fix stale "independent sessions" comment |
| `apps/faucet/src/lib/testids.ts` | +7 testids |
| Tests | Extend `createAztecWalletSession.test.ts` (EXISTS at base — factory-level suite) + `useWalletConnection.test.ts`; update both panel tests; NEW `ChooseAccountModal.test.ts`, `AccountSwitcher.test.ts`; journal/BridgeForm switch tests |
| `implementations-plan/index.md` | Entry (done) |

### Non-obvious mechanics

Pause-state epoch safety: the token captures `flowEpoch` + handles at pause; `confirmAccountChoice` claims synchronously and re-checks `isStale(flowEpoch)` after every await in the tail; wallet-side disconnect during the modal → `onDisconnect` → `wipeToIdle()` (epoch bump + status reset closes the modal; the claimed-token pattern makes the late `confirmAccountChoice` a no-op). `reset()` and `connectImpl`'s residue sweep inherit token cleanup via `cleanupSession()`.

### Trade-offs & alternatives not taken

See Decision ledger.

UX alternatives (four proposals, D selected): A, the quiet dropdown, survives inside D as the switching mechanism; B, the switch-account modal, is the fallback if the row content ever outgrows a dropdown; C, the account rail, was set aside because it caps out around four accounts and crowds the strip on mobile.

## Decision ledger (codex round 1 → adopted/rejected)

| # | Finding (severity) | Disposition |
|---|---|---|
| D-1 | TokenCard stale-account binding (CRITICAL) | **Adopted**: account in card key + integration test proving post-switch drip uses the new account. |
| D-2 | Persistence not per-wallet, A→B→A forgets (HIGH) | **Adopted**: bounded LRU map (8 entries, `[walletId, address]` pairs). |
| D-3 | Pause continuation underspecified (HIGH) | **Adopted**: explicit single-use token + shared `finishSetup` tail; no deferred-Promise resolver. |
| D-4 | Popover not reusable as-is — missing `#popover` root, pinned null-crash, no unmount cleanup (HIGH) | **Adopted (local-dropdown variant)**: scoped-CSS dropdown reproducing the Popover recipe. Repairing Popover + design-package tests rejected for light-tier scope; logged as follow-up candidate. |
| D-5 | Single-account users lose Disconnect (HIGH) | **Adopted**: menu always renders (single checked row + Disconnect footer). |
| D-6 | Remember one-account connections? (MED ask) | **Decided: yes** — persist on every successful selection. Later grant expansion auto-keeps the remembered account (no surprise modal); new accounts are discoverable in the dropdown. |
| D-7 | Nested buttons in trigger (MED) | **Adopted**: plain-text trigger; AddressDisplay (copy) moves into menu rows. |
| D-8 | Switching semantics during in-flight ops (HIGH ask) | **Decided: disable while busy** via `useOpsInFlight` registry + disabled rows w/ hint. In-flight ops complete under captured accounts. |
| D-9 | Grant parsing unhardened (HIGH) | **Adopted**: per-entry validation, canonical address parse, alias sanitize (control/bidi strip) + cap, dedupe, list cap 16. |
| D-10 | Bidi/control-char alias spoofing (MED) | **Adopted** (in D-9); address always visible beside alias. |
| D-11 | Storage tampering silently selects another granted account (MED) | **Adopted**: remembered auto-selection fires a visible "Using account …" toast; residual risk documented (bounded: only accounts the user already granted are reachable). |
| D-12 | Provider ids are claimed, not authenticated (HIGH ask) | **Acknowledged/documented**: same trust level as the existing preferred-wallet memory; the emoji verification remains the trust anchor; a spoofed id can only pre-select within the spoofer's OWN grant. No stronger identity exists at this layer — out of dApp-side scope. |
| D-13 | BridgeForm doesn't reset form state (Fact correction) | **Adopted**: account-change reset of amount/stage/receipt (I3 was wrong). |
| D-14 | Consumer-correctness phase missing (HIGH) | **Adopted**: new Phase 2. |
| D-15 | `createAztecWalletSession.test.ts` "does not exist" (MED) | **Rejected — codex misread**: the file exists at base (verified). Testing plan extends it. |
| D-16 | Modal a11y (radio semantics, focus trap, labels) (MED) | **Adopted** (spec'd in UI layer). |
| D-17 | Stale "independent sessions" comments in App.vue/session config (LOW) | **Adopted**: comment sweep in Phase 5. |

### Round 2 additions

| # | Finding (severity) | Disposition |
|---|---|---|
| D-18 | Busy gate must live at the mutation boundary, not UI-only (HIGH) | **Adopted**: `isSwitchBlocked?: () => boolean` injected via session config; `selectAccount` rejects while busy. DI keeps the factory generic/testable. |
| D-19 | Busy coverage incomplete — add-token, journal retries, `resumeSessionWork` (HIGH) | **Adopted**: `withOperation()` helper (acquire/finally-release, idempotent); wrap-site list expanded to 8 spans; grep sweep at implementation to prove coverage. |
| D-20 | `finishSetup` error ownership + persist-ordering contradiction (HIGH) | **Adopted**: finishSetup owns the catch for both callers (normalize, error status, clearPreferred-if-remembered, release); selection set+persisted AT selection time, before setup; setup failure → retry re-grants and auto-applies the remembered choice (no re-modal). |
| D-21 | `AztecAddress.fromString` doesn't exist in this Aztec version (HIGH) | **Adopted — codex correct** (verified: 45 `fromStringUnsafe` call sites, zero `fromString`): validate via `fromStringUnsafe` round-trip canonicalization in try/catch; validation level documented (syntactic; the wallet independently validates `from` per RPC). |
| D-22 | BridgeForm reset can strand `ownedId`/foreground suppression (HIGH) | **Adopted**: account-change reset routes through `journal.releaseForeground(ownedId)` + `ownedId = null` (the form's existing release sequence). |
| D-23 | LRU read/write both cap+dedupe+bound, atomic reinsert (MED) | **Adopted** (spec'd in §6). |
| D-24 | Grant-cap truncation must be disclosed, not `console.warn` (MED) | **Adopted**: warning toast + "Showing 16 of N granted accounts" row in modal and menu. |
| D-25 | Auto-selection toast needs a single owner; it's signal, not a security control (MED) | **Adopted**: module-level watcher in `useWalletConnection.ts` is the sole emitter; chip remains the real safeguard (already documented in Security). |
| D-26 | Menu rows re-introduce nested buttons via AddressDisplay (MED) | **Adopted**: li wrapper = selection button + sibling copy icon-button. |
| D-27 | Phase tweaks: setup-rejection-after-confirm test in Phase 1; busy invariant + BridgeForm ownership in Phase 2 (LOW) | **Adopted** (phase specs updated). D-15 conceded by codex (test file exists). |

### Round 3 conditions (verdict: conditional approve)

| # | Condition (severity) | Disposition |
|---|---|---|
| D-28 | Wrap spawned `runDepositClaim`/`runWithdrawConsume` promises, not the void `resumeSessionWork()` dispatcher (MED) | **Adopted** (wrap-site spec updated; in the mid-op switch test matrix). |
| D-29 | Toast watcher needs explicit session signals, not status inference (MED) | **Adopted**: one-shot `selectionNotice` ref with monotonic key + kind/metadata; consumed once, cleared in cleanup; exactly-once tested. |
| D-30 | Address validation is syntactic-only — correct the security wording + test curve-invalid behavior (MED) | **Adopted**: wording corrected (authorization ≠ note-receivability); curve-invalid granted address unit-tested through the normal RPC error path. |
| D-31 | Menu `<li>` `role="none"` + keyboard treatment for sibling copy control (LOW) | **Adopted**. |

### Post-implementation audit round (verdict: reject → fixes applied)

| # | Finding (severity) | Disposition |
|---|---|---|
| D-32 | Journal actions can act for a non-active account — only private claims were guarded (HIGH) | **Adopted**: the pre-click recipient guard now covers ALL deposit claims (public + private + auto-resume) — mismatch card instead of running; `claimFuelStandalone` gets the same guard (throws with switch-to instructions). Divergence from v4's "re-scope visibleRecords" is now EXPLICIT: records stay visible across switches (no vanishing in-flight cards) but can only be ACTED on under their account — uniform enforcement chosen over view-scoping. Test ⑧c pins the public path. |
| D-33 | `claimFuelStandalone` + detached inline `sendStandaloneFjClaim` outside operation spans (HIGH) | **Adopted**: both wrapped in `withOperation` (the detached promise independently — it outlives its parent span). |
| D-34 | Write path missed the string bound (MED) | **Adopted**: `writeRememberedAccount` refuses oversized ids/addresses; test pins no-persist for a 300-char provider id. |
| D-35 | D-30 test fixture (0x…02) is actually curve-VALID — evidence didn't prove the claim (MED) | **Adopted**: fixture replaced with 0x…03, verified curve-INVALID via out-of-band `isValid()` probe (WASM-dependent, so pinned in a comment rather than asserted in the jsdom suite). |
| D-36 | Modal trap counted `tabindex="-1"` radios as Tab boundaries; initial focus on container (MED) | **Adopted**: selector excludes them; initial focus lands on the selected radio; mount-while-open regression test added. |
| D-37 | Switcher arrow traversal included disabled rows (LOW) | **Adopted**: `:not([disabled])`. |

### Post-impl verification round (verdict: **approve**) — residuals

| # | Residual (severity) | Disposition |
|---|---|---|
| D-38 | Account guards allowed execution when the active account is null (MED) | **Adopted (fail-closed)**: both guards now refuse an UNKNOWN active account, not just a truthy mismatch. |
| D-39 | Standalone guard + the two span placements lack direct regression tests (MED) | **Accepted residual**: the guards are 3-line clones of the ⑧b/⑧c-tested pattern; span placements verified by codex + the D-19 sweep. A direct `claimFuelStandalone` test needs the full useDeposit mock surface — cost exceeds the marginal proof for a testnet tool. |
| D-40 | Preferred-wallet id was still unbounded on write (LOW, pre-existing) | **Adopted**: same `STORED_STRING_MAX` refusal as the selected-account map. |
| D-41 | D-30 wording overclaimed an RPC-error-path test (LOW) | **Adopted**: wording corrected in §5; only parser acceptance is tested. |

## Phase 6 (user-requested follow-up) — Account labels on history cards ✓

User selected Options 1+2 for the labels: always-on account tag on deposit cards (neutral active / sand other; alias + short address, full address in title) + busy-gated `SWITCH TO <label>` replacing the account-guarded actions (claim / claim-without-fuel / claim-your-gas) for records of another GRANTED account, via a shared `switchActiveAccount()` (selectAccount + toast; canonical grant address). Non-granted recipients keep the guard-note path. **Withdraw cards untagged by design** — `WithdrawJournalRecord` persists only `recipientL1`, never the Aztec sender (additive `senderL2` field = noted follow-up).
**Gate ✓**: typecheck 0 · lint 0 · test:faucet 587/587 (11 new tests).

### Labels-round codex loop (verdict: conditional approve → fixes folded)

| # | Finding (severity) | Disposition |
|---|---|---|
| D-42 | Tampered (non-string/empty) journal recipients crash card rendering; empty bypasses the engine compare (MED) | **Adopted**: card `acct` refuses non-string/empty (no tag, no crash); engine guard fails closed on them (`recipientOk` → mismatch). Tests: card render + engine ⑧d. |
| D-43 | Switch offer ignored session status — enabled no-op while not connected (MED) | **Adopted**: `offerSwitch` requires `status === "connected"`; test added. |
| D-44 | Visually-empty aliases (zero-width/whitespace) defeat fallbacks (LOW) | **Adopted**: sanitizer strips zero-widths (U+200B-200F, U+FEFF) + trims; empty alias → address fallback everywhere; test added. |
| D-45 | Header wrap can split age/corner control on narrow widths (LOW) | **Accepted residual** — cosmetic; flagged for the user's manual smoke test. |

## Merge refresh — 118 commits on the base branch

The branch sat ~4 weeks while the base branch moved 118 commits. Merged the base branch (a
merge, NOT rebase — the PR squash-merges, so a merge commit costs nothing and rewrites no history).

**Collision surface.** Only `implementations-plan/index.md` conflicted (pure append collision — both
sides' entries kept). The four overlapping code files (`useBridgeJournal.ts`, `useDeposit.ts`,
`useFuel.ts`, `vite.config.ts`) auto-merged; the base branch's edits landed in adjacent regions (receipt
classification, permit deadline, `resolvePackageAsset`) rather than on top of ours.

**Post-merge verification** (textual auto-merge is not semantic correctness):
- All eight `withOperation` span sites, the fail-closed recipient guard, and `claimFuelStandalone`'s
  guard verified present.
- D-19 coverage invariant re-swept against the base branch's new code: its three new faucet libs
  (`fuel-target`, `claim-receipt`, `bridge-steps`) contain zero wallet sends and the base branch added no new
  exported actions — no new spans to wrap.
- `vite.config.ts` kept BOTH sides: our plural `deriveAllowedPreviewHosts` and the base branch's
  `resolvePackageAsset`.
- **`@aztec` 5.0.1 → 5.2.0 re-probe**: `AztecAddress.fromStringUnsafe` behaves identically (throws on
  short hex / bad hex / above-modulus; canonicalizes case and a missing `0x`), and both curve-validity
  fixture pins still hold (`0x…02` valid, `0x…03` invalid) — so D-21/D-30/D-35 stand unchanged.
- Faucet suites now run on the **bun runtime** (`bun --bun vitest run`), so the local runs
  below exercised the same runtime CI uses.

**Gates on the merged tree**: faucet typecheck 0 · `bun run lint` 0 · `test:faucet` 615/615 (60 files —
the base branch's new faucet suites and ours green together) · `test:e2e` 15/15 · `bun run audit:faucet` 0.

**Merge-integration codex round — VERDICT: approve.** It independently confirmed the two hazards I
suspected are benign: `confirmLandedTxHash` is hash-scoped and display-only, so retaining it across a
switch is consistent with deliberately cross-account-visible cards (and busy-gating blocks switching
during active polling); and `fuelRecipientFor` preserves the former inline mapping exactly, leaving
`rec.recipient` the correct ownership/`from` basis for private fuel (the PrivateFPC is the fuel
destination and fee payer, not an account). It also diffed the 5.0.1 vs 5.2.0 capability definitions
byte-for-byte (identical) and found the bun-runtime-sensitive test constructs deterministic.

| # | Residual (severity) | Disposition |
|---|---|---|
| D-46 | `claimFuelStandalone` doesn't explicitly reject PRIVATE records (LOW → **fixed, owner-reported in the wild**) | **Adopted** — see below. Initially deferred as an owner's call; the owner then reported hitting it live (a private bridge offered CLAIM YOUR GAS, the click failed confusingly), which moved it into scope. |
| D-47 | `AccountSwitcher.test.ts` leaked its stub clipboard into later cases (LOW) | **Adopted**: descriptor saved and restored in `finally`. |
| D-48 | Stale "under 5.0.1" comment after the 5.2.0 bump (LOW) | **Adopted**: comment now states the constraint without pinning a version. |

### D-46 follow-up — private bridges must never offer the public gas recovery

**Mechanism** (traced, not assumed). A private fueled deposit commits `fuelRecipient = PRIVATE_FPC_ADDRESS`
in the L1 witness, so the Fee-Juice message is content-hash-bound to the PrivateFPC, not to the user's
account. The claim itself is `claim_private` paid by `privateMintAndPayFee`, which runs `FeeJuice.claim`
+ `PrivateFPC.mint_and_pay_fee` as SETUP of that same transaction: the gas claim and the token claim are
ONE tx, the bridged FJ paying for the very tx that consumes it. A **completed** private record has
therefore definitionally spent its fuel — a `fuel.consumed` that is still false there is an unlatched
flag (the inclusion probe needs `fuel.claimTxHash` plus an included receipt), not stranded gas.

**The bug.** The card's `fuelRecoverable` gate never checked `isPrivate`, so those records offered
CLAIM YOUR GAS → `claimFuelStandalone` → a **public, sponsored** `FeeJuice.claim(rec.recipient, …)`.
Two independent defects: it names the user as claim recipient when the message is bound to the FPC (so
it cannot match — the confusing failure the owner hit), and the whole ladder is public+sponsored, which
this file's own L11 invariant forbids for private records.

**Fix.** `fuelRecoverable` returns false for private records (reasoning inline so it isn't "cleaned up"
later); `claimFuelStandalone` refuses them defensively with an honest message. A card test pins both
directions — private hides the affordance, its public twin still shows it — and was verified to fail
without the fix. No unit test for the function-level refusal: there is no `useDeposit.test.ts`, and its
dependency surface makes a harness disproportionate for one guard sitting behind an already-tested gate
(same disposition as D-39).

**Why this strands nothing.** An unfinished private claim never reaches the affordance (`fuelRecoverable`
requires `completedAt`); its retry path is the normal CLAIM action via `decidePrivateFuelClaim →
"private-fpc"`.

## Security & Adversarial Considerations

- **Threat model**: malicious/compromised wallet extension feeding hostile grant payloads (addresses, aliases, list size); same-origin storage tampering; user confusion about which account funds land in. Surface: grant parsing, localStorage, the two new UI surfaces.
- **Hostile grants**: per-entry validation with canonical `AztecAddress` parsing, throwing-`toString` containment, alias type/sanitize/cap, dedupe, bounded list (D-9). Vue interpolation escapes; no `v-html`.
- **Storage is untrusted input**: shape-validated; semantically constrained to (connected wallet id, currently granted address); worst-case outcome of tampering = pre-selecting a DIFFERENT ALREADY-GRANTED account, surfaced by the auto-selection toast + ever-visible chip (D-11). Wallet ids are claimed identifiers — documented residual, emoji verification is the trust anchor (D-12).
- **Account confusion**: active account always visible in the chip on every tab; switch → toast; choose step names the consequence; in-flight ops can't race a switch (D-8); post-switch faucet cards provably re-bind (D-1 test).
- **Least privilege / supply chain / crypto**: no new dependencies, credentials, or crypto; no CI changes. Repo defaults (frozen lockfile, min-age, biome) apply.
- **Input validation at boundaries**: `confirmAccountChoice`/`selectAccount` validate membership against live grant state; invalid input is a silent no-op returning false.

## Assumptions

**Facts** (verified):
1. `selectedAccount.value = granted[0]?.address ?? null` — `createAztecWalletSession.ts:524`; `accounts` exposed but consumed by no component.
2. `useBridgeWallet` re-exports `useWalletConnection` — one singleton for all tabs (`useBridgeWallet.ts`).
3. `TokenCard.vue:25-28` binds account at setup; `FaucetView.vue:51` key excludes account (the D-1 hazard). `BridgeForm.vue:90` watcher recreates only the balance handle. Journal `connectedAztec` is a live getter (`useDeposit.ts:273`); deposit recovery is record-based.
4. The Nulo wallet's approval multi-selects accounts and returns the full session list with aliases; wallet RPCs take per-call `from`, validated wallet-side; no `accountsChanged` event; capability re-request never re-opens the wallet account picker.
5. `Popover.vue` defaults `teleportTo: "#popover"`; faucet `index.html` has no such root; the null-cleanup race is BUG-PINNED in the file (`Popover.vue:11-12,37-41`).
6. Persistence precedent: `readPreferred`/`writePreferred`/`clearPreferred` (`createAztecWalletSession.ts:133-162`); pause-and-claim precedent: `confirmVerification` (`:384-431`).
7. `createAztecWalletSession.test.ts` EXISTS at base (factory-level suite), alongside `useWalletConnection.test.ts`.
8. Commands are real: faucet `typecheck` (vue-tsc), root `lint` (biome), root `test:faucet`, root `audit:faucet` (root `package.json`).

**Inferences** (attackable):
1. The pause token + shared tail composes with the epoch model exactly as `confirmVerification` does — Phase 1 tests target confirm-vs-disconnect ordering, double-confirm, cancel-then-reconnect, stale-tail completion, retry→choice interplay.
2. With D-1's key fix and D-8's busy gate, no consumer path can execute under a stale account: remaining consumers read at action start (grep-verified) and new consumers must follow the same rule (noted in session-factory doc comment).
3. Journal re-scoping on switch (live getter) is the CORRECT product behavior, consistent with the wallet's account-siloing precedent — characterization-tested, not changed.
4. `useOpsInFlight` as a module-scope counter is sufficient — no operation spans a page reload (journal recovery handles that), so no persistence needed.

**Asks**: none unresolved — UX direction, tab scope, persistence, validation layers answered in Phase 0; D-6/D-8/D-11/D-12 decided and logged above (flag at approval gate for confirmation).

## Phases

### Phase 1 — Session layer ✓ (gate green: typecheck ✓ · lint exit 0 · test:faucet 549/549)
Pause token + `"choosing-account"` + `finishSetup` tail + hardened `extractGrantedAccounts` + per-wallet LRU persistence + `selectAccount`. Tests (extend `createAztecWalletSession.test.ts`): 1-valid-account auto; >1 no-memory → pause → confirm → connected+persisted; remembered-valid skips modal (and A→B→A both remembered); remembered-stale (wrong wallet id / address gone) → pause; hostile grants (bad address, curve-invalid-but-syntactic address [D-30], throwing toString, dup, oversized list, bidi alias) → sanitized/surfaced; `selectionNotice` exactly-once + cleanup reset [D-29]; `selectAccount` valid/invalid/busy-blocked (via injected `isSwitchBlocked`); cancel-during-choice → idle + captured provider disconnected; wallet-disconnect-during-choice → idle; double-confirm no-op; **confirm → setup failure → error status → `retryCapabilities` → re-grant auto-applies remembered choice without re-prompting** (D-27); storage-failure tolerance; oversized-grant truncation surfaced.
**Gate**: `cd apps/faucet && bun run typecheck && cd ../.. && bun run lint && bun run test:faucet` · all exit 0, new tests green · typecheck+lint+unit.

### Phase 2 — Consumer correctness under switching ✓ (gate green: typecheck ✓ · lint exit 0 · test:faucet 556/556; D-19 sweep logged in lessons/phase-2.md)
FaucetView account-keyed cards; BridgeForm account-change reset via `releaseForeground` (D-22); `useOpsInFlight` + `withOperation` across ALL 8 wrap sites + coverage grep sweep (D-19); `isSwitchBlocked` wiring (D-18); journal re-scope characterization test. Integration tests: post-switch drip uses the NEW account (D-1 proof); switch attempt mid-operation rejected at the session boundary.
**Gate**: same commands · all exit 0, D-1 integration test green · typecheck+lint+unit.

### Phase 3 — Choose-on-connect modal ✓ (gate green: typecheck ✓ · lint exit 0 · test:faucet 563/563)
`ChooseAccountModal.vue` (radiogroup a11y, focus handling) + App.vue mount + status sweep. Tests: N rows + alias fallback; select+Continue → confirmAccountChoice; Esc/backdrop → cancel; not rendered for 1-account; focus restore.
**Gate**: same commands · exit 0 · typecheck+lint+unit.

### Phase 4 — Account switcher ✓ (gate green: typecheck ✓ · lint exit 0 · test:faucet 573/573)
`AccountSwitcher.vue` (plain-text trigger, local dropdown recipe, always-rendered menu, busy-disabled rows, Disconnect footer) into both panels; toast on switch + on remembered auto-select. Tests: open/close/Esc/outside; switch → selectAccount+toast; busy → rows disabled; single-account menu shows Disconnect; keyboard nav (incl. copy-control reachability, D-31); auto-selection/truncation toasts fire exactly once via `selectionNotice` (D-29).
**Gate**: same commands · exit 0, all faucet tests green · typecheck+lint+unit.

### Phase 5 — Polish, docs, aggregate ✓ (gate green: `bun run audit:faucet` exit 0 end-to-end)
Copy pass; stale-comment sweep (D-17); `implementations-plan/index.md` status; docs touch-ups.
**Gate**: `bun run audit:faucet` (typecheck:all + test:faucet + lint + verify:deployments + build:faucet) · exit 0 end-to-end · aggregate.

## Post-implementation

`/code-review max --fix` (committed separately) → codex post-impl audit (net diff + code-review summary + plan + adversarial ask) → fix loop → PR to the base branch.

## Audit log

- Round 1 (fresh session, xhigh): **reject** — 4 blocking findings, all dispositioned in the ledger (D-1..D-17).
- Round 2 (resumed, xhigh): **reject** — busy invariant at mutation boundary + coverage, nonexistent address API, finishSetup error ownership, BridgeForm ownership cleanup. All verified against the repo and dispositioned (D-18..D-27); codex conceded D-15.
- Round 3 (resumed, xhigh): **`conditional approve (conditions: wrap spawned journal continuations rather than the void dispatcher, define explicit one-shot toast metadata, and accurately document/test syntactic-only address validation)`** — no remaining CRITICAL/HIGH; five phases confirmed right-sized. All three conditions + the LOW folded into v4 (D-28..D-31). **Convergence reached.**
- Post-impl round 1 (resumed, xhigh, on the full diff + code-review commits): **reject** — 2 HIGH (wrong-account journal actions; unguarded standalone FJ spans), 3 MED, 1 LOW. All fixed (D-32..D-37).
- Post-impl round 2 (resumed, xhigh): **`approve`** — all fixes verified (incl. independent re-verification of the 0x…03 curve-invalidity); 4 noted residuals dispositioned as D-38..D-41 (3 folded, 1 accepted with rationale). **Final.**

## Seeds (FINAL — approved scope)

Use exactly ONE seed per session.

### Recommended: /goal

```
/goal All 5 phases marked ✓ in implementations-plan/archive/faucet-multi-account/plan.md (the per-phase headers in the file, not just the chat), each ✓ backed by its phase's validation gate as defined in plan.md reported passing in the transcript (Phases 1–4: faucet typecheck + `bun run lint` + `bun run test:faucet`; Phase 5: `bun run audit:faucet`); for each phase the agent has printed `LESSONS_FILE=implementations-plan/archive/faucet-multi-account/lessons/phase-N.md` in the transcript; `/code-review max --fix` complete with findings applied and committed separately; codex post-impl audit complete with high/critical findings addressed; `bun run test:faucet` and `bun run lint` both report exit 0 in the transcript.
```

### Alternative: /loop 15m

```
/loop 15m Drive implementations-plan/archive/faucet-multi-account forward. Never idle waiting for my input. Each firing:
1. Reality check: read implementations-plan/archive/faucet-multi-account/plan.md and lessons/ (authoritative state — not the chat); run `git status` and `git log --oneline -5`. If a PR exists, `gh pr view --json statusCheckRollup` (no --watch).
2. Waiting on CI is fine — confirm it's progressing; use the wait to review the diff or prep the next phase.
3. No task in hand? Pick the next pending step from plan.md and start it. After each meaningful edit run `bun run lint` + `bun run test:faucet`. Commit → push (feature branch only).
4. Stuck or facing a decision you'd normally bring to me? Call /codex xhigh with full context, converge, act, and log the consult + verdict in lessons/phase-N.md. Hard limits stay hard: never merge to main, never publish/deploy, never expand scope beyond plan.md.
5. Same step failed 5 times? Stop retrying; reassess with codex, then continue down the agreed path.
6. Phase green? "Green" = the phase's validation gate as written in plan.md (Phases 1–4: faucet typecheck + `bun run lint` + `bun run test:faucet`; Phase 5: `bun run audit:faucet`). Run it, paste the result, mark ✓ in plan.md, file the lessons entry, print `LESSONS_FILE=implementations-plan/archive/faucet-multi-account/lessons/phase-N.md`, advance.
7. All phases ✓? Run `/code-review max --fix` → commit fixes separately → codex post-impl audit (net diff + code-review summary + adversarial ask) → address high/critical → write the wrap-up report (what shipped, contentious calls with ELI5 context, open items). Surface and stop.
Keep the ASCII checklist visible each firing (human readability; plan.md is the source of truth).
```
