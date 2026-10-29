---
plan: gas-floor-1
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: completed (PR #70)
base: main a111e8a
budget: "recon: 1 Sonnet explorer; code-review: off; Codex gpt-6.1-sol at high"
---

## Outcome

- **Status:** completed; delivered in PR #70 (one arc), awaiting the orchestrator's merge. Delivers ask28, ask32.
- **Shipped:** the `below-floor` route outcome and the refusal sorting in `gasFailure` (`useCrossChainRoute.ts`);
  the claim-minimum sentence, no box and a settled `loading` for it (`useCrossChainSend.ts`); "~1 min" and
  "usually ~1 min" for the Cross to Aztec step on both networks; route, send and step tests; browser cell 55.
- **Changed in review:** planning corrected the fixture facts (fixed terms keep 75%) and the controls, and added the
  re-quote case. Implementation review made the refusal a required argument. Rejected: a mainnet carve-out for
  `unsafe`, a wizard-level test and the whole browser suite run locally (ledger D3, D8, D9).
- **Left to the owner, unchanged:** "usually 3–8 min end to end" and "a few minutes for Aztec to pick it up"
  (`OWNER-ASKS.md`).
- **Lessons:** none promoted. The sandbox's missing-library error names its own fix. The screenshot-tour hold is in
  `apps/tools/tests/browser/README.md`.
- **Known limits:** #71.
- **Open items:** the two owner asks in `OWNER-ASKS.md`, with the orchestrator.
- **Seeds:** the `/goal` and `/loop` seeds at the end are retired; they are history, not instructions.

# gas-floor-1: a gas slice under the claim minimum, and the Cross to Aztec estimate

## Summary

**Requirements.** ask28 → a1. ask32 → a1. Issues: none.
**UI impact** (the owner's recorded decisions, the whole visible budget):
- ask28: "On a Base Sepolia token-and-gas send, a gas slice the testnet swapper quotes under the claim minimum shows the venue-outage state of the cross-chain card. Show it as the Ethereum send does, as too little gas for the claim, and never report a readable swap as unreadable."
  Surfaces: the amount step of a cross-chain send. Below the floor, the `venue` box goes away; the gas breakdown shows
  the existing `gasMinimumShortfall` sentence; the fee lines and "Arrives on Aztec" show their existing "—"; Next stays
  disabled. A broken pin or a zero rate shows the existing `no-route` box instead of `venue`. No new words.
- ask32: "Wherever the app shows the Cross to Aztec step (the Ethereum send and the cross-chain send), its time estimate reads about one minute ("~1 min", "usually ~1 min") instead of 1–4 minutes, on each network where the network's timing supports it."
  Surfaces: the four sync strings, on testnet and mainnet (fact 6).

## Outcome & Quality Bar

**For whom.** A person who sends a small amount with gas from a source chain, and anyone who watches a deposit cross.
**Excellent.** (1) A slice too small to claim says so, with the figures and what to do ("send a larger amount"),
never "can't be priced right now"; a real outage still says that. (2) The cross-chain answer settles: no spinner
and no hung review re-quote behind the refusal.
**Good enough.** The half cap that makes the slice small stays (sizing policy is out of scope).

## Assumptions

### Facts (verified at a111e8a; trails in `recon.md`)

1. Today a `floor` refusal reaches `venue`: `gasAt:200` drops the refusal, `reverted()` is false (recon fact 1).
2. With a positive `minFuelFj` (every shipped manifest; zero needs `feeJuice.minFj` 0 too), a `floor` refusal implies
   `expectedOut < minFuelFj` and `floor == minFuelFj` (recon fact 3), so `gasMinimumShortfall(expectedOut, floor)` is
   never null for one. A zero minimum is a condition the product does not support.
3. Live: 0.3 USDC buys 9.6 FJ against a 29.77 FJ minimum (recon fact 2). The Ethereum send shows the shortfall
   sentence for the same slice; `GAS_TOO_SMALL` needs a slice that takes the whole amount, which the half cap
   prevents (recon fact 5). The gas share sizes to the floor except under the half cap (recon fact 6).
4. Only `useCrossChainSend.ts` reads route outcome kinds; the review's re-quote waits for `xc.loading` to fall
   (recon fact 7).
5. The browser sandbox: 1 whole token buys 1 FJ, the claim minimum is 1 FJ, fixed terms keep 75% of a send
   (`SELF_BUILT_RELAY_FEE_BPS` 2500), and cross-chain cells start on the local source chain 31338 in place of Base
   Sepolia (README "The source chain"). A send of 1 delivers 0.75; its half-cap slice buys 0.375 FJ.
6. 6.0.0 inbox delay, L1 message to L2 tree: testnet median 60 s (36–84), mainnet median 72 s (36–96), same 72 s
   slots and bucketed Inbox on both (recon fact 9). The app's gate passes on that same predicate
   (`l1ToL2MessageReadiness`: tree size > index), polled every 6 s (`arrival.ts:14`).

### Inferences

- I1: no consumer outside `useCrossChainSend.ts` breaks on a new outcome kind (fact 4; TypeScript flags the rest).
- I2: for a fresh app send the visible Cross to Aztec phase is the inbox delay plus one 6 s poll and the claim
  simulate: the SDK's 3-block countdown never runs there, because app rows carry no `depositL2Block` (`useSend.ts:693`;
  cross-chain records never set it; `countdownApplies`, `useBridgeJournal.ts:1466`). So "~1 min" holds on both
  networks, as the owner reports. No live app deposit was timed here: that is a keyed live run, the owner's.

### Asks

- none.

## Architecture & Implementation

- **Route** (`src/composables/useCrossChainRoute.ts`). Add an outcome kind and give `gasFailure` the refusal:
  ```ts
  /** The venue quotes the slice under the claim minimum: the amount is too small, nothing is down. */
  | { kind: "below-floor"; expectedOut: bigint; floor: bigint }
  // gasFailure(c, res?: FuelQuoteRefusal): floor → below-floor; provider && !reverted() → unavailable (venue);
  // anything else (revert, unsafe, a zero probe) → noRoute(NO_GAS_ROUTE)
  ```
  `sliceOf` passes a failed probe's refusal and calls `gasFailure(c)` for a zero probe; `gasAt` passes `q`. LI.FI's
  `floor` takes the same path (shared code); its `provider` refusals keep today's mapping (out of scope).
- **Send** (`src/composables/useCrossChainSend.ts`). `noticeOf` returns null for `below-floor`. `gasErrorOf` takes
  the quoted answer: `below-floor` → `gasMinimumShortfall(expectedOut, floor)`; a route → today's checks. `loading`
  treats a `below-floor` answer as settled, so the amount step and `settleRequote` stop waiting.
- **Steps.** `bridge-steps.ts`: `etas.sync` "usually ~1 min", `DEPOSIT_ESTIMATES.sync` "~1 min".
  `crosschain-steps.ts`: `sync.eta` "usually ~1 min", `sync.estimate` "~1 min".
- **No change** to `SendWizard.vue`, `AmountStep.vue`, `CrossChainState.vue`, `GasBreakdown.vue` or the SDK.
  Alternatives not taken: the decision ledger.

## Security & Adversarial Considerations

- **Threat model.** The venue (testnet swapper, LI.FI) is an untrusted quote source. The change only re-labels its
  refusals; `floorFor`, the pin checks and `verifyRoute` are untouched, and a refused quote still yields no route and
  nothing to sign. The figures in the sentence come from the venue's quote and the manifest's minimum, formatted by
  `formatCompact`; no venue text reaches the screen. A refused quote can only make a send unavailable, as today; a
  misleading successful quote is bounded by the signed floor, unchanged here.
- **Least privilege, cryptography, supply chain, secrets:** no new dependency, permission, key or network call. N/A.

## Phase 1 (arc a1): refusal mapping, card state, estimates ✓

1. Route: the outcome kind and `gasFailure` as above. Write each first test before its fix and see it fail.
2. Send: `noticeOf`, `gasErrorOf`, `loading` as above.
3. Steps: the four strings.
4. Tests (`src/` paths):
   - `test/crosschain.ts`: add venues `under-floor` (live rate 32 FJ per USDC, the testnet `minFuelFj`), `zero-rate`
     (reads 0) and `pin-broken` (quote refuses `unsafe`).
   - `composables/useCrossChainRoute.test.ts`, one new case on fixed terms (`fixedAt`) with a half slice: 1 USDC on
     `under-floor` (0.375 USDC slice, 12 FJ) → `below-floor` with the exact `expectedOut` and `floor`; 5 USDC (60 FJ)
     → a route (control, under the 8-token cap); `pin-broken` and `zero-rate` → `no-route` `NO_GAS_ROUTE`; `down` →
     `unavailable` with the venue reason (pinned, the outage control).
   - `composables/useCrossChainSend.test.ts`, one new case on `under-floor`: `propose` sizes 1 USDC (32 FJ) → a
     route; it then sizes 0.3 USDC (9.6 FJ) and the ask re-quotes → `loading` falls to false, notice null,
     `gasError` is the exact `gasMinimumShortfall` sentence, `ready` false; on `down` → notice `venue` (control).
   - `lib/bridge-steps.test.ts:160,175` and `components/BridgePhaseRail.test.ts:69` take the new strings;
     `lib/crosschain-steps.test.ts` pins the cross-chain sync `eta` and `estimate` once.
   - `tests/browser/specs/deposit-crosschain.spec.ts`: cell 55 (`cells: 6`), modelled on cell 17. Fund 1 token on the
     source chain, start a public token + gas send of "1" (0.375 FJ), wait for the route; assert `sendGasBreakdown`
     contains "minimum a claim needs", no `sendXcNotice`, Next disabled, no signature, the source balance unchanged.
     Failure mode: the real swapper read, the manifest minimum, the gas share and the amount step composing into the
     outage box; unit tests fake the reader and the composition. Estimate 30 s; measure it.
5. After shots, light and dark: a throwaway `tests/browser/specs/zz-gas-floor-shots.spec.ts`, run alone
   (`bash scripts/e2e/agent.sh specs/zz-gas-floor-shots.spec.ts` from `apps/tools`), never committed. Capture the
   below-floor amount step and the cross-chain and Ethereum step lists with "~1 min", into the lane scratch
   directory. Delete the spec before any full run.

**Gate:** `bun run lint`; `bun run typecheck:all`; from `apps/tools`, `bun --bun vitest run
src/composables/useCrossChainRoute.test.ts src/composables/useCrossChainSend.test.ts src/lib/bridge-steps.test.ts
src/lib/crosschain-steps.test.ts src/components/BridgePhaseRail.test.ts` (all pass; then restore the old
`gasFailure` body, see the new route and send cases fail, and restore the fix); `bun run test:all`;
`bun run audit:tools`; `bun run e2e:tools -- specs/deposit-crosschain.spec.ts specs/deposit-token-gas.spec.ts
--retries=0` (the new cell, and cell 17 as the Ethereum control). Pass: exit 0 for each. CI's `tools-e2e-status`
runs the whole suite.
Layers: lint, typecheck, unit, component, e2e. A Bun or barretenberg SIGBUS counts as the host: rerun that file alone.

## Decision ledger

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| D1 | Shape | a `below-floor` outcome with `expectedOut`, `floor` | `no-route` + a field (that kind always draws a box); a route without its gas leg (no bytes to sign); a probe-rate pre-check in the sizer (duplicates `floorFor`; LI.FI's slice quote can differ from its probe) |
| D2 | The minimum shown | the refusal's `floor` (fact 2) | `FUEL.minFuelFj`: a second source, possibly undefined |
| D3 | `unsafe`, zero probe | `no-route`, existing box: the card's own taxonomy ("the gas venue quotes nothing") and the SDK's (`quoteRefusal`: `unsafe` → `no-fuel-route`) | `refused` (means our own bytes failed the decoder); new copy (outside the budget); keeping `unsafe` on `venue` (Codex r1: mainnet scope) — the brief names `unsafe`, `venue` is the "readable as unreadable" ask28 forbids, and no production build reaches it today (the swapper never emits it; the mainnet manifest has no bridge; only the local `/lifi/` test bundle can) |
| D4 | Placement | the gas breakdown's error line, no box, as the Ethereum send | a `CrossChainState` box carrying the sentence (a new box state) |
| D5 | Loading | a `below-floor` answer is settled | leaving `loading` on the route alone: a spinner forever and a hung review re-quote |
| D6 | Browser | a new cell 55 | a pre-step in cell 50: ties a UI check to a long fill cell |
| D7 | ask32 | both networks (fact 6, I2) | testnet only: the measurement and the owner's report agree on both |
| D8 | Review re-quote | the composable case: a re-quote that lands below the floor drops `loading` | a `SendWizard` case (Codex r1): its cross-chain branch is a mock there, so it would prove only `settleRequote`'s existing lines; PR #59 also edits that test file |
| D9 | Local e2e | the touched specs at retry 0, per the program's gate | the whole suite locally (Codex r1): CI's required `tools-e2e-status` runs it on the PR |

## Audit verdicts

- **Codex r1 (gpt-6.1-sol, high): conditional approve.** Adopted: fact 2 limited to positive minima; fixed terms keep
  75%, not 99.x% (fact 5, cell 55 figures); the route control moved to fixed terms with a half slice and 5 USDC (the
  Across fixture always delivers 4.9 USDC, and 100 is over the cap); the send case sizes its own slice (the fixture's
  1 USDC buys 32 FJ); a re-quote case for `loading`; the security line narrowed to refused quotes; timing kept as I2.
  Rejected: D3's mainnet carve-out, a wizard test (D8), the whole suite locally (D9).
- **Codex final (fresh session, gpt-6.1-sol, high): approve.** It accepted D3, D8 and D9, and narrowed D3's rationale to
  production builds (adopted). Follow-up in the same session: the planner suspected the SDK's 3-block countdown
  (`SYNC_TARGET_MARGIN_BLOCKS`; L2 blocks now 51 s testnet, 70 s mainnet) would hold the phase at 2–3.5 min and
  proposed sending ask32 to the owner. Codex refuted it with a trace, and the planner verified it: fresh app rows carry
  no `depositL2Block`, so the countdown is skipped (I2). ask32 stays in a1, with no owner ask.
- **Implementation, Codex fix loop (gpt-6.1-sol, high).** r1: CLEAN, one comment nit (adopted for `gasFailure`;
  the fixture comment stays, it explains `a + 1n`). r2 (resumed, on the fix diff): CLEAN. Converged in 2 rounds.
- **Implementation, Opus diff review (beside r1): 3 findings, no bug.** Adopted: `gasFailure` takes a required
  refusal, the zero probe returns no route directly, the `gasError` TSDoc covers below-floor. Sent to the owner
  (`OWNER-ASKS.md`, ships unchanged): `DEPOSIT_TAKES` "usually 3–8 min end to end" and the cross-chain review's "a few
  minutes for Aztec to pick it up". Known limit: a zero `minFuelFj` leaves the step without a reason (unsupported
  manifest), filed at close-out.
- **Deviations.** The Ethereum stepper labels the step "Crossing"; its estimate is `DEPOSIT_ESTIMATES.sync`. Cell 55
  measured 41.6 s (estimated 30 s); `deposit-crosschain` went from 10.0 min (cells 50–54) to 10.7 min. The new
  worktree needed `contracts/bridge/evm/lib`: forge-std, OpenZeppelin and v4-core copied, `lifi-contracts` installed
  with `--no-git` at the README's pin.

## Delivery

One arc, one PR, on branch `worktree-gas-floor-1`, which carries this plan's commit. Merge `origin/main` before the
PR. Title: `fix(tools): show a gas slice under the claim minimum as such and cross to aztec in ~1 min`. The body
says what changed and why, the gates with outcomes, the e2e wall-clock of `deposit-crosschain` before and after,
`Delivers ask28, ask32`, quotes ask28 and ask32 as the sign-off, and names the after shots (file names only).
`code_review: off`. No parallel lanes. The close-out is the PR's final commits.

## Post-implementation

1. **Codex fix loop** on the diff from `a111e8a` (net of the plan commit): `~/.claude/skills/codex/scripts/run-codex.sh
   <prompt-file> <worktree> high read-only gpt-6.1-sol`, with this plan, the adversarial ask, and verbatim: *"Report
   bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface,
   new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it
   alone."* and *"Audit the comments for value per character. Flag any comment that narrates what the code visibly
   does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a
   sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have.
   Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and
   exact."* Every prompt says: never open, read, cat, list or search a local `.env` or `*.env` file; never open,
   list or search `~/.agents/orchy/`. Triage (verify claims against the tree), fix, commit, log the round in
   `lessons/phase-1.md` and here, then `resume-codex.sh` with the fix diff. Until a round finds nothing material;
   stop and surface after three. A fix that adds state, a lifecycle, a protocol, a recovery policy or a public
   contract is a plan change: stop. One Opus `general-purpose` review of the final diff runs beside round 1.
2. **Delivery** as above: the gate again on the final head, push, `gh pr create`, `gh pr checks <n> --watch`.
3. **Close-out** (the PR's final commits): an `## Outcome` block after the front matter (date, status, shipped, PR,
   `Known limits:`, `Open items:`, the seeds retired); promote a general gotcha to `implementations-plan/lessons.md`
   only within its 8 KiB budget, retiring what it supersedes; file open work as issues (a weakness as a private
   draft advisory; a known limit as a closed `known-limit` issue); delete `STATUS.md`; merge `origin/main`, read what
   changed in `index.md` and `lessons.md`; `git mv implementations-plan/gas-floor-1 implementations-plan/archive/` in
   its own commit, with one line added to `implementations-plan/archive/index.md`. No row in `index.md`.
4. **Teardown** after the orchestrator merges: `git fetch -q origin main && git cat-file -e
   FETCH_HEAD:implementations-plan/archive/gas-floor-1/plan.md`, then `agent-worktree done gas-floor-1 --merged`;
   relay a refusal, never force.

## Seeds

- `/goal Phase 1 of implementations-plan/gas-floor-1/plan.md is ✓ with its gate passing in the transcript; the Codex fix loop converged (a resumed pass with no new material finding, quoted); the PR exists with the close-out commits; bun run lint and bun run test:all exit 0.` (recommended)
- `/loop 15m Drive implementations-plan/gas-floor-1 per its plan.md: the next unchecked step, the gate, the Codex loop, delivery, close-out; never merge; stop when the PR is green.`

Size: about 200 lines, over the 150 target: the Post-implementation section carries the two review rules verbatim, and the ledger the audit trail.
