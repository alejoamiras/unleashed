# Phase 21 — Bridge footer on the form steps

## What was done

- **`BridgeFooter.vue` (G74).**
  - One flex-wrap row with gap 6px 14px: the chain label, the Portal factory, Router and Fee Juice portal links, then "Aztec:" (margin-left 10) and the Bridge hub link.
  - There are no separators. Labels are 400 ink-3 and links ink-2 with a dotted underline (offset 4).
  - Testnet has no tagline. Mainnet adds a second line, "Real funds — keep it small", decided only by `IS_MAINNET`.
  - A contract with no generation to link still renders as a plain label.
- **`useShell().bridgeForm`.** A module-level flag, reset by `__resetShellForTests`, that says the wizard is on a form step.
- **`SendWizard.vue`.**
  - One `view` computed replaces the template's `v-if` chain. It is `permit`, `stepper` or `receipt` once the stage has its data, and `form` otherwise.
  - A watcher publishes `view.kind === "form"` to `bridgeForm` (immediately), and `onScopeDispose` resets the flag to false.
- **`AppShell.vue`.** `<BridgeFooter v-else-if="section === 'send' && bridgeForm" />`. `SendView` stays mounted under `v-show`, so its flag outlives a switch to another section, and the shell ANDs the flag with the section.

## Tests

- New `BridgeFooter.test.ts` (mocking `@/lib/network`, the generation and the explorer):
  - testnet is one row with the four links, no "·" and no tagline, and every link is `noopener noreferrer`;
  - mainnet's second line reads "Real funds — keep it small";
  - without a generation, three plain labels remain beside the Fee Juice portal link.
- `AppShell.test.ts`:
  - The landing test no longer asserts the footer.
  - A new test shows the bridge footer only on Send while the flag is set, gone on Activity, back on Send, and gone when the flag drops.
- `SendWizard.test.ts`: the flag is true on the token step and on the review. It turns false when the stepper takes over, stays false on the receipt, turns true again after New send, and is false once the wizard unmounts.

## Attempts and notes

1. **`view` is a discriminated object, not a bare string union.** The plan names the kinds `"permit" | "stepper" | "receipt" | "form"`. Carrying the record or snapshot on the kind lets the template bind `view.record` and `view.snapshot` with vue-tsc narrowing on `view.kind`, with no non-null assertions and no second null check in the template. The flag reads `view.kind`.
2. **Tour, first run.** It failed in 3.3m. An attempt to raise the connection error strip, by cancelling the wallet's verification step, never saw a verification modal: the test wallet connects without one. The half-started connect then left the Aztec connect button disabled, so `connectAztec` timed out. The strip is proved by `ConnectionErrorStrip.test.ts`, as the plan allows ("else the unit test"), and the attempt was removed.
3. **Tour, second run.** It passed, `1 passed (3.7m)`. USDT is already registered in the sandbox, so its private token + gas review has no first-time note. Those captures are kept as `05-review-private-gas`.
4. **A third spec (`zz-arc7b`)** took the private first-time review from the unregistered no-route token (NORT, token only), with Details closed and open. It passed, `1 passed (1.6m)`.
5. Both `zz-*` specs were deleted before any commit and never committed.
6. Phase 20's review fix had to land before this phase's wizard edits. Those edits were saved as a patch, the two files were restored to HEAD, the fix was committed, and the patch was re-applied cleanly (`git apply --3way`, then unstaged).

## Deviations from the plan

- **`view` is a discriminated object** (see note 1). It is behaviourally the same union.
- **The footer line is `v-else-if`, and `.foot` stays.** On this branch `.foot` still holds the faucet's `Footer`, which arc 6 moves into `DripView`. After integration the BridgeFooter line becomes the wrapper's only child, a `v-if`, and "the `.foot` wrapper goes once empty" applies then. The `AppShell.vue` hunk will conflict with arc 6's edit of the same lines, and so will `AppShell.test.ts`'s faucet-footer assertion.

## Validation gate (LG for PR 5)

Every command ran on the last code commit before review, with only this record's untracked files in the tree. The review fix, which changes tests only, re-ran the tools unit suite and `typecheck` (see Verifier review).

- **PG:**
  - `bun run lint`: exit 0. The same 1 warning and 2 infos, from before this plan. The complexity baseline was OK.
  - `bun run typecheck:all`: exit 0.
  - `bun run test:all`: exit 0.
    - design: 236 tests.
    - bridge-core: 451 passed, 1 skipped.
    - tools: 1570 tests.
  - `bun run --cwd apps/tools test:e2e`: exit 0 (30 tests).
- **BG:** exit 0, "BG PASS".
  - testnet and mainnet each built.
  - `verify:build-target` passed for both.
  - Neither `dist` contains `data:font`.
  - Both `dist/_headers` match the baselines.
  - `verify:deployments` reported "All committed addresses match the rebuilt instances."
- **`bun run audit:tools`:** exit 0 (1570 tests; the testnet build finished in 2.02s).
- **Baselines:** `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- **T:** `agent.sh specs/zz-arc7.spec.ts` exit 0, `1 passed (3.7m)`. `agent.sh specs/zz-arc7b.spec.ts` exit 0, `1 passed (1.6m)`. Both specs were deleted afterwards and never committed. See the board comparison below.
- **Deferred to the integrated branch: `bun run e2e:tools`, the full browser suite.**
  - This track ran the arc 7 specs the phases name:
    - phase 19: `tokens`, `fee-states`, `accounts`, `deposit-token-gas` (22 passed);
    - phase 20: `deposit-token`, `deposit-gas-only`, `exits`, `registration-retry`, plus `tokens` again (27 passed).
  - It did not run the rest of the suite.

## Board vs capture (arc 7)

The table groups the captured surfaces by the widths they were taken at; every capture was taken in both dark and light.

| Widths | Capture | What it shows |
|---|---|---|
| 1440, 1100, 390 | `03-token-footer` | The token step with the footer, full page. |
| 1440, 1100, 390 | `04-amount-token-gas` | Private, with the veil and the gas panel. |
| 1440, 1100, 390 | `05-review-private-gas` | USDT token + gas, private. |
| 1440, 1100, 390 | `05-review-private-first` | NORT token-only, first time. |
| 1440, 1100, 390 | `05-review-exit-private` | |
| 1440, 390 | `04-amount-no-route` | Both gas cards blocked with their reason in place. |
| 1440, 390 | `04-amount-token` | |
| 1440, 390 | `04-amount-gas` | |
| 1440, 390 | `04-amount-public` | Private off. |
| 1440, 390 | `04-amount-stale` | The review stood down by a failed gas re-read, as `fee-states.spec.ts` cell 12 does it. |
| 1440, 390 | `04-amount-exit` | |
| 1440, 390 | `05-review-private-gas-details` | Details open. |
| 1440, 390 | `05-review-private-first-details` | Details open. |
| 1440, 390 | `05-review-public-token` | |
| 1440, 390 | `06-inflight-no-footer` | Full page. |
| 1440, 390 | `07-receipt-no-footer` | Full page. |

Every capture has a report line:
- No capture scrolls horizontally.
- "Portal factory" is on the page on every form step, and absent on the in-flight and receipt captures.

The spec also asserted the absence before shooting.

Matches with DCQBridgeAmount (Token + gas, private, 1440):
- the three cards;
- the field and unit;
- the balance line;
- the gas panel: zap eyebrow, glyph nudges, un-notched count, inset `dl`;
- the raised privacy panel with its flipped label;
- the veil line;
- Back, and Continue with its chevron;
- the one-row footer.

Matches with DCQBridgeReview:
- the 104px grid rows and the Send band;
- the eye-off "Private — only you can see it";
- the Fee figure over its note;
- the first-time note;
- the Details summary with its hint;
- the key on Sign and send.

Differences that are recorded decisions or data:
- **The hint never names the portal (OQ23 A).** The board's hint reads "Token, route, slippage, portal, account, signature".
- **The footer's chain label is the sandbox chain's name ("Foundry:")**, where the board has "Sepolia:".
- **The field shows no magenta underline or block cursor.** The captures are unfocused; the board draws the focused field.
- **Figures come from the sandbox**, for example 20 transactions and "from 73.769598 USDT".
- **No "Confirm the request in your wallet" status line.** It shows only while a confirm is pending, and none was captured.
- **The rail's theme control and the 390 frame box** belong to other arcs or the harness.

Differences to flag:
- **At 390 the footer breaks between "Aztec:" and "Bridge hub".** The row wraps item by item, so a label can end one line while its link starts the next. Grouping each label with its links would keep them together.
- **At 390 the Visibility note ("— visible on Aztec" / "— only you can see it") wraps under the word**, and a long fee note runs to five lines.

## Verifier review

An independent reviewer read the phase's diff. It found no High and no Medium.

It re-ran:
- the footer, shell and wizard unit tests (67);
- the e2e unit config (30);
- `vue-tsc` (clean, template narrowing included);
- Biome.

It walked every stage and data combination of `view` against the old chain. Permit with no record, stepper with an unresolved record, and receipt with no snapshot all fall to the form, as before; the first and last are unreachable.

It checked the lifecycle:
- no TDZ;
- `bridgeForm` has no other writer;
- the flag stays correct through RUN IN BACKGROUND, the permit prompt, HMR, and section switches;
- no frame shows a stale footer.

It also looked at the token-step, in-flight and receipt captures.

Fixed (tests only; the tools unit suite and `typecheck` re-ran green: 1570 tests, exit 0):
- **No test proved the permit prompt drops the flag (Low).** The existing permit test now asserts `bridgeForm` is false.
- **No test put the flag on the faucet (Low, integration).** After arc 6 removes `Footer`, only `section === 'send'` keeps the bridge footer off the faucet. The AppShell test now also visits drip with the flag set.
- **The wizard tests relied on the previous case's unmount to reset the shell (Nit).** `beforeEach` now calls `__resetShellForTests()`.

Left:
- **The 390 footer wrap (Low).** It is flagged for the owner. The proposed fix groups each chain's label and links in an inline-flex `nowrap` span inside the same row, moving the 10px margin to the Aztec group. The desktop row would not change.
- **The integration note on `.foot` padding (Low).** If the integrator removes the `.foot` wrapper, its horizontal padding (`0 36px`, and `0 16px` at ≤760) must move into `BridgeFooter`'s `.footer`, or the footer loses its inset. The reviewer compared the arc 6 branch: its AppShell has `<BridgeFooter v-if="section !== 'drip'" />`, and the merge should resolve to `<BridgeFooter v-if="section === 'send' && bridgeForm" />`, dropping `Footer`'s import and its test mock.
- **The plain-label fallbacks for Portal factory and Router can no longer be reached in the app (Nit).** The footer now mounts only with the wizard, which needs a generation. They stay as defensive code, and the plan asked for that test.
- **`bridgeForm` is a writable ref for every `useShell()` consumer (Nit).** This matches `section`.
- **The `<footer>` sits inside `<main>`, so it is not a contentinfo landmark, and the links open a new tab without notice (Low, pre-existing).**

## Flags for owner sign-off

- The fee-note copy and the Details hint are new copy (the plan's own flag). The screens are `05-review-*`.
- The 390 footer wrap above.
- The mainnet footer's second line is proved by `BridgeFooter.test.ts` only. Serving `build:mainnet` shows only the placeholder.

## Codex round 1 (PR 5 layer)

Codex reviewed the layer's diff and reported two Medium findings, one Low, comment cleanups, and verdicts on nine questions. It found no High.

### Accepted

- **Medium: the gas-only review quoted the wrong fee model.**
  - A gas-only send never registers its source token, and it claims through the standalone fuel claim (`PRIVATE_FUEL_CLAIM_GAS`, 4M L2 gas), not the hub claim (2M).
  - The review priced a private gas-only send at `ceilingsFor(state)`: the hub claim, plus a registration for a first-time token. It also added `fjRegister` to a public gas-only send's figure.
  - `useGasShare` gains `fuelClaimCeiling()`, priced from the clamped limits the way `fuelClaim.ts` submits them. `ceilingsFor`, `ownGasCeilingFor` and the new function now share one `feeLimitOf(txs)` helper. `networkFeeOf` branches on `intent === "gas"`: private uses the fuel claim's ceiling, and public drops the registration charge. One invariant comment marks the branch.
  - Tests:
    - `SendWizard.test.ts` gets a four-case table (private and public, each with a registered and a first-time token) that pins "≈ 0.4 FJ" (the mocked fuel ceiling) and "≈ 0.1 FJ".
    - `useGasShare.test.ts` pins 81M at fees 10/20.
  - `deposit-gas-only.spec.ts` makes no assertion on the review's fee line, so nothing there needed changing.
- **Medium: the amount field hid the real insertion point.**
  - G100 made the block cursor the only caret, but the block always sits after the whole value.
  - The field now tracks `caretAtEnd` on `input`, `keyup`, `click`, `select` and `focus`: the selection is collapsed and at the value's end. The label carries `data-caret-at-end`. Only `.field[data-caret-at-end]:focus-within` shows the block and makes the native caret transparent. Anywhere else the native caret shows in `--ul-signal`.
  - Without `field-sizing` support, the native caret is used throughout, as before.
  - The block's size moved from `.field:focus-within .cursor` onto `.cursor`, so the attribute selector cannot out-specify the ≤760 size rule.
  - The redundant "only caret" comment went with it.
  - `AmountStep.test.ts` checks the attribute: at the end it is set; after a move to the middle (`keyup`) it is cleared; a selection that runs to the end (`select`) clears it too; a click back at the end sets it again.
  - A keyup-driven update lags while an arrow key is held down. The block reappears only when the key is released.
- **Low: remote error text was not bounded.** The review's error line and the gas card's error line now render through `safeSentence`. Raw errors stay as they were everywhere else.
  - A scan of the app's string literals found no app-authored error over 240 code points. The longest is the private-withdrawal refusal at 223, so the cap cuts only foreign text.
  - Instead of adding a new test, each component's existing error test was extended. Each now also pins that a bidi-laden 500-character error renders stripped and capped at 240 code points plus the ellipsis.
- **Verdict 2: the ChoiceCards accessible name.** Each radio is now named by `aria-labelledby` pointing at its label span, and described by `aria-describedby` pointing at the span under it.
  - **Beyond the brief:** that span is the description on every card, not only a blocked one. With the name taken from the label alone, an enabled card's caption ("Part of it arrives as gas.") would otherwise drop out of the accessibility tree.
  - The old assertion that an enabled card has no `aria-describedby` is replaced by a test that resolves both references: an enabled card is described by its caption, a blocked one by its reason.
  - The amount step's mounted live region is unchanged. `accounts.spec.ts` and `fee-states.spec.ts` still resolve the blocked card's reason through `aria-describedby`.
- **Verdict 4: the unpriced private-exit note.** It began "from the private gas…". `feeContractFee` now picks "paid from" or "from" by whether a figure stands above the note, for both the claim and the withdrawal. The duplicate lead-in logic in `heldGasFeeOf` is gone. A new `SendWizard.test.ts` case pins the unpriced exit's note.
- **Verdict 6: the ProgressBar zero sliver.** The fill is border-box with a 3px right edge, so 0% still drew a sliver. At 0% the fill is not rendered; `aria-valuenow` stays "0". `ProgressBar.test.ts` pins it.
- **Comments.**
  - `txCoveredOf` loses its sizing-target description, which contradicted the floor-based contract under it.
  - `TokenCard`'s historical QA paragraph is deleted. It said the handler resets emphasis at entry, which it does not.
  - `gasReason`'s restating doc comment is deleted.

### Not changed

- **Verdict 1** is superseded by the caret fix, a middle path that keeps the board's block cursor at the end of the value.
- **Verdict 3 / G146** stays as it is. OQ32 A is the owner's decision.
- **Verdicts 5, 7, 8 and 9** stay as they are, per Codex: the hyphens outside G94's scope, the remount and result ownership (pre-existing), the TokenCard article, and the discriminated `view`.

### Residual, closed

- A private gas-only send's "gas for ≈ N transactions" counted the whole floor, and the gas card's "Enough for" divided the whole quote. The standalone fuel claim's ceiling is forfeited before any credit lands.
- Both now subtract `fuelClaimCeiling()` (`mandatoryGasOf` → `gasOnlySetAside`; `GasBreakdown` gets a `setAside` prop through `AmountStep`'s `gasSetAside`). A public gas-only send sets nothing aside.
- One assertion changed: the wizard's gas-only count, 9 → 5.

### Gate

- `bun run lint`: exit 0. The pre-existing warning and two infos remain; the complexity baseline was OK.
- `bun run typecheck:all`: exit 0.
- `bun run test:all`: exit 0.
  - design: 241 tests.
  - bridge-core: 451 passed, 1 skipped.
  - tools: 1584 tests in 107 files.
- `bun run --cwd apps/tools test:e2e`: exit 0 (30 tests).
- Baselines: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- Browser, in its own sandbox, stopped by pgid: `agent.sh specs/deposit-gas-only.spec.ts specs/fee-states.spec.ts specs/tokens.spec.ts specs/drip.spec.ts` exit 0, `22 passed (21.8m)`, none flaky.

### Owner flags

- **The caret deviates from G100.** G100 asked for `caret-color: transparent` inside the `@supports` block, so that the block cursor would be the only caret. Now the block shows only while the selection is collapsed at the end of the value. Anywhere else, the native caret shows in `--ul-signal` and the block hides. This needs the owner's sign-off.
- **The gas-only review's fee figure changes.**
  - A private gas-only send now shows the standalone claim's ceiling. It is higher than the hub claim's for a registered token, and lower than the claim plus registration for a first-time one.
  - A public gas-only send on a first-time token drops from one transaction plus registration to one transaction.
- **Copy:** the unpriced private exit's note now starts "paid from the private gas you already hold".
- **An error longer than 240 code points** now ends in "…" on the review and on the gas card.
- **A progress bar at 0%** no longer shows the 3px edge.

## Codex round 2 (PR 5 layer, the fix diff)

`material findings: 1`. Every round-1 fix was confirmed. The `fuelClaimCeiling` pricing matches what the claim submits for the same fee snapshot.

- **Medium, accepted.** An expired fee quote made `fuelClaimCeiling()` null, which the set-aside turned into `0n`, so the count divided the whole floor again.
  - `mandatoryGasOf` and `gasOnlySetAside` now return `null` while unpriced, and `txCoveredOf` then states no count. The same holds for the token + gas path, whose `ceilingsFor(...) ?? 0n` had the same flaw.
  - `GasBreakdown` states no "Enough for" when `setAside` is null.
  - Tests: the wizard's gas-only case with the ceiling unpriced gives `gasSetAside` null and `txCovered` null; `GasBreakdown` with `setAside: null` shows no count line.
- **Low, accepted.** The caret flag went stale while an arrow key was held (keydown repeats with no keyup) and after parent-driven value changes.
  - It now syncs on `keydown` (on the next task, after the caret moves), on `selectionchange`, and after a post-flush watch on `amount`, alongside the earlier events.
  - Test: a key repeat and a parent-driven value each resync the flag. With the watch removed, the parent case fails.
- **ARIA:** descriptions on enabled cards are kept. A focused description changing alongside a live announcement may repeat on some assistive technology, which Codex judged not worth removing either mechanism for without a reproduction.

## Codex round 3 (PR 5 layer)

`material findings: 0`. The unpriced set-aside now reaches every count as null, and the caret flag resyncs on held keys, selection changes and parent-driven values. A queued sync after unmount is a no-op. The PR 5 loop converged in three rounds.
