---
plan: tools-console
tier: mid
code_review: off
eli5_mode: artifact
status: APPROVED — owner accepted all six choices (a)–(f) after the illustrated explanations and pulled the small follow-ups into scope; seeds final; implementing
---

## Outcome

Archived. Seeds retired.

# Tools Console — the shell around the Send wizard

Rebuild the tools app's shell to the round-3 Console design: a left rail (Send / Faucet / Activity), wallet chips in a header, the wizard card with a vertical step rail, and a collapsible Activity dock that lists bridge records as two-line rows grouped Needs you / Running / Done, with one needs-you badge when hidden. The three wizard step bodies (Token, Amount, Review and their children) are frozen: no markup, style or testid change. Design source: the "Tools, Two Shells" study (round 3); its rules are restated here as acceptance criteria.

Owner answers (Phase 0): done = round-3 mock, pixel-faithful, both themes, verified on the preview. Gates: lint + typecheck + unit every phase; tools jsdom smoke on shell phases; owner preview walk at the end. `/code-review` off. Dock hidden by default on first visit. Mint strip stays inside the Token step. Activity page opens with the Home mock's first-visit state.

## Scope

**In.** `AppShell` rail + header + dock layout; three sections (Send, Faucet, Activity); flat wallet chips; one Aztec wallet panel (the near-duplicate `WalletPanel`/`BridgeWalletPanel` merged, since the header relocates both anyway); `WizardShell` card with a vertical `StepStrip`; a two-line `ActivityRow`; a pure record policy shared by the page card and the dock row; record grouping + needs-you count; dock open/hidden preference with the once-per-record auto-open; the completion toast moved to a shell-level owner; the quieted in-flight stepper (timeline, 2.4s pulse, secondary elapsed); the glow budget applied to shell components; Activity page with the first-visit state; responsive fallbacks; tests inline; a shell-level smoke; README file map. **Small fixes pulled in at the owner's request:** the raw viem error string when a token is picked with no Ethereum wallet (`useTokenSelection.select` surfaces `e.message`, which for a viem `BaseError` is `An unknown RPC error occurred. Details: … Version: viem@…`; the throw is the custom transport in `useL1Wallet.ts:34`); the page card rendering persisted `blocked` text and `displaySymbol` raw; the stale plan-referencing comment at `useBridgeJournal.ts:1460`; the README's `FaucetView` name.

**Out.** The frozen steps (`TokenStep`, `TokenList`, `TokenTile`, `MintStrip`, `AmountStep`, `ChoiceCards`, `GasBreakdown`, `ReviewStep`, `ReviewDetails`); the wallet; the journal engine's behaviour; the mainnet placeholder; the receipt.

## Acceptance criteria (the round-3 rules)

1. Accent appears at most three times on any screen: the active step marker, the primary button, and the needs-you signal — the CLAIM/FINISH button while the dock is open, the strip badge while it is hidden, never both.
2. Mint marks only what is done (done dots, ✓ stamps). Elapsed times on done phases are secondary.
3. One pulse on the page, 2.4s, on the bridge in flight; the compact rails on the Activity page do not pulse; `prefers-reduced-motion` stops it.
4. Dock rows are exactly two lines: amount; route · visibility-as-words (+ gas) · age. The right slot on line 1 holds the action button (needs you, spanning both lines), the phase word (running), or `Bridged ✓` (done). No tag boxes, no sentences, no DISCARD in the dock.
5. The dock collapses to a 44px strip: chevron, vertical ACTIVITY label, one accent badge with the needs-you count only while that count is > 0. Running never badges.
6. The dock opens itself once per record when that record enters Needs you while the dock is hidden; hiding it again keeps it hidden for that record, across reloads and across tabs. It never opens for progress and never for a blocked record.
7. The dock is hidden by default on first visit; the explicit choice persists per browser; an auto-open does not overwrite the choice.
8. On the Activity section the dock is not mounted (`v-if`): the page is the dock. On Send, the dock never lists the record whose stepper is on screen (the engine's one-surface rule); backgrounding it makes it appear.
9. Frozen steps: the `git diff` of the nine step components against the base is empty at every gate; every `tl-send-*` step testid resolves; `send-smoke.test.ts` passes unchanged.
10. Both themes hold (the tokens are the design package's; no new colour literals).

## Architecture & Implementation

### Proposed architecture

```
AppShell.vue  (grid: rail 200 | main 1fr | dock 300 | strip 44)
├── useCompletionToasts()      called ONCE here — the completion-toast watcher, moved out of BridgeJournal
├── RailNav.vue                roving tablist: Send · Faucet · Activity (plain count)
├── SectionHeader.vue          title + subline + <slot name="wallets">
│     Send/Activity: L1WalletPanel + AztecWalletPanel   Faucet: AztecWalletPanel installCta
├── ConnectionErrorStrip       one instance, exclude per section (unchanged)
├── main
│   ├── SendView.vue           wizard only (wallets + journal moved out); IS_PLACEHOLDER gate kept
│   ├── DripView.vue           TokenCard grid only
│   └── ActivityView.vue       v-if section==='activity': first-visit state, or BridgeJournal (page list) over `records`
├── ActivityDock.vue           v-if section!=='activity' && !IS_PLACEHOLDER: open → grouped ActivityRows; hidden → DockStrip.vue
├── Footer / BridgeFooter      swap by section (as today)
└── AppToastRegion, WalletPickerModal, ChooseAccountModal (unchanged)
```

New modules, each a singleton in the `useTheme` shape with a `__reset…ForTests()`:

- `lib/record-policy.ts` (pure, no Vue) — `recordState(record, rt, wallet): RecordState` extracted from `BridgeJournalCard.vue`'s computeds: `stage` (with the card's `claimable: rt.claimable ?? !!leafIndex` rule), `attention`, `blocked`, `busy`, `actionable`, `showClaim`, `showFinish`, `retry`, `ownedByOther`, `switchTarget`, `fuelRecoverable`, `showClaimWithoutFuel`, `depositLegRecoverable`. The card keeps its own UI state (`discardArmed` + its timer, `fuelRecovering`, the `reconcileFuelConsumed` watcher, `age`, labels) and wraps `recordState` in one `computed`. No watcher, timer or clock lives in the policy.
- `lib/activity.ts` (pure) — `classify(state): { group, action }` following the card **exactly**, in the card's precedence: `completedAt → done` first (with `claim-gas`/`switch` when fuel is recoverable), then `busy → running`, otherwise `needs-you` with `claim | finish | retry | switch | null` (null = blocked or stuck-before-send: the row shows the word *Blocked* / *Stuck* and routes to the page). `groupRecords`, `needsYouCount(rows)`, `phaseWord(record, rt)` (the active `stepperPhases` label, lower-cased), `visibilityWords(record)`, `rowStrings(record)` (symbol/amount through `safeDisplay` + a length cap).
- `composables/useActivityFeed.ts` — one `computed` over `useBridgeJournal().visibleRecords` (the foregrounded record is the stepper's, never the dock's) + `runtime` + the wallet refs + `useNow()` (all read inside the computed) producing `{ rows, needsYouIds, count }` via the two pure modules. Rows carry `id`, `group`, `action`, `phase`, `strings`, `age`. It is the dock's only data source.
- `composables/useShell.ts` — `section: Ref<"send"|"drip"|"activity">` (initialised by today's `defaultTab()`), `goTo`, `openActivity(recordId?)` → sets section + `highlightedId`. `SendWizard.showActivity()` calls it.
- `composables/useDockState.ts` — `open` (session), `preference` persisted under `unleashed:tools-dock` (`"open" | "hidden"`, allowlisted, default hidden), `seen` persisted under `unleashed:tools-dock-seen` (an array of record ids validated as strings, **pruned to ids that still exist in the journal** rather than capped — unfinished records are never evicted, so a fixed cap could forget a live bridge), `show()`, `hide(currentNeedsYouIds)` (writes the preference and adds the given ids to `seen`), `autoOpenFor(ids, liveIds)` (re-reads `seen` from storage on every call so another tab's hide counts, opens the session flag — never the preference — for any id not in `seen`, then adds it).
- `composables/useCompletionToasts.ts` — the watcher from `BridgeJournal.vue:71-96`, verbatim, called once in `AppShell`. `BridgeJournal` loses its `toasts` prop.

### Key interfaces

```ts
// lib/record-policy.ts
export interface RecordState {
  stage: DepositStage | SendDepositStage | WithdrawStage
  attention: Attention | undefined
  blocked: string | undefined
  busy: boolean
  actionable: boolean
  showClaim: boolean; showFinish: boolean; retry: boolean
  ownedByOther: boolean; switchTarget: string | null   // canonical address of the granted account that owns it
  fuelRecoverable: boolean; showClaimWithoutFuel: boolean
  depositLegRecoverable: boolean
}
export function recordState(rec: BridgeJournalRecord, rt: RecordRuntime, wallet: WalletView): RecordState
// lib/activity.ts
export type ActivityGroup = "needs-you" | "running" | "done"
export type ActivityAction = "claim" | "finish" | "retry" | "claim-gas" | "switch" | null
export function classify(rec: BridgeJournalRecord, s: RecordState): { group: ActivityGroup; action: ActivityAction }
export function needsYouCount(rows: ReadonlyArray<{ id: string; group: ActivityGroup; blocked: boolean }>): number   // blocked rows count; auto-open filters them separately
// composables/useActivityFeed.ts
export interface ActivityRowModel { id: string; group: ActivityGroup; action: ActivityAction; phase: string; amount: string; symbol: string; route: string; visibility: string; age: string; blocked: boolean }
export function useActivityFeed(): { rows: ComputedRef<ActivityRowModel[]>; needsYouIds: ComputedRef<string[]>; count: ComputedRef<number> }
// composables/useDockState.ts
export const DOCK_KEY = "unleashed:tools-dock"; export const DOCK_SEEN_KEY = "unleashed:tools-dock-seen"
export function useDockState(): { open: Ref<boolean>; show(): void; hide(currentNeedsYouIds: readonly string[]): void; autoOpenFor(needsYouIds: readonly string[], liveIds: ReadonlySet<string>): void }
// composables/useShell.ts
export type Section = "send" | "drip" | "activity"
export function useShell(): { section: Ref<Section>; goTo(s: Section): void; openActivity(recordId?: string): void; highlightedId: Ref<string | null> }
```

`StepStrip.vue` gains `orientation?: "horizontal" | "vertical"` (default horizontal; vertical sets `aria-orientation` and maps ↑/↓ onto the existing `move`) and an optional per-step `hint`. `WizardShell.vue` gets the card head (direction tabs + "Step N of 3") and the rail | panel body; its slots, `sendStepPanel`, `sendStepAnnounce` and the focus watcher are unchanged. `BridgeJournal.vue` becomes the page list only (no `density`, no `toasts`).

### Data & control flow

- **Feed.** `useActivityFeed` maps `visibleRecords` → `recordState` → `classify` → rows sorted needs-you → running → done, newest first within a group.
- **Foreground record.** The stepper/receipt is the one surface for the record the wizard is showing (`useBridgeJournal.ts:1460-1462`): the dock uses `visibleRecords` and never lists it. On the Activity page the stepper is hidden, so the page list reads `records` and shows the record as a normal card (`BridgeJournal.test.ts`'s `visibleRecords` pin flips to `records` for the page list only). The stale comment at `useBridgeJournal.ts:1460-1461` (it names plan phases) is rewritten to state the rule.
- **Auto-open.** `ActivityDock` watches `needsYouIds` minus blocked ids and calls `autoOpenFor(ids, liveIds)`. Session flag only; the preference is untouched.
- **Row action.** `ActivityRow` emits `act(id, action)`; `ActivityDock` dispatches to the same engine entry points the card uses (`runDepositClaim`, `runWithdrawConsume`, `claimFuelStandalone`, `switchActiveAccount`). CLAIM/FINISH are not gated on `opsBusy` (record-local `busy` + `withRecordLock` already prevent duplicate runs; `opsBusy` protects account switching); SWITCH is disabled while `opsBusy`, as on the card; CLAIM GAS keeps a dock-local per-record in-flight set because `claimFuelStandalone` has no record lock. Clicking the row body calls `useShell().openActivity(id)`.
- **Background.** `SendWizard.onBackground()` unchanged; its strip's Activity link → `openActivity(backgroundedCanonical.value ?? backgroundedId)` — a provisional record can be rekeyed before Activity opens.
- **Sections.** `RailNav` → `useShell().goTo`; Send and Faucet stay `v-show` (state survival), Activity is `v-if` (no local state).
- **Placeholder networks.** `IS_PLACEHOLDER` gates the wizard today so nothing bridge-related instantiates. The dock, the feed and the Activity list are gated the same way; the Activity section shows the same placeholder copy as Send. `useCompletionToasts` is gated too.

### File-level change map

| File | Change |
|---|---|
| `apps/tools/src/AppShell.vue` | grid layout; rail, header, dock/strip, footer swap, strip exclude per section; `useCompletionToasts()` once |
| `apps/tools/src/components/RailNav.vue` (new) | roving tablist, count prop, testids `tabs`, `tabSend`, `tabDrip`, `tabActivity` (new) |
| `apps/tools/src/components/SectionHeader.vue` (new) | title, subline, wallets slot |
| `apps/tools/src/components/ActivityDock.vue`, `DockStrip.vue`, `ActivityRow.vue` (new) | open/hidden, hide button (moves focus to the strip), badge, rows; testids `dock`, `dockHide`, `dockStrip`, `dockOpen`, `dockBadge`, `activityRow`, `activityRowAction` |
| `apps/tools/src/views/ActivityView.vue` (new) | hosts the page-list `BridgeJournal`; passes a `firstVisit` slot that replaces the dashed empty block with the two tiles — the restore control, its 1 MB pre-read cap, input reset and `restoring` guard stay in `BridgeJournal` |
| `apps/tools/src/lib/record-policy.ts`, `lib/activity.ts`, `composables/useActivityFeed.ts`, `useShell.ts`, `useDockState.ts`, `useCompletionToasts.ts` (new) | above, each with a colocated test |
| `apps/tools/src/components/BridgeJournal.vue` | page list only: `toasts` prop and watcher removed; reads `records` |
| `apps/tools/src/components/BridgeJournalCard.vue` | one `computed(recordState)` replaces the inline gates; UI state and watchers stay; private tag restyle; `blocked` and `displaySymbol` render through `safeDisplay` with a length cap; otherwise no behaviour change (42 tests pin it) |
| `apps/tools/src/components/BridgePhaseRail.vue`, `BridgeStepper.vue` | timeline spine, `.took` secondary, pulse 2.4s on the full rail only, active label ink |
| `apps/tools/src/components/send/StepStrip.vue`, `WizardShell.vue` | `orientation`, hints, card head; slots/testids preserved |
| `apps/tools/src/components/AccountSwitcher.vue`, `L1WalletPanel.vue` | flat chip; testids preserved |
| `apps/tools/src/components/AztecWalletPanel.vue` (new; replaces `WalletPanel.vue` + `BridgeWalletPanel.vue`) | one component over the one session singleton; props: the testid pair (`status`/`account`/`btnConnect`… vs `bridgeL2Status`/`bridgeL2Account`/`bridgeL2Connect`…) and `installCta` (the wallet-install block, Faucet only); the two test files merge into one |
| `apps/tools/src/composables/useTokenSelection.ts`, `lib/errors.ts` | `select` reports `userMessage(e)` (viem `BaseError` → its `details`, else `shortMessage`, else `message`); with no Ethereum wallet connected the balance read is skipped (balances simply absent) and a pasted address reports "Connect your Ethereum wallet first." |
| `apps/tools/src/views/SendView.vue`, `DripView.vue`, `SendView.test.ts` | drop hero + wallets row; the tests that pin the heading, wallets and journal move to the shell tests |
| `apps/tools/src/components/send/SendWizard.vue` | `showActivity` → `useShell().openActivity` |
| `apps/tools/src/lib/testids.ts` | new ids above |
| `apps/tools/tests/e2e/tools-smoke.test.ts`, `shell-smoke.test.ts` (new) | shell pins re-homed; the "3b" pin becomes "exactly one journal page list and one dock"; new shell smoke (below) |
| `apps/tools/README.md` | file map (`DripView`, new components), the shell description |

### Non-obvious mechanics

- **One toast owner.** The watcher is a shell concern: it runs once from `AppShell` regardless of which section is visible or whether the dock is hidden. The "3b" pin counts one `journal` page root (on Activity) and one `dock` root, never two of either.
- **Pure policy, not a composable.** `recordState` runs inside `computed`s owned by whichever component renders the record; watchers (`reconcileFuelConsumed`, the discard arm timer) stay in the card, so a feed rebuild never re-creates effects.
- **Seen set.** `unleashed:tools-dock-seen` holds ids the user has been shown or has hidden. It is pruned to ids still present in the journal on every write (never capped: the journal never evicts an unfinished record, so a cap could forget a live bridge), re-read from storage on every `autoOpenFor` so another tab's hide is honoured, and unknown shapes are ignored. A record re-entering needs-you after RETRY has the same id, so it does not reopen the dock.
- **Blocked rows.** Group needs-you, counted in the badge (a decision is owed), no button, the word *Blocked*; the page card carries DISCARD with its two-step arm.
- **Responsive.** ≥1100px: three columns. 760–1100px: the dock leaves the grid; open renders as a right overlay panel (same component, positioned; Escape closes; focus trapped while open), the strip stays. <760px: the rail becomes a top row of three tabs; the overlay is full-width. These breakpoints are a decision of this plan (no precedent in the app); the owner can move them at the gate.

### Trade-offs & alternatives

- **Pure policy shared by card and row (hybrid) vs plan A's composable vs outline B's projection.** A's composable leaked watchers when instantiated per row. Outline B landed the visible shell first and left the journal engine and the card untouched: `composables/useActivityFeed.ts` as a thin read-only projection re-deriving only what a row shows, the row's single button dispatching straight to the engine for needs-you records, every other case (retry wording, switch account, claim gas, discard) left to the page card. It won a zero diff on the card and a dock that cannot regress the page's action logic; it lost on drift: B's projection mislabels RETRY/SWITCH/fuel recovery, and its needs-you count can disagree with the number of CLAIM/FINISH buttons on the page. The hybrid keeps one decision table with zero lifecycle risk. Chosen.
- **`ActivityDock` as its own component vs a `density` prop on `BridgeJournal`.** The two share only the singleton: different sort, no restore, no header, different empty state. A prop would fork one component down the middle and threaten the complexity budget. Chosen: separate component.
- **Shell state as a singleton vs AppShell-owned provide/inject.** Codex preferred provide/inject to avoid hostname-initialised module state; the app's every other cross-component state (`useOpsInFlight`, `useWalletConnection`, `useTheme`) is a singleton with a test reset, and `SendWizard`/`SendView` tests mount without `AppShell`. Chosen: singleton + `__resetShellForTests`, initialised lazily on first `useShell()` call.
- **Dock hides the foreground record vs lists it marked.** The signed-off mock shows an *on screen* row; the engine's one-surface rule (the stepper/receipt is the only surface for the foregrounded record) and the smoke pin say otherwise, and two codex passes ruled the same way. Chosen: hidden on Send (it appears the moment it is backgrounded); the mock's *on screen* row is dropped and the owner is told at the gate.
- **Persist the section.** Not needed; rejected. **Router.** More surface than three sections warrant; rejected.

## Security & Adversarial Considerations

- **Threat model.** A static dApp; the shell holds no keys. Attack surface is the journal (local, attacker-controllable via restore files) and the token list (validated upstream). No `v-html`; all record strings render as text nodes.
- **Persisted attacker text.** `blocked` (`journal.ts:65`) and `displaySymbol` (`asset-label.ts:24`) are persisted record fields a restore file can carry. The dock never renders `blocked` (the word *Blocked* instead) and passes amount/symbol through `safeDisplay` with a length cap, so a look-alike or bidi string cannot spoof a row. The page card gets the same `safeDisplay` + cap in Phase 1 (pulled in at the owner's request).
- **Destructive actions.** DISCARD is never reachable from the dock; it stays behind the card's two-step arm.
- **Restore path.** The Activity first-visit state reuses `BridgeJournal`'s restore control unchanged (1 MB pre-read cap, input reset, `restoring` guard, validation, error toast); no second restore path exists.
- **Busy gating.** Row actions honour `opsBusy` the way the card does; classification is display-only, the engine re-validates every run.
- **Persisted preferences.** `unleashed:tools-dock` and `unleashed:tools-dock-seen` are read through allowlists/shape checks; tampered values fall back to hidden / empty.
- **Cross-tab.** The journal reloads on `storage` events, so another tab's new needs-you record can auto-open this tab's dock. Acceptable; documented in the composable's comment.
- **Clickjacking / origin.** Unchanged: CSP `frame-ancestors 'none'` (`vite.config.ts:115`); no new frames or postMessage.
- **Supply chain / least privilege.** No new dependencies; `bun.lock` unchanged; no workflow changes.

## Assumptions

**Facts** (verified; recon.md has the lines)
1. `SendView.vue:42` is the only `BridgeJournal` mount; `send-smoke.test.ts:414-416` mounts `SendView` with only the wallet panels stubbed and leaves the journal real; it makes no assertion on journal testids.
2. `tools-smoke.test.ts:270-279` pins one journal list via the `journalEmpty` count; `SendView.test.ts:27-57` pins the heading, wallet panels and journal inside `SendView`.
3. `SendWizard.vue:974` `showActivity` is a `scrollIntoView` on the journal testid.
4. `useBridgeJournal.ts:1462` `visibleRecords` excludes `activeFlowId`; its comment (line 1460) is stale about "graced cards".
5. `BridgeJournalCard.vue:186-193` derives `claimable` for any idle record with a `leafIndex`; `bridge-steps.ts:88` derives `syncing` for the same record — the two derivations already differ. The card has 42 tests; its gates live at lines 46–183, 184–265 and 301–312, including two watchers (`:50-56`, `:165-171`).
6. `BridgeJournal.vue:71-96` is the completion-toast watcher, keyed on `journal.lastCompleted` and gated by the `toasts` prop.
7. `scripts/design-resolver.ts:16` auto-registers only `Flex`.
8. `useTheme.ts` is the persisted-preference pattern; `tools-smoke.test.ts:171-176` resets singletons by hand.
9. No layout `@media` exists in the tools app; CSP `frame-ancestors 'none'` at `vite.config.ts:115`.

**Inferences** (unverified)
1. Hiding the foreground record from the Send dock (instead of the mock's *on screen* row) is acceptable to the owner: the stepper is beside the dock, and backgrounding reveals the row.
2. A persisted, journal-pruned seen-set keyed by record id is enough for "stays hidden for that bridge"; keying on `updatedAt` would reopen on every engine patch, which is worse.
3. The breakpoints 1100 / 760 are adequate for a testnet tool.
4. `AccountSwitcher`'s flat restyle does not break its keyboard tests (they select by testid).
5. `StepStrip`'s vertical variant keeps `role="tablist"` with `aria-orientation="vertical"` and its roving logic unchanged.

**Asks**
- Resolved at Phase 0: done = pixel-faithful round-3 ✔ · gates ✔ · `/code-review` off ✔ · dock hidden by default ✔ · mint strip stays ✔ · Activity uses the first-visit state ✔.
- **Confirmed by the owner, all six:** (a) the dock offers CLAIM / FINISH / RETRY / SWITCH / CLAIM GAS, never DISCARD; (b) blocked records count in the badge but never auto-open; (c) auto-open is session-only and once per record across reloads and tabs; (d) on placeholder networks the dock and Activity list do not instantiate; (e) breakpoints 1100 / 760; (f) the foreground record is hidden from the Send dock until backgrounded (the mock's *on screen* row is dropped). Round-1 answers: (a)(c)(d)(e) ok; (b)(f) confirmed after the illustrated ELI5 explanations.

## Phases

`<lint>` = `bun run lint` (repo root; includes the complexity baseline check); `<typecheck>` = `bun run --cwd apps/tools typecheck`; `<unit>` = `bun run --cwd apps/tools test`; `<smoke>` = `bun run --cwd apps/tools test:e2e`; `<frozen>` = `git diff --quiet <rev> -- apps/tools/src/components/send/TokenStep.vue apps/tools/src/components/send/TokenList.vue apps/tools/src/components/send/TokenTile.vue apps/tools/src/components/send/MintStrip.vue apps/tools/src/components/send/AmountStep.vue apps/tools/src/components/send/ChoiceCards.vue apps/tools/src/components/send/GasBreakdown.vue apps/tools/src/components/send/ReviewStep.vue apps/tools/src/components/send/ReviewDetails.vue` (exit 0 = untouched). Every gate is `<lint> ∧ <typecheck> ∧ <unit> ∧ <smoke> ∧ <frozen>`, all exit 0, plus the phase's own line.

### Phase 1 ✓ — Policy, feed, shell state, toast owner (no visible change) — green, `lessons/phase-1.md`
- `lib/record-policy.ts` extracted from the card; the card wraps it in one `computed`; its 42 tests unchanged and green.
- `lib/activity.ts` with a decision-table test built from record-shape builders (the style of `bridge-steps.test.ts`) covering every row of recon's table, the blocked/stuck cases, RETRY relabel, SWITCH, CLAIM GAS, **completedAt + busy → done** — plus a **parity pin**: for each fixture, `classify().group` and `.action` match the card's derived `stage`/`showClaim`/`showFinish`/`fuelRecoverable`.
- `useActivityFeed.ts` (+ test: grouping order, the foreground record absent, blocked rows counted, `age` ticks with `useNow`).
- Rewrite the comment at `useBridgeJournal.ts:1460-1461` to state the one-surface rule without plan references.
- `useShell.ts` (+ test: default section by host; `openActivity` sets section + highlight; reset), `useDockState.ts` (+ test: default hidden; preference read/write and allowlist; seen-set persist, prune-to-live-ids and shape check; `autoOpenFor` opens once per id and re-reads storage (a synthetic cross-tab hide is honoured); `hide(ids)` marks them seen; auto-open leaves the preference alone).
- `useCompletionToasts.ts` extracted verbatim; `BridgeJournal` loses `toasts`; `BridgeJournal.test.ts` toast cases move to `useCompletionToasts.test.ts`; `AppShell` calls it once.
- Small fixes: `lib/errors.ts` `userMessage(err)` (+ test with a viem `BaseError` fixture); `useTokenSelection.select` uses it and skips the balance read when no Ethereum wallet is connected (+ tests: viem error → plain sentence; no wallet → no balance read, pasted address → the connect sentence); the card renders `blocked`/`displaySymbol` through `safeDisplay` + cap (+ two card tests: a bidi/look-alike symbol and a 400-char `blocked` string).
- **Gate line:** the parity pin is green; `BridgeJournalCard.test.ts` is byte-identical to the base branch.

### Phase 2 ✓ — Shell: rail, header, sections — green, `lessons/phase-2.md`
- `RailNav.vue`, `SectionHeader.vue`, `ActivityView.vue` (first-visit state + page list over `records`), `AppShell.vue` grid; `SendView`/`DripView` lose hero + wallets; strip exclude per section; footers swap; placeholder gating; `SendWizard.showActivity` → shell; flat chips in `AccountSwitcher`/`L1WalletPanel`; `AztecWalletPanel.vue` replaces the two Aztec panels (both testid sets kept via props; `WalletPanel.test.ts` + `BridgeWalletPanel.test.ts` merge into `AztecWalletPanel.test.ts` with every existing case).
- Tests: `RailNav.test.ts` (roving tablist ↑/↓ and ←/→, count, testids), `AppShell.test.ts` (three sections, one strip, Activity `v-if`, footer swap, placeholder), `ActivityView.test.ts` (first-visit vs list, foreground record listed), `SendView.test.ts` re-homed, `tools-smoke.test.ts` pins updated, new `tests/e2e/shell-smoke.test.ts` mounting `App.vue`: rail switching, header wallets, dock hidden by default, a completion toast while on Faucet with the dock hidden, background handoff to Activity, every new testid present.
- **Gate line:** `shell-smoke.test.ts` green.

### Phase 3 ✓ — Activity dock — green, `lessons/phase-3.md`
- `ActivityDock.vue`, `DockStrip.vue`, `ActivityRow.vue`; auto-open watch; badge; hide moves focus to the strip; SWITCH gated on `opsBusy`; per-record CLAIM GAS guard.
- Tests: `ActivityRow.test.ts` (two lines, side slot per group/action, `safeDisplay` + cap, on-screen mark without a button), `ActivityDock.test.ts` (hidden by default, hide/show + focus, badge only when count > 0, auto-open once and not for blocked rows, not mounted on Activity, dispatch per action, SWITCH disabled while `opsBusy`, CLAIM GAS double-activation guarded, background handoff uses the canonical id).
- **Gate line:** the shell smoke gains the dock cases (badge count vs page buttons agree).

### Phase 4 ✓ — Wizard card, in-flight stepper, glow budget, responsive — green, `lessons/phase-4.md`
- `StepStrip` `orientation="vertical"` + hints; `WizardShell` card head + rail | panel; `BridgePhaseRail`/`BridgeStepper` timeline restyle (pulse only on the full rail, reduced-motion honoured); tag/elapsed colours; breakpoints (overlay with Escape + focus trap; rail-to-top).
- Tests: `StepStrip.test.ts` (vertical, ↑/↓, hints, testids), `WizardShell.test.ts` (existing pins + card head), `BridgePhaseRail.test.ts` (no pulse in compact), `ActivityDock.test.ts` overlay keyboard cases.
- **Gate line:** `<frozen>` explicitly re-run and quoted.

### Phase 5 ✓ — Preview walk + docs
- `bun run audit:vue` exit 0 (typecheck ∥ unit ∥ lint, then build); `bun run --cwd apps/tools build:testnet` exit 0; push; the Cloudflare branch preview builds.
- Owner walks the preview: one send to the first claim, one faucet drip, dock hide/show/auto-open, the 1100 and 760 boundaries, keyboard-only rail + dock, both themes. Feedback lands in `lessons/phase-5.md` and is fixed in place.
- README file map + shell description; `implementations-plan/index.md` entry.
- **Gate line:** the owner's sign-off recorded in `lessons/phase-5.md`.

## Post-implementation

`code_review: off` — `/code-review` is not run.

1. **Codex audit** (`/codex xhigh`, fresh session): the net diff from the base branch, this plan.md with its decision ledger and acceptance criteria, an explicit adversarial/security ask ("what could go wrong, what would an attacker target, what are we trusting that we shouldn't"), and both rules below verbatim.
2. **Iterative fix loop:** verify each factual claim against the repo before acting; apply accepted fixes; commit; log the round in `lessons/post-impl.md`; resume the same codex session with the fix diff for a re-review. Stop when a round yields no new material findings. Still material after 3 rounds → surface to the owner.
3. **Delivery** (below): open the PR only now.

The no-over-engineering rule: *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."*

The comment-quality rule: *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*

## Delivery

Single arc, single PR: the task branch → the base branch, opened with `gh pr create` after the codex loop converges. Title: `feat(tools): console shell — rail, header chips, step rail, activity dock`. `code_review: off`. The PR body links this plan and names the two design studies. No stack ceremony.

## Audits

- **Fable (round 1)** — VERDICT: conditional approve — hybrid = plan A's structure with a pure `recordState()` (no watchers) shared by card and row; classify follows the card exactly; `useCompletionToasts()` in `AppShell`; `ActivityDock` its own component; both lists read `records`, mark the foreground, exclude it from count/auto-open on Send; no DISCARD in the dock; test resets + the missing tests.
- **Codex (round 1)** — session `01a0717e-2967-7a60-bd53-f3f3afd26b9c`. VERDICT: conditional approve — hybrid "pure shared record policy + dedicated dock feed", resolve syncing/foreground/initial-auto-open semantics, preserve destructive confirmation, add shell-level integration coverage.
- **Codex (final, fresh context)** — session `01a0718a-3b8e-7072-818a-892def2db8c2`. VERDICT: conditional approve — conditions: hide the foreground record from the Send dock, fix completion precedence and dock mounting, make seen-state retention/synchronization explicit, guard CLAIM GAS, use canonical handoff IDs, preserve the restore-file safeguards, and obtain owner confirmation for the unresolved product choices. All folded in (ledger 16–27); the owner confirmation is the approval gate.

## Decision ledger

| # | Finding (source, severity) | Decision |
|---|---|---|
| 1 | Extracting card state as a composable instantiated per row leaks watchers/timers (fable HIGH, codex HIGH) | **Adopted.** Pure `lib/record-policy.ts`; watchers stay in the card. |
| 2 | Inference 1 (`syncing` → running) rests on a stage the card never yields idle (fable HIGH, codex HIGH) | **Adopted.** Classify follows the card exactly; the refinement is dropped. |
| 3 | Hidden dock unmounts the toast owner (fable HIGH); toast scheme fragile (codex MED) | **Adopted.** `useCompletionToasts()` once in `AppShell`; `toasts` prop removed; moved to Phase 1 (codex HIGH on sequencing). |
| 4 | `density` prop is a false seam (both MED) | **Adopted.** `ActivityDock` is its own component over `useActivityFeed`. |
| 5 | Foreground record: fable says both lists read `records` and mark it; codex says the dock should use `visibleRecords` on Send | **Split the difference.** Listed and marked on Send with no action button, excluded from count/auto-open; the Activity page reads `records`. Flagged for the final codex pass. |
| 6 | DISCARD one-click in the dock (both HIGH) | **Adopted.** Never in the dock; blocked/stuck rows show a word and route to the page. |
| 7 | Auto-open persists the preference / reopens on every reload for blocked records (fable MED, codex MED) | **Adopted.** Session flag only; a persisted seen-set keyed by id; blocked and foreground records never auto-open. |
| 8 | Shell state: singleton (fable) vs AppShell provide/inject (codex MED) | **Rejected codex's alternative.** The app's convention is singletons with test resets; tests mount subtrees without `AppShell`. Resets added. |
| 9 | `blocked`/`displaySymbol` are persisted attacker text (codex MED) | **Adopted for the dock** (word + `safeDisplay` + cap). The page card's raw render is pre-existing → follow-up, out of scope. |
| 10 | Placeholder networks would instantiate the journal outside the `IS_PLACEHOLDER` gate (codex MED) | **Adopted.** Dock, feed, Activity list and the toast owner are gated identically. |
| 11 | `send-smoke` cannot see the shell (codex HIGH); `SendView.test.ts` pins the removed heading (codex MED); frozen diff only at Phase 4, Phase 1 skips smoke (fable MED) | **Adopted.** New `shell-smoke.test.ts`; `SendView.test.ts` re-homed; `<frozen>` and `<smoke>` in every gate. |
| 12 | Missing tests: toast while hidden, parity pin, foreground on Activity, focus on hide, testid sweep, overlay keyboard, retry re-entry, cross-tab (both) | **Adopted** into the phase test lists; cross-tab documented, not tested (jsdom `storage` events are synthetic). |
| 13 | `bun run audit:vue` before a UI PR (fable LOW) | **Adopted** in Phase 5. |
| 14 | Compact rails pulsing on Activity (fable LOW) | **Adopted** into criterion 3. |
| 15 | "86 tests" (mapper miscount; codex) | **Corrected** to 42. |
| 16 | Final: #5 unsound — an action-less row is still a second surface; the smoke pin counts list containers (codex final HIGH) | **Adopted.** Dock uses `visibleRecords`; the mock's *on screen* row is dropped; owner told at the gate. |
| 17 | Final: `v-show` keeps the dock rendered on Activity, against criterion 8 (MED) | **Adopted.** `v-if`. |
| 18 | Final ruling on `opsBusy`: it protects account switching, not run concurrency (record-local `busy` + `withRecordLock` do) | **Adopted.** SWITCH only. |
| 19 | Final: `busy → running` before `completedAt → done` inverts the card's precedence (HIGH) | **Adopted.** Completion first; `completedAt + busy` fixture. |
| 20 | Final: a 64-id seen cap can forget a live bridge (unfinished records are never evicted); `hide()` had no input; cross-tab (HIGH) | **Adopted.** Prune to live ids, `hide(ids)`, re-read storage per call. |
| 21 | Final: CLAIM GAS has no record lock → double activation (MED) | **Adopted.** Dock-local per-record in-flight set. |
| 22 | Final: background handoff must use `backgroundedCanonical` (MED) | **Adopted.** |
| 23 | Final: `age` needs `useNow()` read inside the feed computed (LOW) | **Adopted.** |
| 24 | Final: the first-visit restore link must reuse `BridgeJournal`'s guarded restore path (MED) | **Adopted.** Slot inside `BridgeJournal`, not a second path. |
| 25 | Final: `<frozen>` against a mutable base branch (LOW) | **Adopted.** Diffs against a fixed base. |
| 26 | Final: Fact 1 wording (MED) | **Corrected.** |
| 27 | Final: product choices need explicit owner confirmation (MED) | **Adopted.** Listed as gate questions (a)–(f). |
| 28 | Owner round 1: (a)(c)(d)(e) ok; (b)(f) need context; pull the small follow-ups in | **Adopted.** ELI5 gains illustrated explanations of (b), (d), (f); the viem message, the card sanitising and the Aztec-panel merge join Phases 1–2. |
| 29 | Owner, round-3 walk: a private token bridged with no gas bought paid its claim from PUBLIC Fee Juice — "should have been blocked at the bridge, it doxxes the user"; hard block at send time; no escape for stuck records (pre-production) | **Adopted, in this PR.** `decideOwnGasSource` takes `privateBridge` — a private bridge pays only from its PrivateFPC credit at both gates (the wizard's token-only choice and the claim ladder), with messages that say why. The nine frozen step files stay untouched; the fence lives in the wizard's gate and the shared decision. |

## Seeds

**Final** (post-approval). Recommended: `/goal` — completion is transcript-observable. The alternative is `/loop 15m`. Use exactly one per session.

```
/goal All five phases marked ✓ in implementations-plan/archive/tools-console/plan.md (the per-phase headers in the file — not the chat, not the task list), each ✓ backed by that phase's validation gate as defined in plan.md reported passing in the transcript: `bun run lint`, `bun run --cwd apps/tools typecheck`, `bun run --cwd apps/tools test`, `bun run --cwd apps/tools test:e2e`, and `git diff --quiet <rev> -- <the nine frozen step files listed in plan.md>` all exit 0, plus each phase's own gate line (Phase 1: the parity pin green and BridgeJournalCard.test.ts byte-identical; Phase 2: shell-smoke.test.ts green; Phase 3: the shell smoke's dock cases green; Phase 4: the frozen diff quoted; Phase 5: `bun run audit:vue` and `bun run --cwd apps/tools build:testnet` exit 0 and the owner's preview sign-off recorded in implementations-plan/archive/tools-console/lessons/phase-5.md); for each phase the agent has printed `LESSONS_FILE=implementations-plan/archive/tools-console/lessons/phase-N.md` in the transcript; `/code-review` was NOT run (plan.md says code_review: off); the codex fix loop over the net diff converged, evidenced by a resumed codex pass reporting no new material findings, quoted in the transcript; the six owner-confirmed choices (a)–(f) in plan.md's Assumptions are implemented as written, including no DISCARD in the dock and the foreground record absent from the Send dock; a single PR exists on GitHub, created only after the loop converged (`gh pr view` output in the transcript); `bun run lint` and `bun run --cwd apps/tools test` both report exit 0 in the transcript.
```
