---
plan: send-copy-1
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: final Codex verdict approve; awaiting the orchestrator's approval
base: main a111e8a
budget: "recon: 1 Sonnet explorer; audit: Codex gpt-6.1-sol at high, plus one Opus Plan critique; code-review: off"
---

# send-copy-1: testnet send wording, and two refusals before any wallet prompt

One arc, one PR (`Closes #40`). The testnet app says our relayer fills a Base Sepolia send and promises no refund
(P6-01). An Ethereum send on a paused route, or on a bridge the app cannot check, stops at Sign and send with the
owner's sentence before any wallet prompt (P7-01, P7-02). Mainnet copy is unchanged. The lane brief has no asks.
Over the light target (about 215 lines): the signed strings are quoted verbatim and two audits are recorded.

## UI impact

- **P6-01 Option B**: "Say our testnet relayer fills it, usually within minutes, and drop every refund promise, the
  closed Details panel's Refund row included." Strings are the B mocks the owner signed, with the code's variables:
  - Review notice: `Testnet: our testnet relayer fills this send on {l1}, usually within a few minutes.`
  - Review Takes: `Usually a few minutes for our testnet relayer to fill it on {l1}, a few minutes for Aztec to pick it up, then your claim.`
  - Bridge step: `{rail} holds your {symbol} until our testnet relayer fills it on {l1}. Nothing for you to do.`
  - Strip ETA: `usually a few minutes, up to {range}`.
  - Expired card: title `Not filled on {l1}`; happened `This transfer waited {window} for our testnet relayer on {l1} and wasn’t filled, so it expired.`; means `Nothing reached {l1} or Aztec, and there is nothing to claim. {rail} keeps the {symbol} in its pool on {src}: testnet sends are not refunded automatically. The network fee for the send is not returned.`; no "due back in" figure, no "Refund on {src} · pending" row.
  - Details panel: no Refund row on testnet.
  - Deletions with no mock (D4): an expired testnet send's Activity row drops "refund pending" from its second line
    and spoken label (both fall back to the row's usual ones; the chip still says "Expired"); its card guide drops
    "Refund pending on {src}, to {who}.".
- **P7-01 Option A**: "Check first and stop before any wallet prompt, saying: "Deposits on this route are paused
  right now. Nothing was sent."" Shown as the review's error (`sendReviewError`).
- **P7-02 Option A**: "Show the app's own sentence: "This app could not check the bridge on this network. Nothing
  was sent."" Same place.
- Nothing else a user sees changes. `OWNER-ASKS.md` §1 asks whether cross-chain sends should get P7-01 too.

## Outcome & Quality Bar

- Every testnet surface of a Base Sepolia send says who fills it and promises no refund; mainnet renders as before,
  proven by a mainnet control in each module that gains a network branch.
- A paused route or a failed check shows its sentence with no wallet request (no Aztec grant, no seal, no approval,
  no signature), no permission screen and no "declined" banner. A check whose reads answer and match never shows it.

Good enough: deletions only on the Activity row; no new browser cell (D3).

## Architecture & Implementation

- **Copy**: strings swap in place. The review keys its testnet lines on `figures.fixed` (today's set: off mainnet
  every Across route is fixed terms) and its Refund row on `IS_MAINNET && refundWait`. The stepper's fixed branch is
  testnet-only by construction. `expiredCopy` and the Activity expired cases gain an `IS_MAINNET` branch; mainnet
  keeps today's strings. Comments that say "manual fill" or a testnet refund are corrected (`crosschain-figures.ts`,
  `crosschain-steps.ts`, `crosschain-outcome.ts`, `crosschain-activity.ts`, `useActivityFeed.ts:54`).
- **Gate**: `useSend` gains `check(plan): Promise<string | null>`. It runs `bridgeNetwork(reads)`, then
  `assertDepositsOpen(net, reads, plan.intent)`, on the send's own reads (one helper, shared with `executeSend`).
  `paused` → DEPOSITS_PAUSED; `wrong-chain` → today's `wrongChainCopy`; any other throw → BRIDGE_UNCHECKED; pass →
  null. It logs at most the error code: the `[bridge:send]` log admits no addresses.
- `assertDepositsOpen` is the SDK's private `assertOpen` (`l1-deposit.ts:92-96`), renamed and exported through the
  workspace-only `@unleashed/sdk/internal` (`pack-check.ts:120-125`). The SDK owns which contract gates a deposit
  (the fuel gate on a network without a token bridge), so the app does not copy `assertExitsOpen`'s direct read.
- `SendWizard.preflight` calls `sendFlow.check` first for an Ethereum send (not cross-chain, not an exit), under the
  existing `preflighting` hold. Once it returns, the snapshot guard (`reviewed === snapshot`, step 2, same account)
  runs before anything else: a superseded review neither sends nor shows a refusal, on every intent, including the
  ones that today return true without a read. A refusal sets `sendFlow.error`, resets `grantState` to idle (an
  earlier attempt's "declined" must not stand beside it) and returns false: `runSend` never starts, so no permit
  screen, no grant, and the review stays.
- `depositPlanOf` drops `pauseCheck: false`: `depositL1` reads the pause again before its first persist, so a pause
  landing during the grant prompt still stops before the seal and the Ethereum prompts. `appFailureOf` maps `paused`
  to DEPOSITS_PAUSED. Both sentences are constants beside `appFailureOf`.
- **Not taken**: (a) only dropping `pauseCheck: false`: the grant prompt (`useSend.ts:501`) precedes it. (b) the gate
  inside `performSend`: the wizard raises the permit screen (`SendWizard.vue:1317-1325`) before `send` runs and marks
  any failed send with an ungranted token as declined (`:1345`), so both would lie on a refusal.

## Security & Adversarial Considerations

- The checks compare answers from the wallet's L1 client and the app's Aztec node; they do not authenticate them.
  A thrown read or a detected mismatch fails closed; a convincing false answer stays inside the existing RPC trust
  boundary. A chain switch during the reads fails closed too: `performSend` re-asserts the chain before the grant.
- No raw node text or mismatch detail reaches the screen or the log. No new dependency, credential, persistence or
  contract change; no crypto touched.

## Assumptions

### Facts (verified at a111e8a)

1. #40's four strings are live (`CrossChainReview.vue:92`, `:122`; `crosschain-steps.ts:98`, `:255`). #40 misses the
   Details Refund row (`CrossChainReview.vue:237-240`, both networks), the expired card (`crosschain-outcome.ts:136-158`,
   no network branch on its refund fields) and the Activity row and guide (`crosschain-activity.ts:119-124`, `:143`, `:258`).
2. Off mainnet every Across route is fixed terms with `TESTNET_FILLER` as exclusive relayer
   (`useCrossChainRoute.ts:296-301`, `:355`); `selfBuiltTerms` throws on mainnet (`across-self-built.ts:53`).
3. The SDK's pause pre-check reads `depositsPaused()` on the factory, or the fuel gate without a token bridge
   (`l1-deposit.ts:92-96`), before the first persist; the app turns it off (`useSend.ts:681`).
4. The grant prompt runs before both checks (`useSend.ts:501` vs `:646`, `:681`), and the wizard shows the permit
   screen before that (`SendWizard.vue:1317-1325`). So the lane brief's "turning on the pre-check stops before any
   wallet prompt" holds only for a token already granted.
5. A node failure reaches the review as raw text, a mismatch as "the deployed contracts are not this release's
   network: …" (`network.ts:92`, `:126`; `useSend.ts:805-815`; `ReviewStep.vue:172`).
6. A passed check is cached for the session (`bridge-generation.ts:82-88`). The mainnet manifest is a placeholder
   today, so the gate runs only on testnet until mainnet's bridge ships.
7. The cross-chain send has neither check (recon § Collisions).

### Inferences

- "Across's testnet refunds no unfilled deposit" rests on the repo's record (`across-self-built.ts:6`, #34). The
  new copy promises nothing either way.

### Asks (working assumption in force)

- A1: P7-01 covers the Ethereum send only (its record says "the wallet still prompts twice"). The cross-chain case
  is `OWNER-ASKS.md` §1; nothing ships for it.

## Phase P1 (arc a1): the testnet wording

Change the copy files. Update the assertions in `CrossChainReview.test.ts`, `crosschain-steps.test.ts`,
`CrossChainOutcome.test.ts`, `BridgeJournalCard.crosschain.test.ts`, `useActivityFeed.test.ts`, `ActivityRow.test.ts`.
Add mainnet controls (mock `IS_MAINNET` as `BridgeFooter.test.ts:8-15` does): the review keeps its Refund row and
"About N min" line; the expired card keeps "Refund pending on {src}" and its Refund row; the Activity row keeps
"refund pending". The testnet outcome test asserts no Refund row beside the Sent row.

**Gate**: `bun run lint && bun run typecheck:all && bun run test:tools` exit 0 (lint, typecheck, unit).

## Phase P2 (arc a1): the refusals before any prompt

Export `assertDepositsOpen`; add `check`; call it from `preflight`; drop `pauseCheck: false`; map `paused`.

- `useSend.test.ts`: stub `assertDepositsOpen` in its `@unleashed/sdk/internal` mock. `check` over a paused route, a
  raw `Error("fetch failed")`, an `invalid-network` refusal, a `wrong-chain` refusal and a pass (null); `depositL1`
  throwing `paused` reads DEPOSITS_PAUSED; the plan pin loses `pauseCheck`.
- `packages/sdk/test/persist-order.test.ts`: a paused factory refuses `paused`, submission `none`, with no persist
  and an empty event log.
- `apps/tools/tests/e2e/send-smoke.test.ts`: stub `assertDepositsOpen` likewise. One `it.each` over both refusals
  with an ungranted token: the sentence shows; no declined banner; no permit screen; zero `retryCapabilities` and
  `depositL1` calls; no journal record. Extend the declined-grant case with a retry onto a paused route: only the
  sentence shows. The existing success cases are the control.
- `SendWizard.test.ts` (its `useSend` mock gains `check`): a public token+gas review whose `check` is held while the
  account switches sends nothing and shows no refusal, for a pass and for a refusal.

**Gate**: `bun run lint && bun run typecheck:all && bun run test:all && bun run --cwd apps/tools test:e2e` exit 0
(lint, typecheck, unit, jsdom smoke).

## Phase P3 (arc a1): full gates, browser cells, after shots

1. Run `bun run audit:tools`.
2. Run `bun run e2e:tools -- specs/deposit-token.spec.ts specs/deposit-token-gas.spec.ts specs/deposit-gas-only.spec.ts specs/deposit-gas-lifi.spec.ts specs/deposit-crosschain.spec.ts specs/registration-retry.spec.ts specs/activity.spec.ts`
   at retry 0, with `PLAYWRIGHT_BROWSERS_PATH` unset. Record the wall-clock. A SIGBUS counts as the host: rerun that
   file alone and say so.
3. Take after shots with a throwaway `specs/zz-send-copy-shots.spec.ts` through `scripts/e2e/agent.sh`; never commit
   it. Use the shots lead's method: the display-only label change in `apps/tools/src/lib/network.ts`, reverted after.
   Chromium, 1280×900, full page, light and dark: the review (Details closed, then open), the Bridge step, the strip,
   the expired card, that send's Activity row, the paused sentence with an ungranted token (factory
   `setPaused(true, false)`, unpaused in `finally`), the unchecked sentence (abort `node_getNodeInfo` with
   `page.route`). Save to `implementations-plan/send-copy-1/design/` (gitignored).

**Gate**: both commands exit 0; every shot exists; `git status` shows no `zz-*` spec and no `network.ts` change.

## Decision ledger

- D1 the gate runs at confirm, in the wizard's preflight, through a `useSend` method on the SDK's own read (Codex
  C1, C3; Opus 1, 4, 6). Rejected: the gate inside `performSend`; only dropping `pauseCheck: false`.
- D2 `depositL1` keeps its own pause read: one `eth_call` covers a pause that lands during the grant prompt.
- D3 no new browser cell: the SDK test proves the gate read, the jsdom smoke proves the wizard through the real app,
  unit tests prove copy and mapping. A cell would add about 30 s and prove nothing more.
- D4 strings exactly as the B mocks; the Activity deletions are "drop every refund promise" itself and add no words.
- D5 the session cache stays (Codex C2 rejected): a node lost after a passed check equals one lost a second after the
  click; the deposit is safe and the claim waits for the node, as today. Close-out files a closed `known-limit` issue.
- D6 a read that fails on the first send of a session shows the P7-02 sentence (Opus 3). That is the sentence's
  meaning, not a fault: no retry is added. The Outcome line says "whose reads answer and match".

## Audit verdicts

- Codex round 1 (gpt-6.1-sol, high): conditional approve. Accepted C1, C3, C4, network branches with mainnet
  controls, no raw-cause log, no calendar date. Rejected C2 (D5). Detail: `lessons/phase-0.md`.
- Opus Plan critique (on the round-1 draft): conditional approve. 1, 4, 5, 6 resolved by D1 and the log rule; 2 by
  the mainnet controls; 3 by D6; nits taken (explicit stubs, "empty event log", `useActivityFeed.ts:54`). The
  optional `generation()` call is not taken: a placeholder network never reaches the send (`SendView`).
- Codex final fresh pass (gpt-6.1-sol, high): conditional approve; both conditions adopted (F1 the snapshot guard
  after the gate on every intent, F2 reset a stale "declined" on refusal, each with its test). D5, D6 upheld.
  Resumed on the revision: **approve**.
- Implementation, Codex fix loop (gpt-6.1-sol, high): round 1, one material finding (a receipt deferred by the
  check's hold replaced the review after its guard; fixed with its regression); round 2, **no material findings**.
  Opus beside round 1: no material findings, nits taken. Detail: `lessons/phase-1.md`.

## Delivery

Single arc a1 = P1–P3 on `worktree-send-copy-1` (it holds the plan commit). Merge `origin/main` first. One PR against
`main` after the local gates and the Codex loop: `feat(tools): name the testnet relayer and refuse paused or unchecked sends early`.
Body: what and why; the UI impact lines quoted; the gates with outcomes and the browser wall-clock; the shots by name
(the orchestrator attaches them); `Closes #40`; `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Post-implementation

1. Codex fix loop: `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol` on
   `git diff a111e8a...HEAD -- . ':!implementations-plan'`, with this plan, the adversarial ask, AGENTS.md § Code
   comments, and verbatim: "Report bugs and small, targeted improvements only. Do not propose speculative
   abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real
   problem. If code works and is clear, leave it alone." Every prompt carries the `.env` and `~/.agents/orchy/`
   lines. Verify each finding in the tree, fix, commit, `resume-codex.sh` with the fix diff; repeat until a round
   has no material finding; at three rounds stop and surface. A fix that adds state, a lifecycle, a protocol, a
   recovery policy or a public contract stops for approval. One Opus `general-purpose` review runs beside round 1.
   Record rounds here and in `lessons/phase-1.md`.
2. Rerun P3 steps 1–2 on the final head; push; open the PR; `gh pr checks <n> --watch` once, bounded.
3. Close-out as the PR's final commits: `## Outcome` after the front matter (status, shipped, `Known limits:`,
   `Open items:`, seeds retired; no calendar date); promote general lessons to `lessons.md` (8 KiB, dedupe); file
   D5 and any open work as issues; delete `STATUS.md`; `git mv` this folder into `implementations-plan/archive/` in
   its own commit with one line in `archive/index.md`. No `index.md` row.
4. Merging is the orchestrator's. After it: `agent-worktree done send-copy-1 --merged`; relay any refusal.

## Seeds (draft; run none, the orchestrator owns implementation sessions)

- `/goal` P1–P3 ✓ in plan.md with each gate's output in the transcript; the Codex loop converged (a resumed round
  with no material finding quoted); the PR is open against main with `Closes #40` and the close-out commits;
  `bun run test:all` and `bun run lint` exit 0.
- `/loop 15m` Drive implementations-plan/send-copy-1 from plan.md and STATUS.md; never merge; surface a red gate
  after three tries.
