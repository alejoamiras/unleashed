# Phase 14 — Record the sender; restructure the snapshot

## What was done

- **The stored field (Q4 B, D5).** `DepositJournalRecord` and `WithdrawJournalRecord` gain an optional `sender?: string`. Its TSDoc says it is display-only and never read by a claim, exit or recovery path. There is no schema bump. `assertDepositFacts` and `assertWithdrawFacts` add `!isOptionalString(sender)`. Schema-3 records reach both through `validateSendSharedFacts`, so a non-string sender quarantines its record.
- **Writers.** `useSend.ts` gives `RecordInputs` a required `sender`. Both `buildSendRecord` sites pass `actors.from`: the row opened before the Permit2 approval, and the rebuild when a public send is re-keyed onto its claim hash. Making the field required means neither site can drop it. `useHubExit.ts` has `exitRecord(id, plan, sender)`, with `from` taken from `performExit`. The attach handoff spreads `base`, so the sender survives the rename onto the exit hash. Nothing reads `sealerL1` or the current connection.
- **Snapshot (G40/G41/G43 data, R5-1).** `SendWizard.vue` captures a `receiptReview` at `onConfirm` from the frozen review. It holds the token the review said would arrive (`tokenRemainder` for a deposit, the amount for an exit, absent for gas-only), the gas `quote` and `estimate.txCovered`. `snapshotOf` now has three parts: shared fields, then `exitSnapshotOf` and `depositSnapshotOf`. `ReceiptSnapshot` gains:
  - `sender?`, the stored value.
  - `recipient`: a deposit's Aztec account or an exit's `recipientL1`.
  - `recipientAlias?`: taken from `accountOf` at snapshot time and passed through `safeDisplay`.
  - `reviewedAmount?`, `gasQuote?`, `txCovered?`, and `atLeast?`.

  It loses `fuelUsed`, `fuelReceived` and the prose `reviewSaid`.
- **R5-1 on the receipt.** The hero is `displayAmountOf(rec)`: a gas-only send's gross `fuel.received`, or its floor shown with "≥". Below the hero sits the caption "bridged · before claim fees". Its review line reads "Review said ≈ {quote} · bridged {figure}" and never says "you got". A token + gas receipt has one row, "Gas bridged", reading "≈ {quote} {FJ|Private FJ} · N transactions · before claim fees". The dead "Gas used" row is deleted. A token receipt's review line is bare figures: "Review said 250.00 · you got 250.00".

## Tests

- bridge-core:
  - `backup.pins.test.ts`: a `sender` on both full shapes, which still validate unchanged, plus two rejection rows (`sender: 1` on a deposit and on a withdraw).
  - `backup.test.ts`: a sealed round trip keeps `sender` on a deposit and on an exit. A pre-field backup opens and validates. A record with an unlisted `futureField` still validates, which is the property that lets a bundle from the plan base load a record carrying `sender`.
  - `journal.test.ts`: a stored schema-3 record with `sender: 7` goes to quarantine, and the pre-field record beside it loads.
  - Run against the pre-fix `backup.ts`, the two rejection rows and the quarantine case failed (3 of 120). All passed after the fix.
- tools:
  - `useSend.test.ts`: the opened row (read from inside the approval mock) and the re-keyed record both carry `L1_ACCOUNT`.
  - `useHubExit.test.ts`: the exit record carries the Aztec `FROM`.
  - `SendWizard.test.ts`: a new gas-only case. The snapshot hero equals `fuel.received`, the asset is `fee-juice`, there is no `atLeast`, `gasQuote` is the review's quote and there is no `reviewedAmount`. **Written first, it failed on the unfixed wizard** with `expected '100000000' to be '987000000000000000'`, the paid token amount standing in for Fee Juice. The existing receipt case now reads `reviewedAmount`, `sender`, `recipient` and the alias. The `useBridgeWallet` mock gains `accounts`.
  - `BridgeReceipt.test.ts`: the Gas ready and Gas used cases become Gas bridged cases (private with transactions, public without a count). The gas-only case asserts the caption, the "≈ quote · bridged figure" line, and that neither "Gas ready" nor "you got" appears. There is a "≥" floor case. The review-said pins become bare figures. The dash case covers `reviewedAmount` and `gasQuote`. Every snapshot names its recipient.
- Browser:
  - `pages/send.ts` `waitForReceipt` also returns the receipt's `text`.
  - `deposit-gas-only.spec.ts`: the shared `bridgeGas` helper asserts "before claim fees" and neither "Gas ready" nor "you got". This covers the public (cell 18) and private (cell 20p) cases the plan names, and every other gas-only cell.
  - `deposit-token-gas.spec.ts` (the private-credit cell at `:146`): the gas row says "before claim fees" and neither forbidden word. Each keeps its received − fee and received − kept postconditions.

## Attempts and notes

1. The first writer commit made `RecordInputs.sender` required. It did not also omit `sender` from `Prepared.inputs`, the pre-derived part of the inputs, so `typecheck:all` failed. I ran only the unit tests and lint before that commit, and vitest does not typecheck. It was fixed as its own commit rather than by rewriting history. Typecheck now runs before every commit in this phase.
2. Biome reformatted two long object literals in the rewritten tests (`biome format --write`).

## Deviations from the plan

- **The snapshot also drops `reviewSaid` and `fuelReceived`.** The plan names only `fuelUsed`. The structured `reviewedAmount`/`gasQuote`/`txCovered` replace the prose line. With the gas row reading the quote, nothing reads `fuelReceived` any more. Keeping either field would leave dead data beside its replacement. `promisedLine` and the wizard's `reviewSaid` ref remain for the background strip, as the plan says.
- **The review line changes shape in this phase, not phase 15.** Without the prose `reviewSaid`, the receipt renders the line from the new figures, so it already reads as the board's bare figures. Phase 15 only moves it into the `dl` row. For gas-only it says "bridged", not "you got" (R5-1).
- **`receiptReview` carries no `decimals`.** The receipt formats the reviewed amount and the arrived amount at the record's own token decimals, so both halves are written the same way. The record's frozen block holds the same decimals the review priced.
- **The "bridged · before claim fees" caption** is a plain paragraph under the hero, styled like the eyebrow (13px, ink-2). Phase 15 places it in the board layout.
- **The phase-13 grep already prints only `AmountStep.vue`'s `onUseAll`**, the state phase 15's gate expects. The receipt's two `toDecimalString` gas figures went with the rows they drew.

## Validation gate

Run (every code commit of the phase):
- `bun run lint`: exit 0 (Biome: 2 infos, none in files this phase touched; complexity-baseline check OK).
- `bun run typecheck:all`: exit 0 (design, bridge-core and tools).
- `bun run test:all`: exit 0.
  - design: 236 tests in 21 files.
  - bridge-core: 451 passed and 1 skipped, in 50 files.
  - tools: 1545 tests in 106 files.
- `bun run --cwd apps/tools test:e2e`: exit 0 (30 tests in 3 files).
- `bash apps/tools/scripts/e2e/agent.sh specs/deposit-token-gas.spec.ts specs/exits.spec.ts specs/deposit-gas-only.spec.ts`: exit 0, 22 passed (30.5m).
  - `deposit-gas-only` is included because the plan adds it to this run when absent.
  - Real deposits (token + gas, gas-only) and real exits wrote records carrying `sender`, then claimed and finished.
  - The page's "No artifact registered … private FJ balance read failed (fail-closed → null)" console lines are the balance probe's expected fail-closed path, not failures.
- R5-1 failed before its fix: the new `SendWizard.test.ts` gas-only case failed on the unfixed wizard (`expected '100000000' to be '987000000000000000'`).
- The stored-data cases are green (Outcome criterion 3). They failed on the pre-fix validator where a failure applies (3 of 120).
  - The pre-field backup opens and validates.
  - A record with an unlisted key validates.
  - `sender: 7` is quarantined.
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- `git grep -n 'toDecimalString(' -- 'apps/tools/src/**/*.vue'` prints one line, `AmountStep.vue:147` (`onUseAll`).

## Flags for owner sign-off

- **The gas row uses the review's quote, as the plan says, not the Fee Juice the deposit reported.** A completed token + gas record also knows the exact gross `fuel.received`. Showing that (still "≈", compact, "before claim fees") would state what was bridged rather than what was quoted. It is a one-line change in `depositSnapshotOf`/`BridgeReceipt` if preferred.
- **"Gas bridged" instead of the board's "Gas ready"**, with "before claim fees" in the value. This is a planned, honesty-motivated deviation (final Codex pass).
- **The gas-only hero now shows the Fee Juice bridged** (the gross `fuel.received`), captioned "bridged · before claim fees". It is no longer the paid token amount at 18 decimals. Review line: "Review said ≈ {quote} · bridged {figure}".
- **The review line is bare figures on every receipt** ("Review said 1.50 · you got 1.50"). The token + gas receipt no longer appends the gas to "you got". The gas has its own row.
- No capture in this phase (no T in its gate). Arc 5's tour runs at phase 15.
