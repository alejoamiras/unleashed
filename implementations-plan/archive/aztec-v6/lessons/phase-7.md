# Phase 7 — Canaries, docs, close the supply-chain window

## Canaries against the promoted manifest

| Canary | How | Success line |
|---|---|---|
| `verify:l1 --strict` | read-only, public Sepolia RPC | `✓ L1 verification passed` |
| `verify:deployments` with `BRIDGE_MANIFEST=public/testnet-bridge.json` | read-only | `All committed addresses match the rebuilt instances.` (USDC, USDT, EURC, GBPC) |
| `verify:deployments` (faucet record) | read-only | `All committed addresses match the rebuilt instances.` |
| `TOKEN_LIST_LIVE=1` `token-list.test.ts` | read-only | `Tests 15 passed (15)`. Without the flag it reports 14 passed and 1 skipped, so the live case ran |
| `drip-canary-testnet.ts` | keyless (throwaway account, sponsored) | `✅ DRIP canary PASSED — SIGNAL + NOISE dripped to a fresh account in 0.5m.` |
| `require-deployed`, then `PRIVATE_RUNS=1 FUEL_SLICE_UNITS=1500000 fuel-testnet.ts --config apps/tools/public/testnet-bridge.json` | keyed (`canaries-02ee2fd7`) | `✓ FPC gate green (require-deployed)` · `✅ 2 fueled runs SETTLED in 1.8m`. Public claim 2894438111086900000 FJ-wei; private-FPC claim 1987539846898200000, `getFeeLimit` 4961297777780000000 |
| `fee-juice-canary-testnet.ts --config apps/tools/public/testnet-bridge.json` | keyed (same chain) | `✅ DIRECT Fee-Juice SELF-PAY canary PASSED — mint→deposit(minFj)→self-pay-claim landed 14572232869986300000 FJ-wei (fee 1427767130013700000) in 1.3m.` |

The chain opened with `verify` and ran it again before the fee-juice canary; both were green. Spend after the chain: 1.030 of 2.0 ETH (`verify` read 1.029954 before the fee-juice canary).

The settle canary's `minFuelFj` (19.85 FJ) agrees with the full calibration (19.67 FJ). The floor stays at 29.77 FJ by the owner's decision (`lessons/phase-6.md`).

## CSP (Branch B step 11), against the Workers Builds preview of the promote commit

- The task branch has a preview alias; the Workers Builds check `unleashed-testnet` passed.
- It serves `connect-src 'self' data: blob: <TESTNET_NODE_URL> <the one token-list file>`: exactly the node constant and exactly one list entry.
- Both endpoints answer 200 with no redirect: the node to a POST `node_getNodeInfo`, and the token list to a GET.
- The preview's `/testnet-bridge.json` hashes to `345f68c0…c76f`, the promoted candidate.
- Left for the owner, as a manual pre-release check: drive the preview with the v6 wallet.

## Owner's manual pre-release check

The owner drove the preview with the v6 wallet. In their words: "it does show. And ive tested the dripper, and even bridging. worked awesomely." The wallet connected, the 4 tokens are listed, a drip landed and a real bridge completed.

## Final `live-intent verify` (`final-verify-9fd7ae5c`)

`✓ verify green — rollupVersion 2914217885, spend 1.030173/2 ETH (baseline 3 → 1.9698266977823546)`. The live window freeze ends here.

## After the freeze

- **The `pre-create` regression is fixed**. `preCreateToken` and `assertGeneration` now register the hub from the record before reading `token_for`, so a per-run wallet store no longer fails with "No artifact registered". The deploy tests' wallet now knows only what it was taught, so all seven tests fail on the old source.
- **Step 3, docs**. Phases 1–5 had already landed most of the change map. This commit adds the live arc's operational lessons:
  - `bridge-generation`: keyed runs and their templates, `env-exec`'s HEAD pin, a Sepolia RPC check, retiring the live manifest on a reset promotion, deleting forge's sensitive cache, and the fuel slice against the floor;
  - AGENTS.md and the package READMEs: the keyed-run key policy.

## Step 4 and the gate

The exclude was never committed: it lived in a local patch outside the tree. A frozen install never re-gates locked versions, so the committed `bunfig.toml`, which has no exclude, already installs. The 7-day wait only bounds a later `package.json` edit that re-resolves those packages.

| Command | Result |
|---|---|
| `bun install --frozen-lockfile --force` | exit 0, 759 packages, no exclude |
| `bun run audit:tools` | exit 0 |
| `bun run test:all` | exit 0: design 242, bridge-core 462 + 1 skipped, tools 1645 |
| `bun run test:ci-gating` | exit 0, 35 pass |
| `bun run lint:actions` | exit 0 |
| `bun audit` | exit 1: 64 advisories (30 high, 27 moderate, 7 low). This is the expected red: the set equals the pre-bump lockfile's (GHSA set diff empty), as in phases 1 and 5. CI runs it advisory |
| `npm audit signatures` | exit 0: 2015 verified signatures, 500 attestations |

Every canary's success line is in the table at the top.

## Post-implementation Codex loop

Run early, while phase 7's gate was being recorded, so the loop could converge on the final diff. Scope: `main...HEAD`, excluding the generated `target/*.json`, the lockfiles, the deploy journal, the live manifest and the intent JSONs. The prompt carried the adversarial ask and both rules verbatim.

### Round 1 (GPT-6 Astra, high; session `01a0f92c-7b24-7352-9cf9-83233cfa3f13`)

Verdict: no new runtime regression. It found three findings, each verified against the files, and all were accepted:

| # | Sev | Finding | Fix |
|---|---|---|---|
| 1 | HIGH | The SKILL's reset-baseline bootstrap trusted the node's graph after `cast code` alone, which is the procedure D15 rejected. This arc followed D15 (`lessons/phase-5.md`), but the runbook still described the old procedure. | The SKILL now gives D15's procedure: authenticate the registry and fee-asset handler upstream, walk the getters through two independent RPCs, and match every node claim. |
| 2 | LOW | The SKILL and `assertTreeDiscipline` said to commit a mid-arc source fix, but `assertNoSourceDrift` refuses that commit too. | Both now say a committed source change voids the intent. Work around a non-blocking defect until after the final verify; a blocking one needs a rebuilt intent that carries the spend tally forward. |
| 3 | LOW | `startLocalNetwork`'s doc block sat above `reapOnSignals`. | Moved back; the `reapOnSignals` comment is shortened to its invariant. |

Added alongside, a finding of the driver's own: the promotion receipt always said "network identity and L1 factory carried from the live manifest", even on the first-promotion path. It now records which path ran. The committed receipt for this arc keeps the old text; it was written by the tool at the time.

### Round 2 (same session, resumed)

Verdict: the reset authentication and the comment placement are fixed. Three accuracy issues remained, each verified and accepted:

| # | Sev | Finding | Fix |
|---|---|---|---|
| 1 | MEDIUM | "A rebuilt intent carries the spend tally forward" is false. `build` reads the current balance and installs a fresh `CAPS` allowance, so a rebuild after spending 1 ETH would authorize another 2. | The SKILL says carry-forward is unsupported. A blocking defect stops the arc for the owner, and recovery keeps the old intent and journal and reconciles cumulative spend against the original authorization. |
| 2 | LOW | `assertNoSourceDrift` compares endpoints (`git diff <build> HEAD`), so "every path changed since build" overstated it: a change committed and later reverted vanishes. | The SKILL and the comment say "differs between the build commit and HEAD". |
| 3 | LOW | A `bridge: null` live manifest passes `assertZeroSeed` on identity alone, so the receipt's "L1 factory carried" still overclaimed. | Receipt text: "existing live manifest: the generation interlock passed". |

### Round 3 (same session, resumed): converged

Codex's whole response: "no new material findings". The loop converged in three rounds; no finding was rejected.
