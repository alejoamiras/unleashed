---
plan: send-copy-2
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: at the approval gate (final Codex verdict: approve); a2 waits for the ask30 sign-off
base: main e1d1c4c
budget: "recon: 1 Sonnet explorer; audit: Codex gpt-6.1-sol at high plus one Opus Plan critique, then a fresh Codex pass; code-review: off"
---

# send-copy-2: the cross-chain pause check, a blank review, plainer testnet cross-chain copy

Two arcs, two PRs against `main`. Over the light target: two arcs and three recorded audit passes. **a1** checks the route's pause before a cross-chain send's first wallet prompt
(P9-01) and starts every review blank (P9-02). **a2** ships the ask30 strings the owner signs, and only those. a2
waits for the sign-off; a1 does not. Mainnet copy is unchanged. Issues: none.

## UI impact

- **P9-01 Option B**: "Check the pause before the first wallet prompt, with page 7's sentence: "Deposits on this
  route are paused right now. Nothing was sent." Nothing leaves the source chain and no fee is spent." The sentence
  shows on the cross-chain review in the error line (`sendReviewError`) when the check reads the route as paused.
  Sign and send holds while the check reads, as it does on the Ethereum send.
- **P9-02 Option B**: "A fresh review starts blank: every send error clears when you come back to the review."
- **ask30**: the direction is recorded; no string is signed. a2 builds only the entries of `OWNER-ASKS.md` §1–§3 the
  owner signs, with their before and after shots. Nothing else a user sees changes. §0 asks how a check that fails
  should behave; a1 ships today's behaviour for it (the send goes). §5 asks about an exit's decline from selection,
  which stays (D4).

## Outcome & Quality Bar

- A testnet user who confirms a cross-chain send on a route the check reads as paused sees the sentence and gets no
  wallet prompt: no seal, no approval, no source transaction, no record. A route that reads open sends as today.
- After Back then Next, the review shows no error, decline or pause notice from an earlier attempt; on the same
  review, an attempt's error stays until the next confirm, as today.

Good enough: one browser step for P9-01; a2 changes strings only, on the testnet branches that exist today.

## Architecture & Implementation

- **P9-01 check.** `useSend` gains `checkCrossChain(plan): Promise<string | null>`, beside `check`. It reads through
  `readClientFor(NETWORK.l1ChainId)` and `appNode()`, because a cross-chain review's wallet is on the source chain.
  It runs `assertDepositsOpen(await bridgeNetwork(reads), reads, plan.intent)`. A `paused` refusal returns
  `DEPOSITS_PAUSED`. A missing reader, a thrown read or any other refusal returns null, logged by code only (D2). The
  router refuses every leg on `FACTORY.depositsPaused()`, which is the flag `assertDepositsOpen` reads (recon).
- **P9-01 wizard.** `heldCheck` takes the check to run. `preflight` runs `crossChainChecked` for a cross-chain review,
  where `bridgeChecked` runs for an Ethereum send. `crossChainChecked` runs the held check, then `reviewStands`, then
  sets `xcError` to the result (null on a pass) and returns whether it is null. A refusal returns false before
  `submitting`, `contractRefusal` and `xc.send`, so nothing prompts.
- **P9-02.** `enterReview` already clears the cross-chain state. It also sets `sendFlow.error`, `exitFlow.error` and
  `exitFlow.paused` to null. It resets a deposit review's `grantState` from `"declined"` to `"idle"`. An exit's
  `grantState` comes from token selection, not a send, so it stays (D4). `runCrossChain` re-tests `reviewed.value ===
  snapshot` after `await xc.send` before it writes `xcRefusal` or `xcError`, so a backgrounded send that fails later
  does not write into a newer review (D7). Its adopt branch is unchanged.
- **a2.** Each signed string replaces its text in place, on the branch it has today: `figures.fixed` or `terms ===
  "fixed"` in `CrossChainReview.vue`, `crosschain-figures.ts` (`quoteWord`, `RETRY_WORDS`) and `crosschain-steps.ts`
  (`bridgingPrompt`); `IS_MAINNET` in `CrossChainState.vue`, `crosschain-outcome.ts` and `crosschain-activity.ts`. An
  unsigned entry keeps today's text. R6 also edits the two templates that hard-code "valid for … before you sign"
  (`SendWizard.vue:1874-1875`, `CrossChainReview.vue:260-262`), keeping mainnet's sentence. W1 is one helper, so it
  also renames the amount step's refused-route button, and S2 also shows on the background strip; `OWNER-ASKS.md`
  lists both. A comment that names a removed mechanism is corrected.
- **Not taken.** (a) `check` unchanged: it reads the wallet's chain, which is the source chain here. (b) A direct
  `depositsPaused` read on `SEND_GENERATION.factory`: it copies the SDK's choice of gate. (c) The check inside
  `runCrossChain`: it would run after `submitting` is set and outside the held preflight.

## Security & Adversarial Considerations

- The check compares chain answers; it does not authenticate them. The pinned reader is the build's own RPC (the
  rule in `lessons.md`), never the wallet's transport. A false "open" answer leaves today's outcome: if the delivery
  reaches Ethereum while deposits are paused, its deposit reverts and it recovers to the user's Ethereum wallet. A
  false "paused" answer stops a send with nothing spent.
- Fail-open (D2) keeps today's exposure, since today the cross-chain path has no check, but it does not make a send
  safe. A node outage lets a paused route's send go; a delivery whose deposit then reverts recovers to the user's
  Ethereum wallet. A manifest mismatch lets a send go into contracts whose frozen pointers name another rollup, so
  its deposit may be unclaimable (`TokenPortalImpl.sol` freezes `INBOX` and `ROLLUP_VERSION`; plausible, unverified
  end to end). The Ethereum send refuses both today. §0 puts this to the owner. The session cache holds verified network data, not a transport: whichever check runs first builds it, and
  each later check still reads the pause through its own client. The pause target comes from the manifest.
- A read that hangs holds the cross-chain review's buttons, as it already does on the Ethereum send (the node client
  has no timeout). No timeout is added: that is a recovery policy (§0 names it).
- No new dependency, credential, persistence, contract change or crypto. No raw RPC text reaches the screen or log.

## Assumptions

### Facts (verified at e1d1c4c; detail in `recon.md`)

1. The wizard skips the bridge check for a cross-chain review (`SendWizard.vue:1174`); its first prompt is in
   `xc.send` (`:1133`), after `contractRefusal` (`:1125`), which reads code without a prompt.
2. `check` reads through the wallet's client (`useSend.ts:807`), which is on the source chain at a cross-chain
   confirm (`SendWizard.vue:1300`). `readClientFor(NETWORK.l1ChainId)` is the pinned Ethereum reader
   (`useEthereumReader.ts:17`), already used by the cross-chain send (`useCrossChainSend.ts:213`).
3. `DepositRouter` reverts every leg on `FACTORY.depositsPaused()` (`DepositRouter.sol:29`, `:235`), and
   `assertDepositsOpen` reads `depositsPaused` on `net.bridge.factory` (`l1-deposit.ts:91-95`).
4. `xcError` shows as `sendReviewError` (`CrossChainReview.vue:255`) and every `enterReview` clears it (`SendWizard.vue:949-956`).
5. `sendFlow.error`, `exitFlow.error`, `exitFlow.paused` and a deposit's `"declined"` survive Back then Next today;
   only the next confirm or `standDown` clears them (recon table).
6. Every ask30 "before" string is testnet-only and sits behind an existing branch, except R6, whose words the two
   templates also hard-code (recon before list); no browser spec asserts any of them (`grep` over `apps/tools/tests`).
7. The browser suite is serial per shard (`playwright.config.ts`, `workers: 1`); cell 53 already pauses the factory
   in a `try/finally` (`deposit-crosschain.spec.ts:250-254`).

### Inferences

- The mainnet manifest is a placeholder, so P9-01 runs on testnet only until mainnet's bridge ships; the code is
  network-neutral.
- "Every send error" does not cover an exit's grant decline at selection, which no send wrote (D4).

### Asks (working assumption in force)

- A1 (`OWNER-ASKS.md` §0): a check that fails (outage or mismatch) lets the send go, as today.
- A3 (`OWNER-ASKS.md` §5): an exit's decline from token selection stays after Back then Next.
- A2: a2 builds only signed entries; S2 ships in a2 only if gas-floor-1 leaves that line alone.

## Disposition

- ask30 → a2, once signed. P9-01, P9-02 → a1. Issues: none. #65 is out of scope.

## Phase P1 (arc a1): P9-01 and P9-02

Files: `composables/useSend.ts`, `components/send/SendWizard.vue`, their tests, `tests/browser/specs/deposit-crosschain.spec.ts`.

1. Add `checkCrossChain`; export nothing else new. Add `heldCheck(run)`, `crossChainChecked` and the `enterReview` resets.
2. `useSend.test.ts`: `checkCrossChain` over a paused route (DEPOSITS_PAUSED), a thrown read, an `invalid-network`
   refusal, no reader (null each) and a pass (null). Assert the reads use the pinned reader and never the wallet's
   `publicClient`, with a pass as the control.
3. `SendWizard.test.ts` (its `useSend` mock gains `checkCrossChain`):
   - a paused cross-chain confirm shows the sentence; `contractAccount` and `xcSend` are not called; a pass sends,
     and the check received the review's plan;
   - a cross-chain confirm never calls `check`, and an Ethereum confirm never calls `checkCrossChain`;
   - a held check that returns after the account switched sends nothing and shows nothing, for a pass and a refusal;
   - Back then Next clears the cross-chain sentence, `sendFlow.error`, `exitFlow.error`, `exitFlow.paused` and a
     deposit's `"declined"`; an exit's `"declined"` stays; on the same review an error stays (control);
   - a cross-chain send whose `xcSend` resolves with an error after a newer review opened leaves that review blank;
     the same failure on the review that sent it shows (control).
4. Browser: cell 53 first confirms on a paused route, inside its own `try/finally` that unpauses. It asserts the
   sentence, zero `eth_sendTransaction` and no record. Then it confirms the same review (rebuilt first if it shows
   expired) and runs as today. Failure mode: with fail-open, a misread in the real build passes silently, and only
   the real pinned reader and node can prove the refusal. Estimate +15 s; record the measured time.
5. Shots for the PR, by P2 step 3's method, light and dark: the cross-chain review with the paused sentence, and the
   same review after Back then Next. Save to `design/a1-*.png`.

**Gate**: `bun run lint && bun run typecheck:all && bun run test:all && bun run --cwd apps/tools test:e2e && bun run audit:tools`
exit 0, then `bun run e2e:tools -- specs/deposit-crosschain.spec.ts specs/l1-wallet.spec.ts specs/recovery.spec.ts` at
retry 0 with `PLAYWRIGHT_BROWSERS_PATH` unset (lint, typecheck, unit, jsdom smoke, browser; the last two specs are the
review's error and decline in the real app, as controls). A SIGBUS counts as the host: rerun that file alone and say so.

## Phase P2 (arc a2): the signed ask30 strings

Starts only after the owner signs, and after a1 merges (`git merge origin/main` first).

1. Replace each signed string (`OWNER-ASKS.md` §1–§3, by id) in the files the before list names; keep every unsigned one.
2. Update the assertions in `CrossChainReview.test.ts`, `crosschain-steps.test.ts`, `CrossChainOutcome.test.ts`,
   `BridgeJournalCard.crosschain.test.ts`. Keep each mainnet control green unchanged; add one where a signed string
   gains a branch it lacks today (for example the Quote band).
3. After shots: Chromium, 1280×900, light and dark, by send-copy-1's method (`archive/send-copy-1/plan.md` § P3 step
   3): a throwaway `specs/zz-send-copy-shots.spec.ts` through `scripts/e2e/agent.sh`, never committed. Shoot the
   review (Details closed and open, and expired; and at 390 px wide for R6's phone bar), the Bridge step, the expired
   card, its outcome panel and an unsent card. Use the display-only label change in `apps/tools/src/lib/network.ts`
   and revert it. Save to `implementations-plan/send-copy-2/design/after-*.png` (gitignored).

**Gate**: `bun run lint && bun run typecheck:all && bun run test:all && bun run audit:tools` exit 0; every shot
exists; `git status` shows no `zz-*` spec and no `network.ts` change.

## Decision ledger

- D1 the cross-chain check is a `useSend` method on the pinned reader, called in the held preflight. Rejected:
  (a)–(c) above.
- D2 only a read `paused` refuses; anything else lets the send go (today's behaviour), pending §0.
- D3 the sentence lives in `xcError`, so P9-02 already covers it.
- D4 P9-02 clears what a send attempt wrote; an exit's selection-time grant outcome is not one.
- D5 one browser step, in cell 53, not a new cell: same setup, about +15 s, serial shard.
- D6 two arcs: a1 needs no signature; a2 waits for one. They share only `SendWizard.vue`'s band (R6), which a2 edits
  after merging a1.
- D7 a send still running in the background can write its error after a newer review opened. The wizard's own
  write (`runCrossChain`'s `xcRefusal`/`xcError`) is guarded with the existing snapshot. `runSend`'s tail write needs no
  guard: it writes `"declined"` only when no grant exists, which is before any record, so before any background. The
  composables' writes (`useSend.ts:521`, `useHubExit.ts:611-625`) carry no owner today (their `epoch` serves the
  grant only); guarding them needs a per-review owner in each composable, which is new coordination state. Known
  limit: the close-out files it as a closed `known-limit` issue, reopened on a user report.

## Audit verdicts

- Codex round 1 (gpt-6.1-sol, high): conditional approve. Accepted: R6's two templates and the phone bar; a1 shots;
  §0 widened to mismatches and the fee consequence, with P9-01's guarantee qualified to an observed pause; R5 and R4
  drafts corrected; W1's amount-step button listed. No finding rejected.
- Opus Plan critique (same draft): conditional approve. Accepted: §0's cases and the hung read; R4 and R2 drafts
  corrected; a1 shots; the before list completed (no-window variants, S2 on the strip); cell 53's own `try/finally`
  and TTL; the cache sentence in Security; D7 as a known limit; §5 for the exit decline; the `network.ts` gate line
  and the never-happens and argument assertions. No finding rejected.
- Codex final fresh pass (gpt-6.1-sol, high): conditional approve. Adopted both conditions: D2's consequences
  restated (recovery only when a delivered deposit reverts; a mismatch may strand a deposit), in Security and §0;
  D7 narrowed to the composables' writes, with the wizard's cross-chain write guarded by the existing snapshot and
  a regression with its control. §5 now says the exit's retry does not re-request the grant. Resumed on the
  revision: one wording fix (wallet recovery only when a delivery reaches Ethereum), then **approve**.
- Detail: `lessons/phase-0.md`.

## Delivery

- a1 = P1 on `worktree-send-copy-2`, which holds the plan commit. Merge `origin/main` first. PR title:
  `feat(tools): check the pause before a cross-chain send and start every review blank`. Body: what and why, P9-01 B
  and P9-02 B quoted by id and text, the gates with outcomes, cell 53's wall-clock before and after, the `a1-*`
  shots by name (the orchestrator attaches them). It delivers no ask, so its body names none.
- a2 = P2, same branch after `git merge origin/main`. PR title: `feat(tools): plainer testnet cross-chain send copy`.
  Body: the signed ask30 strings quoted by id and text, `Delivers ask30`, the shots by name, the gates.
- Both bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. The close-out rides a2.
- Parallelism: none worth it; a2 is gated on a person, not on a1.

## Post-implementation (per arc)

1. Codex fix loop: `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol` on
   the arc's diff (`git diff <arc base>...HEAD -- . ':!implementations-plan'`), with this plan, the adversarial ask,
   AGENTS.md § Code comments, and verbatim: "Report bugs and small, targeted improvements only. Do not propose
   speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes
   each real problem. If code works and is clear, leave it alone." Every prompt carries the `.env` and
   `~/.agents/orchy/` lines. Verify each finding, fix, commit, `resume-codex.sh`; repeat until a round has no
   material finding; stop at three rounds. A fix that adds state, a lifecycle, a protocol, a recovery policy or a
   public contract stops for approval. One Opus `general-purpose` review runs beside round 1. Log rounds in
   `lessons/phase-N.md` and here.
2. Rerun the arc's gate on the final head; push; open the PR; `gh pr checks <n> --watch` once, bounded.
3. Close-out as a2's final commits: `## Outcome` after the front matter (status, shipped, `Known limits:`,
   `Open items:`, seeds retired; no calendar date); promote general lessons to `lessons.md` (8 KiB, dedupe); file
   open work as issues; delete `STATUS.md`; `git mv` this folder into `implementations-plan/archive/` in its own
   commit with one line in `archive/index.md`. No `index.md` row.
4. Merging is the orchestrator's. After a2 merges: `agent-worktree done send-copy-2 --merged`; relay any refusal.

## Seeds (draft; run none, the orchestrator owns implementation sessions)

- `/goal` P1 ✓ in plan.md with its gate's output in the transcript; the a1 Codex loop converged (a resumed round
  with no material finding quoted); a1's PR is open against main; `bun run test:all` and `bun run lint` exit 0.
- `/loop 15m` Drive implementations-plan/send-copy-2 from plan.md and STATUS.md; never merge; start P2 only on a
  recorded sign-off; surface a red gate after three tries.
