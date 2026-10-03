# P3 — wallet chips + rename + gates (lessons)

## P3 COMPLETE
- Both wallet panels restyled to one-row chips (`[ETHEREUM · addr ✕]` / `[AZTEC · addr ✕]`) — ALL logic untouched (connect, wrong-chain switch inside the L1 chip, the Aztec verification modal + intermediate states as wider status chips); ✕ carries the existing disconnect testids + aria-label. `BridgeView .wallets` → wrapping flex row.
- "IN-FLIGHT BRIDGES" → "PENDING BRIDGES" + honest sub-copy + "Nothing pending." empty state.
- Gates: `bun run audit:faucet` exit=0 · `bun run audit:vue` exit=0 (both in the transcript). Suites: faucet 228 ✓ · smoke 9 ✓ · build ✓.

LESSONS_FILE=implementations-plan/archive/bridge-form-stepper/lessons/phase-3.md

## post-impl
/code-review max --fix: sealed-envelope patch verification (separate commit). Codex post-impl: reject (rekey foreground orphan) → fixed (form reads engine activeFlowId; CAS-only releases; rekey pin) → flip: **approve** (file:line-verified). Suites 229 ✓ smoke 9 ✓.

LESSONS_FILE=implementations-plan/archive/bridge-form-stepper/lessons/phase-3.md

## manual-test feedback round
- **Claim stuck at "Confirming" forever (user report, both surfaces): ROOT CAUSE = Aztec 4.2.0 `TxStatus` has NO `success` value.** The enum is block-finalization state: `dropped | pending | proposed | checkpointed | proven | finalized`. A confirmed claim reads `checkpointed` then `proven` for epochs before `finalized`; our matcher accepted only `success|finalized`, so confirmed claims polled as "pending" until the 10-round cap. Fix: inclusion = `checkpointed|proven|finalized` (plus legacy `success|mined`), with the separate `TxReceipt.executionResult` carrying the revert signal. Added per-check `receipt check {id, checkNo, status}` logging + the lookup-failure message so the next anomaly diagnoses from the console.
- Wallet chips: 999px pills violated the brutalist system (the wallet is `border-radius: 0` everywhere) - chips now sharp; the privacy toggle's round knob is functional and untouched.
- Em-dashes dropped from all faucet copy (mechanical sweep, 45 files, tests included).

## confirmation-policy round (user report: "couldn't be verified" dead-ends)
- Two compounding causes: (1) the checkpointed fix made receipts flip "success" at the EARLIEST inclusion state, while the message probe verifies through the wallet's lagging PXE - simulate still saw the message ⇒ false/null ⇒ scary note; (2) the "press CLAIM" escape hatch was a TRAP for already-claimed records: a consumed message throws the SAME "no message found" wording as a not-yet-synced one, so the gate looped forever.
- Owner policy (user decision): **a checkpointed receipt IS confirmation.** Local-provenance sends complete with no probe; rediscovered records get a best-effort probe that can only DELAY (probe false ⇒ keep polling with "waiting for your wallet to sync") - null/unverifiable completes on the receipt. Residual risk accepted + documented in-code: forging a checkpointed claimTxHash needs localStorage write, which already owns the journal.
- Pins reworked: ⑰ local-provenance completes despite PXE lag; ⑰a rediscovered+still-claimable keeps polling to the soft cap with NO attention; ⑰b rediscovered private completes prompt-free (0 signatures, no auto-unseal); ⑰c explicit-CLAIM single-signature verify unchanged.

## sync countdown round (raven research fold)
- Researched raven-bridge-frontend (subagent): their "blocks remaining" is a FIXED-MARGIN countdown - snapshot `node.getBlockNumber()` when the L1 deposit confirms, target = snapshot + 3, poll + render the delta. No message-awareness, no PXE check; they claim blind at zero.
- Combined theirs + ours: `depositL2Block` snapshot persisted on the record (optional field, backward-compatible); the SYNC phase first counts down "Aztec block X of Y - Z until your funds arrive" WITHOUT touching the PXE (no simulate churn), then hands to the claim-simulate gate with honest copy "message arrived - waiting for your wallet to sync it (check N)". The gate stays the consumability authority; the countdown can only pace, never green-light. Fallbacks: missing snapshot/dep/node ⇒ straight to the gate with the old copy.
- Pins: countdown defers simulates (order-log assert: 4 block polls before the first simulate, completes after); missing snapshot ⇒ zero block polls, gate immediately.

## L2-balance "-" RESOLVED: stale wallet build (user environment)
- The raw error ("Scope violation: executeUtility.opts.scopes ... not in session's approved accounts") came from an OLD wallet build loaded in the browser - predating the wallet's scope-tolerance fixes. Reloading the current build fixed balances with no app change.
- KEPT from the hunt (real improvements): `useTokenBalance` settles public/private independently (one failing path never blanks the other) + stores/logs RAW per-path errors (`normalizeError` toast copy had masked every failure as "Something went wrong"); BridgeForm renders "balances unavailable - retrying" instead of an eternal silent "-". The diagnosis took exactly one console paste once the masking was gone.

## dopamine round (waiting-UX research applied, both surfaces)
- Research basis: NN/g progress indicators + visibility heuristic, HBS labor illusion / operational transparency, goal-gradient + anticipation dopamine, queue-psychology countdowns (overestimate), Kahneman peak-end.
- ONE shared `BridgePhaseRail` (full for the stepper, compact strip for the journal cards) over the same mapper - cards now show the identical phase glyphs, live detail, bars, and clocks. Card testids `journalRail`/`journalPhase` kept distinct from the stepper's (one-surface pins must not collide); `journalStep` testid preserved on the rail's detail line.
- Labor record: `lib/phase-clock.ts` (module clock, display-only, shared across surfaces; reload degrades honestly) - completed phases keep "✓ DEPOSIT - 14s"; active phases tick a live timer + deliberately OVERESTIMATED eta hints; mapper gains `progress` (SYNC blocks via new runtime.syncBlock; PROVE proven blocks - NEVER fabricated elsewhere) rendered as ▓░ bars.
- Peak-end: receipt opens with a stamped BRIDGED ✓ / RELEASED ✓ banner + "Xm Ys end to end" (from persisted createdAt/completedAt - survives reloads); done cards show the same stamp + mint flash during their 8s grace; every phase completion plays a 220ms stamp-in.
- Gotchas: vitest fake-timer cross-test contamination - zombie mounted components keep ticking into later tests and share the module phase-clock when record ids repeat (unique ids + unmount per test); `advanceTimersByTimeAsync` also advances `Date.now`.

## dopamine round fixes (user testnet catch)
- Phase-clock retry honesty: backward transitions reset the phase's clock (re-activated ⇒ fresh attempt timer; regressed-to-pending ⇒ stale times forgotten). Before: a wallet-lock stall during SYNC leaked an 8m pre-failure start into CONFIRM's badge and re-runs read 0s/inflated. Durations now measure the LATEST attempt, pinned both ways.
- RETRY moved INLINE onto the failed phase row (the rail emits; the stepper routes) - the bottom-of-card button was unintuitive. testid `stepperRetry` preserved.
- NEW BRIDGE / RUN IN BACKGROUND clear both flows' stale `error` refs - a "Wallet locked" ghost no longer greets the fresh form (pinned).
- Receipt de-shouted: small mint stamp (the pending-card style, 20px, no inverted block) + the meme: a one-shot CSS-only brutalist confetti burst (14 square mono bits, deterministic placement, 0.9s, zero deps - supply-chain policy respected).

## polish round (user testnet feedback)
- De-duplicated CROSSING (ex-SYNC): the bar owns the numbers ("111508 / 111510" + ▓░), the detail owns the words ("2 blocks until your funds arrive"). Label SYNC → CROSSING (journey language, key/data-phase unchanged for e2e).
- Dropped all visible "check N" counters (gate + receipt rounds) - they read as "retry until we hit the nail". Logs keep the counts; the unreachable streak stays (genuine connectivity signal).
- Cards: stage line + CLAIM/FINISH/DISCARD are IDLE-ONLY now (shown ⇒ pressable; while the engine drives, the rail narrates alone - the stale "confirm in your Aztec wallet" during CONFIRM is gone); copy adapts per stage (claiming = "Claim sent - press CLAIM to keep watching it confirm"); done cards show ONE tick (the direction-aware stamp; stage line gone).
- RETRY on a failed claim no longer revisits CROSSING: `runtime.claimable` (gate already passed) short-circuits the countdown and narrates the single revalidation simulate under CLAIM ("re-checking the message").
- The all-cards-disappeared report: almost certainly Vite HMR re-instancing module state (engine refs) when commits were pushed to the watched branch mid-test - records stay in storage; a reload restores. Watching for a repro on a quiet dev server before treating it as a product bug.

## final card polish (user)
- Compact rail: ONE pulse (the strip's active cell); the detail line lost its dot AND idle cards no longer show the static signing prompt as if live ("Confirm the deposit in your Ethereum wallet" on a dead record) - compact detail renders only for live stepDetail or a failed note.
- Skipped glyph ⊘ → ✓ (an allowance that suffices IS approval satisfied); the full rail's SKIPPED badge keeps the nuance.
- CLEAR button → ✕ dismiss in the done card's top-right (testid journalClear preserved). Gotcha: removing a v-if button from a v-if/v-else-if chain silently re-chains the v-else-if to the PREVIOUS sibling - DISCARD leaked onto done cards until made standalone.

## window-timeout round (user report)
- "Timed out waiting for window" = the wallet settling an unanswered confirmation popup - the claim prompt expired, the bridge itself was fine (the crossing bar was full). Three fixes:
  - `humanizeWalletError` at the flow boundary: the timeout reads "The wallet's confirmation window timed out before you could sign. Reopen your wallet and retry." Unknown messages pass through.
  - Phase attribution: `rt.claimable` (gate passed) now selects CLAIM as the active/failed phase - a post-gate failure can no longer plant its X on a visibly-complete CROSSING.
  - Error notes render ONCE: error/unknown-outcome notes live in the rail's failed phase; the card's separate note line keeps only non-failing attentions (mismatch/stale) + soft notes.

## vanishing-done-cards audit (user report: "sometimes disappears after re-engaging")
- ROOT CAUSE: not a race - the F12 provenance-scoped auto-hide. A re-engaged card whose claim SEND happened in this tab gained provenance ⇒ auto-hid after the 8s grace; a pure receipt-resume (claimTxHash from an earlier session) had no provenance ⇒ stayed. "Sometimes" = which path the re-engagement took.
- FIX: auto-hide retired (it predates the ✕ dismiss). Completed cards stay until (a) the user's ✕ or (b) the foreground receipt path closes via NEW BRIDGE (`hideCompleted` - refuses non-completed records, pinned). `localClaimProvenance` keeps its TRUST role (checkpoint completion without the probe); only the hide side-effect went. Engine + smoke pins rewritten to the new contract.
