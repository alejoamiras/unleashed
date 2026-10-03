# Phase 4 — Form / card seam + leaves

**Status:** ✓ green. Gate: typecheck 0 · test 403/403 · build ✓ · test:e2e 14/14 · lint 0 · no dts churn.

## What shipped (7 Flex swaps)
- **TokenCard:** `.head` (`<header>` → `<Flex tag="header" direction="column" gap="4">`, full) + `.actions` (`<div>` → `<Flex gap="12" wrap="wrap">`, full). `.foot` **kept** (single-child `justify-content:flex-start` = no-op flex → churn, per rubric criterion 5 / fable M3).
- **BridgeForm:** `.amount-row` (→ `<Flex align="center" gap="8">`) + `.opt-row` (→ `<Flex v-if="fuelAvailable" align="center" gap="10">`). Both pure-layout full swaps; `data-testid`s on children (inputs/toggle) untouched.
- **FuelForm:** `.amount-row` (→ `<Flex align="center" gap="8">`).
- **FaucetView:** `.faucet-view` (→ `<Flex direction="column" gap="32">`, full) + `.hero` (→ `<Flex tag="header" direction="column" gap="16" class="hero">`, class-preserving — kept `.hero` for `margin-bottom` + `.hero h1`/`.hero .sub` descendants).

## Kept local (documented)
- **The brutalist controls** (the whole point of "consume-only"): BridgeForm `.modes`/`.mode` cards, the fuel `.toggle`+`.knob`, the boxed `.amount` number inputs, `.fuel-slice-row` — bespoke, no primitive fits without package edits or drift.
- `.foot` (no-op flex), footers (`Footer`/`BridgeFooter` `.footer` — typography/spacing-dominant: they set inherited mono/color/border for all children; flex-column is incidental), `.contracts` (`align-items:baseline` — Flex can't express), `.cards` grid (FaucetView), `.wallets` (two-axis `gap:12px 16px`).
- **(Corrected during the loop pass)** all 3 views migrated: `FaucetView` `.faucet-view`/`.hero`, plus `BridgeView` `.bridge-view`/`.hero` + `FuelView` `.fuel-view`/`.hero` (`<div>`→`<Flex direction="column" gap="28">` full; `.hero` class-preserving for `margin-bottom` + `.hero h1`/`.sub`). Initial "thin wrapper, not migrated" call was wrong — they have the same clean pattern as FaucetView. Their `.wallets` (two-axis `gap:12px 16px`) stays local.
- `App.vue` `.page` (`<main>`) kept local — a centering container (`max-width:760px; margin:0 auto; padding`) where flex-column is secondary; `.tabs` bar bespoke per D2.

## Learnings
- Indentation varies per file/region: `BridgeForm` form rows at 2 tabs; `FuelForm` `.amount-row` at 3 tabs (nested deeper); `FaucetView` `.faucet-view` at 1 tab. Always confirm the exact tab depth from a fresh read before anchoring an edit — a wrong tab count silently fails the match.
- In-phase validation (typecheck + test after the first 4 swaps, before adding opt-row/FaucetView) caught nothing but kept the blast radius small per step.
- `Flex wrap="wrap"` → `flex-wrap:wrap`; `justify="end"`/`"between"` → `flex-end`/`space-between`; `align="center"`/`"start"` → `center`/`flex-start`; `tag="header"`/`"section"` preserves landmarks. All confirmed against the rendered gate (component tests assert through them).

## Phase 4 tally
11 Flex swaps (7 form/card + 4 view roots across all 3 views). Combined with P1–P3: ~19 primitive adoptions across the app, plus the resolver infra. Zero pill reuse (documented non-fits). The forms' bespoke controls + the App-shell centering container stay bespoke — the honest, correct "consume-only" outcome.

LESSONS_FILE=implementations-plan/archive/design-system-faucet-adoption/lessons/phase-4.md
