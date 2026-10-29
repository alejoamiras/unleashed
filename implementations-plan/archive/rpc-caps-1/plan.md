---
plan: rpc-caps-1
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: completed (PR #77)
base: main bee3a71
budget: "recon: 1 Sonnet explorer; code-review: off; Codex gpt-6.1-sol at high"
---

## Outcome

- **Status:** completed; delivered in PR #77 (one arc), awaiting the orchestrator's merge. Closes #61.
- **Shipped:** `cappedLogs` (`packages/bridge-core/src/capped-logs.ts`), `maxLogBlocks` on `SOURCE_CHAINS[84532]`
  with the measured caps, the wrapping in `readClientFor`, and the corrected comments in `source-chains.ts` and
  `network-targets.ts`. Tests: `capped-logs.test.ts` (two unit cases and the `RPC_CAPS_LIVE` check), the cap pin in
  `source-chains.test.ts`, and the wiring case in `useEthereumReader.test.ts`.
- **Changed in review:** planning narrowed the completeness claim to failed requests and added I2, A2 and four test
  cases. Implementation round 1 added a remainder range and a filter check to the tests and fixed three comments.
  Rejected, with reasons in the ledger: one global chunk of 200, split on refusal, `methods.exclude` (D1),
  retention-aware routing (D5), and cancelling on the deadline (D6).
- **Lessons:** none promoted, because `lessons.md` is at its budget (8,188 bytes). The endpoint facts live in
  `source-chains.ts`'s comment and `recon.md`. The note on viem stubs lives in `lessons/phase-1.md`.
- **Known limits:** #78.
- **Open items:** none. Reported to the orchestrator for triage: PublicNode Sepolia's log retention of about 1.7
  days keeps older cross-chain records `incomplete`.
- **Seeds:** the `/goal` and `/loop` seeds at the end are retired. They are history, not instructions.

# rpc-caps-1: keep every log query within its endpoint's measured cap

## Summary

Base Sepolia's fallback read RPC, `sepolia.base.org`, refuses an `eth_getLogs` range wider than 201 blocks, and the
app's discovery asks for 2,000. Each capped endpoint's `http` transport gets a wrapper. The wrapper splits a wider log
query into requests within that endpoint's configured cap and joins the answers in order; any failed request fails
the whole query. The catalogue records each cap, and the comments state what was measured.

**Requirements.** #61 → a1 (`Closes #61`). Asks: none. **UI impact.** Recorded owner decisions: "(none: no visible
change)". No product surface changes: no copy, layout or formatting moves.

## Outcome & Quality Bar

**For whom.** A testnet user whose cross-chain send lost its source hash. The app finds the send by scanning Base
Sepolia logs, and that scan reaches `sepolia.base.org` when PublicNode fails a request.

**Excellent.** (1) When PublicNode fails a log request, `sepolia.base.org` answers it in full. No request sent there
is wider than its cap. (2) When any request of a split query fails, the whole query fails, so discovery reads
`incomplete`. A successful but short answer from an endpoint stays trusted, as today (D5).

**Good enough.** A long lost-hash window that needs more requests than the 45 s discovery budget allows stays
`incomplete` on the fallback path: a retry, never a wrong verdict.

## Assumptions

**Facts** (verified at bee3a71 and live; measurements in `recon.md`):

1. `sepolia.base.org` serves `to − from ≤ 200` (201 blocks) and refuses wider ranges with `-32614 "eth_getLogs is
   limited to a 200 range"`, with no result. `source-chains.ts:27` says 500, and so does the relayer (`run.ts:42`).
2. PublicNode Base Sepolia serves `to − from ≤ 50,000` (`-32701` past it) and ≤ 20,000 results (`-32602`). For one
   emitter over one 2,000-block range, its answer equals the sum of ten 200-block answers from `sepolia.base.org`.
3. Discovery uses one `chunkBlocks` (default 2,000, `crosschain-discovery.ts:196`) for both chains, and no caller
   overrides it. Its only Base Sepolia log read is the lost-hash `Transfer` scan (`:399`). Its client is
   `readClientFor(84532)` (`useEthereumReader.ts:17`): `fallback([publicnode, sepolia.base.org])`.
4. viem 2.57.1's `fallback` starts every request at the first transport. It hops on any error except a rejection or
   revert, throws the last transport's error, and never hops on a success, an empty list included. `http`'s own
   `retryCount: 1` applies, and the fallback retries the whole chain (3 times) on a retryable error only (among them
   `-1`, `-32005`, `-32603`, `-32007`, HTTP 403, 408, 413, 429 and some 5xx; `utils/buildRequest.ts:291`). Today a PublicNode failure sends the 2,000-block query to `sepolia.base.org`, which refuses
   it: the read fails closed, but the fallback does nothing for logs.
5. Discovery's Ethereum side reads Sepolia through PublicNode. The SDK's reconcile reads the caller's L1 client (the
   wallet's provider in the app, `useSend.ts:184`). Neither reads a source chain, so neither changes.
6. Scripts reach `sepolia.base.org` only through an operator's `BASE_SEPOLIA_RPC_URL`, and there the refusal fails
   the read closed. The testnet relayer is out of scope (relayer-2).
7. PublicNode Base Sepolia keeps logs and receipts from block ≈ 47,000,000 (about 11 days back). Between 46,500,000
   and that block it answers logs as `[]` and receipts as `null`, without an error; a range across the boundary is
   cut to its upper part. Below 46,500,000 it refuses (`4444`). PublicNode Sepolia refuses logs past about 12,000
   blocks back (about 1.7 days, `4444`). `source-chains.ts:14` and `network-targets.ts:53` say each endpoint serves
   logs "without silently truncating".

**Inferences.**

- I1: An Across lost-hash window runs from the send to the fill deadline (2 h after the quote, #60) plus at least
  3,600 s: about 54,000 blocks. PublicNode answers it in 27 reads. `sepolia.base.org` needs 270 requests, which may
  pass the 45 s budget (not measured): then the window stays `incomplete` on that path.
- I2: A record old enough for fact 7's gap has an Ethereum window more than 12,000 Sepolia blocks back, so discovery's
  Ethereum scan is refused and the run reads `incomplete` before the gap can yield `pending` (code trace:
  `readEthereum` → `routerDeposits` → `logsOf`).

**Asks** (technical; the working assumption stands unless the orchestrator overrides it):

- A1: File fact 7's gap as a closed `known-limit` issue (D5). Working assumption: yes.
- A2: Accept that a split query keeps sending after discovery's deadline rejects it, bounded by the request counts in
  D6. Working assumption: yes; a cancellation path would add a lifecycle and a cross-layer contract.

## Architecture & Implementation

- **Data** (`packages/bridge-core/src/source-chains.ts`): `SourceChain` gains `maxLogBlocks?: Readonly<Record<string,
  number>>`, the configured largest inclusive block count of one `eth_getLogs` request to a listed URL, chosen at or
  below the measured limit. Base Sepolia: `{ "https://base-sepolia-rpc.publicnode.com": 50_000,
  "https://sepolia.base.org": 200 }`. The comment states each measured limit, its refusal and fact 7's retention
  gap. The `rpcUrls` doc drops "without silently truncating". `network-targets.ts:53` gets the same doc fix only.
- **Mechanism** (new `packages/bridge-core/src/capped-logs.ts`, exported from the index): `cappedLogs(transport,
  maxBlocks)` wraps ONE endpoint's transport and keeps its config. It forwards every request unchanged except an
  `eth_getLogs` with one filter whose `fromBlock` and `toBlock` are hex quantities and whose `to − from + 1 >
  maxBlocks`. That request becomes sequential requests over `[from, from + maxBlocks − 1]` … `[…, to]`, joined in
  order; a non-array answer throws. A tag, a `blockHash` or an inverted range passes through. Each call collects into
  its own array and rejects on the first failed request, sending nothing more. It returns the inner transport with
  only `request` replaced, so it adds no retry layer (D6). A non-positive or non-integer `maxBlocks` throws at
  construction.
- **Wiring** (`apps/tools/src/composables/useEthereumReader.ts`): `readClientFor` wraps each `http(url, …)` with
  `cappedLogs` when `sourceChain(chainId)?.maxLogBlocks?.[url]` names a cap, and wraps nothing otherwise (Sepolia,
  sandbox chains). Discovery, `scanRange` and the SDK stay unchanged.
- **Flow (fallback path)**: discovery asks for 2,000 blocks → PublicNode fails → the fallback calls the wrapped
  `sepolia.base.org` → ten 200-block requests → one array, or the error. A retry by the fallback starts the split
  again from its first request, so one answer always comes from one endpoint attempt.

## Security & Adversarial Considerations

- **An RPC that truncates instead of refusing.** Both endpoints refuse an over-cap range outright (facts 1–2). The
  wrapper never sends one, and a failure of any part fails the whole query. The attacker capability that matters is
  control of an RPC's answers, latency or errors. A successful omission is not detectable here: discovery
  authenticates the logs it gets, not the ones it does not get. The one measured omission is fact 7's retention gap
  (demonstrated at the endpoint). Its application consequence, `pending` instead of `incomplete` for a record older
  than about 11 days, needs an Ethereum reader that keeps more history than the source reader (I2). The product has
  none, so D5 records it as a known limit.
- **A split loop that never ends.** The wrapper does not bisect or retry. Its request count is
  `ceil((to − from + 1) / maxBlocks)`, fixed by the caller's range and a constant cap; a hostile answer cannot extend
  it. A test pins that invalid caps throw.
- **Work after the deadline.** `budgetedReads` races each read against the deadline and does not cancel it. So after
  `incomplete`, a split may still send up to its count of requests, times viem's retries (D6, A2).
- **Least privilege, supply chain, crypto.** No key, no new origin (the CSP is unchanged), no new dependency (viem
  is exact-pinned in bridge-core), no cryptography.

## Phases (arc a1)

### Phase 1: per-endpoint log caps ✓

1. In `source-chains.ts`, add `maxLogBlocks`, the Base Sepolia caps and the corrected comments. In
   `network-targets.ts:53`, correct the doc.
2. Add `capped-logs.ts` and export it from `packages/bridge-core/src/index.ts`.
3. In `useEthereumReader.ts`, wrap each capped URL's `http` transport.
4. Add `capped-logs.test.ts` (bridge-core). Make a stub endpoint (viem `custom`) that refuses `to − from > 200` with
   `-32614` and otherwise answers one log per block, tagged with the stub's name.
   - Test 1: through `fallback([down, cappedLogs(stub, 200)])`, read 2,000 blocks. Assert all 2,000 logs, in order.
     Assert that the stub saw 10 requests, each ≤ 200 blocks, covering the range without a gap or overlap. Control:
     a 150-block read is one unchanged request. Assert that caps 0, −1, 1.5 and `NaN` throw.
   - Test 2, run twice: the stub's 4th request fails with `-32000` (viem does not retry it), or answers
     `result: null`. Alone, the call rejects after exactly 4 requests. Placed before a second stub in a fallback, the
     call returns only the second stub's complete answer.
5. In the same file, add `describe.skipIf(!process.env.RPC_CAPS_LIVE)`. For each capped URL of
   `SOURCE_CHAINS[84532]`, query the WETH predeploy (`0x4200…0006`) over one fixed range a few hundred blocks below
   the head. A `cap`-block query answers an array. A `cap + 2`-block query is refused with the measured code
   (`-32614` or `-32701`). Then read one recent 2,000-block range with at least one log through
   `cappedLogs(http(sepolia.base.org), 200)`. Its ordered `(transactionHash, logIndex)` pairs must equal PublicNode's
   single answer.
6. In `source-chains.test.ts`, pin the caps in the entry's `toEqual`. Assert that every key is in `rpcUrls` and
   every value is a positive integer.
7. In `useEthereumReader.test.ts`, extend `stubRpcs` to answer `eth_getLogs`, with `sepolia.base.org` refusing over
   200 blocks. Add one test: with PublicNode down, `readClientFor(84532).getLogs` over 2,000 blocks returns every
   log, and no request to `sepolia.base.org` is wider than 200 blocks.
8. Measure each new test's runtime. Write it, and the live run's output, in `lessons/phase-1.md`.

- **Gate:** `bun run lint`; `bun run typecheck:all`; `cd packages/bridge-core && bun --bun vitest run
  src/capped-logs.test.ts src/source-chains.test.ts`; `cd apps/tools && bun --bun vitest run
  src/composables/useEthereumReader.test.ts src/lib/network.test.ts src/lib/network-targets.test.ts`;
  `cd packages/bridge-core && RPC_CAPS_LIVE=1 bun --bun vitest run src/capped-logs.test.ts` (keyless public
  endpoints). Mutations: remove the wrapping in `readClientFor` and see step 7's test fail; make the wrapper forward
  every request and see test 1 fail; restore both. Then `bun run test:all` and `bun run audit:tools`. Pass: exit 0
  for each, both mutations red, and no complexity regression. Layers: lint, typecheck, unit, live (gated). No UI,
  workflow or bridge-flow change, so neither `e2e:tools` nor `lint:actions` runs.

## Decision ledger

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| D1 | Where the cap applies | per endpoint, in its own transport: the issue asks that a refused range still gets answered | (a) one chunk of 200: I1's window takes 270 reads, over `maxReads` 200 even with PublicNode healthy, and the one option shrinks Ethereum's chunk too; (b) split on refusal in `scanRange`: works above the fallback, so it retries PublicNode at every split, meets `ScanIncomplete`'s budget and changes the SDK's shared scan; (c) `methods: { exclude: ["eth_getLogs"] }` on `sepolia.base.org`: the smallest, and it does stop every unsupported range, but it leaves logs with no fallback at all, PublicNode's 20,000-result refusal included |
| D2 | Cap data | optional `maxLogBlocks` record on `SourceChain`, keyed by URL | `rpcUrls` as `{ url, cap }` entries: touches the CSP origins, the Node-safe copy, `script-l1` and the sandbox sources for nothing; a module-level URL map: detaches the cap from its chain |
| D3 | Wrapper home | bridge-core, beside the cap data it serves; the live test reads both from one package | an app utility: workable, but splits the cap from its data |
| D4 | `sepolia.base.org` cap | 200 blocks per request | 201 (what it serves): one block of margin, matching its own message |
| D5 | PublicNode retention gap | no arc; corrected comments; a closed `known-limit` issue at close-out. Missing prerequisite: an Ethereum reader keeping more than about 11 days of logs (I2). Reopen when a source chain's reader keeps less history than its Ethereum reader, a mainnet source gets a keyless RPC, or a user reports an old record stuck in `pending` | retention-aware routing: a recovery policy and per-endpoint upkeep for a consequence the product cannot reach today |
| D6 | Budget | `maxReads` counts logical reads; one is up to 10 requests on the fallback path, each tried twice (`http`'s `retryCount: 1`), and the chain is tried up to 4 times on a retryable error (viem's default 3 retries): at most 80 requests to `sepolia.base.org`; the deadline bounds the wait, not the work | counting each request, or cancelling on the deadline: a second budget surface, or a lifecycle across the SDK and the app |

## Audit verdicts

**Codex round 1 (`gpt-6.1-sol`, high, fresh session): conditional approve.** Claims checked against the tree and live.

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | Medium: "a partial list never reaches discovery" overclaims; the retention gap is a successful short answer (demonstrated) | adopted: Excellent (2) and Security now cover failed requests only. D5 records the trust kept, its prerequisite and the reopening condition; I2 adds the Ethereum-side refusal found while verifying |
| 2 | Low: fact 5 named PublicNode for the SDK's reconcile; fact 7 lacked the 46,500,000 boundary; cap units conflicted with D4; "full history" was one sample (demonstrated) | adopted, all four (facts 5 and 7, Data, `recon.md`) |
| 3 | Medium: the deadline does not cancel a read, so a split keeps sending after `incomplete` (demonstrated on `budgetedReads`) | adopted as stated, bounded work (Security, D6, A2), pinned by tests 1–2's request counts. Rejected: a cancellation path (a lifecycle and a contract) and a deadline test (the deadline is the SDK's and does not change) |
| 4 | Low: tests miss the partial-then-backup case, constructor caps, exact live codes, ordered identities (plausible) | adopted: tests 1, 2 and step 5 |

**Final fresh Codex pass (new session): approve.** No settled disposition reopened; D1–D6, I2 and A1–A2 judged
proportionate, and the caps re-measured independently (201 served and 202 refused; 50,001 and 50,002).

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | Low: fact 4 listed viem's retryable errors too narrowly (demonstrated, `buildRequest.ts:291`) | adopted: fact 4 names them as examples, with the source line |
| 2 | Low: no test catches a wrapper that returns the prefix on a `null` answer (plausible) | adopted: test 2 runs with `-32000` and with `result: null`. Mechanism adds: no second retry layer |

**Implementation round 1.** Codex (new session): clean, 2 Low. Same-family review (Opus, alongside): 1 material Low,
3 Low. Verified and fixed in c4924b8; mutations in `lessons/phase-1.md`.

| # | Finding (label) | Disposition |
|---|---|---|
| C1 | Low: the retention comment said every older block answers short; below 46,500,000 it refuses (demonstrated) | fixed: the comment names both bands |
| C2 | Low: `overCap`'s doc-comment restated its signature | fixed: deleted |
| O1 | Low, material: no split range left a remainder, so a loop dropping the last partial part passed (demonstrated by trace) | fixed: test 1 splits 1,000–3,049 into 11 parts; the mutation fails |
| O2 | Low: the stub ignored the filter, so a split that dropped `address` passed (plausible) | fixed: the stub refuses a part without it; the mutation fails |
| O3 | Low: two test comments said "past the cap" where the code means `to − from > 200` and two blocks past it | fixed |
| O4 | Low: the return type admits a `raw` http transport, and `config.request` still names the inner request (needs unsupported conditions: no caller does either; viem reads it only for filter scopes) | no change |

**Implementation round 2 (resumed Codex): clean.** All fixes verified. Converged in 2 rounds.

## Delivery

One arc, one PR against `main`: a1 = phase 1 plus the close-out commits, `Closes #61`, code review `off`. Branch
`worktree-rpc-caps-1`; this plan's commit is its first commit. Merge `origin/main` before the last gate run. Keep to
the read path: the app's cross-chain route and copy (gas-floor-1, send-copy-2), the SDK's network checks
(route-auth-1) and the relayer (relayer-2) belong to other lanes. One phase, so nothing runs in parallel. Size: over
the 150-line target by the audit table and the verbatim review rules; nothing is restated.

## Post-implementation

1. **Codex fix loop** over the net diff from bee3a71: `~/.claude/skills/codex/scripts/run-codex.sh <prompt-file>
   <worktree> high read-only gpt-6.1-sol`, prompt in `implementations-plan/rpc-caps-1/_codex-diff.md`. Send the diff,
   this plan, the ledger, the adversarial ask (a truncating answer, an endless split, a mixed-endpoint answer, a
   partial list reaching discovery, work after the deadline), the line "Never open, read, cat, list or search a
   local `.env` file or any `*.env` file (an `*.env.example` template is fine). Never open, list or search
   `~/.agents/orchy/`.", and verbatim: "Report bugs and small, targeted improvements only. Do not propose speculative
   abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real
   problem. If code works and is clear, leave it alone." and "Audit the comments for value per character. Flag any
   comment that narrates what the code visibly does, restates its line, references implementation plans / phases /
   reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or
   constraint deserves a comment it doesn't have." Verify each claim, fix, commit, log the round in
   `lessons/phase-1.md`, then `resume-codex.sh "" <followup> <codex-dir> high` until a round has no material finding.
   Stop after three rounds and surface. A fix that adds state, a lifecycle, a protocol, a recovery policy or a
   public contract stops for approval.
2. **Delivery.** After `git merge origin/main`, run `bun run test:all`, `bun run lint` and `bun run audit:tools`; each
   must pass. Then run `gh pr create` (title ≤ 93 characters, a Conventional Commit; body: the changes, the
   validation with outcomes, the test runtimes, the live run, `Closes #61`).
3. **Close-out**, as the PR's final commits. First read what `origin/main` changed in `index.md` and `lessons.md`.
   Add the `## Outcome` block after the front matter (status, shipped with the PR number, `Known limits:`, `Open
   items:`, seeds retired). Promote generalizable lessons to `lessons.md` (dedupe, retire, keep under 8 KiB). Run
   `gh issue list --state all --search "publicnode retention"`, then file D5 as a `known-limit` issue (the five
   sections, D5's prerequisite and reopening condition) and close it as not planned. Delete `STATUS.md`. Then, in its
   own commit, run `git mv implementations-plan/rpc-caps-1 implementations-plan/archive/rpc-caps-1` and add one line
   to `implementations-plan/archive/index.md`. Add no row to `index.md`. Then run `gh pr checks --watch` and report.
4. **Teardown** after the orchestrator merges: `agent-worktree done rpc-caps-1 --merged`; relay a refusal, never
   force.

Where open work lives: a bug or gap → an issue with a `Record` link; a product call → `owner-decision`; a suspected
exploitable weakness → a private draft advisory; a finding needing unsupported conditions → a closed `known-limit`
issue; knowledge → `lessons.md`.

## Seeds (draft; run none)

```
/goal Phase 1 of implementations-plan/rpc-caps-1/plan.md marked ✓ with its gate reported passing in the transcript, the RPC_CAPS_LIVE run included; the Codex fix loop converged (a resumed pass quoted with no material finding); the PR exists with Closes #61 and carries the close-out archive commit; bun run test:all and bun run lint exit 0.
```

```
/loop 15m Drive implementations-plan/rpc-caps-1/plan.md: read plan.md and lessons/, take the next unticked step, run its gate exactly, tick it; at the end run Post-implementation 1–3; never merge or open a .env file; stop after three failures on one step.
```
