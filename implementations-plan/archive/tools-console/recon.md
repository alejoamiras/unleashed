# Recon — tools Console shell

Read-only sweep of `apps/tools/` and `packages/design/` at the base branch (the merged any-erc20 stack). Two agents: a batched reuse sweep and a journal-runtime mapper. Verified by hand where it matters (marked ✔).

## Reuse map

| Capability | Existing code | Verdict | Why |
|---|---|---|---|
| Shell + section switching | `apps/tools/src/AppShell.vue` (`tab` ref, `defaultTab()` on `bridge.*` hosts, one `ConnectionErrorStrip` above all views, views kept mounted with `v-show`, footer swap) | **adapt** | The wiring is right; only the horizontal tab pill becomes a rail with a third entry. |
| Wallet chips | `AccountSwitcher.vue` (shared chip + menu, roving keyboard nav, deliberately not the design `Popover`), `L1WalletPanel.vue` (`AddressDisplay` + connect), `BridgeWalletPanel.vue` / `WalletPanel.vue` (near-duplicate connect state machines; only `WalletPanel` carries the wallet-install CTA) | **adapt** | Relocate into the header unchanged; flatten the chip-in-chip styling. Unifying the two panels is pre-existing duplication, out of scope. |
| Step strip → rail | `components/send/StepStrip.vue` (props `steps/active/completed`, `stateOf`, `reachable`, roving tablist, testids `sendStepStrip`/`sendStep`), `WizardShell.vue` (direction segment, caption, focus-on-step-change, slots `#token/#amount/#review`) | **adapt** | Logic is orientation-free; add an `orientation` prop + per-step hint. The slots are the seam the frozen steps plug into: untouched. |
| Journal list | `BridgeJournal.vue` (sort by `createdAt` desc, restore-file flow, the single completion-toast watcher gated by `toasts`, empty state) ✔ rendered once, from `SendView.vue:42` | **adapt** | Stays the one toast owner; moves into the dock; gains a density. |
| Journal record state | `BridgeJournalCard.vue` computeds `stage`, `attention`, `blocked`, `actionable`, `showClaim`, `showFinish`, `offerSwitch`, `fuelRecoverable`, `showClaimWithoutFuel`, `age`, `acct`, `txLinks` (720 lines, 86 tests) | **adapt (extract)** | A two-line row needs a strict subset of these; extract them into a composable both card and row use, so the decision table has one source. |
| Needs-you / Running / Done grouping + count | none ✔ (`grep needsAttention|pendingCount|attentionCount|needsAction` over `apps/tools/src packages/design/src` → 0; `visibleRecords` at `useBridgeJournal.ts:1462` only excludes the foregrounded record) | **build new** | Pure function over the extracted record state; unit-tested as a decision table. |
| "On screen" record | `SendWizard.vue` `ownedId`/`ownedRecord`/`permitRecord`/`receiptSnapshot`, `onBackground()`, background strip with `sendBackgroundActivity` → `showActivity()` ✔ `SendWizard.vue:974` = `document.querySelector(journal).scrollIntoView()` | **adapt** | `showActivity` must become "open the dock / switch to Activity"; the dock needs the foreground id to draw the on-screen rule. |
| Persisted UI preference | `composables/useTheme.ts` ✔ (`THEME_KEY="unleashed:theme"`, allowlisted read, try/catch write, module singleton ref, SSR guard) | **reuse as pattern** | Copy the shape for the dock open/hidden preference. |
| Faucet view | `views/DripView.vue` (h1 + `.wallets` + `TokenCard` grid), `Footer.vue` vs `BridgeFooter.vue` | **adapt** | Drop the per-view hero and wallets row (header owns them); keep the two footers swapped by section. |
| Empty state | `BridgeJournal.vue` empty block (`journalEmpty`, `journalRestoreLink`), `SendView.vue` `sendUnavailable` | **adapt** | The Activity page's first-visit state replaces the dashed box; the dock keeps a one-line empty. |
| Design primitives | `packages/design`: `Button` (variants `primary`, `primary_outline`, …; sizes `large…micro`), `Badge`, `Tag`, `SectionLabel`, `Card`, `Icon` (json name list incl. `chevron`), `Flex` | **reuse-as-is** | ✔ Only `Flex` is auto-registered (`scripts/design-resolver.ts:16`); everything else is imported explicitly per SFC. |
| Responsive breakpoints | none (no layout `@media` in `app.css` or any shell component; only `prefers-reduced-motion` in the wallet panels) | **build new** | The rail + dock layout introduces the first breakpoints. |
| Test conventions | `mount()` + local `sel()` helper + `global.stubs`, `attachTo: document.body` for focus tests, no Pinia, module singletons with `__reset*ForTests()`; `tests/e2e/tools-smoke.test.ts` mounts `App.vue`, `send-smoke.test.ts` mounts `SendView` with the wallet panels stubbed ✔ and asserts no journal testids | **reuse-as-is** | The smoke pins that move with the shell are named below. |

## Facts the plan leans on (verified)

- `AppShell.vue:17-22` — `type Tab = "drip" | "send"`, `defaultTab()` picks `send` on a `bridge.*` hostname.
- `AppShell.vue:58-66` — one `ConnectionErrorStrip` above both views, with a per-tab `exclude` list; views stay mounted (`v-show`) so the shared wallet session and each view's local state survive switches.
- `SendView.vue:36-43` — the wallets row (`L1WalletPanel` + `BridgeWalletPanel`), `SendWizard`, `BridgeJournal`, all inside the send view; `IS_PLACEHOLDER` gates the wizard.
- `tools-smoke.test.ts:270-279` — "3b. the Send tab renders the wizard, and its journal is the only bridges list app-wide": counts `journalEmpty` (expects exactly one when a bridge generation exists).
- `useBridgeJournal.ts:692-700, 1462` — `activeFlowId` (the foregrounded record), `releaseForeground`, `visibleRecords` excludes it.
- `BridgeJournal.vue:21-24` — props `kind?`, `toasts` (default true), `title` (default `YOUR BRIDGES`).
- `packages/bridge-core/src/journal.ts` — stages: deposit `depositing | syncing | claimable | claiming | done` (+ `registering` for send deposits), withdraw `exiting | proving | consumable | consuming | done`; `completedAt` is the single source of "done"; `blocked?: string` is the persisted terminal reason.
- `useBridgeJournal.ts:69-82, 99-126` — `Attention` = `mismatch | tampered | unseal-failed | stale | stale-deployment | receipt-mismatch | malformed-record | unknown-outcome | error`; `RecordRuntime` = `busy, attention, note, step, stepDetail, claimable, proven, syncBlock, provenBlock, targetBlock, confirmLandedTxHash, …`, module-level, never persisted.
- `lib/bridge-steps.ts:46-50` — `isTerminalAttention` = `{stale-deployment, receipt-mismatch, malformed-record}`; `depositCopy` labels `PERMISSION / SEAL / APPROVE / AUTHORIZE / DEPOSIT (+ FUEL) / CROSSING / REGISTER / CLAIM (GAS | REGISTER + CLAIM) / CONFIRM`; withdraw `EXIT / PROVE / FINISH / CONFIRM`.
- `BridgeJournalCard.vue:184-265` — the action gates (quoted in the mapper's table): `showClaim` = deposit ∧ stage≠done ∧ (stage≠depositing ∨ depositTxHash) ∧ actionable ∧ idle; `showFinish` = withdraw ∧ stage∉{done, exiting} ∧ actionable ∧ idle; RETRY relabel when attention ∈ {error, unknown-outcome}; `offerSwitch` when the recipient is another granted account; `fuelRecoverable` from `decideStandaloneFuelRecovery`; DISCARD available on any non-done idle record, including blocked ones.
- `lib/clock.ts` `useNow()` — one app-wide 1s heartbeat; `age` and `liveElapsed` derive from it.
- `lib/testids.ts` — prefix `tl-`; shell ids `app`, `tabs`, `tabDrip`, `tabSend`, `themeToggle`, `sendView`, `journal`, `journalEmpty`, …

## Grouping decision table (from the mapper; the plan's `lib/activity.ts` implements exactly this)

| busy | completedAt | blocked / terminal attention | condition | Group | Action |
|---|---|---|---|---|---|
| true | — | — | any | running | none (the phase word narrates) |
| false | set | — | fuel not recoverable | done | none |
| false | set | — | `fuelRecoverable`, own account | done | CLAIM GAS |
| false | set | — | `fuelRecoverable`, other granted account | done | SWITCH |
| false | unset | yes | any | needs you | DISCARD only |
| false | unset | no | deposit, `depositing`, no tx hash | needs you | DISCARD only (stuck before send) |
| false | unset | no | deposit, `depositing` + tx hash, or `syncing/claimable/claiming/registering` | needs you | CLAIM, or RETRY on error/unknown-outcome, or SWITCH when another granted account owns it |
| false | unset | no | withdraw, `exiting`, no tx hash | needs you | DISCARD only |
| false | unset | no | withdraw, `proving/consumable/consuming` | needs you | FINISH, or RETRY on error/unknown-outcome |

Note the mapper's caveat: a deposit that is `syncing` with no attention is, by the card's gates, CLAIM-able (the engine's claim lane waits for consumability itself), so it lands in **needs you** unless it is `busy`. The dock's "running" group is therefore: busy records, plus records whose *this-session* run is in flight. The plan's classifier adds one refinement the card does not have: a `syncing` record with no attention and a live sync (`rt.syncBlock` set, or `rt.step`) reads as running; an idle `syncing` record with nothing in flight reads as needs you. This is an inference the audits should attack.

## Collision risks

1. `SendWizard.showActivity()` scrolls to the journal by testid; with the journal in a dock that may be collapsed, it must call into the shell (open the dock / switch to Activity) instead.
2. One completion-toast owner: exactly one `BridgeJournal` with `toasts=true` must exist. The dock instance owns it; any Activity-page list is `toasts=false` and `v-if`-mounted.
3. `WalletPanel` vs `BridgeWalletPanel` duplication: relocate, do not copy.
4. One `ConnectionErrorStrip` for three sections; keep its `exclude` rule per section.
5. Bare `<Button>`/`<Icon>` tags do not resolve unless imported (or added to the resolver allowlist + `components.d.ts` regenerated). Import explicitly.
6. `WizardShell` owns `sendStepPanel`, `sendStepAnnounce`, the slot names and the focus-on-step watcher; the rail must keep all four.
7. Two footers; swap by section, do not merge silently.
8. `apps/tools/README.md` names `FaucetView`; the file is `DripView.vue`. Fix in passing.

## Conventions to match

SFC order script → template → style scoped; grouped imports with `/** … */` headers; `tl-` testids only through `TESTIDS`; e2e selectors by testid only; hairline borders over shadows; mono for metadata, headline for titles; roving tablist for grouped exclusive choices; Biome cognitive ≤15 and ≤80 lines per function; comments say why or invariant, never what, never plan/phase words.
