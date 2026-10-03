# Phase 3 — Journal / stepper / receipt seam

**Status:** ✓ green. Gate: typecheck 0 · test 403/403 · build ✓ · test:e2e 14/14 · lint 0 · no dts churn.

## What shipped (4 Flex swaps)
- **`BridgeJournal.vue` — 3 swaps:** `.journal` (`<section>` → `<Flex tag="section" direction="column" gap="14" class="journal">`, class-preserving for the `.journal h3` descendant), `.cards` (`<div>` → `<Flex direction="column" gap="10">`, pure-layout full swap, rule deleted), `.head-row` (`<header>` → `<Flex tag="header" align="center" justify="between" gap="12">`, full swap, `tag="header"` preserves the landmark). All testids preserved (journal on the section Flex).
- **`BridgeReceipt.vue` — 1 swap:** `.links` (`<div>` → `<Flex gap="12" class="links">`, class-preserving — kept `.links` on the same node so the `.links a` / `.links a:hover` descendant rules still match; deleted only `display:flex; gap`). This is the fable-H1 orphan case done CORRECTLY (keep the class, don't delete a descendant-needed rule). The `<a>` children keep `rel="noopener noreferrer"` + `receiptLink` testid.

## The pill inventory — tested, both NON-FITS (the audits' key open question, answered)
The final codex pass said to evaluate `Tag` (closer than `Badge`) for the status pills. Did it:
- **`Tag` vs `BridgeJournalCard` `.tag` (PRIVATE/PUBLIC): NON-FIT.** Faucet `.tag` = `font:600 10px/1 mono; padding:3px 6px`, a `1px solid` border in the earlier `outline` token, NO background; package `Tag` = `font 400 11px; padding:4px 8px`, a background in the earlier `surface-low` token, tones neutral/test/warn. Multiple visible drifts (size 10→11, weight 600→400, padding, a new bg) AND the bespoke `.tag.private` accent variant maps to no package tone. Keep local.
- **`Badge` vs `BridgePhaseRail` `.badge` (SKIPPED): NON-FIT.** Faucet `.badge` = bordered `10px/600` transparent `2px 5px` grid-item (`justify-self:start`); package `Badge` = FILLED (variant bg), no border, `2px 6px`. Bordered-vs-filled is a fundamental mismatch. Keep local.
- **Finding:** the faucet has a *consistent bespoke mini-pill style* (`10px/600` mono, bordered, transparent) that is denser than BOTH package primitives. Neither fits without visible drift. No pill reuse — documented, not asserted.

## Kept local (documented)
- `.empty-state` (dashed box — `LoadingState` non-fit: forces a spinner, hardcoded testid, no link-button slot; identity is the border/padding, flex is incidental).
- `.rhead` — `align-items: baseline` (Flex can't express).
- `.ledger`/`.ledger .row` — border-bottom + nested `.ledger .row .k`/`.v` selectors; fiddly + risky for modest gain.
- `BridgePhaseRail` + `BridgeStepper` — bespoke progress visualizations (grid rail + connector/glyph flex layouts); swapping risks the positioning for ~0 reuse gain.

## Takeaway
Phase 3's honest yield: 4 Flex swaps. The most-hyped candidate (pills → Tag/Badge) is a documented non-fit — the deep-flow's "evaluate per case" instruction earned its keep by catching that the asserted reuse wasn't real. This IS the "some things aren't re-usable and that's fine" outcome.

LESSONS_FILE=implementations-plan/archive/design-system-faucet-adoption/lessons/phase-3.md
