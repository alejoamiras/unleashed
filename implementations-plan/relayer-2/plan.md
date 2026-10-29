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
size: "about 80 lines over the 150-line light target: ask34 joined after the first audit, with its own phase, security cases and tests"
status: approved by Codex (Phases 1 and 2); a1 in progress
---

# relayer-2: a time-based scan window and a 15-second cadence for the testnet relayer

The testnet relayer reads Base Sepolia's `FundsDeposited` logs over a fixed 4,000 blocks, sized for 2 s blocks; at
today's 0.2 s that is 13 minutes of a 2-hour fill window, so an older admitted deposit is never filled or logged.
Phase 1: each pass reads every source block stamped within 7,800 s before Sepolia's head time, found by binary search
over block timestamps, in at most 100,001 blocks. Phase 2 (ask34): each one-minute cron run makes up to four
sequential passes, 15 s apart, each the whole of today's run, and starts no send it cannot finish at Sepolia's
normal pace before the next cron fires.

| Item | Delivered by | Note |
|---|---|---|
| #60 | a1, Phase 1 | every claim held: the block time (F1) and the live missed deposit (F6) |
| ask34 | a1, Phase 2 | the cadence, sequential passes and bounds ship; "never overlap" and "never a second pending transaction" hold except two existing fill-path cases, `OWNER-ASKS.md` §1 |

**UI impact.** The lane brief records no owner decision: "(none: no visible change)". a1: none. The Worker has no
screen; its log timing, a new `late` log line and its README change. No app or SDK file is touched.

## Outcome & Quality Bar

- **For whom.** A testnet user waiting for a fill (a demo), and the owner reading Workers Logs.
- **Excellent.** (1) Every admitted deposit with more than 120 s to its deadline by Sepolia's clock is in every
  healthy pass's window, whatever the source block time. (2) A deposit is seen within about 15 s and, in the first
  33 s of a minute, sent then; no pass starts while another is in flight, and every try checks for a pending
  transaction first. (3) A pass that cannot cover its window ends in one `failed` line before any send, and the
  next pass retries.
- **Good enough.** The destination fill window stays block-based (D6); a send in flight is never cut short (D11).

## Assumptions

**Facts** (sources in `recon.md`)
- F1. Base Sepolia: 36,000 blocks span 7,200 s; five blocks share each second's timestamp (non-decreasing, repeating).
- F2. Sepolia: 800 blocks span 9,600 s, and its 12 s slots keep 800 blocks at least that long.
- F3. An admitted deposit's `fillDeadline` ≤ quote + 7,200 s ≤ its block's timestamp + 7,200 s: `classify` refuses a
  longer window (`select.ts:46`); the pool reverts a quote later than its block (`TestSpokePool.sol:121`, as upstream).
- F4. PublicNode serves 50,000-block `getLogs` on Base Sepolia (5,000 tried on Sepolia); `sepolia.base.org` now caps at
  200, so `CHUNK_BLOCKS`'s comment (500, "Base's own endpoint") is stale. The Worker reads PublicNode only.
- F5. Workers Paid, a cron under an hourly interval: 15 min wall, 30 s CPU, 10,000 subrequests per invocation, six
  connections awaiting headers at once; the clock advances only across I/O. viem's HTTP transport times out at
  10 s and retries 3 times, under `retried`'s 10 attempts.
- F6. Live: deposit `0x7285351c…04fa` (block 51,865,756) passes `classify`, is unfilled, and sat 11,650 blocks back
  with 4,867 s to its deadline.
- F7. PublicNode publishes no rate limit. From this host, 220 reads in 3.7 s drew no 429; four passes a minute make
  about 260 reads, 64 of them in each pass's first 2 s.
- F8. A send (out-of-scope `fillSourceDeposit`) is reads, an approval awaited to its receipt, gas simulations and a
  `fillRelay` awaited to its receipt; each `waitForTransactionReceipt` gives up after 180 s, and `sendFill` then
  sends a revoke, even while the approval may still be pending.

**Inferences.** I1: PublicNode keeps serving 2,000-block queries (the live test checks it). I2: `SOURCE_LAG`
(2 blocks, 0.4 s) is short for a lagging backend: a brief lag costs a retried read or a deposit seen a pass later; a
sustained one fails passes, known limit #34's outage case. It stays. I3: Workers' egress IPs are shared, so
PublicNode may throttle them below this host's rate; a throttled read fails its pass closed.

**Asks.** `OWNER-ASKS.md` §1 (the two fill-path cases); a1 ships without waiting.

## Architecture & Implementation

**Phase 1 design.** A pass reads Sepolia's head block once, before the source scan, and passes its timestamp `D` to
the scan (`since = D − SCAN_WINDOW_S`) and to the deadline skip it already makes. A new `src/window.ts` exports
`scanWindow(stamp, head, since)`: it reads `head`'s timestamp `T`; throws when `T < since`; sets
`floor = max(0, head − MAX_SCAN_BLOCKS)` and throws when `floor > 0` is stamped at or after `since` (equality refuses
too: earlier blocks may share the second); else returns `{ from, recentFrom }`, the first blocks in `[floor, head]`
stamped at or after `since` and `T − IGNORED_LOG_S`, by binary search. `stamp(n)` is
`retried(() => source.getBlock({ blockNumber: n })).timestamp`. This mirrors the sdk's `windowStart`.

**Phase 2 design.** A new `src/schedule.ts` exports `relayRun(pass, scheduledTime)`. The slots are
`scheduledTime + 15 s × k` (k = 0–3). After entry and after each pass, the next slot is
`k = max(previous + 1, latest slot already due)`, so slots that a late invocation or a slow pass missed are dropped.
The run waits for slot `k`, skips it with under 5 s left before `runEnd = scheduledTime + 58 s`, and ends after a
`refused` pass. `run.ts`'s `relayPass(c, { runEnd })` is
today's run: a read-only survey (route, float, destination head, source scan, fill check), raced against
`min(45 s, runEnd − now)` with every read refused once it expires, then `fillOne`, never raced. Before each
candidate's try, `fillOne` runs the pending and fee check (`pause`), raced against the time left before the send
cutoff `runEnd − FILL_BUDGET_MS` (25 s); a pass at or past the cutoff, or whose `pause` reaches it, ends `late`.
No state crosses passes. The worker restocks after the first pass that passed its checks, only with 12 s left
(the balance read raced to `runEnd − 10 s`, then Circle's own 10 s timeout), else `restock-refused`;
`relayOnce(c)` is one pass with no `runEnd` (the manual `once` and the anvil suite).

| File | Change |
|---|---|
| `src/window.ts` (new) | `SCAN_WINDOW_S = SELF_BUILT_FILL_WINDOW_S + 600`, `IGNORED_LOG_S = 30`, `MAX_SCAN_BLOCKS = 100_000`, `scanWindow` |
| `src/run.ts` | P1: drop `SCAN_BLOCKS`, `IGNORED_LOG_BLOCKS`; clamp the lagged head at 0; `CHUNK_BLOCKS` 2,000; `FILL_LOG_BLOCKS` states the 12 s invariant; `ignored` when `blockNumber ≥ recentFrom`. P2: `relayPass(c, { runEnd })`, the raced survey, the late gate and `pause` before each try, `relayOnce`; the destination client polls at 1 s |
| `src/schedule.ts` (new) | `PASSES = 4`, `PASS_INTERVAL_MS = 15_000`, `RUN_MS = 58_000`, `relayRun` |
| `src/worker.ts`, `src/log.ts` | the cron path runs `relayRun`, restocking after the first checked pass; `late` joins the events and `CHECKED` |
| tests | `src/window.test.ts`, `src/schedule.test.ts` (new); `src/run.test.ts`, `src/worker.test.ts`; `test/integration/live-window.integration.test.ts` (new, `describe.skipIf(process.env.RELAYER_LIVE !== "1")`) |
| `README.md` | the window and the passes in "What it fills"; `ignored`, `failed`, `late` rows; runbook step 2's limits |

**Ledger.**
- D1. Search timestamps rather than extrapolate a rate from two blocks: a rate change inside the window (#60's own
  event) breaks extrapolation; deadlines are known only after the logs are read.
- D2. Over the cap, or with the source head stamped before the window, the pass fails closed (`failed` naming the
  cause; no log read, no send), as the sdk's `windowStart` refuses both. Scanning only the newest blocks would drop
  the oldest deposits silently, #60's own bug. The cap is 2.5× today's 39,000 blocks.
- D3. A relayer-local search (about 12 lines) beside the sdk's: `@unleashed/sdk/internal` does not bundle for a
  Worker, and a Worker-safe export is a contract change on the published sdk, in another lane's directory.
- D4. `CHUNK_BLOCKS` 2,000, as the repo's other Base Sepolia scans on PublicNode (`crosschain-discovery.ts:196`):
  20 log reads instead of 79. Block width does not bound a response's size; a flood stays known limit #34.
- D5. The ignored-log boundary is a second search inside `[from, head]`, at most 17 reads. 30 s is two pass
  intervals: each ignored deposit is logged by about two passes. Passes more than 30 s apart (a 40 s pass, an
  invocation over 15 s late) leave a gap whose ignored deposits get no line: logs only.
- D6. `FILL_LOG_BLOCKS` stays 800: it spans at least 9,600 s, past the 7,800 s window (the live test checks it).
- D7. Anchor on Sepolia's head time: the destination pool compares a deadline with its own clock, and F3 bounds the
  deadline by the source block's timestamp, so no clock-skew inference remains. The 600 s past the fill window keep
  an expired deposit in the `skipped` `deadline` lines for about ten minutes, as today.
- D8. The read-only survey races its deadline, so a slow provider (F5) fails the pass before the run's end, and each
  read is refused once the deadline passes, including one in flight at it, so an abandoned survey runs no further
  step and logs nothing more; it holds no state and reaches no write. Sends are not raced: abandoning one could leave a signing send behind.
- D9. Each pass rescans the whole window, as a run does today: no state crosses passes, so a failed or abandoned
  pass cannot corrupt the next. Rejected: scanning only the blocks since the previous pass (about 3 source reads
  instead of 56), which needs a cursor committed atomically, rollback and dedupe rules (Codex traced both hazards)
  for reads that fit the limits (F5, F7). Reopen if PublicNode throttles the Worker.
- D10. Passes are sequential: `relayRun` awaits each pass, so no pass starts while one is in flight. A slow pass or a
  late invocation drops the slots it missed rather than running them back to back: a pass starts only at a slot,
  the next not yet started after the previous pass ends. A run too late for any pass logs `late`.
- D11. A send cannot be bounded from the relayer: its receipt waits sit in the out-of-scope fill path (F8). So the
  run bounds the start of each try: with under 25 s left before `runEnd` (two 12 s slots and a second of polling, a
  heuristic for normal pace) the pass logs `late` and sends nothing. The passes at 0, 15 and 30 s can send; the
  45 s pass looks, and the next run's first pass sends 15 s later. A slower send runs past the minute: §1.
- D12. `pause` (pending nonce, fee ceiling) runs before each candidate's try, not once a pass, so no try of ours
  starts while one of our transactions is pending; it is raced to the send cutoff, so its reads cannot push a try
  past it.
- D13. The midnight restock runs after the first checked pass and only with 12 s left, bounded by `runEnd`.

## Security & Adversarial Considerations

- **A wider window admits more deposits**: two hours instead of 13 minutes, the intent. Each still passes `classify`,
  then the fill path's checks: the receipt re-read, the pool's relay hash, `fillStatuses`, deadline and exclusivity
  by Sepolia's clock, the float, a simulated fill, the fee ceiling. `MAX_TRIES` (8) and the order are unchanged per
  pass; strangers draining the float stays known limit #39, at up to three sends a minute instead of one.
- **A lying source RPC.** Freshness and monotone timestamps are trusted, as its logs and receipts already are
  (relayer-1, "A lying source RPC"). A stale but coherent head hides newer deposits (availability only); a head
  stamped before the window or a floor inside it fails closed; unordered timestamps can misplace a boundary, in at
  most 17 probes. No answer admits a deposit `classify` refuses.
- **A lying destination RPC.** `D` moves the window and the deadline skip together. A `D` in the past widens the
  window into expired deposits (up to the cap), whose fills revert: gas only, at most `FEE_CEILING_WEI` a send,
  which lying about `fillStatuses` already allows.
- **Overlap and double sends.** Passes never overlap (D10); every try checks for our pending transaction first (D12)
  and starts only with 25 s left (D11). Two existing fill-path cases remain (§1): a try that outlasts the minute
  (slow reads before its first write, or a stall between its approval and its fill) can meet the next run's try
  (known limit #36), and a receipt wait that gives up after 180 s revokes while the approval may be pending. A pass
  whose Sepolia reads hit a backend not yet at the fill the pass before it landed can try that relay again, at an
  approval and a revert or revoke. None moves tokens twice.
- **Range errors and throttling.** A refused or throttled read fails its pass (`failed`); the next pass retries.
- **Budget.** A pass makes at most about 90 logical source reads and 8 destination reads, plus `pause` per try; with
  every retry four passes stay under 10,000 subrequests, and each survey ends by `runEnd`. CPU is log decoding,
  far under 30 s; a CPU or wall overrun ends the invocation without our line (Workers Logs records it): known
  limits #34 (a flood), #35, #36.
- **Logs.** One new event, `late`; reasons carry block counts and seconds, never a URL. Per-pass lines (`skipped`,
  `low-gas`, `low-inventory`) now come up to four times a minute.

## Phase 1 — the window from timestamps ✓

1. Add `src/window.ts` and `src/window.test.ts`. 2. Change `src/run.ts` per Phase 1 of the change map.
3. Rework `config()` in `src/run.test.ts`: `SOURCE_HEAD` 50,000,000, five blocks per second, `getLogs` by range.
4. Add the tests below, the live test and the README rows.

**Tests:**
- `window.test.ts`, one table: 2 s then 0.2 s blocks give the exact `from` and `recentFrom`; a chain younger than
  the window and a head of 0 give `from` 0; a cutoff inside a shared second gives that second's first block; a
  floor stamped exactly at `since` throws; a head stamped before `since` throws.
- `run.test.ts`: on a 0.2 s chain with Sepolia's clock 12 s behind, a deposit 7,000 s old is filled; the first
  `fromBlock` is the first block stamped at or after `D − 7,800`, and 20 calls cover it to the head without gap.
- `run.test.ts`: an ignored deposit 20 s old is logged; one 120 s old is not.
- `run.test.ts`: a 0.05 s chain (past the cap) ends the pass `failed` naming the cap, with no `getLogs` call and no
  fill. A scan whose first chunk holds an admitted deposit and whose second stalls: once the stall is reached, fake
  timers advance 45 s and the pass ends `failed`, no fill; releasing the stall then makes no read and no fill.
- live: on PublicNode the window spans 7,800 s at under half the cap, one 2,000-block `getLogs` succeeds on each
  chain, and Sepolia's 800 blocks span at least 7,800 s.

**Validation gate** (all exit 0): `cd packages/testnet-relayer && bun run test && bun run typecheck`; from the
root `bun run lint` and `bun run typecheck:all`.

## Phase 2 — four passes a minute (ask34) ✓

1. Add `src/schedule.ts` and `src/schedule.test.ts`. 2. Change `src/run.ts`, `src/worker.ts`, `src/log.ts` per
Phase 2. 3. Update `src/worker.test.ts` for the cron path. 4. Add the tests below and the README.

**Tests:**
- `schedule.test.ts` (fake timers, a fake pass): with the first pass taking 20 s, passes start at 0, 20, 30 and
  45 s, never two in flight, each told `runEnd` 58 s, and the run ends before 58 s; with a 40 s first pass the next
  start at 40 and 45 s; an invocation that starts 50 s late makes one pass; a `refused` pass ends the run.
- `run.test.ts`: with 20 s left the pass logs `late`, reads no nonce and sends nothing; with 30 s left it reads the
  pending nonce, then fills; when a first try refuses write-free after 10 s, the second try is `late`; a `pause`
  that stalls past the cutoff ends the pass `late` with no fill.
- `worker.test.ts`: the midnight restock follows the first checked pass, once a run; with under 12 s left it is
  `restock-refused` and asks nothing.

**Validation gate** (all exit 0; layers: lint, typecheck, unit, integration on anvil, live read-only):
- `cd packages/testnet-relayer && bun run test && bun run typecheck` (the bundle test included).
- From the root: `bun run lint` and `bun run typecheck:all`.
- `cd packages/testnet-relayer && bun run test:integration` (build `contracts/bridge/evm` first per `lessons.md`).
- `cd packages/testnet-relayer && RELAYER_LIVE=1 bun --bun vitest run --config vitest.integration.config.ts
  test/integration/live-window.integration.test.ts`.
- Before the PR: `bun run test:all` and `bun run audit:tools`.

## Delivery

One arc, one PR: a1 = Phases 1 and 2 on `worktree-relayer-2` (it holds the plan commit), against `main`, title
`fix(testnet-relayer): derive the scan window from timestamps and pass every 15 s`, body `Closes #60` and
`Delivers ask34`, with §1's residual stated. `code_review: off`. The close-out is the PR's final commits. Merge
`origin/main` before the PR. Merging deploys the Worker through Workers Builds; the owner then checks Workers Logs
for four passes a minute and no `failed` naming the window.

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
| Codex final, fresh (`01a188e8`) | conditional approve | refuse each read past the deadline, so an abandoned scan stops (D8; reproduced: it kept reading); budget stated as logical reads and HTTP attempts; the timeout test proves the abandonment boundary; I2 qualified | none |
| Codex final, resumed | **approve** (Phase 1 scope) | the four fixes verified, no regression | none |
| Codex ask34 (`01a188f9`) | reject | the two fill-path cases go to the owner (§1), not claimed as "never"; the late gate and `pause` before each try (D11, D12); restock inside the minute (D13); a full rescan each pass removes the cross-pass state and its commit and rollback hazards (D9); 25 s called a heuristic | a durable lock or a fill-path change now: persistence, coordination and an out-of-scope recovery policy, so the owner's call (§1) |
| Codex ask34, resumed | conditional approve | race `pause` to the send cutoff (D12); bound the restock by `runEnd` (D13); drop missed slots (D10) | none |
| Codex ask34, resumed again | **approve** | the three conditions verified, no Phase 1 regression | none |
| Codex fix loop 1 (`01a1890f`) | 2 low | the run's comments say it starts nothing after its end, not that it ends (an admitted send is awaited); two narrating comments deleted | none |
| Opus diff review | 8 low or nit | a pass starts only at a slot (D10); an in-flight read refused at the deadline (D8); `late` for a run with no pass; the live test two blocks below the head; a failed-first-pass worker test; §1 case 1 widened; D5 corrected; wording | a guard for finite deadlines over 2³¹ − 1 ms (no caller); the lagging-backend retry ships as known limit 4 (gas only) |

## Seeds

- `/goal` Phases 1 and 2 ✓ in implementations-plan/relayer-2/plan.md with their gates passing in the transcript; the
  Codex fix loop converged (a resumed pass with no new material finding quoted); the PR closing #60 and delivering
  ask34 exists after the loop, with the close-out's archive move shown by `git show --stat`; `bun run test:all` and
  `bun run lint` exit 0.
- `/loop 15m` Drive implementations-plan/relayer-2 per its Post-implementation section; never merge.
