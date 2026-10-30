---
plan: journal-2
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: approved by the final Codex pass; awaiting the orchestrator
base: main 1b3b202
budget: "recon: 1 Sonnet explorer; audit: Codex gpt-6.1-sol at high, then a fresh Codex pass; code-review: off"
---

# journal-2: the remaining journal writers under the cross-tab lock

One arc, one PR against `main`: **a1** closes #110. The hub exit's two writes, the engine's `blocked`,
`completedAt` and consume-hash patches, and the startup prune run inside `underJournalLock`, each span reading the
fresh copy. The engine holds the browser's lock adapter from its first call, so the prune is locked although it runs
before the send wiring. Asks: none. Over the 150-line target by about 70: the Post-implementation steps, the seeds
and the ledger are kept whole.

## UI impact

The lane brief's budget: "(none)". No string, state or layout is added. The prune's rows read as gone until its
locked removal, as a discarded row does, so no expired card shows on load (D4); the exit's opening write and a
withdraw's completion keep their in-memory side in the span, so the takeover and the toast behave as today (D1, D2).

## Outcome & Quality Bar

**For whom**: a user with the app open in two tabs while one tab exits, finishes an exit, blocks a token, or loads.

**Excellent**:
- No write of this lane can drop another tab's locked write, such as a filed record holding claim secrets: it
  queues behind that tab's span and lands on its result.
- Every span is one synchronous load → guard → write; none awaits, prompts, reads the network or requests the lock.

**Good enough**: tabs without Web Locks or on an older bundle stay outside the lock (#109); the startup quarantine
keeps its unlocked rewrite (a closed known limit at close-out, D4).

## Architecture & Implementation

**D1, the hub exit (`useHubExit.ts`).** `openExitRecord` becomes `async`: one span holds `addRecord(base)`,
`markSessionLive` and `setRecordStep`, because the span's `reload()` wakes the wizard's watchers before the flow
resumes. `authorizeExit` takes `open: () => Promise<void>` and awaits it on both paths. `onSent` returns
`underJournalLock(() => updateRecord(rec.id, { consumeTxHash: hash }))`; the SDK's `consumeWithdrawal` declares
`onSent?: (txHash: Hex) => void | Promise<void>` and awaits it (`packages/sdk/src/execution/flows.ts`, exported only
through the workspace-only `./internal`), so the hash is stored before the receipt wait, as its TSDoc says.

**D2, the engine's patches (`useBridgeJournal.ts`).** Each becomes `await underJournalLock(() => …)`, its in-memory
side in the span:

| Site | Span body |
|---|---|
| `checkTokenBlock` | `patchRecord(id, { blocked })`, `setRuntime(stale-deployment)` |
| `blockTokenRecords` (async) | selects the token's records from a fresh load, patches and flags each; `attestSendTokenBlocks` awaits it |
| `completeWithdraw` (async) | `updateRecordWhen(id, (c) => !c.completedAt, { completedAt })`; only when written: runtime clear, `receiptRounds`, `lastCompleted` (`foreground` read before any watcher runs), log |
| `runWithdrawConsumeLocked` | the consume hash; the failed-receipt clear with its note |
| `finishSubmittedConsume` | the prior-hash clear with its note |

Callers await `completeWithdraw`. The exit logic is otherwise unchanged.

**D3, the fee ladder.** No change: its `merge` is unreachable in the app and its one live path is already locked
(recon, "Claims that did not hold"); a wrap would nest inside `reconcileFuelConsumed`'s span.

**D4, the startup prune.** `initJournal` keeps `quarantineInvalid` synchronous before the first `reload()`, as
today, so a failed quarantine still stops the shell before any write. It captures one `now`, adds every id
`isPrunable(rec, PRUNE_AFTER_MS, now)` selects to `discarding`, reloads, and requests `void underJournalLock(prune)`:
`pruneCompleted(kv, PRUNE_AFTER_MS, now)`, the ids leave `discarding`, `reload()`. A throw is logged and the ids stay
hidden, since today no expired card shows; storage keeps them and the next load prunes again. bridge-core exports `isPrunable`, which `pruneCompleted` uses, so hide and prune share
one predicate. The `discarding` comment names both removals.

**D5, the lock from the first call.** The engine's default deps (module and `__resetJournalForTests`) carry
`locks: webJournalLocks()`, as `kv` defaults to `localStorage`. `useSend.ts` and `useHubExit.ts` drop their
`locks: webJournalLocks()` lines. Without `navigator.locks` it is `undefined`, as today.

**Rules** (from #107): never wrap `discard`; no span awaits, prompts, reads the network or calls `underJournalLock`;
lock order is record → journal, and no span takes a record lock.

**Not taken.** A locked `patchRecord` inside the engine: callers already in a span would nest. A fire-and-forget
`onSent`: under contention the hash could land after the receipt wait. A call-site wrap of the prune alone: no
adapter exists yet at init. No hiding: an expired card would flash on load (an owner call). The quarantine in the
span: its failure would no longer stop writes, and a write gate is a new lifecycle (ledger R1). `ensureSendJournalDeps`
from the shell: couples the shell to the send wiring.

## Security & Adversarial Considerations

- **Threat model**: one origin's `localStorage`, written only by this app's tabs; no other party triggers the race.
  Storage stays attacker-writable (extensions, devtools); loaders still validate every record.
- **A lost write that drops a claim credential**: each wrapped writer rewrites a whole lane. Unlocked, its load can
  precede another tab's locked filing (claim secrets, a sealed envelope) and its write follow it, so the filed record
  leaves storage after the deposit is sent. Every wrapped site now serializes with every locked writer. The startup
  quarantine does not (D4): plausible but unverified, filed as a closed known limit.
- **A nested acquire that deadlocks**: the lock is not re-entrant; a span returning a nested request holds it
  forever. No new span runs inside another (recon, Nesting); the fee ladder stays unwrapped for this reason (D3).
- **A prune that runs before the lock helper exists**: D5 gives the engine its adapter at module load. Without Web
  Locks the prune is a deferred, unlocked call (#109).
- **Starvation**: spans stay synchronous; Web Locks grant in request order. A frozen holder delays, never loses (#109).
- **Least privilege, crypto, supply chain**: no dependency, credential or primitive added; frozen lockfile.

## Assumptions

**Facts**
- F1: the issue's writers are unlocked on main, except the fee-ladder `merge`, which no app path reaches (recon).
- F2: `initJournal` runs in `AppShell`'s setup, before `SendWizard` wires `locks` (`AppShell.vue:37-38`, `SendWizard.vue:186-187`).
- F3: `underJournalLock` without locks is `Promise.resolve().then(fn)` (`useBridgeJournal.ts:1028-1029`).
- F4: `reload()` hides `discarding` ids (`:314-319`); `discard` uses it for its locked removal (`:624-657`).
- F5: `consumeWithdrawal` calls `onSent` before `waitForTransactionReceipt` and ignores its result (`flows.ts:78-80`).
- F6: `lastCompleted.foreground` is read before the form's watcher releases the takeover (`:963-967`).
- F7: `useBridgeJournal.test.ts` runs in jsdom and `useHubExit.test.ts` in node; neither has `navigator.locks`.
- F8: a throw in `initJournal` fails `AppShell`'s setup (a `defineAsyncComponent` in `App.vue`), so no write follows.

**Inferences**
- I1: as in #107, a pre-flush watcher runs before an awaiting caller resumes from a span that called `reload()`.
  The watcher tests below pin each consequence.

**Asks**: none.

## Phase 1 (arc a1): the remaining writers under the lock

1. Merge `origin/main`; confirm `grep -n "export function underJournalLock" apps/tools/src/composables/useBridgeJournal.ts`.
2. Add `isPrunable` to bridge-core `journal.ts`; use it in `pruneCompleted`.
3. Make D5; drop the two wiring lines; fix the test comments that say the composables wire the locks.
4. Do D4, then D2, then D1 (SDK `onSent` first). Run the touched tests after each file.
5. Add `composables/test/other-tab.ts` (another tab's held load → write of one lane, with a request counter); move
   #107's two lost-write tests onto it.
6. Add the tests below; run the gate. Arm each hold only after the engine is initialised, so the prune's request
   never counts as the write under test. Revert each new test's fix once and see it fail.

Tests (a never-happens with its control in each):
- `useHubExit.test.ts`, over the opening write and the consume hash: while another tab holds the lock, storage is
  unchanged; after release both its record and the exit's write are stored. The opening write also: a pre-flush
  `watch(records)` sees `isSessionLive(id)` on the first tick the row is listed.
- `useBridgeJournal.test.ts`, over `checkTokenBlock`, `blockTokenRecords`, the consume hash, `completeWithdraw` and
  both clears: the same lost-write shape. `completeWithdraw` also: a `completedAt` another tab stored without a
  storage event survives and sets no `lastCompleted`; a pre-flush watcher that releases the foreground on
  `completedAt` still leaves `lastCompleted.foreground` true.
- `useBridgeJournal.test.ts`, the prune: under a held lock, `initJournal` lists the live row and never the expired
  one, and storage is unchanged; after release the expired row is gone and the other tab's record is kept.
- `useBridgeJournal.test.ts`, a prune whose write throws: the expired row stays unlisted, the live row stays listed,
  storage keeps both.
- `useBridgeJournal.test.ts`, D5: with `navigator.locks` stubbed and the engine reset, `initJournal` requests
  `JOURNAL_LOCK` with no `connectJournalDeps`, and the prune runs inside that request.
- `packages/sdk/src/execution/withdraw.test.ts`: `consumeWithdrawal` waits for `onSent` before the receipt wait.

**Validation gate**
- Commands: `bun run --cwd packages/bridge-core test -- src/journal.test.ts`;
  `bun run --cwd packages/sdk test -- src/execution/withdraw.test.ts`;
  `bun run --cwd apps/tools test -- src/composables/useHubExit.test.ts src/composables/useBridgeJournal.test.ts src/composables/useBridgeJournal.stages.test.ts src/composables/useSend.test.ts src/composables/crosschain-deposit-flow.test.ts`;
  `bun run lint`; `bun run typecheck:all`; `bun run test:all`; `bun run audit:tools`;
  `bun run e2e:tools -- specs/exits.spec.ts specs/activity.spec.ts specs/deposit-token.spec.ts` (retries default 0).
- Pass: every command exits 0; the new tests pass; existing tests change only where a write became awaited.
- Layers: typecheck/lint, unit, build, e2e (sandbox). No e2e cell is added: the browser harness drives one tab, and
  the unit tests reach every site.

## Post-implementation

Single-arc plan. While implementing: comments state invariants, never a plan, phase, issue or review; log attempts in
`implementations-plan/journal-2/lessons/phase-1.md`; `agent-worktree status journal-2 "<line>"` at each gate; stop
and reassess after 3 failures on one step.

1. Codex audit, one package: the net diff from the plan commit, this plan, the adversarial ask (a lost write between
   tabs, a nested acquire, an unlocked prune, a watcher that sees a write before its in-memory side), and both rules
   verbatim: *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra
   configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works
   and is clear, leave it alone."* *"Audit the comments for value per character. Flag any comment that narrates what
   the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a
   paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment
   it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be
   few, dense, and exact."* Command: `~/.claude/skills/codex/scripts/run-codex.sh <prompt-file> <worktree> high
   read-only gpt-6.1-sol`. Every prompt carries the two never-read rules (`.env` files, `~/.agents/orchy/`).
2. Fix loop: verify each claim, apply accepted fixes, commit, log the round, resume the session (`resume-codex.sh`).
   A fix that adds persistent state, a lifecycle, a protocol, a recovery policy or a public contract stops for the
   orchestrator. Until a round has nothing material; hard stop at 3 rounds.
3. Delivery: merge `origin/main` (PR #113 edits `useBridgeJournal.ts` and `journal.ts`; read what changed in
   `index.md` and `lessons.md`), rerun the gate, then `gh pr create` against `main`, title
   `fix(tools): write the exit, engine patches and startup prune under the journal lock`. Body: what and why, the
   gate run, `Closes #110`, the fee-ladder claim that did not hold, ending
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Comment on #110 with that claim. Then
   `gh pr checks --watch` in a bounded loop.
4. Close-out as the PR's final commits: `## Outcome` after the front matter (date, status, shipped, dropped,
   `Known limits:`, `Open items:`, seeds retired); file the quarantine known limit (closed, `known-limit`, hypothesis,
   consequence, the unverified interleaving, disposition, reopening condition: a lost write traced to a startup
   quarantine, or quarantine failures seen in the field; dedupe with `gh issue list --state all --search`); promote
   gotchas to `lessons.md` (dedupe, prune, under 8 KiB); delete `STATUS.md`; `git mv implementations-plan/journal-2
   implementations-plan/archive/journal-2` in its own commit; one line in `archive/index.md`; no row in `index.md`.
   Homes: work in this arc → this plan and the PR; outliving work → an issue with a `Record` link; a product call →
   `owner-decision`; an exploitable weakness → a private draft advisory; done or rejected → an Outcome line;
   unsupported conditions or an unverified path left by choice → a closed `known-limit`.
5. Merging is the orchestrator's. Once `git fetch -q origin main && git cat-file -e FETCH_HEAD:implementations-plan/archive/journal-2/plan.md`
   succeeds: `agent-worktree done journal-2 --merged`; relay a refusal, never force.

## Delivery

| Arc | Phases | Stacks on | `/code-review` |
|---|---|---|---|
| a1 + close-out | Phase 1, then the close-out commits | `main` | off |

One branch (`worktree-journal-2`), one PR, plain `gh pr create`. No lanes. #110 → a1. Asks: none.

## Decision ledger

Round 1, Codex (gpt-6.1-sol, high): **reject**, two findings, both verified against the code.

| # | Finding | Label | Settled |
|---|---|---|---|
| R1 | The draft put `quarantineInvalid` in the deferred span with a catch. A failed quarantine would then let a later write drop the invalid entry; today its throw stops the shell first (F8). | demonstrated by trace | accepted: the quarantine stays synchronous; a write gate would be a new lifecycle; its unlocked rewrite becomes a closed known limit |
| R2 | The tests pinned serialization, not the fresh-copy guard or the watcher order. | coverage gap | accepted: the remote-completion, foreground and session-live cases; holds armed after init |
| R3 | F7 wrong for `useHubExit.test.ts` (node). | fact | corrected |
| R4 | One `now` for hide and prune, or a row can cross the window while the lock waits. | plausible | accepted |

Codex agreed with D1 (awaited `onSent`), D3, D5, the hiding, and the shared test helper. Resumed verify pass on the
settlement: **approve**; it asked that the known limit describe an unverified interleaving of supported conditions,
and that the serialization claims exclude the quarantine (both applied).

Final fresh Codex pass (new session): **conditional approve**, one condition, verified (`discard`'s catch unhides,
`:651-655`) and applied: a failed prune keeps its rows hidden instead of restoring them, pinned by a throwing-storage
test. Facts, inferences, D1–D3 and D5 confirmed. Resumed verify pass: **approve** (no regression: hidden ids stay
in storage and in every whole-lane write).

## Seeds (draft; the orchestrator runs the arc)

Recommended: `/goal`, because completion is visible in the transcript.

```
/goal Phase 1 of implementations-plan/journal-2/plan.md is marked ✓, backed by its validation gate (e2e:tools on the three specs included) reported passing in the transcript; LESSONS_FILE=implementations-plan/journal-2/lessons/phase-1.md printed; /code-review NOT run; the Codex fix loop on gpt-6.1-sol converged on the net diff, shown by a resumed pass with no new material findings quoted in the transcript; one PR against main opened only after that (gh pr view output), carrying Closes #110 and the close-out that archived the plan (git show --stat of the archive move); bun run test:all and bun run lint exit 0 in the transcript.
```

```
/loop 15m Drive implementations-plan/journal-2 forward without waiting for input. Each firing: read plan.md and lessons/ (not the chat); if the plan is archived on main, run agent-worktree done journal-2 --merged and stop; if delivered, babysit CI only; else take the next step of Phase 1, run the touched tests after each edit, commit; at the phase's end run its gate, mark ✓, then the Post-implementation section in order. Decide with Codex (gpt-6.1-sol, high); never merge, publish or widen scope. Stop after 5 failures on one step and reassess with Codex.
```

Use exactly one per session; they do not compose.
