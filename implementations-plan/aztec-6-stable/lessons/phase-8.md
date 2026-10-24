# Phase 8: the quality loop, before any key

`origin/main` had not moved, so no rebase. The loop ran on `gpt-6.1-sol` at `high`, read-only (this host's
`approve-for-me` sandbox mode), over `git diff origin/main` minus `target/*.json`, the lockfiles and the
retired journal. Round 1 started while the browser and integration suites ran, so it read the uncommitted
anvil change and the regenerated sandbox fixture too.

## Round 1 (session `01a16b76-2187-7fc0-92bf-e19fec755b36`)

Verdict: *"no demonstrated high-severity regression; one medium operator trap and three low documentation
findings."* Codex re-derived the sandbox hub and tokens, the faucet's Dripper and tokens, and the canonical FPC
address and digest; it found the baseline still read from the committed blob and outside the allowlist, the FPC
compat map still digest-keyed and fail-closed, and no test assertion removed.

1. **Medium, accepted.** `fee-juice-canary-testnet.ts` defaults to `testnet-bridge.json`, which names the rc.3
   portal until promotion, and its coherence check compares only the asset and handler, which survive a reset.
   A run before promotion would deposit into the retired portal and then wait out its claim. Codex confirmed
   by keyless reads that the old portal still takes deposits. The plan runs the canary only after promotion,
   and the deposit is a free-mint testnet asset, but the guard is four lines: the canary now refuses a manifest
   whose fee-juice portal or wallet chain id differs from the node's `node_getNodeInfo`, before any L1 call.
2. **Low, accepted.** The headroom comments in `send-flow.ts` and `generation.ts` described a fresh Inbox tree
   of about 120k gas. 6.0.0's Inbox absorbs messages into rolling-hash buckets, and the first message of an L1
   block opens a new one (`Inbox.sol` `_absorbIntoBucket` in `@aztec-foundation/l1-artifacts@6.0.0`). The
   comments and the `follow-ups.md` entry now say the gas depends on the bucket state at inclusion.
3. **Low, accepted.** The anvil comment said "no flow could size a fee", and `phase-6.md` said under-target
   blocks take an 8-wei base fee back to 7; with any gas used, the decrease at 8 wei also rounds to zero. Both
   now claim only what holds: the decrease rounds to zero below 7 wei, a stable start rather than a fixed fee.
4. **Low, declined.** Codex asked to cut `private-fpc-canonical.json`'s `$comment` to provenance and the
   address invariant. JSON has no other place for the descriptor's documentation, this diff changed only its
   version string, and its consumer list tells an operator which gates read a field before they edit it.

## Round 2 (resumed, the fix diff)

Codex: *"No new material findings (high confidence within the fix diff)."* The loop converged after one fix
round.

The fixes touch comments, `follow-ups.md` and the testnet canary, which no local suite runs. They landed while
the Phase 6 integration and browser suites were running, so the gate's literal condition, the Phase 6 gate
re-run after the last fix, is met only by a second full run on the committed fix tree (below).

Phase 7 had not run when the loop converged: npm still served `@nulo-sh/*` at `0.2.0`. Per A6(a) Phase 9 waits
for it, and the tree stays frozen apart from Phase 7, which re-runs this gate.

## Gate after the fixes

| Command | Exit | Note |
|---|---|---|
| `bun run lint` | 0 | |
| `bun run typecheck:all` | 0 | |
| `bun run test:all` | 1 | only the testnet-manifest case (promotion) |
| `bun run test:ci-gating` | 1 | only `published-packages.test.ts` (Phase 7) |

## The Phase 6 gate, re-run on the committed fix tree

`.vite` cleared first; the integration and browser suites ran side by side after the smoke, each on its own
sandbox, at load average 150–300 on 188 cores.

| Command | Result |
|---|---|
| `bun run --cwd packages/bridge-core deploy:sandbox --smoke` | exit 0, `✅ sandbox deploy + smoke OK (17.7m)` |
| `bun run --cwd packages/bridge-core test:integration` | exit 0, 6 files, 35 passed, 1743 s |
| `bun run e2e:tools` | exit 0, `73 passed (2.0h)`, wall-clock 7509 s |
| `bun run lint`, `bun run typecheck:all` | exit 0 |
| `bun run test:all` | only `testnet-bridge.json is a valid v2 manifest for its own chain` fails (promotion) |
| `bun run test:ci-gating` | only `published-packages.test.ts` fails (Phase 7) |
| `verify:deployments`, both builds with `verify:build-target`, `build:landing` | exit 0 |

`git status --porcelain` was empty after the run.
