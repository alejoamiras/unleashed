---
plan: journal-1
tier: mid
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: plan complete; awaiting the orchestrator's approval
base: main 97e100e; builds on PR #88 (sdk-1-a6-claims), which must be on main first
budget: "recon: 2 Sonnet explorers; audit: Codex gpt-6.1-sol at high plus one Opus Plan critique, then a fresh Codex pass; code-review: off"
---

# journal-1: one record and one set of claim secrets per signed send; the send's writes under the journal lock

Over the mid target (350 lines) by about fifteen: the two audit rounds and the final pass are kept whole.

One arc, one PR against `main`: **a1** closes #65 and #80. A cross-chain route is offered for one send only: once a
route is handed to a send, the amount step quotes that ask again, so the next send draws fresh secrets and a fresh
LI.FI id and files its own record. The cross-chain filing becomes insert-only. Every journal write of both send flows,
and of the restore that shares their filing, runs inside `underJournalLock`. Asks: none.

## UI impact

The lane brief's budget: "Fresh claim material per send changes nothing a person sees." This plan stays inside it:

- A second send of one ask re-prices: the amount step shows its existing loading line, then figures that may differ
  from the first send's. That is how every ask is priced today; no string, state or layout is added. It is the
  fresh claim material the brief names; `OWNER-ASKS.md` notes it so the orchestrator can say otherwise.
- The step strip does not change: the review keeps the answer it froze until the amount step shows again (D1).
- The insert-only filing refuses an id the journal still holds. The wizard reaches that only when a discard's
  removal failed and restored the row (F6); it then shows the existing expired state through the existing
  `ROUTE_EXPIRED` refusal ("This quote expired." / "Refresh quote" on mainnet, "These terms expired." / "Rebuild
  terms" on testnet). No new string or state.
- The stepper takes over at filing exactly as today: the filing span also marks the record this session's (D3).
- A restore whose record another tab filed between the restore's check and its write ends as it does today (the
  restore reports success), but keeps the stored copy instead of overwriting it.

## Outcome & Quality Bar

**For whom**: a user who sends from a source chain twice in a row (same token, same amount, inside a minute), and
one who has the app open in two tabs while a send, a restore and a claim write the journal.

**Excellent**:
- Two back-to-back sends of one ask leave two records with different ids, claim secrets, `lifiTxId`s and
  `srcTxHash`es; both cards show after a reload.
- A send's filing never replaces a stored record: the first send's source facts and outcome survive the second.
- While another tab holds the journal lock for a guarded write, a send's write waits and then lands on that tab's
  write: neither is lost. This holds among writers that take the lock; the rest are an open issue.
- A send's write holds the journal lock only for one synchronous span: no prompt, read or claim runs inside it, and
  requests queue in order, so the claim's guarded writes cannot be overtaken indefinitely.

**Good enough**: the exit flow, the fee-ladder `merge`, engine-internal patches and the startup prune keep their
unlocked writes (Out of scope, one open issue at close-out).

## Architecture & Implementation

### D1: a quoted route is offered for one send (#65's cause)

`useCrossChainSend` re-offers an answer whose claim material a send already used: its watcher requotes only when
`key !== asked`, and nothing resets `asked`. The handle that decides which answer the wizard sees remembers the route
it handed to a send, and its watcher quotes again when the amount step would offer that route:

```ts
/** The route last handed to a send: its secrets and LI.FI id fund one deposit only. */
let spent: CrossChainRoute | null = null
// the watcher on [key, quoting]:
if (on && k && (k !== asked.value || (spent !== null && route.value === spent))) requote()
// send:
send: (q, r, token, client) => { spent = r; return sendOn(sources(), q, r, token, client) }
```

The mark is lazy on purpose: resetting `asked` at send time would empty `quoted` while the review is up, so
`amountReady` drops and the step strip loses the amount step's "done" (`SendWizard.vue:621-627`). With the lazy
mark the review is untouched. When the amount step shows again with the ask (`quoting` turns true, or the key
returns), the pre-flush watcher requotes before the step renders, and `latestQuote.ask` clears the spent answer
synchronously. `quoteCrossChainRoute` draws fresh secrets and a fresh `lifiTxId` per call. The frozen
review keeps its own `FrozenRoute`, so a retry after an attempt that left nothing (a refused prompt discards the
record and returns the wizard to the review, by design) still signs what the user read. No watcher stands the review
down on `xc` (the invalidation list at `SendWizard.vue:1000-1013` watches the Ethereum-origin `routeOutcome`). D1
does not cover a frozen review re-signed after its filed record was discarded: see Security, S1.

### D2: insert-only cross-chain filing (#65's storage invariant)

- `packages/bridge-core/src/journal.ts`: `insertRecord(kv, rec): boolean`. One synchronous load, check, write span.
  It returns `false`, writing nothing, when any lane holds `rec.id` (the `locate` check `rekeyRecordWhen` makes).
  Else it runs `assertStorable`, appends and writes the lane, and returns `true`. Storage failures throw. TSDoc says
  cross-tab exclusion is the caller's (`underJournalLock`).
- `useBridgeJournal.ts` `addRecordVerified(rec): boolean` and `addCrossChainRecordVerified(rec): boolean`:
  `insertRecord`, then the existing read-back (throws on a failed write, as today); `false` when the id is held.
  Their only callers are the two send flows and the restore's `track`.
- `crosschain-deposit-flow.ts` `journalAndSend`: the filing span (D3) returns `false` on a held id, and the flow
  throws `ROUTE_EXPIRED` **before the `try`**: inside it, `settleFailedSend` → `endUnsent` → `discard` would delete
  the record that holds the id. `sendOn` maps the throw to the `expired` refusal.
- `useSend.ts` `openRow`: a `false` throws the existing "Could not persist the bridge record — aborting before the
  deposit" error (never expected: the id is the SDK's fresh claim hash or a fresh provisional id).
- `useBridgeBackup.ts`: `track` becomes `async`; both branches file under the lock; a `false` keeps the stored record
  and returns as today (only a concurrent restore of the same bridge, from any of its backups, can hold the id, so
  the journal already tracks it); `restoreFile` awaits `track` before `log` and return. No new outcome is shown.
- `upsertRecord` (used by `addRecord`) and `rekeyJournalRecord` keep their semantics.

### D3: the send flows' writes under the journal lock (#80)

Each write becomes `await underJournalLock(() => <the same engine call>)`, the form #88 uses for discovery. The body
stays a synchronous engine call. Names are #88's tree (`useSend.ts` line numbers from #88's branch).

| File | Write | Change |
|---|---|---|
| `useSend.ts` `openRow` (:564) | `addRecordVerified`, then `markSessionLive`, `markGrantOutcome` | one span: file, then the in-memory marks |
| `useSend.ts` `persistSend` (:542) | `updateRecord(id, factsOf(rowOf(...), record))` | wrap; compute inside the span from the fresh copy: `updateRecordWhen(id, () => true, (current) => factsOf(current, record))` |
| `useSend.ts` `nameAtSignature` (:608) | `rekeyJournalRecord` | wrap; `async`, awaited in `signTypedData` before the wallet is asked; the renamed record is built inside the span from the persisted provisional row (`currentRecord(known)`), so a field another tab set there (`blocked`) survives |
| `useSend.ts` `afterReceipt` (:731) | `updateRecord({ token })` | wrap |
| `deposit-flow.ts` `sealPrivateRecord` | `updateRecord({ sealedEnvelope, sealerL1 })` | wrap; the read-back after the await |
| `crosschain-deposit-flow.ts` | filing (D2) with `markSessionLive` and `setRecordStep("preparing-source")` in the same span; seal (:252), `srcTxHash`/`srcBatchId` (:295, :320, :331), `approveTxHash` (:357), `not-sent` (:375) | wrap; the route patches already compute from the fresh copy |
| `useBridgeBackup.ts` `track` | both adds | wrap (D2) |

The session marks go inside the filing span because the span's `reload()` lets the wizard's pre-flush watcher see
the new row before the awaiting flow resumes. `adoptRunRecord` adopts only a session-live row
(`SendWizard.vue:1170-1175`), so a mark after the await would leave the next prompts over the review, and a record
kept after a failed deposit would never be adopted (Opus, demonstrated by trace).

The failure bookkeeping becomes an awaited chain: `endUnsent` and the cross-chain `settleFailedSend` turn `async`;
`journalAndSend`'s `catch` awaits `settleFailedSend` before it rethrows the original error; a bookkeeping failure is
logged and never replaces that error (today's `try`/`catch` stays around the awaited body). `approvalsUnanswered`
still clears only after the `approveTxHash` write.

Rules: never wrap `discard` (on #88 it takes the journal lock itself); nothing inside a span awaits, prompts or reads
the network, and no span requests the lock again (a nested request only queues; awaiting it would deadlock).

When another tab discarded the provisional row first, `nameAtSignature` keeps today's semantics: the rekey still files
the named record. That record carries the claim material the signature is about to commit to; refusing it would be a
visible abort on a race nobody can cause on purpose, and filing it loses nothing (#88's locked discard and this
rekey serialize, and either order leaves the named record).

### Data and control flow (cross-chain, after the change)

1. Amount step: `requote` → route R1 (secrets S1, `lifiTxId` L1). The review freezes R1.
2. Confirm: `xc.send(R1)` marks R1 spent; `journalAndSend` inserts S1 and marks it session-live in one span; the
   seal, approvals and source send each journal under the lock.
3. New send, same ask: the amount step would offer spent R1, so R2 (S2, L2) is quoted before it renders; its
   confirm inserts S2 beside S1. Both are listed and watched.

### Trade-offs and alternatives not taken

- **Outline B, refuse-first** (keep the cache, refuse the second send at the held id with a new sentence): a visible
  refusal on an ordinary path (an owner ask with mocks), and it blocks a send the user means to make. Rejected.
- **Fresh secrets at sign time**: the signed bytes would differ from the quoted, verified and (on mainnet) priced
  ones. Rejected.
- **The journal as a spent-route ledger**, or a durable consumption history: couples the quote handle to the journal
  or adds persistent state with a retention policy, for S1 only. Rejected (S1 is a known limit).
- **Second send under the first record (`extraDeposits`)**: discovery's Ethereum-side list, with no source send,
  secrets or `lifiTxId`. Rejected.
- **Lock inside every engine export**: changes the SDK store's synchronous `merge` and every caller. Rejected.

## Security & Adversarial Considerations

- **Threat model**: the journal is one origin's `localStorage`; only this app in this profile writes it, so no other
  party can trigger either race. Storage stays attacker-writable (extensions, devtools); loaders validate records.
- **A record overwritten or merged with another send's**: D1 removes the cause; D2's locked insert-only filing means a
  send cannot replace a stored record, and every later send write is keyed by the id its own filing created.
- **Claim secrets shared between two deposits**: after D1 each ordinary send uses a route quoted for it. **S1**
  (Codex, plausible): within the 60 s quote, another tab's two-click Discard of the landed record stands this tab's
  wizard down to the same frozen review, and a second confirm files the freed id with the same secrets. Disposition:
  a known limit, filed closed at close-out. It needs the user to discard their own unfinished deposit; the two
  source transactions are sent by one account, and Across's public deposit id ties each to its fill, so the shared
  hash links nothing new. Only the user holds the secret, so no one else can claim either deposit, and the
  discarded deposit is as untracked as any discard leaves it. Before its leaf lands, a cross-chain card offers no
  discard (`CrossChainCardBody.vue:57-84`); after it, the ordinary card's Discard takes two clicks. The fix
  (refuse a re-confirm, or force the amount step) changes what the review does, and needs the owner. Reopen on a
  user report or if records lose their source sender.
- **A lost write between tabs**: D3 serializes both send flows' writes and the restore's with every locked writer on
  #88's tree; read-modify-writes compute inside their span.
- **Deadlock, starvation**: spans are synchronous; nested journal requests are forbidden (the `discard` rule); the
  only lock order is record → journal, and no send write takes a record lock. Web Locks grant exclusive requests in
  order, so a claim's queued write waits behind the spans queued before it, never behind an unbounded stream. Where
  `navigator.locks` is missing, `underJournalLock` is a deferred call, as today.
- **Boundary**: a tab without Web Locks, or still running an older bundle, writes outside the lock; a frozen tab
  that was granted the lock delays every other tab's journal write until it thaws (no lease or lock stealing is
  added). One closed known limit at close-out states both.
- **Least privilege, cryptography, supply chain**: no new dependency, credential or primitive; secrets come from the
  existing `randomField`/`computeSecretHash` (`@aztec-labs/aztec.js`, exact-pinned); frozen lockfile as today.

## Assumptions

**Facts**
- F1: each quote draws fresh secrets and a fresh `lifiTxId` (`useCrossChainRoute.ts:339-348`, :139-157).
- F2: the record id is the claim secret hash, the fuel hash for gas only (`routeRecordId`, :161-164); `upsertRecord`
  replaces by id (`journal.ts:517-529`).
- F3: `asked` is set only in `requote` and never reset (`useCrossChainSend.ts:288-306`).
- F4: discovery is the only producer of `extraDeposits`; a restore carries a file's existing ones.
- F5: on `main` the lock guards four claim-internal writes; #88 adds discovery, the reseals, the claim delta, the fuel
  `consumed` reconcile and `discard`. #80's "already locked" list describes #88's tree.
- F6: the wizard returns from the stepper to its frozen review only when its owned record leaves the journal view:
  only the wizard claims the foreground (`SendWizard.vue:1158`), and the stand-down watcher fires on a vanished row or
  a moved foreground (:1478-1499). A row leaves the view through a discard: this tab's settle path when nothing left
  the wallet, or a card's Discard in any tab. On #88 a discard hides the row before its locked removal, and restores
  it if the removal fails; that failure is the one way a frozen review meets a held id.
- F7: a plain error's message passes through `sendFailureCopy`; `ROUTE_EXPIRED` maps to the `expired` refusal
  (`useCrossChainSend.ts:204-228`, `CrossChainState.vue:67-71`).
- F8: every `underJournalLock` body on both trees is synchronous; the lock is not re-entrant (`journal-locks.ts:28, 45-48`).
- F9: the SDK awaits `persist` and wraps its throw as `persist-failed` (`packages/sdk/src/run.ts:23-30`).

**Inferences**
- I1: #88's discard removal and this tab's later insert queue on one lock in request order, so a same-tab retry after
  a discard finds the id free.
- I2: a Vue pre-flush watcher runs before an awaiting caller resumes from a lock span that called `reload()` (Opus's
  trace for both lock adapters). The takeover tests pin the consequence either way.

**Asks**: none open. D1's re-pricing of a repeated ask is noted in `OWNER-ASKS.md` under the brief's budget line.

## ✓ Phase 1 (arc a1): single-use offers, insert-only filing, the send writes under the lock

Precondition: PR #88 is on `main`. Do not start on a tree without it: its locked writers are half of #80's fix.

1. Merge `origin/main`; confirm `grep -n "export function underJournalLock" apps/tools/src/composables/useBridgeJournal.ts`.
2. Add `insertRecord` and its tests to `packages/bridge-core/src/journal.ts`.
3. Make both verified adds insert-only; update `openRow`, `journalAndSend` and `track`/`restoreFile` (D2).
4. Add the lazy spent mark to `useCrossChainSend` (D1).
5. Wrap D3's writes, one file at a time, with the async failure chain; run the touched tests after each file.
6. Add the tests and the browser cell below; run the gate.

Tests (each names the failure it catches):
- `journal.test.ts`: `insertRecord` refuses an id either lane holds and leaves that record unchanged (never-happens),
  and writes a new id beside it (control).
- `useCrossChainSend.test.ts`: quote an ask, `send` (`sendCrossChain` mocked): `ready` stays true during the send
  (the strip is unchanged); leaving and re-entering the amount step with the same ask runs a new quote whose
  `routeRecordId` and `lifiTxId` differ. Control: with no send, re-entering an ask answered "no route" does not
  requote. Catches #65's cause.
- `crosschain-deposit-flow.test.ts`, two sends of one ask: two `quotedRoute`s, two `sendCrossChain`s → two records
  with distinct ids, secrets, `lifiTxId`s and `srcTxHash`es, both in `listedRecords`. Then the first route again,
  `now` pinned inside the TTL: rejects with `ROUTE_EXPIRED` after the chain heads were read; the wallet sent, signed
  and batched nothing (its `liveAccount`/`chainId` reads excluded); the first record is unchanged.
- `crosschain-deposit-flow.test.ts` and `useSend.test.ts`, takeover at filing: a pre-flush `watch(listedRecords)`
  sees `isSessionLive(id)` on the first tick the new id is listed.
- `crosschain-deposit-flow.test.ts`, lost-write race: one `memKV` and one `memoryJournalLocks()`; another "tab" holds
  the lock across a load → modify → write of a second record while the send journals `srcTxHash`. While held,
  storage is unchanged (never-happens); after release, both writes are stored (control).
- `crosschain-deposit-flow.test.ts`, failure chain: a rejected deposit with a journaled approval ends `not-sent`
  through the awaited chain, and the caller sees the wallet's rejection, not a bookkeeping error.
- `useSend.test.ts`: the race shape for `persistSend`: the SDK's deposit facts and the other tab's write both survive;
  and, in the existing public-send test, a `blocked` flag another tab set on the provisional row survives the rename.
- `useBridgeBackup.test.ts`: a restore whose id another tab filed after the pre-check resolves as today and leaves
  the stored record unchanged.
- Browser, `deposit-crosschain.spec.ts` cell 56 (bump `cells`): relayer `never`; send one ask; press Run in
  background (it calls `onNewSend`; New send needs a finished or unconfirmed send); send the same ask again; two
  cross-chain records with distinct ids, `lifiTxId`s and `srcTxHash`es; after a reload, two cards. Failure mode: the wizard's real path back to the same ask re-offering a sent route (`SendWizard.test.ts`
  mocks `useCrossChainSend`, so no cheaper layer composes the wizard, the handle and the journal; the takeover
  timing is real only here too). Estimate 120 s; no fill or claim is awaited. Measured runtime goes in
  `lessons/phase-1.md` and the PR body.

**Validation gate**
- Commands: `bun run --cwd packages/bridge-core test -- src/journal.test.ts`;
  `bun run --cwd apps/tools test -- src/composables/useCrossChainSend.test.ts src/composables/crosschain-deposit-flow.test.ts src/composables/useSend.test.ts src/composables/useBridgeBackup.test.ts src/composables/useBridgeJournal.test.ts`;
  `bun run lint`; `bun run typecheck:all`; `bun run test:all`; `bun run audit:tools`; `bun run e2e:tools -- specs/deposit-crosschain.spec.ts specs/deposit-token.spec.ts specs/activity.spec.ts`
  at retry 0.
- Pass: every command exits 0; the new unit tests and cell 56 pass; existing tests change only where a write became
  awaited.
- Layers: typecheck/lint, unit, build, e2e (sandbox).

## Decision ledger

Round 1: Codex **reject** (S1–S4, UI impact, e2e gate); Opus **conditional approve** (takeover at filing, strip
change, e2e gate, held-id test and placement, lock `track`, one open issue, #88 first). Every finding below is
verified against the code.

| # | Decision | Codex r1 | Opus r1 | Settled because |
|---|---|---|---|---|
| D1 | Lazy spent mark in `useCrossChainSend` (was: reset `asked` on send) | keep the place | the reset changes the step strip; use a lazy mark | accepted Opus: same cause fix, nothing on screen moves during the send |
| D2 | Insert-only filing for both verified adds; `ROUTE_EXPIRED` on a held id, thrown before the `try`; a restore that meets a held id keeps it and succeeds | keep; lock the restore (S2); `ROUTE_EXPIRED` copy is an owner call | sound; pin the TTL in its test; keep the throw before the `try`; insert both families in `track` | accepted all but the owner call: the refusal is reachable only on a failed discard removal (F6) and uses existing copy |
| D3 | Call-site `underJournalLock` on both send flows and `track`; session marks inside the filing span; async failure chain | keep; add S2, fix S3, specify S4 | marks inside the span (demonstrated takeover regression); build the rekey from `currentRecord` | accepted |
| D3a | Rekey after another tab's discard still files the named record | refuse a missing source | read the persisted row inside the span | kept filing: refusing aborts a send visibly on a race nobody provokes; filing loses nothing and the locked discard serializes with it |
| D4 | No nested journal requests, no awaits in a span | agreed | agreed; a nested request only queues | wording fixed |
| D5 | Cell 56 plus `e2e:tools` on the touched specs | the gate is required; prefer one focused cell | the gate is required; no new cell needed | cell kept: the issue and the lane brief ask for two cards, and only the browser composes wizard, handle and journal |
| D6 | #88 on main first | required | hard prerequisite | accepted |
| S1 | Re-confirm after another tab's discard: closed known limit | blocking; fix needs the owner | needs unsupported conditions; known limit | known limit: a deliberate two-click discard of one's own landed deposit inside the quote's minute; no new linkage, no one else can claim |
| S5 | Remaining unlocked writers | issue for exit, engine, prune; leave the fee ladder | one open issue incl. the fee-ladder `merge` | one open issue at close-out |
| S6 | Frozen tab holding the lock | fix the wording; no leases | known limit | folded into the lock-boundary known limit |

Outline B: both reviewers prefer A (B refuses an ordinary repeat send with new copy, and keeps S1's hole).

Final fresh Codex pass: **conditional approve**, three conditions, each verified and applied: (1) D1 must not read
"no route" as spent (`null === null`): the guard is `spent !== null`, with a no-route control test; (2) cell 56
cannot press New send while the send is bridging (only an unconfirmed or finished send offers it): it presses Run in
background, which calls `onNewSend`; (3) the restore's "already tracked" refusal in the race would be a new visible
outcome: the restore now keeps the stored record and succeeds as today, so nothing visible changes. Also taken: a
test that the rename keeps another tab's `blocked`, and the per-browser suite wall-clock in the PR body. A resumed
verify pass on those fixes: **approve** (one wording fix applied: a concurrent restore may use another backup of the
same bridge).

**Implementation audit (a1).** Round 1, on the arc diff: Codex **approve with fixes**; Opus (`general-purpose`)
**approve with fixes**. Both found no path that overwrites a record, shares secrets, loses a write on these flows or
deadlocks. Applied, each verified against the code and each new or tightened test checked against its regression:
(1) both: the failure-chain test passed with the caller's `await` removed (an uncontended lock span is one microtask),
so it now holds the lock across the refusal; (2) Opus, needs unsupported conditions (an id collision), local fix:
`openRow` set `row.id` before filing, so a refused held id reached the failed send's cleanup, which would discard or
flag the holder; `row.id` is set after filing, with a test; (3) Opus: the `blocked` rename test wrote through this
tab's reloading `updateRecord`; it now patches storage only; (4) comments: one redundant line dropped (Codex), the
rename comment states its invariant, `underJournalLock`'s TSDoc states the non-re-entrant, held-until-settled rule
(Opus). Opus also noted that cell 56 proves D1 only inside the 60 s TTL (past it the review requotes anyway); recorded
with the measured runtime in `lessons/phase-1.md`.

## Out of scope

- The claim's writes and the SDK claim entries (#88), the send copy (send-copy-2), deposit reconcile in the SDK (#89).
- Unlocked writers outside the send flows and the restore: `useHubExit.ts` (open, `consumeTxHash`), the fee-ladder
  store's `merge` (`deposit-flow.ts`), engine-internal `patchRecord` writes (`blocked`, `completedAt`, withdraw
  patches) and the startup prune. Disposition: one open issue at close-out (dedupe first): both reviewers traced the
  same whole-lane race for them.

## Post-implementation

Single-arc plan. While implementing: comments state invariants and reasons, never a plan, phase, issue or review; log
meaningful attempts in `implementations-plan/journal-1/lessons/phase-1.md`; `agent-worktree status journal-1 "<line>"`
at each gate; stop and reassess after 3 failures on one step.

1. Codex audit, one package: the net diff from the plan commit, this plan with its ledger, the adversarial ask
   (records overwritten or merged, secrets shared, lost writes, lock deadlock or starvation), and these two rules
   verbatim. *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra
   configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works
   and is clear, leave it alone."* *"Audit the comments for value per character. Flag any comment that narrates what
   the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a
   paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment
   it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be
   few, dense, and exact."* Command: `~/.claude/skills/codex/scripts/run-codex.sh <prompt-file> <worktree> high
   read-only gpt-6.1-sol`. Every prompt carries the two never-read rules (`.env` files, `~/.agents/orchy/`).
2. Fix loop: verify each claim against the code, apply accepted fixes, commit, log the round, resume the same session
   (`resume-codex.sh`) with the fix diff. A round fixes bugs, adds tests and makes local changes; a fix that adds
   persistent state, a lifecycle, a coordination protocol, a recovery policy or a public contract stops for the
   orchestrator. Until a round has nothing material; hard stop at 3 rounds, then surface.
3. Delivery: merge `origin/main` (read what changed in `index.md` and `lessons.md`), rerun the gate, then
   `gh pr create` against `main`, title `fix(tools): give each cross-chain send its own claim secrets and lock the send's journal writes`.
   Body: what changed and why, the gate run, the per-browser suite wall-clock before and after, `Closes #65`,
   `Closes #80`, ending `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Then `gh pr checks --watch`
   in a bounded loop.
4. Close-out, as the PR's final commits: the `## Outcome` block after the front matter (date, status, shipped with
   the PR number, dropped items, `Known limits:` for S1 and the Web Locks boundary, `Open items:` for the
   remaining-writers issue, the seeds retired); promote generalizable gotchas into `implementations-plan/lessons.md`
   (dedupe, prune, under 8 KiB); file each item (dedupe with `gh issue list --state all --search`; a known limit is a
   closed `known-limit` issue with hypothesis, consequence, missing prerequisite, disposition and reopening
   condition); delete `STATUS.md`; `git mv implementations-plan/journal-1 implementations-plan/archive/journal-1` in
   its own commit, link repair, one line in `implementations-plan/archive/index.md`. No row in `index.md`.

   | Situation | Home |
   |---|---|
   | Work inside this arc | this plan and the PR |
   | Actionable work that outlives the plan | a GitHub issue with a `Record` link to the archived plan |
   | Needs a product call or waits outside the repo | an issue labelled `owner-decision` or `blocked:external` |
   | A suspected exploitable weakness | a private draft security advisory |
   | Rejected, superseded or done | a disposition line in the Outcome |
   | A path that needs unsupported conditions, or whose consequence does not matter | a closed `known-limit` issue |
   | Knowledge that prevents a repeat | `implementations-plan/lessons.md` |

5. Merging is the orchestrator's. Once the close-out is on trunk (`git fetch -q origin main && git cat-file -e
   FETCH_HEAD:implementations-plan/archive/journal-1/plan.md`): `agent-worktree done journal-1 --merged`; relay a
   refusal, never force.

## Delivery

| Arc | Phases | Stacks on | `/code-review` |
|---|---|---|---|
| a1 + close-out | Phase 1, then the close-out commits | `main` with #88 | off |

One branch (`worktree-journal-1`), one PR, plain `gh pr create`; the close-out lands as its final commits. No lanes.

## Seeds (draft; the orchestrator runs the arc)

Recommended: `/goal`, because completion is visible in the transcript.

```
/goal Phase 1 of implementations-plan/journal-1/plan.md is marked ✓, backed by its validation gate (bun run e2e:tools on the touched specs included) reported passing in the transcript; LESSONS_FILE=implementations-plan/journal-1/lessons/phase-1.md printed; /code-review NOT run (code_review: off); the Codex fix loop on gpt-6.1-sol converged on the net diff, evidenced by a resumed pass with no new material findings quoted in the transcript; one PR against main exists, opened only after that (gh pr view output), carrying Closes #65 and Closes #80 and the close-out that archived the plan (git show --stat of the archive move); bun run test:all and bun run lint both exit 0 in the transcript.
```

```
/loop 15m Drive implementations-plan/journal-1 forward without waiting for input. Each firing: read plan.md and lessons/ (not the chat); if the plan is archived on main, run agent-worktree done journal-1 --merged and stop; if delivered, babysit CI only; else take the next step of Phase 1, run the touched tests after each edit, commit; at the phase's end run its validation gate, mark ✓, then the Post-implementation section in order. Decide with Codex (gpt-6.1-sol, high) instead of waiting; never merge, publish or widen scope. Stop after 5 failures on one step and reassess with Codex.
```

Use exactly one per session; they do not compose.
