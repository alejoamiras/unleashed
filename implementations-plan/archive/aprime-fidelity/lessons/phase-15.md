# Phase 15 — Receipt layout

## What was done

- **`BridgeReceipt.vue` in the board's order (G40–G45, G87–G90, the G124 slice).**
  - A header row: route, visibility word, and the elapsed time in a Mono span on the left. The `formatStamp` stamp (Mono 12.5, ink-3) is on the right, and is left out without `completedAt`.
  - The check at 24, decorative, beside a 17/700 `<h2 id>` "Arrived". The section is `<section aria-labelledby>` that h2.
  - The hero: the element carrying `heroTestid` holds only the digits and the symbol. The digits are capped at 56px with line-height 1, and the `--n` fit (floor 20px) counts the grouping commas. The symbol is Mono 600 20px in ink.
  - The gas-only caption "bridged · before claim fees" sits under the hero, as phase 14 left it.
  - The scanline band is 12px tall and bleeds through the padding to both card edges (`margin: 14px calc(-1 * var(--pad)) 0`). The 2px signal line sits at top 5, at .4. One 3px carrier pass at .5 translates across once the digits lock (`var(--ul-converge)`, delay 640ms), starting and ending outside the band.
  - The account line (`sendReceiptAccount`). A deposit reads "In your Aztec account ‹alias› · 0x2b8e…91d0": the alias goes through `safeDisplay` again at render, and without one the line reads "In your Aztec account · 0x…". An exit reads "On Ethereum · 0x…" in EIP-55 form. The whole address is in `title`.
  - A `<dl>` of `div`-grouped rows (130px + 1fr, row-gap 10, 14/1.45):
    - Gas bridged keeps `gasTestid`, now on the `dd`.
    - Review said (`sendReceiptReviewSaid`, on the `dd`, bare figures).
    - From (`sendReceiptFrom`): `sender` only when it has the sending chain's address shape, `/^0x[0-9a-f]{40}$/i` for a deposit and `{64}` for an exit. The value is trimmed, checksummed for Ethereum, and whole in `title`.
    - Visibility (`sendReceiptVisibility`) on every receipt:

      | Receipt | Visibility |
      |---|---|
      | Private deposit | "Private — others on Aztec see static" |
      | Public deposit | "Public — visible on Aztec" |
      | Private exit | "Sent from your private Aztec balance · arrives publicly on Ethereum" |
      | Public exit | "Public — visible on Aztec and Ethereum" |

  - Links are 14/700 with an 18px gap. Both CTAs are `size="large"`: New send with `repeat` 24, and Add to wallet with `plus` 24, which is hidden while `addTokenBusy`. Gap 10.
  - Section margins are 18/14/14/12/28/24/28. The card padding is 32, or 20 at ≤760, where the `dl` is one column and the CTAs wrap.
  - The note sits outside the card, in a column wrapper with a 16px gap. It has info-box 24, 14/1.45 ink-2, `--ul-raised` and notch-2. "…with both transactions." renders only when both links do; otherwise it reads "Its record stays in Activity."
- **Convergence keyframes (G89).** The keyframes sit at 0/37.5/75/100% with per-segment `steps(3)`, `steps(3)`, `steps(2)`. The axes are XELA 90/45/12/0, YELA −80/−38/−10/0, SCAN 70/40/10/0 and BLED 60/30/6/0. The digits declare the zero axes as their base, so the reduced-motion `animation: none !important` shows the end frame. The pass also stops under reduced motion and stays outside the band.
- **`formatStamp(ms, now)`** in `phase-clock.ts` gives "today 14:22", "yesterday 09:10", or "29 Sep 14:22", in local time on a 24-hour clock. It compares days at local midnight and rounds, so a DST shift cannot move a stamp a day.
- **Testids:** `sendReceiptAccount`, `sendReceiptFrom`, `sendReceiptVisibility`.

## Tests

- `phase-clock.test.ts`: one case with the three `formatStamp` forms, built from local dates so it holds in any zone.
- `BridgeReceipt.test.ts` rewritten around two small snapshot builders. The dense pins moved onto the `dd` values, and the file now asserts:
  - the h2 names the section;
  - the stamp shows, and is absent without `completedAt`;
  - the exit account line is checksummed (the EIP-55 spec vector), with the whole address in `title`;
  - the alias is used when present, a bidi mark is stripped, and the address stands alone without an alias;
  - From renders for a deposit (`Ethereum · 0x5aAe…eAed`) and an exit (`Aztec · …`), and is absent with no sender, an Aztec-shaped sender on a deposit, an address carrying a bidi mark, or an Ethereum-shaped sender on an exit;
  - the four Visibility wordings, and that a private exit never calls Ethereum private;
  - no "Gas used"/"Gas ready";
  - the one-link and two-link notes.
- Browser:
  - `pages/send.ts` `waitForReceipt` returns `from`.
  - `deposit-token-gas.spec.ts` cell 13 expects `Ethereum · ${trimAddress(getAddress(l1.address))}`.
  - `exits.spec.ts` cell 27 expects `aztec · ${trimAddress(actor.address)}`, compared case-insensitively because Aztec addresses carry no checksum casing.
  - Both reuse `trimAddress` from `src/lib/format.ts`, which has no dependencies.

## Attempts and notes

1. The first render of the account line printed "In your Aztec accountmain". Vue's whitespace condensing dropped the space that led a `<template v-if>`. The space now comes from the interpolation itself.
2. Tour, first run (`zz-arc5.spec.ts`, one actor, sequential sends). Amount, review, and three receipts were captured: private token + gas, public token-only, and gas-only. The fourth send, a public exit, never left its review. The page logged `submitting: true` and then idle, and no stepper, receipt or stale notice appeared within 120s. The run did not keep a capture of that state. A second spec (`zz-arc5b`), with a fresh actor holding its L2 USDC before connecting (as `exits.spec.ts` cell 27 does), captured the exit receipt cleanly. The full suite's `exits.spec.ts` covers the real flow, including the new From assertion. I did not investigate the chained-send failure further. It happens after three deposits in one session in a tour, not in any spec.
3. Tour, second run. After the exit, the next deposit's Token-only card stayed disabled for 30s. The background-strip capture was taken by a third run, again with a fresh actor, using a token + gas deposit.
4. The amount capture already shows the gas breakdown open under Token + gas, so the separate breakdown capture was a duplicate and was dropped.

## Deviations from the plan

- **The third registered testid is `sendReceiptVisibility`.** The plan says to register three testids, but one of the three it names (`sendReceiptReviewSaid`) already existed. Visibility is the row whose wording the owner signs off, so it gets the third.
- **The Gas bridged and Review said testids moved to the `dd`**, so e2e reads the value without its label. `deposit-token-gas.spec.ts`'s gas assertions are `toContain`/`not.toContain` and hold either way.
- **The check icon is decorative.** It was `label="completed"`. The new h2 names the section, so a labelled icon would announce "completed Arrived".
- **With no alias the account line reads "In your Aztec account · 0x…"**, keeping the separator. The board always shows an alias.
- **The cyan pass is a horizontal translate across the band** that starts and ends outside it. The Motion board shows only the end frame ("locked + sweep") and the receipt board shows no cyan line, so a capture shows only the pink line.

## Validation gate (LG for PR 4)

Every command ran on the last code commit of the phase.

- **PG:**
  - `bun run lint`: exit 0. Biome printed 1 warning and 2 infos. The warning is an unused type import in `useBridgeJournal.stages.test.ts`, which predates this plan and is in a file this phase did not touch. The complexity-baseline check was OK.
  - `bun run typecheck:all`: exit 0 (design, bridge-core and tools, the browser tsconfig included).
  - `bun run test:all`: exit 0.
    - design: 236 tests in 21 files.
    - bridge-core: 451 passed and 1 skipped, in 50 files.
    - tools: 1550 tests in 106 files.
  - `bun run --cwd apps/tools test:e2e`: exit 0 (30 tests in 3 files).
- **BG:** exit 0.
  - testnet and mainnet each built.
  - `verify:build-target` passed for both.
  - Neither `dist` contains `data:font`.
  - Both `dist/_headers` match the baselines.
  - `verify:deployments` reported all committed addresses match. The script ended "BG PASS".
- **`bun run audit:tools`:** exit 0 (1550 tests in 106 files; the testnet build finished in 3.42s).
- **`e2e:tools`, run as 6 concurrent shards (`--shard=i/6`), each with its own sandbox:** all six exited 0, 70 passed (17 + 7 + 17 + 11 + 13 + 5), none flaky.
  - No `zz-*` spec was present during the run.
  - Cell 13 (`deposit-token-gas.spec.ts`) and cell 27 (`exits.spec.ts`) passed with their new From assertions.
- **Baseline:** `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- **The phase-13 grep:** `git grep -n 'toDecimalString(' -- 'apps/tools/src/**/*.vue'` prints only `AmountStep.vue:147`, the `onUseAll` line.
- **T:** see below.

## Board vs capture (arc 5)

Captures:

| Capture | Themes | Widths |
|---|---|---|
| `07-receipt-private-gas` | dark, light | 1440, 1100, 390 |
| `07-receipt-public`, `07-receipt-gas-only`, `07-receipt-exit` | dark, light | 1440, 390 |
| `04-amount-private` (veil and breakdown), `05-review` (step-rail value), `06c-background-strip` | dark | 1440 |

The report flags no horizontal scroll in any capture.

Differences from DCQReceipt that are recorded decisions:
- The "Gas bridged" label and its "before claim fees" value, where the board has "Gas ready" (phase 14 flag).
- "Private FJ" where the board has "FJ" (OQ7 A).
- No Network fee row (G40).
- No proof print (G39 deferred), so the `dl` takes the full width.
- The digits' red COLR palette (lessons.md).

Differences to flag:
- **At 390 the symbol wraps under the hero** even for short figures such as "10.00". The fit formula reserves one character for the symbol, and at phone width the symbol plus the 14px gap needs more than that. No board draws a phone receipt. Tightening the formula would shrink every hero.
- **The note says "This bridge is finished"** on every receipt, exits and sends included. That is the board's copy, which draws only a deposit.
- **The account line on an exit has no alias** ("On Ethereum · 0x…"), because Ethereum accounts have none in this app.
- **The 390 captures show the harness's test-wallet frame box at top left.** This is a harness artefact seen in every earlier arc.

## Flags for owner sign-off

- The exit Visibility wording, both kinds, and the public deposit wording "Public — visible on Aztec".
- R5-1's gas-only hero ("5.00 FJ", captioned "bridged · before claim fees") and its review line "≈ 5 · bridged 5.00".
- "Gas bridged" over the board's "Gas ready" (from phase 14).
- The 390 hero wrap and the no-alias account line above.

## Codex post-implementation review, round 1 (PR layer 4)

Codex reviewed the layer: one Medium, nine Lows, a comment audit, a security pass and a diagnosis of the tour's stuck exit, no High. The Medium, Lows 2, 3, 5, 8 and 9 and the comment audit were fixed; Lows 1, 4, 6 and 7 were left. No copy changed.

Medium, fixed:
- **The receipt could rewrite what the frozen review said.** The wizard kept the reviewed base units but not their decimals, and "Review said X · you got Y" formatted both halves at the record's decimals, so a storage update that changed the record's token decimals before completion rescaled both sides alike. `ReceiptReview.amount` is now `{ value, decimals }` from the plan's token, the snapshot carries `reviewedDecimals`, and the "Review said" half reads only that; "you got" keeps the record's decimals. Missing review decimals read as a dash. Regression (`SendWizard.test.ts`): a 6-decimal review whose record is re-stamped to 18 decimals before completion renders "1.00 · you got 0.000000000001"; with the record's decimals feeding the review half it fails with "0.000000000001 · you got 0.000000000001".

Low, fixed:
- **Low 2:** the send-receipt fixture is 1,000 WBTC, so hero and review line pin "1,000.00".
- **Low 3:** the unused `formatBigInt` import in `SendWizard.vue` is gone.
- **Low 5:** the last `hasFuel` title now names the gas row and the gas-only hero.
- **Low 8:** cell 15 checks "Gas bridged" present and "Gas ready"/"Gas used" absent on the whole receipt, since labels live in the `dt`. "you got" stays asserted on the gas row only: the Review said row legitimately contains it.
- **Low 9:** the stamp requires a valid `Date`, so `completedAt: 1e20` shows no stamp instead of "NaN undefined NaN:NaN"; unit-tested. Midnight staleness left, as the reviewer advised.
- **Comments:** `token`'s fallback is the generic "TOKEN" at 18 decimals, not the deployment; `sender` is described as unverified (shape does not prove provenance); `reviewedDecimals` states that the review's units never come from persisted metadata; the `heroLabel` and `account` narration is gone; the converge comment states only that the digits never change; `formatDisplayAmount`'s doc is one contract sentence; the test file's "LIVE manifest" comment is replaced.

Left, with the reviewer's reason:
- **Low 1:** `formatDisplayAmount` repeats four arithmetic lines of `toDecimalString`; both are correct and consolidating adds little.
- **Low 4:** the wizard can pass an alias of `""`, which the receipt already treats as no alias; no visible defect.
- **Low 6:** an intermediate commit's typecheck failure does not reach the squash result.
- **Low 7:** "bridged" qualifies the gas-only hero and distinguishes the actual figure in its comparison; the repetition carries meaning.

Stuck exit (not acted on here): the reviewer's leading hypothesis, at moderate confidence, is a refusal before record creation (`useHubExit` returns `""` from a guard or preflight, so nothing is adopted and `submitting` clears), with the grant/readiness guards or the wallet's preflight as suspects; it found nothing in this layer's diff (the `sender` capture adds no await or wallet call) that plausibly causes it.

Security pass: no finding. `sender` is optional, type-checked on load and restore, excluded from ids, dedup, secrets and recovery keys, covered by the backup's existing authentication tag, and rendered only as an address of the sending chain's shape.

Gate:
- `bun run typecheck:all` exit 0. `bun run test:all` exit 0 (design 236, bridge-core 451 + 1 skipped, tools 1552 in 106 files). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- `bun run lint` exit 0 (the pre-existing warning and two infos; complexity-baseline OK). No `zz-*` spec was present when it ran.
- `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- Browser: `agent.sh specs/deposit-token-gas.spec.ts` in its own sandbox, exit 0, 7 passed (11.0m), none flaky, cell 15's new assertions included; the run stopped its own sandbox by pgid.

## A pre-existing exit bug found by the tour

This is the tour's stuck exit (attempt 2). It is not a regression of this arc.

**Symptom.** Paste the fee asset on Deposit, switch to Exit, pick USDC (already granted), and confirm. The first confirm is refused with "Your wallet is still setting up the app's contracts. Try again in a moment."; a second confirm reaches the stepper. `confirmReview` waited 120 s for a stepper or a stand-down, so the refusal looked like a hang. On a real wallet the switch also raises a permission prompt for a token that cannot be exited.

**Root cause** (lines):
- `SendWizard.vue` `onDirection` (639–646) re-resolves the picked token for the new direction, and `reselect` then calls `ensureExitGrant` (582–594). That function asked for a grant on any token that was not granted yet, including one the hub has not bound. `exitBlocked` (370–375) already refuses such a token, because its `state.kind` is not `"registered"`. It also read `selection.selected.value` after the await, not the token it was called for, so a pick overtaken by a later one could still ask again, for whatever was selected by then.
- The grant goes through `retryCapabilities` (`createAztecWalletSession.ts` 761–781), which sets `contractsReady = false` (778) for the whole re-registration, about 4–9 s.
- Meanwhile the user picks USDC. `onSelect` resets `grantState` to idle and USDC is already granted, so Confirm is enabled (`ReviewStep.vue` 86 disables only on busy, a pending grant, or a portal mismatch). The exit's guard (`useHubExit.ts` `exitGuardRefusal` 522–526, read in `performExit` at 533) then refuses on readiness. The send lane has the same window: `useTokenGrant.ts` returns `"granted"` at once for a granted token (51), and `useSend.ts` read readiness right after (597).

**Pre-existing since** the any-ERC-20 wizard (the selection-time exit grant and its re-resolve on a direction switch) and the readiness gate (and `retryCapabilities` dropping `contractsReady`). The refusal has existed since the readiness gate.

**Fix:**
- `reselect` captures the selection's epoch, which `select` claims before its first await. If a later pick or direction moved the epoch, the grant step is skipped. Otherwise it passes the resolved token and the direction to `ensureExitGrant`, which returns without asking unless the direction is Exit and `state.kind === "registered"`.
- `prompt-queue.ts` gains `promptsSettled()`, which resolves when every prompt queued so far has settled and never rejects. `performExit` awaits it before any guard, and `performSend` awaits it after the grant, before the readiness read. A confirm pressed during a re-grant now proceeds once the re-registration lands. A failed re-grant sets `status = "error"`, and the refusal is still the session's own error. The Confirm button's rule and all copy are unchanged.
- Harness: `confirmReview` stops when the review's error sits beside a live Confirm and fails with the error's text. An error left by an earlier attempt sits beside a held button, so it does not count as a refusal of the new press.

**Evidence.**
- Unit tests, each run before the fix and failing for the stated reason:
  - `SendWizard.test.ts`: switching to Exit with an unbound token calls `ensureGranted` 0 times (before the fix: 1). An exit pick overtaken while it is read asks nothing, and only the latest pick asks (before: 2 calls, the second for the now-selected token).
  - `useHubExit.test.ts`: a confirm during a queued re-grant waits and then exits (before: `""`, refused). A re-grant that fails while the confirm waits surfaces the session's error (before: the setup-pending copy).
  - `useSend.test.ts`: the same pair for a granted token's send (before: refused / the setup-pending copy).
- Browser, with a throwaway `zz-exitwin.spec.ts` (deleted, never committed): fund an actor with public L2 USDC and Fee Juice as in cell 27, paste the fee asset on Deposit, switch to Exit, pick USDC, public, review, confirm.
  - Before the fix (the harness change applied, the source not): the switch asked the wallet for a grant (`requestCapabilities` +1), and the first confirm failed at once with "the review refused the confirm: Your wallet is still setting up the app's contracts. Try again in a moment." Exit 1.
  - After the fix: no grant was asked on the switch, and the first confirm reached the stepper in 2.2 s. 1 passed, exit 0.

**Gate:**
- `bun run lint` exit 0 (the pre-existing warning and two infos; complexity-baseline OK). `bun run typecheck:all` exit 0. Both were re-run after the `zz` spec was deleted.
- `bun run test:all` exit 0 (design 236, bridge-core 451 + 1 skipped, tools 1558 in 106 files). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- Browser, each in its own sandbox, run concurrently, each stopping its sandbox by pgid:
  - `specs/exits.spec.ts`: exit 0, 7 passed (16.5m).
  - `specs/deposit-token-gas.spec.ts`: exit 0, 7 passed (10.6m).
  - Neither had a flaky test.

**Round 2.** Codex found two Medium issues, and both were accepted.
- **The send now rechecks its grant after the wait.** A send whose token was already granted got `"granted"` at once, then waited for another token's re-grant. That re-grant replaces `grantedContracts` wholesale and can leave this token out, yet the send went on to its irreversible Ethereum deposit on the earlier verdict. `useSend.ts` `settledRefusal` now runs after the wait, in order: the stall refusal, the readiness refusal, then, for a non-gas send, `isGranted(plan.token.l2Token)`, which falls back to the existing "didn't grant access to this token" copy. The exit already rechecked: its wait runs before `exitGuardRefusal`, which reads `isGranted`. New test: the queued re-grant lands without the send's token, and the send is refused with no Permit2 approval, no signature and no deposit. With the recheck removed, the same test sends (`0xtokenhash`).
- **The wait is bounded.** `promptsSettled(withinMs)` now resolves `false` after `withinMs`, and both lanes pass `PROMPT_WAIT_MS` (60 s) from `prompt-queue.ts`. On timeout the submit returns `""` with the new `PROMPTS_STALLED` copy. The queue is not reset, and a late settle resumes nothing, because the submit has already returned. The doc comment now says that awaited inside a queued prompt the function waits on itself until timeout, and that it is not a lock, so the post-wait checks stay. New fake-timer test on the exit lane: once the bound passes, the exit returns `""` with the stall copy, the operation hold is released, and a late settle authorises nothing.
- **Owner sign-off needed:** new user-visible copy on the review when the wait times out: "Your wallet hasn't finished an earlier request. Check your wallet and try again. Nothing was sent."
- Gate:
  - `bun run lint` exit 0 (the pre-existing warning and two infos; complexity-baseline OK). `bun run typecheck:all` exit 0.
  - `bun run test:all` exit 0 (design 236, bridge-core 451 + 1 skipped, tools 1560 in 106 files). `bun run --cwd apps/tools test:e2e` exit 0 (30).
  - The baseline diff exits 0.
  - Browser, run concurrently in their own sandboxes: `specs/exits.spec.ts` exit 0, 7 passed (16.4m); `specs/deposit-token-gas.spec.ts` exit 0, 7 passed (9.8m). Neither had a flaky test.

### Codex round 3 (the fix diff)

`material findings: 0`: both round-2 Mediums are closed. Its in-memory probes found no timer leak (early settle, timeout, late settle, rejection). Two small items were taken:
- The prompt-queue doc comment said "deadlocks". With the bound, a call awaited inside a queued prompt waits on itself until the timeout. The wording is corrected here and in the round-2 note above.
- Codex recommended, but did not require, a send-lane timeout test. It was added: a stalled queue, then the bound elapses. The send returns `""` with `PROMPTS_STALLED` and releases the operation hold. It makes no Permit2 approval, no signature and no send, even after the stalled request settles late. With the timeout branch removed from `useSend.ts`, the test fails: the send goes through.

The PR 4 loop converged in three rounds.
