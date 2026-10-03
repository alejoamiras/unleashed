# Phase 20 — Review step

## What was done

- **The fee is a figure over a note (G48, the copy table).** `ReviewEstimate.networkFee` is the figure alone (`string | null`) and `networkFeeNote` is the prose (`string`); the doc says so. The wizard builds the pair per case with small helpers:
  - `networkFeeOf` handles the gas leg. Public is "≈ X FJ" with the note "taken from the gas that arrives". Private is the ceilings figure, or null while unpriced, when the note gains the prefix "priced from network fees at claim time, ".
  - `exitFeeOf`: a public exit has no figure and reads "your Aztec wallet's own fee, then Ethereum gas to finish". A private exit has the figure or null, and the note "from the private gas you already hold, then Ethereum gas to finish — set aside in full … the withdrawal's fee ceiling, not its exact cost".
  - `heldGasFeeOf` covers a token-only send. With public Fee Juice held it shows "up to ≈ X FJ" and the "from the Fee Juice you already hold — paid by your account as its own fee: …" note. Otherwise the private case: the figure or null, with "from" becoming "paid from" when there is no figure.
  - `feeContractFee` is the shared figure-plus-note builder for held private gas.
  - `fjFigure` formats a figure or passes null through.
  - The bigint arithmetic and every `formatCompact` call are unchanged. Each helper is well under complexity 15.
- **G94, " - " → " — ".** It covers:
  - the fee notes;
  - the stale banner reasons (`CEILING_NOW_PRICED_TOKEN_ONLY` and `_EXIT`);
  - both gas errors (`quoteShortfall`, `privateSliceShortfall`);
  - the private exit refusals in `useHubExit.ts`.
  The in-flight strings in `deposit-flow.ts` are left for a later phase.
- **`ReviewStep.vue`:**
  - G91: the rows are a 104px + 1fr grid with gap 16, and the Send row aligns on the baseline (its `dd` is flex, gap 12). The symbol is ink, legs gap 6, soft-inline 15 ink-2, step gap 16. The status line is 14 ink with gap 12, and its dots gap 3.
  - G49: the Visibility `dd` is a flex row with gap 8. The eye (`eye-off` 12 in `--ul-accent-text` for private, `eye` 12 in ink for public) sits in a coloured wrapper, followed by the `<strong>` word and "— note". The literal space is kept.
  - G48: the Fee `dd` is a column. The Mono figure renders only when there is one, then a 13/1.4 ink-3 note, with the literal space between them kept.
  - G46: a leading `key` 24 on "Sign and send", hidden while busy.
  - G92: `.soft` loses its `::before` edge and takes padding 12 14. The info and warn icons were already 24.
- **`ReviewDetails.vue`:**
  - G50: the leading `chevron` 12 is secondary, at −90 closed and 0 open, with gap 10. After "Details" comes a right-hand hint (13/400 ink-3, hidden at ≤760) built from the rows present: "Token, route, slippage, account, signature", without route and slippage on a token-only send and without slippage on an exit. It never names the portal.
  - G93: the panel `dl` rows are a 104px + 1fr grid with column-gap 16 and row gap 8, padding 4 14 14. `dt` is ink-3 and `dd` ink. `.full` keeps only its wrapping.
- **`ConnectionErrorStrip.vue` (G92):** notch-2. The close icon was already 12 in a 28×28 box.

## Tests

- `ReviewStep.test.ts`:
  - The estimate fixtures use the new shape. `:102` keeps "Fee≈ 0.1 FJ taken from…" through the literal space.
  - A figure-less row renders the note alone.
  - The Visibility row has its svg, and "Public — visible on Aztec" holds.
  - An exit estimate is note-only.
  - The key icon shows, and is gone while busy.
  - The hint reads `Details${hint}` in the three cases and never matches `/portal/`.
- `SendWizard.test.ts`: the plan's phrases moved to `networkFeeNote`. Figure cases assert "up to ≈ 0.01 FJ", "≈ 0.01 FJ", `/^≈ [\d.]+ FJ$/` or null, with the note checked exactly or by its leading clause.
- `testid-coverage.test.ts`: the two estimate fixtures take the new shape.

## Attempts and notes

1. Five files failed Biome's formatter after the first edits. `bunx biome format --write` on those files fixed it.
2. An exit with no figure first said "paid from" in its note, reusing the token-only rule. The table gives the exit only "from…", so the exit's note always starts "from". Only the token-only note switches to "paid from" when it has no figure.
3. The phase's browser build ran with the next phase's files copied aside and restored from HEAD, so it tested phase 20 alone. Those files were put back once Playwright had started. PG ran the same way.

## Deviations from the plan

- **All three private exit refusals were swept.** G94 names only `useHubExit.ts:121`, the "none" line, but "short" and "unverifiable" had the same " - ". `exits.spec.ts:277` reads "holds none at the fee contract", which still matches.
- **The fee helpers are split per direction and per payer** (`exitFeeOf`, `heldGasFeeOf`, `feeContractFee`), which the plan allows ("split per direction if needed").

## Validation gate

Every command ran on the last code commit of the phase, with the next phase's files set aside (see note 3).

- **PG:**
  - `bun run lint`: exit 0 (the same 1 warning and 2 infos, from before this plan). The complexity baseline was OK.
  - `bun run typecheck:all`: exit 0.
  - `bun run test:all`: exit 0.
    - design: 236 tests.
    - bridge-core: 451 passed, 1 skipped.
    - tools: 1564 tests.
  - `bun run --cwd apps/tools test:e2e`: exit 0 (30 tests).
- **Baselines:** `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- **Browser:** `bash apps/tools/scripts/e2e/agent.sh specs/deposit-token.spec.ts specs/deposit-gas-only.spec.ts specs/exits.spec.ts specs/registration-retry.spec.ts specs/tokens.spec.ts`: exit 0, `27 passed (44.1m)`, none flaky.
  - By spec: deposit-token 6, deposit-gas-only 8, exits 7, registration-retry 2, tokens 4.
  - `tokens.spec.ts` was added to re-run phase 19's review fix, which moved the route line into a mounted live region that `tokens.spec.ts:98` reads.
  - The run shared the machine with the arc 7 tour, which explains its length.
- The review fix changes only a test and two comments. Its unit files ran green (90 tests), and it needed no browser re-run.

## Verifier review

An independent reviewer read the phase's diff. It found no High and no Medium.

It checked:
- all six table rows, character by character;
- the G94 lines;
- every G row;
- the browser phrases: `deposit-token.spec.ts:210,241`, `exits.spec.ts:277`, `deposit-token-gas.spec.ts:230`, and `pages/send.ts:69`, which reads `data-visibility`.

It re-ran:
- the review, details, wizard, testid-coverage and exit unit tests (140);
- the e2e unit config (30);
- `vue-tsc`;
- Biome.

Fixed (test and comments only, so no browser re-run):
- **Fee test gap (Low, pre-existing).** Only five of the nine fee variants were pinned. A new wizard test pins the public gas leg ("taken from the gas that arrives") and the public exit (no figure; "your Aztec wallet's own fee, then Ethereum gas to finish").
  - The unpriced private gas leg is left untested: the `ceilingsFor` mock is typed `bigint` and cannot return null without a cast.
  - The unpriced private exit is covered by the next point.
- **Comments (Nit).** The Details hint is the summary's, open or closed. `ReviewEstimate.networkFee`'s example also names "up to ≈ X FJ".

Left:
- **An unpriced private exit's note starts "from…" with no figure above it (Low).** The table's exit row has no unpriced variant, so the code follows it literally. Before this phase the line read "paid from the private gas you already hold on Aztec, …". Applying the claim's "paid from" rule to the exit is a one-line change inside `feeContractFee`. It is flagged for the owner's copy decision, not made.
- **The G94 sweep is partial on the same surface (Low, pre-existing, outside scope).** " - " remains in other refusals that render in the review's error line: `useHubExit.ts` (the authwit, registration and send-lane messages) and `useSend.ts`. The in-flight list for `deposit-flow.ts` also covers only two of its lines. Recorded here for the plan's close-out (`follow-ups.md` is shared with the parallel tracks, so it is left alone).
- **The Details toggle's accessible name includes the hint on desktop (Nit).** The visible label is inside the name, so this is acceptable.
- **The fixture note "… on Aztec" in `ReviewStep.test.ts` is not one the wizard produces (Nit).** It is harmless: that test is about the row, not the copy.
- **The gas leg's inner gap (Nit).** The design notes ask for 8px; the plan row does not, and a literal space remains. This only affects the screenshot comparison.
- **At 390px (Nit).** The Visibility note wraps under the word, and the Send symbol stays beside a wrapping amount. See the arc 7 tour.

## Flags for owner sign-off

- The fee-note copy (all six cases in the plan's table), which is new copy. Screens are in the arc 7 tour.
- An unpriced private exit: no figure, and the note starts "from the private gas you already hold, then Ethereum gas to finish — …". The table gives the exit no "paid from" variant; the token-only row has one.
- The Details hint is new copy: "Token, route, slippage, account, signature", reduced per send.
