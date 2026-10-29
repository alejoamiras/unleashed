---
plan: relayer-2
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
quality_bar: production
base: main a111e8a
trunk: main
budget: "recon: 1 Sonnet explorer; code-review: off; foreign reviewer gpt-6.1-sol at high"
size: "about 35 lines over the 150-line light target: the security cases the lane brief requires and each test's failure mode"
status: approved by the final Codex pass; a1 next
---

# relayer-2: a source scan window derived from block timestamps

The testnet relayer reads Base Sepolia's `FundsDeposited` logs over a fixed 4,000 blocks, sized for 2 s blocks; at
today's 0.2 s that is 13 minutes of a 2-hour fill window, so an older admitted deposit is never filled or logged.
Each run will read every source block stamped within 7,800 s before Sepolia's head time, found by binary search over
block timestamps, in at most 100,001 blocks and 45 s; an ignored deposit is logged by the runs within 60 s of its block.

| Item | Delivered by | Note |
|---|---|---|
| #60 | a1 | every claim held: the block time (F1) and the live missed deposit (F6) |
| Asks | none | the lane brief names none |

**UI impact.** The lane brief records no owner decision: "(none: no visible change)". a1: none. The Worker has no
screen; only its log timing and its README change, and no app or SDK file is touched.

## Outcome & Quality Bar

- **For whom.** A testnet user whose send waits while the Worker is down, and the owner reading Workers Logs.
- **Excellent.** (1) Every admitted deposit with more than 120 s to its deadline by Sepolia's clock is in every
  healthy run's window, whatever the source block time; the queue still fills one a run, largest first. (2) A run
  reads little (56 source reads live) and boundedly; one that cannot cover its window ends in one `failed` line
  before any fill, and the next minute retries.
- **Good enough.** The destination fill window stays block-based (D6); the fill stage gets no new deadline.

## Assumptions

**Facts** (sources in `recon.md`)
- F1. Base Sepolia: 36,000 blocks span 7,200 s; five blocks share each second's timestamp (non-decreasing, repeating).
- F2. Sepolia: 800 blocks span 9,600 s, and its 12 s slots keep 800 blocks at least that long.
- F3. An admitted deposit's `fillDeadline` ≤ quote + 7,200 s ≤ its block's timestamp + 7,200 s: `classify` refuses a
  longer window (`select.ts:46`); the pool reverts a quote later than its block (`TestSpokePool.sol:121`, as upstream).
- F4. PublicNode serves 50,000-block `getLogs` on Base Sepolia (5,000 tried on Sepolia); `sepolia.base.org` now caps at
  200, so `CHUNK_BLOCKS`'s comment (500, "Base's own endpoint") is stale. The Worker reads PublicNode only.
- F5. Workers Paid: 10,000 subrequests per invocation, 30 s CPU per sub-hourly cron run, 15 min wall. viem's HTTP
  transport times out at 10 s and retries 3 times, under `retried`'s 10 attempts: one slow read can last minutes.
- F6. Live: deposit `0x7285351c…04fa` (block 51,865,756) passes `classify`, is unfilled, and sat 11,650 blocks back
  with 4,867 s to its deadline.

**Inferences.** I1: PublicNode keeps serving 2,000-block queries (the live test checks it). I2: `SOURCE_LAG`
(2 blocks, 0.4 s) is short for a lagging backend: a brief lag costs a retried read or a deposit seen a run later; a
sustained one fails runs, the provider-outage case of known limit #34. It stays.

**Asks.** None.

## Architecture & Implementation

**Design.** `relayOnce` reads Sepolia's head block once, before the source scan, and passes its timestamp `D` to the
scan (`since = D − SCAN_WINDOW_S`) and to the deadline skip it already makes. A new `src/window.ts` exports
`scanWindow(stamp, head, since)`: it reads `head`'s timestamp `T`; throws when `T < since`; sets
`floor = max(0, head − MAX_SCAN_BLOCKS)` and throws when `floor > 0` is stamped at or after `since` (equality refuses
too: earlier blocks may share the second); else returns `{ from, recentFrom }`, the first blocks in `[floor, head]`
stamped at or after `since` and `T − 60`, by binary search. `stamp(n)` is
`retried(() => source.getBlock({ blockNumber: n })).timestamp`. This mirrors the sdk's `windowStart`.

| File | Change |
|---|---|
| `src/window.ts` (new) | `SCAN_WINDOW_S = SELF_BUILT_FILL_WINDOW_S + 600`, `IGNORED_LOG_S = 60`, `MAX_SCAN_BLOCKS = 100_000`, `scanWindow` |
| `src/run.ts` | drop `SCAN_BLOCKS`, `IGNORED_LOG_BLOCKS`; clamp the lagged head at 0; read the destination head before the scan; `sourceDeposits(c, since)` reads `[from, head]` within `SCAN_DEADLINE_MS = 45_000`, every source read refused past it; `admitted` logs `ignored` when `blockNumber ≥ recentFrom`; `CHUNK_BLOCKS` 500 → 2,000 with a true comment; `FILL_LOG_BLOCKS` states the 12 s invariant |
| `src/window.test.ts` (new), `src/run.test.ts` | tests below; `config()` stubs a timestamp per block and filters logs by range |
| `test/integration/live-window.integration.test.ts` (new) | `describe.skipIf(process.env.RELAYER_LIVE !== "1")`, read-only on the default endpoints |
| `README.md` | the window in "What it fills"; `ignored` (60 s) and `failed` rows; runbook step 2's limits; Scripts row |

**Ledger.**
- D1. Search timestamps rather than extrapolate a rate from two blocks: a rate change inside the window (#60's own
  event) breaks extrapolation; deadlines are known only after the logs are read.
- D2. Over the cap, or with the source head stamped before the window, the run fails closed (`failed` naming the
  cause; no log read, no fill), as the sdk's `windowStart` refuses both. Scanning only the newest blocks would drop
  the oldest deposits silently, #60's own bug. The cap is 2.5× today's 39,000 blocks.
- D3. A relayer-local search (about 12 lines) beside the sdk's: `@unleashed/sdk/internal` does not bundle for a
  Worker, and a Worker-safe export is a contract change on the published sdk, in another lane's directory.
- D4. `CHUNK_BLOCKS` 2,000, as the repo's other Base Sepolia scans on PublicNode (`crosschain-discovery.ts:196`):
  20 log reads instead of 79. Block width does not bound a response's size; a flood stays known limit #34.
- D5. The ignored-log boundary is a second search inside `[from, head]`, at most 17 reads.
- D6. `FILL_LOG_BLOCKS` stays 800: it spans at least 9,600 s, past the 7,800 s window (the live test checks it).
  Reopen if Sepolia's slots shrink.
- D7. Anchor on Sepolia's head time: the destination pool compares a deadline with its own clock, and F3 bounds the
  deadline by the source block's timestamp, so no clock-skew inference remains. The 600 s past the fill window
  keep an expired deposit in the `skipped` `deadline` lines for about ten runs, as today. The ignored log keeps Base
  Sepolia's time, since it concerns the deposit's own block.
- D8. The read-only source scan races 45 s (the sdk's scan budget), so a slow provider (F5) fails the run before the
  next cron minute, and each source read is refused once the 45 s are spent, so an abandoned scan stops at its next
  read; nothing consumes its result. The fill stage is not raced: that could abandon a signing send. The reads
  before and after the scan keep today's bounds.

## Security & Adversarial Considerations

- **A wider window admits more deposits**: two hours instead of 13 minutes, the intent. Each still passes `classify`,
  then the fill path's checks: the receipt re-read, the pool's relay hash, `fillStatuses`, deadline and exclusivity
  by Sepolia's clock, the float, a simulated fill, the fee ceiling. `MAX_TRIES` (8) and the order are unchanged;
  strangers draining the float stays known limit #39.
- **A lying source RPC.** Freshness and monotone timestamps are trusted, as its logs and receipts already are
  (relayer-1, "A lying source RPC"). A stale but coherent head hides newer deposits (availability only); a head
  stamped before the window, or a floor inside it, fails closed; unordered timestamps can misplace a boundary, in at
  most 17 probes. No answer admits a deposit `classify` refuses.
- **A lying destination RPC.** `D` moves the window and the deadline skip together. A `D` in the past widens the
  window into expired deposits (up to the cap), whose fills revert: gas only, at most `FEE_CEILING_WEI` a send,
  which lying about `fillStatuses` already allows.
- **Range errors.** A refused chunk fails its retries and the run logs `failed`; the next minute retries. A swapped
  endpoint must serve 2,000 blocks (the README says so; the live test checks the defaults).
- **Budget.** At the cap a scan makes about 90 logical reads (2 head reads, 2 searches of at most 17, 51 log chunks);
  with viem's and `retried`'s retries that is at most about 3,600 HTTP attempts, under 10,000, and the 45 s deadline
  ends it sooner, in the existing catch, before any fill. It bounds the source scan only. A CPU or wall overrun ends
  the invocation without our line (Workers Logs records it): known limits #34 (a flood), #35, #36.
- **Logs.** No new field; reasons carry block counts and seconds, never a URL.

## Phase 1 — the window from timestamps

1. Add `src/window.ts` and `src/window.test.ts`.
2. Change `src/run.ts` per the change map.
3. Rework `config()` in `src/run.test.ts`: `SOURCE_HEAD` 50,000,000, five blocks per second, `getLogs` by range.
4. Add the tests below, then the live test, then the README rows.

**Tests** (each fails on today's code or guards a fact the design rests on):
- `window.test.ts`, one table: 2 s then 0.2 s blocks give the exact `from` and `recentFrom`; a chain younger than
  the window and a head of 0 give `from` 0; a cutoff inside a shared second gives that second's first block; a
  floor stamped exactly at `since` throws; a head stamped before `since` throws.
- `run.test.ts`: on a 0.2 s chain with Sepolia's clock 12 s behind, a deposit 7,000 s old is filled; the first
  `fromBlock` is the first block stamped at or after `D − 7,800`, and 20 calls cover it to the head without gap.
- `run.test.ts`: an ignored deposit 30 s old is logged; one 120 s old is not.
- `run.test.ts`: a 0.05 s chain (past the cap) ends the run `failed` naming the cap, with no `getLogs` call and no
  fill. A scan whose first chunk holds an admitted deposit and whose second stalls: once the stall is reached, fake
  timers advance 45 s and the run ends `failed`, no fill; releasing the stall then makes no read and no fill.
- live: on PublicNode the window spans 7,800 s at under half the cap, one 2,000-block `getLogs` succeeds on each
  chain, and Sepolia's 800 blocks span at least 7,800 s.

**Validation gate** (all exit 0; layers: lint, typecheck, unit, integration on anvil, live read-only):
- `cd packages/testnet-relayer && bun run test && bun run typecheck` (the bundle test included).
- From the root: `bun run lint` and `bun run typecheck:all`.
- `cd packages/testnet-relayer && bun run test:integration` (build `contracts/bridge/evm` first per `lessons.md`).
- `cd packages/testnet-relayer && RELAYER_LIVE=1 bun --bun vitest run --config vitest.integration.config.ts
  test/integration/live-window.integration.test.ts`.
- Before the PR: `bun run test:all` and `bun run audit:tools`.

## Delivery

One arc, one PR: a1 = Phase 1 on `worktree-relayer-2` (it holds the plan commit), against `main`, title
`fix(testnet-relayer): derive the source scan window from block timestamps`, body `Closes #60`. `code_review: off`.
The close-out is the PR's final commits. Merge `origin/main` before the PR. Merging deploys the Worker through
Workers Builds; the owner then checks Workers Logs for `idle` or `filled` and no `failed` naming the window.

## Post-implementation

1. Codex fix loop on the arc diff against `main`: `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree>
   high read-only gpt-6.1-sol`, then `resume-codex.sh` per round, with plan.md, this ledger, the adversarial ask and
   blueprint's no-over-engineering and comment-quality rules verbatim. One Opus `general-purpose` diff review runs
   beside round 1. Fix, commit, log each round in `lessons/phase-1.md`. Stop when a round has no material finding;
   at three rounds, surface. A fix that adds state, a lifecycle, a protocol, a recovery policy or a contract stops.
2. Rerun the full gate on the final head, push, `gh pr create`, then `gh pr checks <n> --watch` with a timeout.
3. Close-out commits: `## Outcome` after the front matter (status, PR, `Known limits:`, `Open items:`, seeds
   retired); promote lessons (dedupe, retire, 8 KiB); file open items as issues; `git mv` the folder to
   `implementations-plan/archive/relayer-2` in its own commit, repair links, add one line to `archive/index.md`;
   delete `STATUS.md`. Merge `origin/main` first and read what changed in `index.md` and `lessons.md`.
4. After the merge: `agent-worktree done relayer-2 --merged` (this session started inside the worktree).

## Audit verdicts

| Round | Verdict | Accepted | Rejected |
|---|---|---|---|
| Codex 1 (`01a188e1`) | conditional approve | anchor on Sepolia's clock (D7; was a 720 s skew inference); 45 s race on the scan (D8); clamp the lagged head; the boundary table; 100,001 blocks and 51 chunks; narrower lying-RPC and success claims | none |
| Codex final, fresh (`01a188e8`) | conditional approve | refuse each source read past the deadline, so an abandoned scan stops (D8; reproduced: it kept reading); budget stated as logical reads and HTTP attempts, scan-only; the timeout test proves the abandonment boundary; I2 qualified | none |
| Codex final, resumed | **approve** | the four fixes verified, no regression | none |

## Seeds

- `/goal` Phase 1 ✓ in implementations-plan/relayer-2/plan.md with its gate passing in the transcript; the Codex
  fix loop converged (a resumed pass with no new material finding quoted); the PR closing #60 exists after the
  loop, with the close-out's archive move shown by `git show --stat`; `bun run test:all` and `bun run lint` exit 0.
- `/loop 15m` Drive implementations-plan/relayer-2 per its Post-implementation section; never merge.
