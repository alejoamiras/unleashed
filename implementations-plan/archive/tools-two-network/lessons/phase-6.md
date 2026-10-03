# Phase 6 — Testnet cutover (EXECUTED)

**Live:** TestUsdc `0x032E4F5f21d74AE177b96BeD98E472FFA9D62448`, fresh
forked portal `0xe0fd81b5ddb13bbb64243d018a6e9c3dfae8d21f`, fresh L2 trio; fuel = core-only
(swap retired, D22); full suite 520/520 vs the LIVE manifest.

## The pre-cutover bug-bash loop (owner-directed, codex gpt-5.6-sol @ xhigh)
4 fresh rounds + 1 resume → convergence (`satisfied` + "Go for the Sepolia testnet cutover"):
r1 iterate(9): the cutover was NOT deployable as written (reuse hard-stop, unwired deployer,
smokes bypassing the app path, promote demanding a faucet candidate, unpinned forge broadcaster,
previews broken). r2 iterate(6): pools are TOKEN-KEYED → D22 swap retirement; digest-ordering
vacuity; 18-dec smoke amounts. r3 iterate(4): recorded swapTargetContract; intent-FIRST ordering.
r4 iterate(1): live-core backfill (zero-seed byte-compare) → resume: satisfied. ~20 findings total,
every one fixed + unit-pinned before a single Sepolia tx.

## Live-execution findings (things only a real run surfaces)
- **Unchecked receipt status in `runRouterDeposit`** (the APP's own path): a reverted `bridge()` has
  empty logs and masqueraded as "no Bridge event". Now throws `bridge() REVERTED (<tx>)`.
- **Transient Inbox slot-capacity reverts**: back-to-back deposits ~20s apart in one ~36s Aztec slot
  can revert; identical calldata succeeded on eth_call replay next block. The smoke retries REVERTED
  3× with a 45s backoff; the app's journal/retry UX already covers users.
- **Zod-vs-raw key order**: promote compares the ZOD-parsed candidate against raw live JSON — schema
  key order ≠ file key order rejected a semantically identical core. `assertZeroSeed` now compares
  canonically (deep key-sort); key-set/value differences still reject.
- **The intent source-pin works**: it correctly STOPPED verification after mid-arc code fixes landed;
  procedure = commit fix → rebuild intent → re-record digest → commit → promote (file-only steps, so
  the reset balance baseline hides no spend).
- **Fixture doctrine**: token amounts/symbols in component tests must derive from the manifest
  (`BRIDGE_TOKEN_DECIMALS`/`SYMBOL`); Fee-Juice rows stay 18-dec (FJ is chain-fixed).
- Operational: the env's Alchemy Sepolia RPC has intermittent DNS failures here (publicnode used as
  read fallback) — and its key leaked into one error trace: **owner may want to rotate it**.

## Residuals for the owner
- AZLO-era journals/backups no longer resolve (expected, D18 — play money; heads-up only).
- The AZLO-era swap stack (pools/quoter) is retired; re-enabling swap-fuel anywhere = a new rollout
  (pools + e2e first), per codex r3.
