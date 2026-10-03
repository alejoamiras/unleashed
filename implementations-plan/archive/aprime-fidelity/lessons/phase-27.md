# Phase 27 — Phone amount step

## What was done

- **Choice rows, G71 + G124 phone half, OQ14 B, D22.** `ChoiceCards.vue` wraps the radiogroup in `.choices` with a `What arrives` heading that names it through `aria-labelledby`. The heading is sr-only above 760 and 13/700 at or below it. Each radio sits in a `role="none"` row: a two-column grid whose radio spans both cells.
  - At ≤760 each radio shows a `.hint` (12.5, ink-2; the line tone on the selected row, ink-3 when disabled) and hides `.desc`. Rows are 40px min, padding 0 12, box 16, with a 4px gap between rows.
  - The selected gas row (Token + gas or Gas) gets a `<button type="button">` beside its radio (`TESTIDS.sendGasDisclosure`). The grid lays it over the hint cell with `z-index: 1`, and that row's in-radio hint is `display: none`. The button reads hint + 12px chevron (rotated 180 while open) + an sr-only ", gas breakdown". It carries `aria-expanded` and `aria-controls` and emits `toggle-gas`. It has no key handlers, so the arrow keys still walk only the radios (`move()` queries `[data-index]`). It renders only when `useMediaQuery(PHONE_QUERY)` matches and the parent passes a `breakdownId`.
  - New props: `txTarget`, `breakdownId?` and `breakdownOpen?`.
- **`hintOf` in `lib/send-model.ts`.** A pure `hintOf(choice, { exit, txTarget, gasBlock, tokenBlocked })` returns `{ lead, count?, tail? }`, so the transaction count renders as a Mono figure. `hintText` joins the parts. The copy is "only the token", "gas for N transaction(s)", "all of it as gas", "back to Ethereum", "not for this token" (no route), "can't check right now" (unavailable) and "needs gas first" (token-only without held gas).
- **Amount step.** `AmountStep.vue`:
  - `.amount` is a grid with named areas: desktop `"field" "balance"`, and ≤760 `"label balance" "field field"`, gap 6 12, baseline-aligned. The error is an implicit full-width row, so an absent error leaves no gap (see attempts).
  - An `aria-hidden` "Amount" caption shows only at ≤760. At ≤760 the balance's symbol span is hidden and the balance is Mono 12.5, so the text stays "Balance 0.005 USDC".
  - `gasOpen` is toggled by `toggle-gas` and reset when the `token` prop changes. `GasBreakdown` gets `id="send-gas-breakdown"` and `v-show="!phone || breakdownOpen"`, where `breakdownOpen = gasOpen || shownGasError !== null || gas?.capped` (narrowed in verifier round 1 to a cap note the breakdown draws). The button's `aria-expanded` reads the same value.
  - At ≤760: `.privacy` loses its panel (transparent fill, padding 0), `.nav` is `column-reverse` with both buttons full width, and the Continue chevron is 12 (24 on desktop). The step gap is 14.
- **Veil-line wrap, found by the tour.** At 390 a private deposit's veil line wrapped with a lone "·" ending line 1. The separator and "you see …" are now one inline-flex unit, so the separator wraps with them. Desktop is unchanged: the line fits there.

## Tests

- `send-model.test.ts`: one `hintOf` table covering token; token + gas at N = 1 and N = 2; gas; exit; and the three disabled reasons. One more case pins the `{ lead, count, tail }` split.
- `ChoiceCards.test.ts`:
  - The radiogroup is named by the heading and holds exactly three `role=radio`, none of which contains a button.
  - At phone width: the hint button is a sibling of the selected radio with `aria-controls` naming the breakdown. Its accessible name is "gas for 2 transactions, gas breakdown". A click emits `toggle-gas` and no `update:intent`. ArrowRight on the button moves nothing. ArrowRight from the radio lands on the next radio, skipping the button.
  - Tab order is checked from DOM order and `tabIndex`, because jsdom does not move focus on Tab. The tab stops are exactly [selected radio, hint button]: Tab from the radio lands on the button, and Shift+Tab returns to the radio.
  - There is no button on the token row, none without a `breakdownId`, and none on a desktop.
- `AmountStep.test.ts` with a phone `matchMedia`: the breakdown is hidden, and the button's `aria-controls` equals its `id` with `aria-expanded="false"`. A click shows the breakdown and flips `aria-expanded`. A gas error or a capped plan shows the breakdown without a click, with `aria-expanded="true"`. On a desktop the breakdown is visible and there is no hint button.
- `testid-coverage.test.ts`: a phone sweep of `ChoiceCards` finds `sendGasDisclosure` with no untagged control.
- `spike.spec.ts`, 390 case: after the review, the case goes back to the amount step. The hint button is visible and its box lies inside the Token + gas row, and `tl-send-gas-breakdown` is hidden until the button is clicked. After the click the row is still the checked radio. The case then continues to review and deposits. To support this, `goToReview` is exported from `pages/send.ts`.

## Attempts and notes

1. A first draft of the grid gave the error its own `"err"` area. An empty named row still takes a row gap, so desktop would have gained 8px under the balance. It was fixed before the commit: the error is placed with `grid-column: 1 / -1` in an implicit row. The 1440 capture has the same rhythm as arc 7's `04-amount-token-dark-1440`.
2. Tour run 1: the exit capture timed out. At 390, after the faucet page, the harness's parked wallet iframe sits over the band's first tab and intercepts the pointer. Run 3 used `dispatchEvent("click")` in the throwaway spec. This is harness overlap, not an app defect.
3. No unit, lint or typecheck failures on any committed state.

## Deviations (with reasons)

- **`ChoiceCards`' `gasReason: string | null` became `gasBlock: GasBlock | null`.** The short phone reasons need the kind of block, not its sentence. The two sentences moved into `GAS_BLOCK_REASON` in `send-model.ts`, where both the cards and the amount step's sr-only live region read them. Neither sentence's text changed.
- **The radio stays described by its full caption (`.desc`) at every width.** It is `display: none` at ≤760, but `aria-describedby` still computes a description from hidden nodes, so a screen reader hears "Part of it arrives as gas." or the full reason, not the clipped hint. A radio's content is presentational, so the visible hint adds nothing to its name. The plan's "only one in the accessibility tree" holds.
- **The breakdown's open state persists across a gas-row switch within the same token.** A user who opened it on Token + gas sees it open on Gas. It resets only on a new `token` prop. The plan says "reset on each token pick"; the prop's object also changes once the chain read lands for the picked row. That can only close a breakdown opened in the brief window before the read lands, and the route quote needs that read first anyway.
- **Step gap 14 at ≤760** matches the Mobile board's body gap. The plan does not list it; it is phone-only CSS.
- **The veil-line fix** is a phone regression found by the tour, fixed in this arc per tour rule 6.

## Board comparison (DCQMobile, 390)

Matches the board: the visible "What arrives" 13/700; 40px one-line rows with right-hand hints and a Mono count; reverse video on the selected row; the disabled rows' in-place "not for this token"; the "Amount" caption with the dotted Mono balance on its right; the 60px field; the full-width magenta Continue with a 12px chevron; no privacy panel.

Differences that are decisions:
1. Back is stacked under Continue, and the gas breakdown exists behind the row hint (OQ14 B). The hint on the selected gas row carries a chevron the board does not draw.
2. The bridge footer shows under the card on the form steps (Q5 B); the board draws none. The theme control is the cycling "System" button (Q1 A). The Ethereum chip keeps its × (OQ13 A).
3. Arrival words on the token row stay "Token", and the default choice stays Token (OQ15 A); the board's frame has Token + gas picked.

Differences flagged for sign-off:
4. **Privacy row layout.** The board puts the label and a one-line "Others see [56×14] · you see 250.00" (12.5) in a column beside the switch. The app keeps its phase 19 structure: switch and label in a row, then the veil line ("Others on Aztec see", a 104×22 veil, 13px) underneath. At 390 that line always wraps to two lines, even for "250.00 USDT": "you see …" starts line 2, and the "·" separator is hidden at ≤760. No copy was changed ("Others see" would be new copy).
5. **Balance label.** The board sets "Balance 1,204.55" all in Mono ink-2. The app keeps "Balance" in body ink-3 before the Mono figure (phase 19, G52), and hides the symbol at ≤760.
6. **The disabled Gas row** reads "not for this token" only for a token with no route. The board's "Token + gas enabled, Gas disabled" state cannot occur (recon G71): a no-route token disables both gas rows.
7. **Review at 390** (regression shot only) keeps Back and "Sign and send" side by side. Arc 9 does not touch the review; there is no Mobile review board.
8. **The bridge footer breaks between "Aztec:" and "Bridge hub" at 390**, in every form-step capture. This is phase 21's open Low flag, carried forward. Its proposed fix is to group each chain label with its links in an inline-flex `nowrap` span, which leaves the desktop row unchanged. It is not applied here: the footer is arc 7's surface and awaits the owner's call.

The 1440 token, amount and review captures and the 1024 amount capture are unchanged from arc 7 apart from the dock state, which the seeded preference opened.

## Tour (T for arc 9, `zz-arc9`, deleted before the full run, never committed)

32 JPEGs were taken, dark and light:
- 390: disconnected with a seeded "open" dock preference, token, wrong chain, no-route amount, token, token + gas (closed), token + gas with the breakdown opened from its hint, gas, exit amount, review, activity, faucet.
- Regression: 1440 token, amount and review; 1024 amount.

Checks recorded per capture:
- Every capture: no horizontal scroll.
- At 390: no dock or strip element in any capture, and the send view spans x 16–374. **The pass criterion holds: nothing at x ≥ 346 is a dock column.**
- Amount rows: 334×40 each. The hint button is 169×40 at x 193–362, inside the Token + gas row; on Gas it is 118×40. The field is 60 tall. Continue (y 817) sits above Back (y 873), both 334 wide.

## Validation gate (LG for PR 6)

All of the following ran:

- **PG:**
  - `bun run lint` exit 0 (the known warning and two infos; complexity-baseline OK)
  - `bun run typecheck:all` exit 0
  - `bun run test:all` exit 0: design 242, bridge-core 451 + 1 skipped, tools 1630
  - `bun run --cwd apps/tools test:e2e` exit 0 (30)
  - `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0, so the complexity manifest gained no entries
- **BG:**
  - `build:testnet` and `build:mainnet` each passed `verify:build-target`, with no `data:font` and `_headers` identical to the base.
  - `verify:deployments` OK, so the gate reports BG PASS.
- **`bun run audit:tools`** exit 0 (tools 1630, testnet build).
- **`bun run e2e:tools`** as six concurrent shards: every shard exited 0.
  - Per shard: 17, 7, 17, 11, 13 and 5 passed, **70 passed** in total, with no flaky or failed tests.
  - This includes `spike.spec.ts`'s 390 case with the hint-button assertions (52.7s).

## Flags for owner sign-off

- The short hints are new copy: "only the token", "gas for N transactions", "all of it as gas", "back to Ethereum", "not for this token", "can't check right now" and "needs gas first".
- The hint button is a separate tab stop right after the selected radio, inside the radiogroup's subtree. This is one extra stop beyond the APG single-tab-stop radio pattern.
- `column-reverse` makes the visual order Continue then Back, but the Tab order is Back → Continue.
- The privacy row and balance-label differences above (items 4–5), and the footer wrap (item 8).
- On phones the veil line's "·" separator is hidden, and "you see …" starts the second line.

## Verifier round 1

Four findings. Each was checked against the code; all four were accepted, one of them as a flag rather than a code change.

1. **Medium, accepted: a capped gas-only plan pinned the phone breakdown open.** `GasBreakdown` draws its cap note only for token + gas, but `breakdownOpen` read `gas?.capped` for any intent, and `buildGas` copies `share.capped` into gas-only plans too. On a phone a gas-only amount under about twice the transactions' cost therefore held the breakdown open with no note to explain it, and the row hint could not fold it. `AmountStep` now holds it open only when `intent === "token+gas"` and the plan is capped.
   - Test: at phone width, a gas-only plan capped at "half" keeps the breakdown hidden with `aria-expanded="false"`, and a click opens it. The test fails on the old rule.
   - Browser: the recapture spec picked Gas at 100 USDT, saw `data-capped="half"` with the breakdown folded, and opened it from the hint.
2. **Low, accepted: the veil line's separator opened line 2 at 390.** The fix moved the orphaned "·" from the end of line 1 to the start of line 2. The veil line always wraps at 390, even for "250.00 USDT", so the earlier note that it wraps only with a six-decimal remainder was wrong. The `.dot` is now hidden at ≤760: line 2 reads "you see 250.00 USDT". Desktop keeps the separator. Board item 4 and the owner flag are reworded to match.
3. **Low, accepted as a flag: the footer's "Aztec:" / "Bridge hub" break at 390.** It is listed as board difference 8 and in the owner flags, carrying phase 21's open flag forward. Phase 21's grouping fix is not applied: the footer is arc 7's surface and awaits the owner's call.
4. **Low, accepted: a blocked gas row still offered the breakdown toggle.** `discloses()` now also requires `enabled(choice)`, so a selected gas row whose route turned unavailable or has no route shows its plain in-radio hint ("can't check right now" or "not for this token"). The CSS rule for a disclosure after a disabled cell became dead and was removed. Test: the phone "no hint button" table gains a `gasBlock: "unavailable"` case with Token + gas selected.

Recapture (throwaway `zz-arc9v`, deleted after the run and never committed): `04-amount-token-*-390`, `04-amount-token-gas-*-390` and `04-amount-token-gas-open-*-390`, dark and light, replace the earlier captures. The actor holds private credit, so the Token row stays enabled, as in the earlier captures. The first attempt used a fresh actor, whose Token row read "needs gas first". A second attempt funded public Fee Juice, which a private token-only send cannot use, and it failed its own "Token enabled" check. The third, with a private credit note, passed. Every capture: no horizontal scroll, no dock, the separator hidden, and "you see …" on line 2 at x 28.

Gate:
- PG: `bun run lint` exit 0; `bun run typecheck:all` exit 0; `bun run test:all` exit 0 (design 242, bridge-core 451 + 1 skipped, tools 1631); `bun run --cwd apps/tools test:e2e` exit 0 (30); the baselines diff exit 0.
- Recapture spec: `1 passed (1.4m)`.
- `agent.sh specs/spike.spec.ts` exit 0: `7 passed (6.3m)`, including the 390 hint-button case.
- The full six-shard `e2e:tools` was not rerun. These fixes touch only the phone disclosure rule and one phone CSS rule, and the specs that cover them (`spike.spec.ts`, plus the recapture) ran.

## PR 6 review evidence

The throwaway `zz-pr6-evidence` ran alone with `agent.sh` (`1 passed (1.7m)`). It was deleted and never committed. It used the arc 8 and arc 9 tour recipe:
- JPEG q72, full page, at 1440×900 or 390×844.
- The wallet iframe and `[data-wallet-parked]` hidden.

Every capture shows no horizontal scroll.

- **Compact rail outline.** The `06-card-crossing-dark-1440` capture is retaken, the only width and theme that existed for it.
  - The card is caught mid-crossing at a 0% fill, reading "2 checkpoints until your funds arrive".
  - The Crossing segment computes `inset 0 0 0 1px` in `--ul-signal`. A zoom of the JPEG shows the magenta outline around the grey track, distinct from the pending Claim and Confirm cells.
  - The page now holds one record; the phase 24b capture had three, left by that tour's earlier parts.
- **Phone Activity chip.** Arc 9 never rendered the 22px count chip at 390. The `06-activity-needs-you-{dark,light}-390` captures are new.
  - The deposit's claim arrival gate was held (`holdNext("simulateTx", hub)`), then the page reloaded, as in `recovery.spec.ts` cell 24a. The record then waits on the user, with Claim offered.
  - The Activity tab's chip reads "1", at 22×22 (x 337, y 59), in both themes, above a needs-you card and a done card.
  - After the reload the needs-you card has no checkpoint count, so its Crossing cell is solid attention, not partial. These captures do not show the `--ul-attention` outline variant.
- **Locked direction fit.** With a deposit's stepper showing, the locked segment's right edge was measured against the `.locked` row's content box (its right minus 24px padding):

| Viewport | Segment right | Content right | Labels | `scrollWidth` | Result |
|---|---|---|---|---|---|
| 341 | 301 | 301 | two lines each, wrapped | 341 | pass |
| 360 | 320 | 320 | one line, wrap allowed | 360 | pass |
| 363 | 323 | 323 | one line, wrap allowed | 363 | pass |
| 364 | 324 | 324 | one line, `nowrap` | 364 | pass |
| 390 | 350 | 350 | one line, `nowrap` | 390 | pass |

No tab's text overflows its button at any width. At 360 and 363 the labels fit on one line even with wrapping allowed. The ≤363 rule therefore has slack above the width where wrapping starts, which lies between 341 and 360.

## PR 6 Codex review (GPT-6 Astra, high), converged in 3 rounds

**Round 1:** 4 material findings, all fixed.

- **Medium: the crossing fraction could move back**. `checkpointSpan` took the widest wait seen, so a lagging node reporting more checkpoints left widened the denominator and erased shown progress. Codex reproduced 3 → 1 → 4 left as Crossing 0% → 67% → 0%. Codex suggested holding a maximum fraction; I kept the count itself monotone instead, `left = min(shown, reported)` within an attempt, against the attempt's first reading. That keeps the bar, the rail's spoken "n of m" and the narration consistent. The cost is that a truly widening wait shows the lower count, and Codex accepted it in round 2. The existing pin `(b)` in `useBridgeJournal.stages.test.ts` encoded the old widening, so it was rewritten, not added to.
- **Medium: unbounded wallet text in the phase list**. `rt.note` reached a failed phase's detail with no strip or cap: a 10,001-character note kept its bidi override. Runtime notes and step details now pass `safeSentence`; the app's own prompts do not.
- **Low: locked direction at 341–363px**. The segment's 284px min-content ran into the stepper row's 24px padding. The wrap rule moved from ≤340 to ≤363; labels stay on one line wherever they fit.
- **Low: held phone breakdown**. Taps while an error or cap note held the breakdown open flipped hidden `gasOpen`. They are ignored, and the hint is `aria-disabled` while held.
- **Other changes:**
  - Five narrating comments were removed.
  - **Compact-rail verdict:** keep the measured fraction (the old PROVE share divided absolute block numbers, so it read near-full) and outline the live partial segment so 0% reads as running. Surface 5 of arc 8 was updated and flagged for sign-off.
- **The 12 open lows:**
  - fix 8 and 10 (the two Lows above);
  - fix the evidence for 12 (the 390 Activity chip, captured above);
  - leave 1–7, 9 and 11, each for a reason Codex gave.

**Round 2:** 1 Low, fixed. Clearing both checkpoint fields when a new attempt's gate began removed `.partial` for one probe's latency, so the card's cell flashed solid. Codex proposed always-outlined active cells. I declined it because it also changes cells that never get a count (legacy records, no probe, the unanchored stretch). The reset is lazy instead: a local `fresh` flag makes the attempt's first count reading replace the previous attempt's values in place. The same commit applies Codex's `checkpointsLeft` doc wording and the plan's surface 5 text.

**Round 3:** 0 material findings. The limitation it noted: while probes keep failing or report the message unanchored, the previous attempt's fraction stays up. This shows under the waiting narration and an incomplete overall bar, and it is not a merge blocker.

**Gate, round fixes:** lint and `typecheck:all` exit 0. The journal, phase and amount suites pass: 234 across the journal suites, plus AmountStep, ChoiceCards and testid-coverage at 76. `test:all` exits 0: design 242, bridge-core 451 + 1 skipped, tools 1632.

## Arc 8 re-tour on the integrated branch

**Why.** Arc 8 was built and toured on its own track, on a base without arc 7's footer removal or arc 9's phone layout, then cherry-picked. So its captures showed things that no longer ship:
- the page footer under the in-flight card;
- a 3px bar edge at 0% on the permission prompt;
- the pre-phone header at 390;
- in `06-inflight-later`, the parked wallet panel over the logo.

**Run.** The throwaway `zz-arc8-retour` ran alone with `agent.sh`: `1 passed (3.5m)`. It was deleted and never committed. It used the same recipe as before: JPEG q72, full page, 1440×900, 1100×900 and 390×844. `iframe, [data-wallet-parked]` was hidden for every capture, `06-inflight-later` included.
- `06-inflight-later` is now driven, not timed. `holdNext("sendTx")` was armed once Crossing was active, so the first deposit parked on Register + claim ("confirm in your Aztec wallet"). The capture was taken there, then the hold was released.
- All 30 arc 8 captures were retaken in place, except `06-card-crossing-dark-1440`, which was retaken for the PR 6 review evidence above. No state was skipped, and no capture was added or dropped.

**Checks, every capture:**
- no horizontal page scroll and no stepper scroll;
- no page footer (the only `<footer>` in the DOM is the Faucet view's, hidden by `v-show`);
- the bar is 18px tall;
- the locked segment is 380 wide at 1440 and 1100 and 310 at 390;
- the log sits beside the list at 1440 and 1100 (498 and 382 wide) and stacks at 390 (310 wide).

Crossing sampled on this head: 50 ("Aztec picks up…") → 50 (2 checkpoints) → 58 (1) → 67 (message arrived) → 67 when done, the same as phase 24's run after its fix. `06-inflight-crossing-advanced` is at 58%.

**What differs from the old captures:**
- There is no Foundry/Aztec page footer under the in-flight card.
- The permission prompt's empty bar has no leading edge.
- At 390 the captures show arc 9's header: the brand row with the theme button, 40px tabs, full-width 44px wallet chips, and a subline that wraps instead of ending in "…".
- `06-inflight-later` has the log and no harness panel.

**Still different from arc 8's visible surfaces, as already recorded:**
- **Surface 3:** the sandbox proves at once, so the exit captures show Finish active and Prove done at 0:05. PROVE's fraction and "Proven block n of m" appear in no capture (phase 23, attempt 3).
- **Surface 4:** the failed phase is Claim ("Claim failed · phase 4 of 5", fill in `--ul-lost`), not Crossing. Its note is the pre-existing "… Your funds are not lost - retry from this card." (phase 23, board comparison 5).
- **At 390** the subline still breaks between the amount and the symbol ("174.20" / "FRSH · public") (phase 23, board comparison 3).
- **The Permission row** has no time, and the sandbox's done rows read 0:00 (phase 23, board comparison 1).

## Final cross-arc Codex review (GPT-6 Astra, high), whole stack, converged in 3 rounds

Round 1 read the whole stack on the integrated branch against `main`. It checked the nine required bugs, the external-text boundary, the protocol strings, the baselines, and the seven open questions it was asked about.

- Every required bug is fixed in code: G02, G03, G14, G58, G67, G68, R5-1, the "TOKEN" toast, and the stuck exit after a direction switch. Only G03, the wizard's strip rule leaking onto the mint strip, has no direct automated pin: it is a scoped-style collision, and jsdom does not evaluate styles. The mint strip's captures are its evidence.
- Medium, pre-existing: toasts and the card's gas-recovery error rendered wallet or RPC text unbounded. The fix passes toast `lead`/`text` through `safeSentence` once, in `useToast.push`, and applies it to the card's inline error.
- Medium: the top-right toast region covered Restore and the open dock's head and first rows, and the recovery toast has no dismiss. Desktop toasts moved to the bottom left, on the content edge, with `--shell-rail` on `.shell` placing them beside the rail.
- Low: two gas-only surfaces dropped "before claim fees":
  - the restore toast (fixed);
  - the stepper headline (fixed here, rendered as `{{ qualifier ? ` ${qualifier}` : "" }}`, because a `<template v-if>` whose text starts with a space lost that space and printed "FJbefore").
- Three cleanups here:
  - `hintText` moved into its test;
  - a "codex bug-bash" citation dropped from `journal.ts`;
  - a narrating comment dropped from `TokenCard.vue`.
- Codex's verdicts on the seven owner questions matched the flags already in the PR bodies. It added one flag: the record surfaces round 0.005 to "0.00", while the forms and the receipt keep it.

Round 2 covered the fixes and the placement.

- The fixes close findings 1 to 3.
- New Medium, pre-existing: `TokenStep` rendered catalog, selection, lookup and add errors unbounded, and so did `MintStrip`'s mint error. Both now pass `safeSentence`, with a hostile-string test each (U+202E plus 10,000 characters).
- My own sweep found every other interpolation that carries error, reason or note text already bounded or fixed copy:
  - `GasBreakdown` and `ReviewStep` errors;
  - card notes;
  - phase details;
  - `ChoiceCards` reasons;
  - the faucet status;
  - `ConnectionErrorStrip`, whose `NormalizedError.message` is always `TOAST_COPY`.
- Placement: keep the bottom-left anchor over the alternatives, list the covered controls prominently, and keep G121's undismissable recovery toast until the owner changes it. Listing an overlap is not its acceptance; the owner decides.

Round 3 (the round-2 fixes and the applied script): 0 material findings.

Placement evidence is in `lessons/phase-12.md`, "Toast placement, cross-arc review". The anchor clears Restore, the header chips and the whole dock. It covers:
- the footer links on short pages;
- the amount step's Back below a window height of about 780px;
- Continue, Back and Sign and send at 761–~800px wide;
- a card's Claim and Discard when scrolled under it.

The arc-7 `04-amount-gas` captures were retaken and still read "≈ 69 transactions". That is correct: on the sandbox the private fuel claim's ceiling is about 0.000069 FJ against about 3.578 FJ per transaction, so subtracting it cannot move the count. The 9 → 5 drop shows only at testnet-scale values, which `SendWizard.test.ts` and `GasBreakdown.test.ts` pin.
