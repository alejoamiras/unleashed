# Phase 8 — Shared dialog shell and verification focus

## What was done

- **G141 + G67 + G140, the design half:** `packages/design` gains `ui/Dialog.vue` and `ui/useFocusTrap.ts`, both exported from `index.ts` (`Dialog`, `useFocusTrap`, `FocusTrapOptions`), and a README line.
  - `Dialog` props are exactly the contract's: `open`, `title`, `describedby?`, `overlayTestid?`, `closeTestid?`; it emits only `cancel`, from the backdrop (`@click.self`), Escape and the header ×. It teleports to `body`, paints `.ul-scrim`, and renders a notch-6 panel (`max-width: 480px`, padding 24, gap 16, `max-height: 100%`) carrying `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (a `useId()` on the h2), `aria-describedby` and `tabindex="-1"`. The header is the board's: h2 20/700 at `--ul-tracking-heading`, a 36×36 × in `--ul-ink-2` (ink on hover) with `close` at 24 and `aria-label="Close"`. The `footer` slot is right-aligned (gap 12, wraps). The overlay's padding is 24, and 16 at ≤760, so a panel is `min(480px, 100% − 32px)` on a phone.
  - `useFocusTrap(panel, { enabled, onEscape, shouldYield? })`: while `enabled` is true, a `document` keydown listener handles Escape (calls `onEscape`, prevents default) and Tab (always prevented; focus cycles over the panel's tabbable set, entering at the first or last from anywhere outside it). `shouldYield()` true leaves both keys alone. The set is `button, a[href], input, select, textarea, [tabindex]` filtered by one exported predicate `isTabbable`: connected, `tabIndex >= 0`, not `:disabled`, no `[hidden]`/`[inert]` ancestor, not `visibility: hidden`, no `display: none` on itself or an ancestor. Initial focus is queued on `nextTick` and dropped when the trap was disabled or disposed, or the panel left the document, meanwhile; the target is a `[data-autofocus]` descendant, else the panel. Disabling or disposing removes the listener and restores focus to the element that had it at open, only if it is still connected and not inside the panel.
- **The three modals migrate.** `WalletPickerModal`, `VerificationModal` and `ChooseAccountModal` render through `Dialog`; their hand-copied traps, focus watchers, `onKey` handlers and overlay/modal/title styles are deleted. Every testid is kept: `tl-wallet-picker`, `tl-verification-modal` and `tl-account-choice` stay on the scrim (`overlayTestid`); `role=dialog`/`aria-modal` move to the panel for the verification modal, so the dock's `[aria-modal='true']` yield still matches. New testids `walletPickerClose` (`tl-wallet-picker-close`), `verificationClose` (`tl-verification-close`), `accountChoiceClose` (`tl-account-choice-close`) sit on the three ×. Cancel (picker), Cancel + They match (verification) and Continue (chooser) move into the right-aligned footer. The chooser widens 440 → 480 and marks its selected radio `data-autofocus`, which keeps its old initial focus.
- **Handoff test in both watcher orders.**

## Tests

- `useFocusTrap.test.ts` (5): Tab and Shift+Tab wrap over a button, a link, an input, a select, a textarea and a `[tabindex="0"]` span, skipping a disabled button, `a[href][tabindex="-1"]`, an input with `tabindex="-1"`, a `[tabindex="0"][disabled]` button, and buttons inside `display:none`, `[hidden]` and `[inert]` ancestors; a detached node is not tabbable; open focuses the panel, Escape calls `onEscape`, `enabled` false removes the listener (Escape and Tab no longer handled) and restores focus; unmount before the queued focus focuses nothing and throws nothing; `shouldYield` true leaves Escape and Tab unprevented until the other modal leaves.
- `Dialog.test.ts` (6): the panel is the named modal and takes focus; Escape, × and backdrop each emit `cancel` once (a click on the panel does not); closing removes the listener and does not restore to a detached opener; the picker → verification handoff in one flush ends with focus on the verification panel, with either dialog's watcher running first; `data-autofocus` wins the initial focus.
- `mount-all.test.ts`: a `Dialog` entry.
- `VerificationModal.test.ts` +1: opened from an outside button, focus lands inside `[role=dialog]` under `tl-verification-modal`, and Escape emits `cancel`.
- `ChooseAccountModal.test.ts` +1 (× cancels the connect) and one assertion (initial focus on the pre-selected radio). The harness now mounts attached to the document, since Escape reaches the dialog through the document listener; the Escape case itself is unchanged.
- `WalletPickerModal.test.ts` unchanged and green (its Escape and focus cases hold against the shell).
- e2e: `tests/browser/pages/connect.ts` `connectAztec` polls, before confirming, until `document.activeElement` is inside `[data-testid=tl-verification-modal] [role=dialog]` (testid passed from `TESTIDS`, never a single `evaluate`).

## Attempts and notes

1. The first `useFocusTrap.test.ts` run failed two cases: earlier cases' components stayed mounted, so their document listeners still prevented Tab and Escape. `enableAutoUnmount(afterEach)` fixed it; the same applies to `Dialog.test.ts`.
2. The migrated chooser's existing Escape case failed (status stayed `choosing-account`): the wrapper was not attached to the document, so the keydown never reached the new document-level listener. Attaching the harness fixed it; the assertion is unchanged.
3. Biome refused a test helper named `escape` (`noShadowRestrictedNames`); renamed `pressEscape`.
4. `VerificationModal.vue` used `<Flex>` without importing it (the package has no auto-import), so its button row rendered as an unknown `<flex>` element. The footer slot replaces it.

## Deviations from the plan

- **Initial-focus target.** The Key-interfaces signature has no initial-focus option. The trap focuses a `[data-autofocus]` descendant, else the panel; the chooser uses it for its selected radio (its behaviour before this phase). A `data-` attribute rather than `autofocus`, so the browser's own autofocus-on-insert never competes with the queued focus.
- **Tab is fully owned while a dialog is open** (always prevented, next candidate focused), not only at the two ends: jsdom cannot move focus natively, so this is the only form the wrap test can prove, and it keeps focus in the panel even when it starts outside it.
- **Verification gains backdrop cancel** and every dialog a ×, per the shell contract (backdrop, Escape and × emit `cancel`). Cancel never confirms; a misclick on the verification scrim cancels the secure channel, as its Cancel button does.
- **Visible now, ahead of phase 9:** the picker's Cancel is right-aligned and auto-width (G65's "right-aligned Cancel"), and the verification body sits in the 24px shell (was 32). The picker's description line, rows and chip remain phase 9.
- `ChooseAccountModal.test.ts` gained one assertion the plan does not name (initial focus on the selected radio), the only test of the `data-autofocus` wiring in a consumer.

## Validation gate

- PG (`impl/pg8.sh`): `bun run lint` exit 0 (complexity-baseline OK; the one warning and two infos are the pre-existing ones). `bun run typecheck:all` exit 0. `bun run test:all` exit 0 (design 231, bridge-core 447 + 1 skipped, tools 1484 in 105 files). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- `bun run e2e:tools` as six concurrent shards (`impl/e2e8.sh`): every shard exit 0, e2e:tools (6 shards) 69 passed (17 + 7 + 17 + 6 + 11 + 11; 30 min wall clock). Every spec connects through `connectAztec` or `driveToConnected`, so each Aztec connect proved the verification focus poll. `spike.spec.ts`'s viewport test (390 and 1024, dock overlay Escape) is unchanged and green. Each shard stopped its own sandbox by pgid.

## Flags for owner sign-off

- The verification dialog now closes (cancels) on a backdrop click, like the picker and the chooser.
- Every wallet dialog has a header ×; footers are right-aligned (the picker's Cancel and the chooser's Continue lose their full width).
- Initial focus: the picker and the verification dialog focus their panel (no ring on a mouse-driven open); the chooser focuses its selected account.
- No capture in this phase; the arc 3 tour runs in phase 9.
