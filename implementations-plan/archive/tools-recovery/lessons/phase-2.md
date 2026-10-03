# Phase 2 — card copy + cell 24b flipped

Arc 1 (the task branch). Gate: the Phase 1 commands green again
(engine 125, lib 424, card 58 incl. 3 new cases, bridge-core journal 28; typecheck; lint) and
`bun run e2e:tools -- specs/recovery.spec.ts` on its own sandbox at retry 0: 4/4 passed (24a, 24c,
**24b — 1.1 min**, 25).

## What landed

- `BridgeJournalCard.vue`: `claimedByOtherLine` (three lines: tokens arrived / press CLAIM YOUR GAS /
  private gas kept), `data-testid="tl-journal-claimed-by-other"`; the idle stage guidance is silent
  for a claimed-by-another record (its button is gone). Three card cases.
- `recovery.spec.ts` 24b: title and assertions flipped — after the relayer's claim the reloaded
  record's CLAIM click ends `data-stage="done"`, `claimedByOther: true` + `completedAt` in storage,
  no `claimTxHash`, `sendTx` count 0, credited exactly once, the done-by-another line shown.
  `pages/journal.ts` reads the two new fields.

## Lessons

- **Detached launches need an executable script.** Run `chmod +x` first, then
  `nohup setsid <abs path> > log 2>&1 < /dev/null &`. A non-executable script
  fails silently (the log holds one `Permission denied` line).
- The "No artifact registered … private FJ balance read failed (fail-closed → null)" console lines
  the run prints are the existing fail-closed balance probe, not a regression.

## Arc-1 codex loop (post-implementation, `/codex high`, read-only)

**Round 1** — session `01a09092-2eb1-7b00-8177-b528a464c2bb`, verdict `request-changes` (3 high, 1 medium).
Verified against the code:
- H1 *`standaloneClaimed` latched from a consumed-shaped send error is not checkpointed evidence* —
  **pre-existing latch semantics** (`deposit-flow.ts:193-199`, with its own rationale) that the plan
  lists as "settled fuel"; the exposure (a proposed-only consumption that later drops ⇒ a completed
  record's fuel affordance hidden ⇒ 7-day prune) is the same for every completed public token+gas
  record today. Not changed in this arc; recorded as a residual for the owner (`standalone-latch-checkpointed`).
- H2 *settlement decided on the captured record while the guard ignored the fuel block* — **accepted,
  fixed**: `sameFuelState` (sealed copy, register hash, fuel secret hash / claim hash / consumed /
  standaloneClaimed) joins the guard; settlement is decided on the re-read record.
- H3 *a persisted `claimedByOther` bypasses the probe* — **accepted, fixed**: `revalidateClaimedByOther`
  re-reads the nullifier with the material at hand (no prompt): nullified ⇒ completion, live ⇒ the
  marker is dropped, no material ⇒ the record waits. Test (k) re-pinned (one probe on resume).
- M4 *the early completion skips the fuel receipt reconciliation the claim build performs* —
  **accepted, fixed**: `reconcileFuel` dep (wired to `reconcileFuelConsumed`), run before settlement
  when the fuel has its own `claimTxHash`.
- Comments: three cuts/rewrites applied (`parity` line, the completion doc, the card's line doc);
  `journal-locks.ts` null-callback comment kept.
- Tests added: forged marker (public live / public nullified / private without material), fuel swap
  while the read awaits, fuel reconciliation before settlement, a throwing record body releases the
  lock, `hubMessageState` reads the envelope's facts, the standalone gas claim's hand-back.
  Skipped: "generation change during the lookup" (a generation only moves through a new runner,
  which the record lock excludes, or a discard — already pinned); "proposed-only fuel consumption"
  (H1, residual).

**Round 2** — resumed, verdict `request-changes` (1 high, 2 medium); H1 accepted as the existing residual.
- R2-1 *F1→F2 fuel swap across the reconciliation await inherits F1's receipt* — **accepted, fixed**:
  `sameFuelIdentity` must hold between the captured and the re-read record; only the settlement flags
  may move. (The mislatched `consumed` on the swapped block is `patchFuel`'s pre-existing merge
  semantics; the completion refuses it.)
- R2-2 *a private marker without cached material is a dead end* — **accepted (narrowed)**: a marked,
  unfinished record whose fuel is settled shows CLAIM as the verification; the interactive click
  unseals through the existing path; automatic resumes stay prompt-free. Unsettled private fuel keeps
  no CLAIM (nothing a click could finish; the record stays open with its sealed copy).
- R2-3 *a fuel receipt pending at first and checkpointed later never reconciles* — **accepted, fixed**:
  a marked record with an unsettled fuel transaction resumes; the resume reconciles first.
- Both rounds: codex could not run vitest in its sandbox (workers timed out); the unit suites were
  run here after each fix (engine 131, policy, card, lib, fuel-recovery all green).

**Round 3** — resumed, verdict `request-changes` (1 high, 1 medium) — the plan's three-round stop.
Both findings verified and fixed in the same commit; per plan § Post-implementation the loop stops
here and the residue is **surfaced to the owner** (the cross-arc fresh pass re-reviews arc 1 in full):
- R3-1 *the reconciliation still writes F1's receipt onto a swapped-in F2 (`patchFuel` merges into
  the live block); the next CLAIM then sees a "settled" F2* — **accepted, fixed** in
  `reconcileFuelConsumed`: the write requires the live block to be the probed one (claim hash and
  secret hash). Pinned in `fuel-recovery.test.ts`.
- R3-2 *a false marker on a private record with unsettled fuel hides the ordinary claim* — **accepted,
  fixed**: `unsealForVerification` no longer requires settled fuel, `record-policy` shows CLAIM for any
  marked, unfinished private record (a public one with open fuel keeps CLAIM YOUR GAS and verifies
  itself on resume). A live message drops the marker and the next click is the ordinary claim.
  Two Phase-2 pins re-pinned (card + engine (k′)): the private kept-gas line and CLAIM-as-verify coexist.
- Not re-submitted to codex (round cap). Residuals for the owner: H1 (`standaloneClaimed` latched
  from a consumed-shaped send error is pre-existing, not checkpointed evidence) and the `patchFuel`
  live-merge semantics outside the completion path.

## Arc-1 boundary

- Full tools suite in two shards on their own sandboxes, retry 0: shard 1/2 **34 passed**
  (29.9 min), shard 2/2 **31 passed** (25.4 min). The three codex-loop fix commits landed after that
  build; `recovery.spec.ts` was re-run on the final arc-1 SHA (see below) — the fixes are confined to
  the marker/reconciliation paths the unit suites pin.
- **Lesson — `git add <dir>` sweeps drafts.** The arc-2/3 finder drafts (untracked, written early while
  the shards ran) were swept into the round-1 fix commit by `git add apps/tools/src`; the unpushed
  branch was rewritten (reset + cherry-pick, identical content minus the four files) before any push.
  Stage by explicit path on a branch that carries drafts for a later arc.
- `recovery.spec.ts` re-run on the final arc-1 SHA at retry 0: **4 passed** (3.5 min).
- Stack: `gh stack init` on the task branch over the base branch, then `gh stack add` for arc 2.
