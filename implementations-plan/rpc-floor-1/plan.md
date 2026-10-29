---
plan: rpc-floor-1
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: approved by the orchestrator at a753635; implementing a1
base: main f24e033
budget: "recon: 1 Sonnet explorer; code-review: off; Codex gpt-6.1-sol at high"
---

# rpc-floor-1: read an old cross-chain record from an endpoint that keeps its history

## Summary

Discovery reads a cross-chain record's whole window on every run. PublicNode Sepolia, the app's only Ethereum
reader, refuses logs older than about 10,000 blocks (1.4 days), so an unresolved record left that long never
resolves. PublicNode Base Sepolia answers older logs and receipts as empty. Each endpoint now refuses what it does
not keep, natively or through a local guard, and viem's existing fallback asks the next endpoint. Sepolia gains a
second keyless reader that keeps full history.

**Requirements.** #75 → a1 (`Closes #75`). Lane asks (`askN`): none. Plan Asks A1 and A3: accepted by the
orchestrator at approval (recorded at each). **UI impact.** Recorded owner decisions: "(none)". No copy, layout, state or format
changes; an old record reaches the outcome screens that already exist.

## Outcome & Quality Bar

**For whom.** A testnet user who sent from Base Sepolia, closed the tab, and came back days later.

**Excellent.** (1) The record resolves to its real outcome while both chains' keyless readers still hold its blocks
(about 12 days on Base as measured). (2) Within the measured retention, no answer from below an endpoint's history
reaches discovery: the run reads it from an endpoint that keeps it, or reads `incomplete`. (3) Receipt polling for a
fresh send behaves as today unless an endpoint still lacks a receipt 1,000 blocks after mining (D3).

**Good enough.** A record older than every reader's history stays `incomplete`, as today (D5). The readers are
trusted to report what they hold honestly, as today (Security).

## Assumptions

**Facts** (verified at f24e033 and live; detail in `recon.md`):

1. PublicNode Sepolia refuses (`4444`) any log range starting more than about 10,000 blocks back, a range across
   the floor included, and answers receipts there `null` while serving the transaction. #75's "about 12,000" was
   an older measurement; its "refuses" holds for logs only.
2. PublicNode Base Sepolia answers logs complete from 47,000,000, `[]` below it down to 46,500,000, and `4444`
   below that; receipts below 47,000,000 are `null` while it serves the transaction. #75's Base claim holds.
3. `sepolia.base.org` serves logs and receipts at 10,000,000 and 30,000,000; both Base endpoints refuse blocks
   below 46,500,000 (`4444`).
4. `rpc.sepolia.ethpandaops.io` is keyless, answers browser CORS for any origin, serves logs, receipts and blocks
   at 5,000,000, and matched PublicNode and Tenderly on every compared range; it refuses 50,000 blocks.
   No other keyless Sepolia endpoint tried serves old logs usably (`recon.md`).
5. viem 2.57.1's `fallback` hops on any error but a rejection or revert and never on a success; code 4444 is not
   retried; a code-less `Error` is retried by the outer layer.
6. A thrown read makes discovery `incomplete`, shown as nothing new (the record keeps its step copy; retry every
   15 s). A `pending` run clears a provisional outcome and a non-final deposit (`crosschain-discovery.ts:838`).
   `expired-on-source` throws `incomplete` when `fillStatuses` says filled (`:616`). A short Transfer scan after a
   reverted recorded attempt keeps the revert (`:429`), so a successful resend the scan missed yields a final
   `not-sent` (`outcomePatch` sets `completedAt`): the worst consequence of a short answer.
7. Testnet routes Across from Base Sepolia only; mainnet has no read RPC; `privacy-providers.test.ts` pins the
   mainnet target only.
8. viem's `waitForTransactionReceipt` keeps polling only on a not-found error and rejects on any other
   (`actions/public/waitForTransactionReceipt.js:148-211`); the app polls source receipts through `readClientFor`
   (`crosschain-deposit-flow.ts:359`, `leftover-approval.ts:56`).

**Inferences.**

- I1: PublicNode Base's boundaries stayed put while the head moved 39,000 blocks. Why they sit at round blocks (a
  pruning step, or where a snapshot started) is unknown, and a resync can move them anywhere. A declared retention of 3,000,000 blocks keeps a margin of
  about 1,950,000 (about 4.5 days) below today's 4,950,000. A shrink past it is caught only by the opt-in live check.
- I2: As measured, the readable age is bounded by Base block history (from 46,500,000, about 5,450,000 blocks or
  12.6 days at 0.2 s). It moves when PublicNode prunes. An older record stays `incomplete` (D5).
- I3: An old record with a lost source hash scans about 54,000 Base blocks on `sepolia.base.org`: 27 budgeted reads,
  270 requests, latency not measured (step 8 measures one). If it passes the 45 s deadline the run reads
  `incomplete`. The recorded-hash path needs a few requests.

**Asks** (technical; the working assumption stands unless the orchestrator overrides it):

- A1 (needs the orchestrator's explicit acceptance at approval): add ethPandaOps as the testnet app's second
  Sepolia reader. It widens two boundaries. Trust: an old record's Ethereum verdict rests on ethPandaOps' answers,
  as a recent one rests on PublicNode's. Privacy: when PublicNode refuses or fails, testnet browsers send
  ethPandaOps their IP, transaction hashes and log topics (secret hashes included). The Privacy Policy covers
  mainnet only, so no legal text changes. **Accepted by the orchestrator:** "`rpc.sepolia.ethpandaops.io` becomes
  the second keyless Sepolia reader on testnet. It may decide old Sepolia verdicts, and testnet browsers send it
  their IP, tx hashes and log topics when PublicNode refuses or fails. The data is public chain data, and it is the
  same class PublicNode already receives. Mainnet, the legal pages and the mainnet bundle stay untouched (prove it
  with the build-target check)."
- A2: File D5's residual as a closed `known-limit` issue at close-out. Working assumption: yes.
- A3 (needs the orchestrator's explicit acceptance at approval): do not run `e2e:tools` locally, an exception to the
  bridge-flow gate. The local target reads one URL per chain with no catalogue entry, so no wrapper applies and its
  reads are unchanged; CI's `tools-e2e-status` runs the suite on the PR. **Accepted by the orchestrator:** "`bun run
  e2e:tools` is not run locally, because the sandbox reader composition is provably unchanged. CI's
  `tools-e2e-status` must be green before you report."

## Architecture & Implementation

- **Data** (`packages/bridge-core/src/source-chains.ts`): `SourceChain` gains `logRetentionBlocks?:
  Readonly<Record<string, number>>`, per URL the latest blocks the endpoint answers `eth_getLogs` completely for, set
  at or below the measured retention. Base Sepolia: `{ "https://base-sepolia-rpc.publicnode.com": 3_000_000 }`. The
  retention prose at `:36-39` becomes the field's measured basis; `sepolia.base.org` gets no entry.
- **Mechanism** (new `packages/bridge-core/src/kept-history.ts`, exported from the index; each wraps ONE endpoint's
  transport, replaces only `request`, adds no retry layer, and calls only its own inner transport):
  - `keptLogs(transport, blocks)`: an `eth_getLogs` with one filter and a hex `fromBlock` first reads the
    endpoint's `eth_blockNumber`; a `fromBlock` below `head − blocks + 1` throws `RpcRequestError` 4444 without
    sending the query. A filter it cannot place (`blockHash`, or `fromBlock: "earliest"`) is refused the same way.
    Head tags and an absent `fromBlock` pass through. Invalid `blocks` throws at construction. The TSDoc states the
    contract: complete answers for numbered ranges inside the declared retention only.
  - `receiptOrNext(transport)`: an `eth_getTransactionReceipt` answered `null` asks the same endpoint for the
    transaction and its head. The wrapper throws 4444, so the fallback asks the next endpoint, only when both probes
    succeed and the transaction is mined at least `PRUNED_AFTER_BLOCKS` (1,000) below that head. An unknown, pending
    or freshly mined transaction, or a failed probe, keeps the original `null`, so polling sees no new error (fact
    8). Every measured floor starts 10,000 or more blocks back; 1,000 blocks is about 3 h 20 min on Sepolia and
    3 min 20 s on Base, a pruning discriminator, not a proven bound on indexing delay.
- **Wiring** (`apps/tools/src/composables/useEthereumReader.ts`): per URL, `http` → `cappedLogs` (if capped) →
  `keptLogs` (if retention declared) → `receiptOrNext` on every URL but the last, so the last endpoint's `null`
  still reaches viem as "not found". `network-targets.ts`: `SEPOLIA_READ_RPCS = [publicnode, ethpandaops]`, comment
  stating why. Discovery, the SDK and scripts stay unchanged.
- **Flow** (old Across record): source receipt → PublicNode `null`, transaction mined → `sepolia.base.org` answers
  → bind → Ethereum logs → PublicNode `4444` → ethPandaOps answers → candidate receipts → PublicNode `null` → next →
  ethPandaOps → verdict. A lost source hash: Transfer scan → `keptLogs` refuses PublicNode below its retention →
  `sepolia.base.org` within its 200 cap.
- **Not taken**: see the ledger (D1–D5).

## Security & Adversarial Considerations

- **An endpoint that answers empty below its floor.** Base PublicNode's log band never receives a query: `keptLogs`
  refuses below the declared retention and the fallback asks the next URL. A `null` receipt goes to the next
  endpoint on both chains once both probes show the transaction mined 1,000 or more blocks back. PublicNode Sepolia refuses old logs natively. Limits: the
  guarantee holds while PublicNode keeps at least the declared retention (I1), and only for numbered ranges.
- **A record wrongly marked settled or expired.** Settling verdicts need positive evidence, which an empty answer
  never supplies, with one exception: a reverted recorded attempt plus a short Transfer scan that misses the resend
  gives a final `not-sent` (fact 6). `expired-on-source` also needs `fillStatuses` at the finalized block to say
  unfilled, so missing `FilledRelay` logs cannot expire a filled relay. A short answer otherwise reads `pending`,
  which clears provisional facts. The guards keep both paths out of every measured floor; a retention that shrinks
  past the declared margin reopens them, which the live check detects when run.
- **Trust in the readers (unchanged model, wider set).** Discovery trusts a reader's answers: an operator can invent
  a receipt or log naming the pinned emitters with public relay fields, and a real block hash passes
  `assertCanonical`, which checks the hash, not inclusion. So an RPC operator can forge an outcome, including a
  final `delivered-to-wallet`. That holds today for PublicNode and `sepolia.base.org`; this change makes ethPandaOps
  the decider for old Sepolia windows (A1). Verifying receipts against block roots would be a new design and is out
  of scope. Exploitability by a third party who is not an operator: unknown, none traced.
- **A routing loop that never ends.** Each request walks the fallback once per attempt. The wrappers refuse with
  4444, which the fallback treats as a hop and its outer layer does not retry. Each wrapper sends at most two probes
  (`eth_blockNumber`, `eth_getTransactionByHash`) to its own endpoint, never to the fallback. The work per request
  stays bounded: `http`'s own retry (1) per endpoint, and up to 4 attempts of the chain only on a retryable error.
  Discovery's deadline bounds the wait, not the work: a read the deadline abandons still finishes its requests,
  and the next round may overlap it. Across runs, the watcher retries `incomplete` every 15 s, as today. A record
  past every reader's history keeps costing a few requests per round while its tab is open (D5).
- **Least privilege, supply chain, privacy.** No key. One new keyless origin in the testnet CSP only; mainnet's CSP
  and Privacy Policy stay unchanged. No new dependency. Testnet browsers send ethPandaOps their IP and the queried
  addresses when PublicNode refuses or fails (A1).

## Phases (arc a1)

### Phase 1: per-endpoint history, routed by the fallback ✓

1. In `source-chains.ts`, add `logRetentionBlocks` and its Base Sepolia value, and rewrite the retention comment as
   its measured basis. In `network-targets.ts`, add ethPandaOps to `SEPOLIA_READ_RPCS` with a one-line reason.
2. Add `kept-history.ts` and export it from `packages/bridge-core/src/index.ts`.
3. In `readClientFor`, compose the wrappers as the Wiring bullet says.
4. Add `kept-history.test.ts` (bridge-core), with a viem `custom` stub: head 10,000; below block 6,000 it answers
   logs `[]` and receipts `null`, and reports every transaction mined; a second stub keeps everything.
   - Test 1: `fallback([keptLogs(pruned, 4_000), full])`. A window 5,000–5,999 is answered by `full` alone, and
     `pruned` never receives that query; so are 6,000–7,000, which starts one block below the first kept block, and
     a `blockHash` filter. Control: 6,001–7,000 stays on `pruned`. Alone, `keptLogs(pruned, 4_000)` rejects the
     low window with code 4444 and never resolves `[]`. Invalid retentions throw.
   - Test 2: `fallback([receiptOrNext(pruned), full])`. A transaction mined at 5,000 gets `full`'s receipt.
     Controls: an unknown hash, a transaction mined at 9,001 (999 blocks back; 9,000 hops), and a null receipt whose
     transaction or head probe fails all return `null` from `pruned` without asking `full`. With `full` down,
     `waitForTransactionReceipt` on the fresh one still resolves once `pruned` answers it.
5. In `useEthereumReader.test.ts`, extend `stubRpcs` with a head, a retention band and receipts. Add one test:
   `readClientFor(84532).getLogs` below PublicNode's retention never reaches PublicNode and returns
   `sepolia.base.org`'s logs; `readClientFor(SEPOLIA).getTransactionReceipt` for a mined old transaction returns
   ethPandaOps' receipt after PublicNode's `null`.
6. Live checks, opt-in with `RPC_CAPS_LIVE=1`, in the two test files; every compared answer must be non-empty, so
   two empty answers never pass as equal. bridge-core: PublicNode Base's 200-block WETH answer at
   `head − logRetentionBlocks` equals `sepolia.base.org`'s (ordered ids). apps/tools, through
   `readClientFor(SEPOLIA)`: a range 20,000 blocks back resolves with logs; PublicNode alone refuses it with 4444;
   a recent 2,000-block answer from ethPandaOps equals PublicNode's; an old receipt resolves.
7. Pin the new field in `source-chains.test.ts` (keys in `rpcUrls`, positive integers) and the new origin in
   `network-targets.test.ts`.
8. Measure each new test's runtime, and one live lost-hash-sized scan (27 reads of 2,000 blocks through
   `cappedLogs(http(sepolia.base.org), 200)`), into `lessons/phase-1.md`. A scan past 45 s confirms I3.

- **Gate:** `bun run lint`; `bun run typecheck:all`; `cd packages/bridge-core && bun --bun vitest run
  src/kept-history.test.ts src/capped-logs.test.ts src/source-chains.test.ts`; `cd apps/tools && bun --bun vitest
  run src/composables/useEthereumReader.test.ts src/lib/network.test.ts src/lib/network-targets.test.ts`; both
  files again with `RPC_CAPS_LIVE=1`. Mutations, each red then restored: drop `keptLogs` from the wiring; make
  `receiptOrNext` return `null`; let `keptLogs` forward below the floor. Then `bun run test:all` and
  `bun run audit:tools`. Pass: exit 0 for each, every mutation red, no complexity regression. Layers: lint,
  typecheck, unit, live (gated). `e2e:tools` is not run locally (A3); CI's `tools-e2e-status` runs it on the PR.

## Decision ledger

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| D1 | How an old window reaches a reader that keeps it | each endpoint refuses what it does not keep; viem's fallback, already in place, hops | a range router in discovery or the client: a second routing layer and a change to `DiscoveryChainReads`, a public contract |
| D2 | Sepolia's old logs | add ethPandaOps second: the list holds no Sepolia endpoint that keeps them (fact 1) | fail closed plus an "unreadable" state: leaves #75's 1.4-day stuck flow and needs the owner; ethPandaOps first: slower on busy ranges, and PublicNode is the reader the earlier probe validated |
| D3 | Old receipts | `receiptOrNext`: hop only when both probes succeed and the endpoint reports the transaction mined at least 1,000 blocks below its head, never on the last URL. Residual: a receipt still missing 1,000 blocks after mining, with the last URL failing, rejects polling | hop on every `null`, or on any mined transaction: a lagging receipt then rejects `waitForTransactionReceipt` when the last endpoint fails (fact 8); a per-endpoint receipt floor: needs a home for the L1's endpoint facts |
| D4 | Base's empty band | declared retention per URL (3,000,000), checked against the endpoint's head | an absolute floor block: wrong as soon as PublicNode prunes again; no guard: reachable once D2 lands (#78's reopen condition), with a final `not-sent` as its worst case (fact 6); runtime completeness checks: a new policy for a measured, guarded band |
| D6 | Deviations found while building | (a) the bridge-core live check compares 2,000 blocks, because WETH is sparse at head − 3,000,000 and 200 blocks can be empty on both; (b) the mainnet bundle is not byte-identical: it already carried the testnet URLs as inert data, so the proof is `verify:build-target mainnet`, an identical `_headers` and the changed chunks listed in `lessons/phase-1.md`; (c) the polling case sets `checkReplacement: false`, since replacement checks read blocks, not receipts | — |
| D5 | Records past every reader's history | stay `incomplete` (as today); closed `known-limit` issue at close-out: missing prerequisite, a keyless Base reader serving blocks below 46,500,000; reopen on a user report, such a reader, or a mainnet source with a keyless RPC | an "unreadable" state or stopping the watcher: a visible change for a record about 12 days unwatched |

## Audit verdicts

**Codex round 1 (`gpt-6.1-sol`, high, fresh session): conditional approve.** Claims checked against the tree;
Codex's own live probes got HTTP 403, so it did not re-measure.

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | Medium: a lagging receipt for a fresh send makes `receiptOrNext` hop; if the last URL then fails, `waitForTransactionReceipt` rejects (demonstrated, viem `:148-211`) | adopted: hop only for a transaction mined ≥ 1,000 blocks below the head (D3, fact 8, test 2 controls) |
| 2 | High: "forged logs fail" is false for a hostile operator; `assertCanonical` checks a hash, not inclusion (demonstrated by trace) | adopted as a correction: Security states the unchanged trust model and its wider set; A1 needs explicit acceptance. Rejected: receipt proofs against block roots, a new design |
| 3 | Medium: the retention margin is empirical; past it, a reverted attempt plus a missed resend gives a final `not-sent` (plausible for the margin; the path demonstrated by trace) | adopted: retention lowered to 3,000,000, the guarantee qualified (Excellent 2, I1, Security), fact 6 names the path. Rejected: a discovery-level test of that path, since it would pin unchanged discovery behaviour; the cause is pinned at the wrapper and the wiring |
| 4 | Low: `blockHash` and `earliest` filters pass the guard (needs unsupported conditions: discovery sends numbered ranges) | adopted: the guard refuses both, and test 1 gains exact-floor, straddle and `blockHash` cases |
| 5 | Low: the deadline bounds the wait, not the work (demonstrated) | adopted: Security states the bounded work, as rpc-caps-1 did; no cancellation |
| 6 | Medium: A1 hides trust and privacy consequences (demonstrated exposure) | adopted: A1 names both and asks for explicit acceptance |
| 7 | Low: I2 and I3 overstate; the e2e skip needs an explicit exception (plausible) | adopted: I2 and I3 qualified, step 8 measures one scan, A3 records the exception |

**Final fresh Codex pass (new session, full decision trail): conditional approve.** No settled disposition reopened;
it judged the trust statement, the per-request head read, the 3,000,000 margin, the rejected discovery-level test and
A3's claim (singleton local URL lists) sound.

| # | Finding (label) | Disposition |
|---|---|---|
| F1 | Medium: a failed transaction or head probe throws through `receiptOrNext`, so fresh polling can reject before any threshold (demonstrated in memory on viem 2.57.1); "polling unchanged" overclaims, as 1,000 blocks is 3 min 20 s on Base (plausible) | adopted: a failed probe keeps the original `null`; Excellent (3), the mechanism and D3 state the residual; test 2 gains probe-failure and 999/1,000-block controls |
| F2 | Low: "Asks: none" contradicts A1 and A3 needing acceptance (plausible) | adopted: the summary separates lane asks from plan Asks and requires recorded acceptance of A1 and A3 |

**Implementation round 1.** Codex (`gpt-6.1-sol`, high, new session, net diff from `origin/main` b8c2289): clean. It
traced the reverted-attempt `not-sent` path as closed for the measured floors, found the 4444 refusals hop without a
retry, the probes kept to their own endpoint, the live comparisons non-vacuous, and no comment worth flagging.

Same-family review (Opus, alongside round 1): 4 Low, no correctness bug in the wrappers. All adopted.

| # | Finding (label) | Disposition |
|---|---|---|
| O1 | Nothing pins the last endpoint's exclusion from `receiptOrNext`: wrapping every URL leaves the tests green (demonstrated by trace) | fixed: the wiring test reads a receipt that is `null` everywhere and expects `TransactionReceiptNotFoundError`; the mutation goes red |
| O2 | No test covers the `earliest` refusal (demonstrated by trace) | fixed: test 1 refuses `fromBlock: "earliest"`; treating it as a head tag goes red |
| O3 | The retention comment commits to a step-pruning model the evidence does not show (plausible) | fixed: the comment and I1 say the boundary's cause is unknown and a resync can move it; only the live check detects a shrink |
| O4 | Three comments: "blocks" meant block reads; `HEAD`'s doc described `OLD`; the stub's doc was stale | fixed |

## Delivery

One arc, one PR against `main`: a1 = phase 1 plus the close-out commits, `Closes #75`, code review `off`. Branch
`worktree-rpc-floor-1`; this plan's commit is its first. Merge `origin/main` before the last gate run. Keep to the
read path: the cross-chain route and copy (send-copy-2), the SDK (route-auth-1, sdk-1) and exit reads (exit-reads-1)
belong to other lanes. One phase, so nothing runs in parallel. Size: over the 150-line target by the two audit tables and
the verbatim review rules; nothing is restated.

## Post-implementation

1. **Codex fix loop** over the net diff from f24e033: `~/.claude/skills/codex/scripts/run-codex.sh <prompt-file>
   <worktree> high read-only gpt-6.1-sol`, prompt in `implementations-plan/rpc-floor-1/_codex-diff.md`. Send the
   diff, this plan, the ledger, the adversarial ask (an empty answer below a floor, a wrongly settled or expired
   record, a routing loop, the new reader as attacker), the line "Never open, read, cat, list or search a local
   `.env` file or any `*.env` file (an `*.env.example` template is fine). Never open, list or search
   `~/.agents/orchy/`.", and verbatim: "Report bugs and small, targeted improvements only. Do not propose speculative
   abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real
   problem. If code works and is clear, leave it alone." and "Audit the comments for value per character. Flag any
   comment that narrates what the code visibly does, restates its line, references implementation plans / phases /
   reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or
   constraint deserves a comment it doesn't have." Verify each claim, fix, commit, log the round in
   `lessons/phase-1.md`, then `resume-codex.sh "" <followup> <codex-dir> high` until a round has no material finding.
   Stop after three rounds and surface. A fix that adds state, a lifecycle, a protocol, a recovery policy or a
   public contract stops for approval.
2. **Delivery.** After `git merge origin/main`, run `bun run test:all`, `bun run lint` and `bun run audit:tools`;
   each must pass. Then `gh pr create` (title ≤ 93 characters, a Conventional Commit; body: the changes, the
   validation with outcomes, test runtimes, the live run, `Closes #75`, and a line that #78's band is now routed).
3. **Close-out**, as the PR's final commits. Read what `origin/main` changed in `index.md` and `lessons.md` first.
   Add the `## Outcome` block after the front matter (status, shipped with the PR number, `Known limits:`, `Open
   items:`, seeds retired). Promote generalizable lessons (dedupe, retire, keep under 8 KiB). Run `gh issue list
   --state all --search "history keyless reader"`, file D5 as a `known-limit` issue (five sections, D5's
   prerequisite and reopening condition) and close it as not planned; comment on #78 with the PR. Delete
   `STATUS.md`. Then, in its own commit, `git mv implementations-plan/rpc-floor-1
   implementations-plan/archive/rpc-floor-1` and add one line to `implementations-plan/archive/index.md`. Add no row
   to `index.md`. Then `gh pr checks --watch` and report.
4. **Teardown** after the orchestrator merges: `agent-worktree done rpc-floor-1 --merged`; relay a refusal, never
   force.

Where open work lives: a bug or gap → an issue with a `Record` link; a product call → `owner-decision`; a suspected
exploitable weakness → a private draft advisory; a finding needing unsupported conditions → a closed `known-limit`
issue; knowledge → `lessons.md`.

## Seeds (draft; run none)

```
/goal Phase 1 of implementations-plan/rpc-floor-1/plan.md marked ✓ with its gate reported passing in the transcript, the RPC_CAPS_LIVE runs included; the Codex fix loop converged (a resumed pass quoted with no material finding); the PR exists with Closes #75 and carries the close-out archive commit; bun run test:all and bun run lint exit 0.
```

```
/loop 15m Drive implementations-plan/rpc-floor-1/plan.md: read plan.md and lessons/, take the next unticked step, run its gate exactly, tick it; at the end run Post-implementation 1–3; never merge or open a .env file; stop after three failures on one step.
```
