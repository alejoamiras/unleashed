---
plan: exit-finish-1
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: a1 built and reviewed (P19-01 A), its PR open; a2 revised for ask60 and audited, awaiting the owner's W1–W5
base: main 7de51e7 (merged into the lane; F1–F4 re-traced, line numbers unchanged)
budget: "recon: 1 Sonnet explorer; code-review: off; Codex gpt-6.1-sol at high"
---

# exit-finish-1: an exit finish follows the transaction that lands

## Summary

The app treats "my receipt wait gave up" as "the finish failed" and clears the recorded hash (#100). Arc a1 reads
what actually mined. Arc a2 keeps a pending finish and watches it by itself, without a wallet, for up to 30 minutes
per page visit, and decides the unprovable cases on evidence (ask60). Recon: [recon.md](recon.md).

**Owner decisions (page 19)**: P19-01 A (a1's two outcomes), P19-02 B (the "still confirming" note; superseded in
part by ask60, below), P19-03 A (today's done card), P19-04 D (store the finish's sender and nonce; prove "didn't go
through"), P19-05 A (spent but unattributable: stay open, Retry), ask60 (keep checking by itself to a stated bound;
the resume control is not labelled Finish). New asks for this revision: W1–W5 in [OWNER-ASKS.md](OWNER-ASKS.md).

## Outcome & Quality Bar

- **For whom**: a user finishing a withdrawal on Ethereum whose finish is slow, sped up or cancelled.
- **Excellent**: (1) a finish that lands under any hash the app saw ends "done" with that transaction's link, with
  no press, while a page is open; (2) a cancelled finish never ends "done"; (3) no card calls a transaction failed
  on missing evidence; (4) the card says what the app is doing and until when, and offers a control only after the
  bound or on evidence.

## Findings (traced; recon.md has the path)

- **F1, F2 (#100)**: H pending past wait B (≈12 min), or sped up to H′ during wait A (viem resolves H′,
  `consumeWithdrawal` returns H) → `false` → H cleared, "failed" → H lands → the re-finish reverts.
- **F3 (new)**: H pending in a resumed wait B; the user cancels it → viem resolves the cancel's receipt (`success`)
  → the exit is marked done while its message is unspent, then pruned after 7 days.
- **F4 (#100 variant)**: H replaced or unknown to the provider → `verifySendConsume` folds the lookup failure into
  "mismatch" → "doesn't match this withdrawal", forever.

**Why a press is needed today (ask60)**, each traced on 7de51e7:

- **P1**: nothing re-arms after wait B; the record waits for a press (`useBridgeJournal.ts:1917`, `:1763`).
- **P2**: every watch read goes through the wallet's EIP-1193 provider (`useHubExit.ts:313-319`, `:276-295`,
  `expectedWitness` `:217`), so it needs an injected wallet provider on Sepolia (`useL1Wallet.ts:38-46`
  checks the provider, not a connected account). The build already pins a wallet-independent
  reader, `readClientFor(NETWORK.l1ChainId)` (`useEthereumReader.ts:18`; testnet `network-targets.ts:91,149`; the
  sandbox build pins anvil, `local-target-loader.ts:107`), which claims (`claim-context.ts:60`) and the token-block
  check (`useSend.ts:187`) use. The Aztec reads use the keyless node (`createAztecNodeClient(NODE_URL)`).
- **P3**: a reload resumes the wait only if the Aztec wallet is connected at boot (`useSend.ts:423-426`), a gate
  that concerns grant prompts, not a prompt-free L1 watch (`resumeActionFor`, `useBridgeJournal.ts:1928`).
- **P4**: a second tab's run gets `HELD_ELSEWHERE` (Web Locks `ifAvailable`, `:941`) and shows "Another tab is
  finishing this exit — try again in a moment." as unknown-outcome with Retry (`:966`); it never takes over.

## Architecture & Implementation

**a1: classify what mined (P19-01 A; unchanged by this revision).** `FinishWait` is `"unconfirmed"` or a
`FinishReceipt` `{ txHash, status: "success" | "reverted", replacedBy?: "same-finish" | "other" }`.

- sdk: `awaitL1Receipt` passes an optional `onReplaced` to viem and throws `L1TransactionRevertedError` with the
  reverted receipt's own hash; `sameWithdrawCall(sent, replacement, portalAbi)` (new, `./internal`): same `to`, both
  decode to `withdraw` with equal arguments; `consumeWithdrawal` returns `mined` with `replacedBy`.
- app: `waitConsumeReceipt` maps to `FinishWait`; `settleFinish(rec, id, sent, observed, failedNote)` replaces both
  inline tails: `other` → clear with today's note; `same-finish` → persist its hash; `success` → complete;
  `reverted` → clear; a hash change without a verdict, or a wait across a `chainChanges` tick, → `"unconfirmed"`.

**a2: the app watches a pending finish by itself (P19-02 B as changed by ask60, P19-03 A, P19-04 D, P19-05 A).**

1. **Reads (P2)**: every watch read uses `reader = readClientFor(NETWORK.l1ChainId) ?? l1.publicClient` behind
   `assertL1Chain`: the receipt wait, `verifySendConsume`, the Outbox root in `expectedWitness`, the Outbox bit and
   P19-04 D's reads. Only a fresh finish (send, simulate, wait A) uses the wallet, as in a1.
2. **Rounds (P1)**: a record with `consumeTxHash` runs one round under the record lock: identity check (three-way:
   `match` remembered per hash for the window; `mismatch` → today's note, stop; `unavailable` → step 3), then
   `awaitL1Receipt(reader, H, { attempts: 2, onReplaced })` (≈3 min), settled by a1's `settleFinish`. Unconfirmed →
   step 3 → `"continue"`. Re-entry is outside the lock, as `runDepositClaimInner` (`bumpGen`/`genOf`), paced to at
   most one round start per 3 minutes, so an inconclusive or failing round cannot burn the window. Wait A's timeout
   and the fresh path's unconfirmed outcome enter the same rounds; wait B goes.
   **Settle guard**: every settle write (clear, replace, complete, the two fields) is conditional on the stored record
   still open and carrying the hash the round observed (`updateRecordWhen`), so a stale round, including one in a
   browser without Web Locks (`journal-locks.ts:23-25`), never touches a newer finish.
3. **Evidence each unconfirmed round**: first ask every pinned endpoint (each URL of `readChainOf`, two on Sepolia)
   for H's receipt and transaction, since viem's `fallback` accepts the first endpoint's `null` and `receiptOrNext`
   only reroutes pruned receipts (`kept-history.ts:83`, `useEthereumReader.ts:36`). A receipt from any endpoint,
   for a hash whose identity matched, goes to `settleFinish`. **H not found** (every endpoint `null` for both):
   with `consumeNonce`/`consumeFrom` stored, read at
   the finalized block B (chain asserted, `chainChanges` unchanged): the sender's nonce past `consumeNonce` and the
   exit unpaid at B → clear H with P19-04 D's copy, Retry, stop. Otherwise the three-state Outbox bit: `spent` →
   P19-05 A's note, Retry, stop; `unknown` or `unspent` → keep H, continue. Records without the fields keep waiting.
4. **Bound: 30 minutes per window**, an in-memory deadline in the record's runtime (`watchUntil`); nothing persisted.
   While it runs, `recordState` reads the record as busy, between rounds too: W1's copy, no primary control, no
   Discard. A window starts at boot, after a fresh finish's wait A, or on a press. Why 30 minutes: it is the deposit soft
   cap the owner already signed, which P19-02 B names; a Sepolia finish at the wallet's fee confirms in minutes,
   and one pending past 30 is underpriced or dropped, which watching cannot change and the wallet can; and each
   watching tab polls the build's public RPCs every 4 s (viem's default at 12 s blocks), the endpoints claims and
   discovery share, so a forgotten tab must not poll forever. **When it passes**: polling stops, H stays, and the
   card shows W2's note with a **Check again** control (W2, W4, W5); a press or a reload opens a new window.
5. **Boot (P3)**: `resumeFinishWatches()` starts a window for every open withdraw with a `consumeTxHash` this tab has
   no window for, called from `ensureHubExitDeps` (SendView is always mounted, `AppShell.vue:126`) after
   `ensureSendJournalDeps` has wired the record lock, and again after each cross-tab `storage` reload (`:438`), so a
   tab that was open before another tab sent H also watches it. No Aztec-wallet gate; `resumeSessionWork` reaching
   the same record is a local duplicate.
6. **Second tab (P4)**: a round that gets `HELD_ELSEWHERE` shows W3 (busy, no control), waits one round's length
   and tries again within its own window, so it takes over when the other tab closes or stops.
7. **P19-04 D's fields**: right after `onSent(H)`, `getTransaction(H)` (reader, then the wallet that broadcast it)
   gives `from` and `nonce`, persisted under the journal lock only while `consumeTxHash` is still H; a failed read
   is retried in later rounds. A `same-finish` replacement keeps them (viem matched it at that sender and nonce);
   any other hash change clears them. Both fields go into `journal.ts` validation and the backup.
8. **Labels**: a withdraw with `consumeTxHash`, idle and not a retry, offers "Check again" on the card, the dock row
   (`openAction` gains `check`) and, after the bound, the full stepper's Confirm phase (W5). No Finish label resumes
   a watch. A record without `consumeTxHash` keeps Finish; error and unknown-outcome keep Retry.

**Cannot be automatic, and why** (the plan's copy claims none of it):

- **A closed page does not watch**: no service worker or server holds the record (background work is the owner's
  call, not this lane's). The next visit opens a new window.
- **Some replacements cannot be followed, even with the page open**: viem detects one only inside a wait that
  fetched the original first (`waitForTransactionReceipt.js:76,127,153`). A replacement that mines while no page
  watches, between two waits, or before a wait's first fetch reads as unconfirmed; if it paid, the record ends in
  P19-05 A (C-11, P9-03: never complete from the node's message position). No copy promises otherwise.
- **No reader pinned and no wallet** (a local build without a sandbox handle): rounds cannot read; the watch does
  not start and the card shows the idle "Check again" state with no auto-check copy.
- **Discard waits for the window**: it is hidden while the app checks (today it is hidden for wait B's 12 minutes).

**Signed decisions this revision changes**: **P19-02 B** — its note and its "Press Finish" control are replaced by
W1 (while watching: no control) and W2 (after the bound: new note, Check again). **P19-03 A, P19-04 D, P19-05 A**:
words and controls unchanged; they can now appear without a press, from a background watch, with no wallet.

**a1's files**: a2 changes `useHubExit.ts`, `useBridgeJournal.ts` and `flows.ts`, which a1 also changes; it branches
from `main` after a1 merges, so a1's scope, files and approval stand.

**File-level change map**

| Arc | Files |
|---|---|
| a1 | sdk `execution/flows.ts`, `execution/l1-receipt.ts`, `internal.ts`; app `composables/useHubExit.ts`, `composables/useBridgeJournal.ts` |
| a2 | the a1 files; sdk `isOutboxMessageConsumed` (three states, optional block); `lib/record-policy.ts`, `lib/bridge-steps.ts`, `ActivityRow.vue`, `BridgeJournalCard.vue`, `BridgeStepper.vue`/`BridgePhaseRail.vue` copy and control; `packages/bridge-core/src/journal.ts` + `backup.ts` (two fields) |

**Alternatives not taken**: watch for the tab's life (polls forgotten tabs forever; W2 offers it); persist the window
(a stored deadline is state the bound does not need); a blocking lock request for the second tab (a new lock mode for
one card); drop the SDK's wait (scripts need it); an L1 log scan for replacements; complete from the Outbox read.

## Security & Adversarial Considerations

- **Trust boundary moves, as claims already did**: the watch's L1 reads come from the build's pinned RPCs (testnet:
  publicnode, ethpandaops, behind `fallback` with `receiptOrNext`; no reader on mainnet, which ships a placeholder
  with no exits) instead of the wallet's provider. A lying reader can complete a record (as a lying wallet provider
  can today), hold one open, or fake P19-04 D's nonce and cost one reverted re-finish; it cannot move funds.
- **Completion evidence**: a receipt of the recorded hash, or of a replacement viem found at its nonce that
  `sameWithdrawCall` accepts. The Outbox bit never completes; a lying node can hold a record open, never close one.
- **Load**: one paced round loop per record per tab, bounded at 30 minutes; a held round reads nothing; the
  not-found probe adds one request per pinned endpoint.
- **Residues**: twin exits (#97); offline replacement (above, a `known-limit` issue). Writes stay under
  `underJournalLock`; the record lock spans each round. No crypto, privilege or dependency change.

## Assumptions

- **Facts** (with P1–P4 above): (1) viem 2.57.1 resolves a replacement's receipt for every reason, once it
  fetched the original (`waitForTransactionReceipt.js:127-203`). (2) `waitConsumeReceipt` and `verifySendConsume`
  fold every throw into `false` (`useHubExit.ts:295`, `:313-319`). (3) `./internal` is workspace-only. (4) C-11
  (GHSA-5759-977m-gjx3) is published. (5) `isOutboxMessageConsumed` answers `false` for a missing or other first message and a missing
  witness, and throws on a failed RPC (`flows.ts:121-139`). (6) viem calls `onReplaced` with `repriced` only when
  `to`, `value` and `input` match, before it resolves. (7) Deposit rounds re-enter outside the lock after
  `INTER_ROUND_MS` = 100 ms and stop at `RECEIPT_MAX_ROUNDS` with a note and no attention (`:986-988`, `:1661`).
  (8) viem polls every `min(max(blockTime/2, 500), 4000)` ms, 4 s at the default 12 s. (9) The mainnet build has
  no node, no wallet transport and `readRpcUrls: {}` (`network-targets.ts:175-188`).
- **Inferences**: an honest RPC answers reads pinned to a finalized block from that block's state, whichever backend
  serves them (P19-04 D's coherence rests on this).

## Phases

### Phase 1 (a1): classify what mined ☑ (approved: P19-01 A)

1. In the SDK, add `onReplaced` to `awaitL1Receipt`, `sameWithdrawCall`, `mined` to `consumeWithdrawal`, and the
   revert error with its hash; extend `withdraw.test.ts` and `l1-receipt.test.ts`.
2. Map `waitConsumeReceipt` to `FinishWait`; pass `mined` through `runSendConsume`.
3. Add `settleFinish`; route the fresh tail and the resume tail through it; update the stage, lock and hub-exit tests.

Tests: a sped-up replacement (and a re-encoded same call) completes with its hash and toast; a wait across a chain
change stays unconfirmed; F3 (fails on the base); a fresh finish cancelled during wait A clears at once; the recorded
hash landing completes (control); viem's real wait over a scripted transport maps receipt, revert, timeout and each
replacement; `sameWithdrawCall` refuses another target, function or arguments.

**Gate**: `bun run lint`, `bun run typecheck:all`, `bun run test:all`, `bun run audit:tools` exit 0;
`bun run e2e:tools -- specs/exits.spec.ts --retries=0` green (cells 27, 28, 31b, 31c use the new tails).

**As built (deviations, tree over plan)**:

- **Chain-change guard on replacements only**: `judged` (`useHubExit.ts`) makes a verdict under another hash
  `unconfirmed` across a tick, never the sent hash's own receipt, which commits to its chain id. Read literally, the
  rule would clear a landed finish whenever the wallet changed chains mid-wait, since a1's `unconfirmed` still clears.
- **Fresh tail**: settles wait A's verdict; only an `unconfirmed` one falls back to the recorded hash's own wait.
- **`replacedByOf`** (sdk `./internal`, beside `sameWithdrawCall`): a verdict only when the receipt is another
  transaction's. viem also reports the sent transaction as its own `repriced` replacement when a receipt read lags the
  block holding it (reproduced over a scripted transport). The SDK and the app share it.
- **The fresh tick** restarts at `onStage("consuming")`, just before the chain-asserted send, and only while the
  captured account is still connected. `useL1Wallet.disconnect` counts as a tick, since no `chainChanged` is heard
  after it (a file outside the map). A receipt with no known status is `unconfirmed`.
- **Tests**: the scripted-chain cases drive the real `awaitL1Receipt` and viem wait through the exported
  `waitFinishReceipt`; the hub-exit test no longer replaces `awaitL1Receipt`.
- **Residue, closed by a2 step 1**: a resumed wait in a page whose L1 wallet never connected has no `chainChanged`
  listener. A wrong-chain completion then still needs the user's own identical `withdraw` to the same address at the
  same nonce on another chain (needs unsupported conditions); a2's pinned Sepolia reader removes the case.

### Phase 2 (a2): the app watches a pending finish ☐ (starts on the owner's W1–W5)

1. Reader switch; three-state identity and Outbox bit; the two fields with their capture and backup.
2. The paced round loop, the window and the evidence step; the settle guard; `resumeFinishWatches` (boot and
   `storage`); the held-elsewhere round.
3. Labels and copy per W1–W5; screenshot each state at 1280 and 390 px, light.

Tests (engine, fake timers, scripted reader): a boot with no wallet connected watches a stored H and completes when
its receipt appears (fails on the base); inconclusive and failing rounds still last 30 minutes, then stop with W2
and keep H, and no control shows before then, between rounds included; a press opens a new window; the first endpoint
answering pending or `null` while the second holds H's receipt completes the record; a stale round (no locks) leaves a newer hash alone; a tab that
sees H arrive by `storage` starts its window; P19-04 D clears on the finalized proof and keeps H on a chain switch or a failed read; spent → P19-05 A, stops;
unknown → continues; a held round shows W3, then takes over when the lock frees; the fields survive a backup round
trip and clear on another-call replacement; `recordState`/dock/stepper show Check again only on an idle stored hash
(Finish without one, Retry on error). No new e2e scenario: holding a transaction needs anvil's automine off, which
every spec on the shard's chain would feel; viem's real wait and the engine's rounds run in unit tests.

**Gate**: Phase 1's commands, then `bun run e2e:tools -- specs/exits.spec.ts specs/recovery.spec.ts --retries=0`
(the exit cells now read receipts through the sandbox's pinned anvil reader).

## UI impact

- Signed: P19-01 A, P19-03 A, P19-04 D, P19-05 A as quoted in [OWNER-ASKS.md](OWNER-ASKS.md); P19-02 B superseded
  in part. Open: W1 (auto-check copy), W2 (after-bound note, label, bound), W3 (another tab), W4 (dock label),
  W5 (the wizard's stepper). Mocks `g1`–`g4`, `h1`–`h2` at 1280 and 390 px.

## Issues and asks

- #100: a1 `Refs #100`; a2 `Closes #100` and `Delivers ask60`, filing the offline-replacement residue as a closed
  `known-limit` issue. F3: fixed in a1, named in its PR.
- Out of scope: deposit legs read `awaitL1Receipt` too (a cancelled leg may resolve as the cancel; unverified);
  watching with no page open; the exit fee path.

## Delivery

One PR per arc against `main`, after its gate and its Codex loop converge; merge `origin/main` first. a1:
`fix(tools): follow an exit finish the wallet replaced, and never finish one it cancelled`. a2: `fix(tools): keep
watching a pending exit finish by itself, and decide it on evidence`, branched from `main` after a1 merges, with the
close-out. Release steps: none.

## Post-implementation (per arc)

1. Codex `run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol` on the arc diff (plan, adversarial ask,
   no-over-engineering and comment rules); fix and resume until nothing material; three rounds unconverged stop it.
2. PR per Delivery; `gh pr checks --watch`. a2's close-out: Outcome, lessons, open items filed, `git mv` to
   `archive/` in its own commit, `archive/index.md`; after merge `agent-worktree done exit-finish-1 --merged`.

## Audit

| Round | Verdict | Findings → disposition |
|---|---|---|
| Session 1: Codex 1, final, two resumed (gpt-6.1-sol, high) | reject ×3, then **approve** | R1–R6, N1–N2, V1–V2, all verified and folded in (three-state Outbox read, three-way identity, trust statement, `onReplaced` verdicts, `sameWithdrawCall`, finalized-block reads); [lessons/phase-0.md](lessons/phase-0.md). |
| Revision for ask60, Codex 1 (fresh, gpt-6.1-sol, high) | reject | X1 ten rounds are not 30 minutes when rounds end early → in-memory deadline, paced rounds. X2 the control showed between rounds → the window reads busy throughout. X3 a lagging first endpoint's `null` hid H → "not found" asks every pinned endpoint. X4 "press first, then speed up" overpromised (gaps between waits) → W2(b) reworded, limit widened. X5 a stale round could clear a newer hash without Web Locks → hash-conditional settle writes. X6 a tab open before H was sent never watched it → windows armed on `storage` reloads. P2 wording: a provider, not a connected account. All verified in the tree and accepted. |
| Codex 1, resumed (verification) | reject | X1, X2, X4, X5, X6 closed. X3 incomplete: a receipt only the second endpoint holds was still ignored → the per-endpoint probe asks for H's receipt too and settles what it finds. Verified and accepted. |
| Codex 1, resumed (last verification) | **approve** | X3 closed; no new material defect. |
| a1 diff, Codex round 1 (fresh, gpt-6.1-sol, high), with an Opus diff review beside it | reject | Codex: a disconnect drops the `chainChanged` listener without a tick → `disconnect()` counts one. Opus: A viem self-reports a lagging own receipt as `repriced`, so a tick cleared a landed finish → `replacedByOf`; B tick taken before proving → re-taken before the send; C null status read as success → `unconfirmed`; gaps: reverted `same-finish` row, lagging-receipt row. All traced and accepted. |
| a1, Codex round 2 (resumed) | reject | The pre-send reset erased a disconnect during proving → reset only while the account is connected (the send is unchanged: refusing it would change what the product does). |
| a1, Codex round 3 (resumed) | **approve** | Fixes verified; no new material defect. |

Size: about 250 lines against light's 150; the overrun is P1–P4 and the a2 detail the revision had to state (bound,
why, what follows, what cannot be automatic, the signed decisions it changes) and this ledger.

## Seeds (draft, not run)

- `/goal Phase 1 ✓ in implementations-plan/exit-finish-1/plan.md with its gate output in the transcript, the Codex loop converged, and the a1 PR open with green checks.`
- `/loop 15m Drive implementations-plan/exit-finish-1 Phase 1 and its post-implementation steps; start Phase 2 only with the owner's W1–W5.`
