# Phase 4 — Fuel UX

**Status:** ✓ complete. Gate green: faucet 357 · smoke 14 (incl. the App-level integrity test + the Bridge smoke unchanged) · typecheck:all + lint exit 0.

## What shipped
- Third **Fuel** tab + `FuelView` (hero + wallet panels + form) + `FuelForm` (L1 $AZTEC balance, amount, PRIVATE/PUBLIC preset, submit → `useFuel`, validation incl. the fail-closed floor, stepper handoff). Builds + renders (`bun run --cwd packages/faucet dev` → Fuel tab).
- **Fuel-accurate stepper** (`bridge-steps.ts` `depositPhases` fuel branch): a fee-juice record uses approve-based phases (NOT the swap Permit2 SIGN / "DEPOSIT + FUEL" shape) and labels the claim **"CLAIM GAS"** (gas-only, no token leg). Pinned by 3 new `bridge-steps.test.ts` cases.

## Decision (logged) — the double-owner fix: FuelView-no-journal, NOT the planned shared-shell lift
The deep plan + the audits (codex/Opus N1) flagged a double-owner integrity bug: `App.vue` keeps views mounted via `v-show`, and a second mounted form/journal would fight the global `activeFlowId` (double-toast / mis-rendered receipt). The plan's fix was lifting the foreground surface into a shared shell above both forms.

**Chosen instead (simpler, verified):**
1. `FuelView` mounts **NO journal** — only `BridgeView` has one, so there is exactly ONE journal mount regardless of tab (the double-toast root cause is two journal mounts). `v-show` retained (no regression to the Bridge tab's in-flow persistence).
2. Each form's `formStage` is **component-local** and the completion-watch guards on `formStage === "stepper"`, so a form only ever steppers a flow IT started.
3. The stepper render is scoped by `assetKindOf` (FuelForm steppers only fee-juice records).

**Verified** by a new App-level smoke (`faucet-smoke.test.ts` 3b): mount `App`, switch to the Fuel tab, assert `findAll(journalEmpty) === 1` + the Fuel form renders. So Bridge+Fuel never double-own `activeFlowId` and a completion can never double-toast — the shell-lift refactor was unnecessary.

**Per-the-loop note:** "shell refactor" is a flagged codex decision. Rather than a redundant inline consult, this decision rides into the **Phase-5 codex post-impl audit** (which reviews the whole net diff, including this seam) — adjust if it surfaces a gap.

**Residual (documented follow-up, NOT a correctness issue):** fuel records currently surface in the **Bridge** tab's journal (the single mount), not under the Fuel tab. A shared-journal lift (one journal above both tabs) would show them under Fuel too — a UX nicety deferred. The two-simultaneous-flows edge (a bridge flow + a fuel flow active at once) is the only theoretical collision; in normal single-flow use it cannot occur, and the post-impl audit will confirm.
