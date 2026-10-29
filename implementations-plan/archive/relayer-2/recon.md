# relayer-2 recon

Base: `main` at a111e8a. One Sonnet reuse sweep plus the driver's own reads and live read-only probes (PublicNode,
`sepolia.base.org`). Scope: #60 and ask34 (a 15-second cadence, added by the orchestrator). No open issue but #60 touches `packages/testnet-relayer`; #40 (send copy) is another lane's.
Closed known limits searched (`relayer`): #34–#39, all still accurate; #34 (a deposit missed past its deadline) and
#36 (overlapping runs) are the ones this plan rests on.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| First block at or after a timestamp | `packages/sdk/src/execution/chain-scan.ts:113` `firstBlockAfter` (first block stamped `>` ts), wrapped by `deposit-reconcile.ts:149` `windowStart` (cap check, then search) | **build new**, same shape: both sit behind `@unleashed/sdk/internal`, whose graph does not bundle for a Worker (esbuild: `Could not resolve "tty"`, via colorette). Exporting them from a Worker-safe sdk entry changes a published package's contract and touches `packages/sdk`, which this lane may not. |
| Chunked `getLogs` | `run.ts:133` `chunks()`; sdk `scanRange` (same module as above) | reuse-as-is (`chunks`) |
| Per-run read budget | sdk `budgetedReads` (count cap, wall deadline); relayer has `retried` only (`bridge-core/src/retried.ts:5`, 10 attempts, 1 s apart) | a relayer-local 45 s scan deadline, each source read refused past it (plan D8); no read-count cap, since the block cap bounds the reads |
| Fill window bound | `SELF_BUILT_FILL_WINDOW_S` = 7,200 (`across-self-built.ts:25`), exported by `across-fill` and used by `classify` (`select.ts:46`) | reuse-as-is |
| Timestamped chain stubs | `deposit-reconcile.test.ts:108` `fakeChain`, `crosschain-discovery.test.ts:258` `chain()`; `run.test.ts:56` `config()` keys its stubs on exact `fromBlock`s | adapt `config()` in place: a timestamp per block and range-filtered logs |
| Block-rate constants | `run.ts:39` `SCAN_BLOCKS` 4,000 (2 s blocks), `:41` `FILL_LOG_BLOCKS` 800 (12 s), `:43` `CHUNK_BLOCKS` 500 ("Base's own endpoint"), `:45` `SOURCE_LAG` 2, `:47` `IGNORED_LOG_BLOCKS` 30 (60 s at 2 s) | replace `SCAN_BLOCKS` and `IGNORED_LOG_BLOCKS`; keep the rest (plan D4, D6, I2) |

Search trail for the absences: `grep -rnIE "firstBlockAfter|bisect|blockByTimestamp|findBlock"` and
`"BLOCK_TIME|blockTime|BLOCKS_PER|SECONDS_PER"` over `packages`, `apps`, `scripts` (no `node_modules`, `dist`,
`.claude`); `"maxReads|deadlineMs|budget"` in `packages/testnet-relayer`. The only other timestamp search is
`apps/tools/src/composables/exit-attach.ts:215` (Aztec L2 blocks, another API).

## Verified facts

- Base Sepolia: 36,000 blocks span 7,200 s (head 51,876,255); five consecutive blocks share each second's
  timestamp, so timestamps never decrease but repeat.
- Sepolia: 800 blocks span 9,600 s (head 12,021,191).
- `getLogs` limits: PublicNode Base Sepolia serves 50,000 blocks (`-32701 exceed maximum block range: 50000` above);
  PublicNode Sepolia served 5,000; `sepolia.base.org` now refuses over 200 (`-32614`), so the 500-block figure in
  `run.ts:43` and `bridge-core/src/source-chains.ts:30` is stale.
- Base Sepolia SpokePool `0x82B5…0F8F`: `depositQuoteTimeBuffer` 3,600, `fillDeadlineBuffer` 21,600. The pool
  reverts a quote later than its block (`TestSpokePool.sol:121` mirrors the check).
- Cloudflare Workers limits page: Paid, 10,000 subrequests per invocation, 30 s CPU for a cron under an hourly
  interval, 15 min wall; Free, 50 subrequests and 10 ms.
- Live #60 case: `0x7285351c…04fa` (block 51,865,756) passes `classify`, is unfilled, and sat 11,650 blocks back
  with 4,867 s left before its deadline.
- The proposed scan, run read-only against PublicNode: a 39,001-block window, 301 blocks for the last minute,
  35 timestamp reads and 20 `getLogs` (2,000 blocks each), 56 source reads in 1.9 s.

- ask34 facts. viem 2.57.1: the HTTP transport times out at 10 s and retries 3 times; `waitForTransactionReceipt`
  waits up to 180 s, polling at the client's interval (4 s by default). `sendFill` awaits two receipts (approval,
  fill), so a send lasts about two Sepolia inclusions. Cloudflare: six connections awaiting headers per invocation.
  PublicNode publishes no rate limit (secondhand: per IP, varies by chain); from this host 220 reads in 3.7 s drew
  no 429.

## Collision risks

- `run.test.ts` stubs key on `SOURCE_HEAD - 2n - 4_000n` and `5_000n - 800n`: every deposit case changes with the stub.
- `SCAN_BLOCKS` and `FILL_LOG_BLOCKS` are exported but imported nowhere else.
- Lanes sdk-1 (`packages/sdk`, `apps/tools`) and send-copy-1 (`apps/tools`) touch no relayer file.
