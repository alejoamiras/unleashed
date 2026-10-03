## Outcome

Archived. Seeds retired.

# bridge-hardening

Hardening arc for the faucet→bridge contracts (`contracts/bridge/{evm,aztec}`): land the
blackhat PoC suite, fix its two actionable findings, then add fuzz/property coverage and a
time-boxed symbolic-formal pass.

## Provenance

Adversarial audit session against the pre-production bridge contracts. Method: full read of
every contract + deploy conductor, then exploit PoCs written as forge tests. Two findings were
actionable (H-1, M-1); the rest either proved defenses hold or are informational.

## Findings summary

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| H-1 | High (conditional) | Portal first-initialization front-runnable → brick + drain if poisoned address published | Fix: deployer-pinned initializer (Arc 2) |
| M-1 | Medium | `_validateRoute` accepts `{X/native},{native/FJ}` which Case-C settlement cannot pay | Fix: delta-driven settlement (Arc 3) |
| L-1..L-5 | Low/info | signable zero slippage, FoT DoS, migration sig invalidation, Permit2 allowance hardwire, zero-recipient mint | Documented; frontend/ops mitigations exist |

L-5 (`claim_public` accepts a zero recipient) stays accepted for this arc. An in-contract guard
changes TokenBridge bytecode, hence its class id and deployed address, which strands the faucet's
committed manifests until a redeploy — and the redeploy is out of scope here. It ships as its own
`fix(bridge)` PR sequenced with that redeploy. `claim_private` and both exit paths already carry
their own zero-recipient guards; only the public claim is exposed, and only to a caller who
supplies a valid L1 message naming the zero address as recipient.

Independently verified sound: content-hash keystone (re-derived from first principles:
`sha256(selector ++ args) >> 8`), witness binding + nonces, delta-based accounting vs
donations, reentrancy posture, sole-consumer invariant, recipient-committed claim secret.

## Arcs (each = one stacked PR via gh stack)

### Arc 1 — blackhat tests land (`test`)
- `contracts/bridge/evm/test/BlackhatAudit.t.sol` (8 unit PoCs) +
  `test/BlackhatV4Fork.t.sol` (3 tests vs the real Sepolia V4 PoolManager, RPC-gated).
- `foundry.toml`: `allow_paths` + `@aztec-blob-lib` remap so the [F-A] PoC compiles the REAL
  upstream portal in-project.
- Gate: hermetic `forge test` green; RPC-gated tests skip unless `SEPOLIA_RPC_URL` is set,
  rather than defaulting to a public endpoint.

### Arc 2 — H-1 fix: deployer-only initializer guard (`fix`)
- DEVIATION from the approved constructor-init, discovered during implementation: a portal
  constructor would need the L2 bridge address, but that address is deterministically derived
  FROM the deployed portal address (bridge ctor args = [proxy, portal]). Under DIRECT EOA CREATE
  that address is nonce-predictable pre-broadcast, so constructor-init is feasible; it was still
  declined to avoid restructuring both conductors mid-flight. The
  equivalent fix: the constructor pins `msg.sender` as an immutable `initializer`, and
  `initialize` reverts `NotInitializer` for anyone else. The front-run dies; both conductors'
  two-phase flow survives unchanged.
- Bytecode changed → `FORKED_PORTAL_KECCAK` + `PORTAL_PIN` + the forked portal artifact
  regenerated via `build-portal-artifact.ts`; conductors gained a same-key resume note.
- Regression proof: `ContentHash.t.sol` + Noir keystone stay green UNTOUCHED (message hashes are
  storage-independent); [F-A] PoC flipped to assert the attack now reverts.

### Arc 3 — M-1 fix: delta-driven settlement (`fix`)
- `UniswapFuelSwap._settle` Cases A/B/C → accumulate per-hop `(currency, int128)` deltas from
  PM's returned BalanceDeltas → take positives → unwrap WETH→ETH only if native owed → settle.
  Mid-native handoffs net to zero (no-op); mid-WETH shapes untouched; the hostile shape becomes
  correct-or-cleanly-reverted. Validation unchanged.
- Tests: existing route/settlement suites stay green; previously-hostile shape added as a
  behaving case; [F-G] kept as regression.

### Arc 4 — fuzz + property hardening (`test`)
- Router: Foundry invariant suite with handler (bridge/sweep/setSwapTarget/donate sequences):
  nothing at rest beyond donations; deposits == pulled − swapped.
- Swap: route-grammar fuzzer on `_validateRoute` (hermetic) + settlement fuzz behind the
  `SEPOLIA_RPC_URL` skip-gate.
- Portal: content-hash roundtrip fuzz (random inputs ↔ captured inbox hash ↔ withdraw
  reconstruction).
- Noir: nargo built-in fuzzing on pure libs (`claim_secret`, content-hash) via pinned
  `aztec-nargo`; contract-level behavior stays with keystone pins + sandbox smoke (scope limit).

### Arc 5 — formal, last, research-first (`test`, NIT)
- Phase A: survey EVM symbolic tools (Halmos / Certora / Kontrol) for solc 0.8.28 + via-ir fit;
  time-boxed half day; choice + rationale recorded in `lessons/`.
- Phase B: prove "router net balance change == 0 on any successful bridge*" and "no token
  movement without a valid witness". Cut and document if the tool fights past the box.

### Arc 6 — economic parameter audit (`test`)
- Inventory every economic knob across the bridged-faucet surface in
  [econ-matrix.md](econ-matrix.md): definition site, who can change it, failure mode, pin.
- Tighten the one untightened knob — the Permit2 signing deadline, 30 min → 600 s — behind a
  shared `PERMIT_DEADLINE_SECONDS` with a value pin AND a reachability guard, since a value pin
  alone cannot see a call site that computes its own literal.

### Arc 7 — frontend economic review (`fix`)
- Line-review `useDeposit` / `useWithdraw` / `fuelClaim` against the matrix; record findings and
  their disposition rather than only the fixes.
- Extract the fuel-target selector (public → user, private → canonical PrivateFPC) and pin it
  against the exported constant, not merely against "address-shaped and not the user".

### Arc 8 — testnet redeploy (`ops`) — NOT IN THIS ARC
- Requires operator credentials. Descoped from the revival by owner decision; the L-5
  zero-recipient guard rides with it, since an in-contract change moves the TokenBridge class id
  and strands the faucet's committed manifests until the deploy lands.

### Arc 9 — TXE suite (`test`)
- Contract-level behavior for the TokenBridge under Aztec's TXE: claims public and private,
  both exits, ownership transfer, and the proxy's mint/burn gates, driven by
  `scripts/run-txe-tests.sh`.
- Adversarial parity between the public and private paths is the acceptance bar — replay, pause,
  zero-recipient and direct-call bypass on BOTH, not just whichever was easier to reach.

### Arc 10 — TS↔circuit mirror (`test`)
- [txe-ts-map.md](txe-ts-map.md) maps each Noir behavior to its TS counterpart and the pin that
  holds them together.
- A conformance oracle for `buildFuelRoute` against `_validateRoute`'s documented rules. It
  restates those rules in TypeScript and executes nothing on the Solidity side, so it cannot
  catch drift introduced there — keeping the two in step stays a review obligation.

### Revival arc
Re-established the baseline (nothing here had ever run in CI), fixed what the missing gate had
let through, and wired the gate. Findings in [lessons/phase-0.md](lessons/phase-0.md).

Owner decisions, settled: the arc merges as a stack and lands as one unit, so intermediate PRs
need not each be independently deployable; the H-1 guard's deployer-key custody risk is accepted.
Losing the deploying key between `deploy` and `initialize` bricks the portal permanently, no
recovery path. Owner has signed off.

Local at the stack top: forge 62, TXE 33, halmos 4, bridge-core 261, faucet 548, lint 0,
typecheck clean. Every one of the revival's findings was a test, guard or CI step that could not
fail, and every fix was verified by mutation — break the thing, watch it go red. What the Status
table does not carry:

- Blackhat tests: the fee-on-transfer test was green for a missing USDC allowance; removing the
  tax entirely left it passing.
- TXE suite: six negative tests were satisfied by a dead oracle.
- CI (new), four self-inflicted: bun missing, halmos passing with zero proofs, and three unpinned
  toolchains (Aztec, forge libraries, Foundry) resolving differently than validated.

Process lesson worth carrying: a file copied from the stack top onto a lower branch broke that
branch's compile AND caused a later cascade to drop the H-1 PoC flip as "already applied" —
leaving a PR that adds a security guard without the test proving it works. CI caught the compile
error; it would NOT have caught the dropped hunk, because the remaining tests still passed. After
any cascade, diff the whole stack against its previous tip and confirm every difference is
intended.

## Validation gates

Per arc: full `forge test` in `contracts/bridge/evm` (hermetic set must be green; fork-gated
tests need `SEPOLIA_RPC_URL`). Noir keystone via pinned toolchain:
`AZTEC_HOME=~/.aztec/versions/5.0.1 bin/aztec-nargo test` in `contracts/bridge/aztec/keystone`.
PR titles ≤93 chars budgeting the squash `(#NN)` suffix; conventional commits, lowercase subject.

## Environment notes

- v4-core MUST be installed at `@v4.0.0` (README pin); latest moves structs and breaks the build.
- `SwapBridgeRouterPermit2Fork` positive flows require maintained testnet state (live pools/
  balances); they fail against fresh public-RPC forks. Replay/tamper/deadline variants pass anywhere.

## Tracked follow-ups

- Path-filtered bridge-contracts CI job (forge tests currently ungated on the base branch).
- TXE suite CI gating (run-txe-tests.sh behind a self-hosted/manual gate until the oracle server ships in CI images).
- Partial-fill regression via fake PoolManager harness; `should_fail_with` upgrade for bare Noir negative tests.

## Status

Counts below are measured, not self-reported: every figure the original arc recorded was a local
claim on a machine with a stale `node_modules`, and several were wrong.

| Arc | State |
|---|---|
| 1 blackhat tests | ✅ 47 hermetic forge tests (the arc recorded 50; the real pre-revival figure was 46). M-1's validation proof moved out of the RPC-gated suite |
| 2 H-1 guard | ✅ deployer-pinned initializer, not constructor-init, with the liveness trade-off the owner accepted. Conductors now preflight the pin |
| 3 M-1 delta settlement | ✅ + production-shape regressions |
| 4 fuzz/invariants | ✅ 4 invariants, falsifiable — the campaign could not fail before (honest-only swap target, an FJ donation branch that never executed, unpinned config) |
| 5 halmos formal | ✅ 4 checks, falsifiable — two proved nothing before: stripping `onlyOwner` off `sweep` still reported PASS |
| 6 econ audit | ✅ matrix + 600 s deadline, now applied at all THREE signing sites with a reachability guard |
| 7 frontend review | ✅ fuel-target helper pinned against the canonical FPC constant |
| 8 testnet redeploy | ⏸ OUT OF SCOPE by owner decision; L-5 rides with it |
| 9 TXE suite | ✅ 32 tests (the arc recorded 16 for a 24-test suite). Runner was unrunnable under this repo's linker and died above ~24 tests |
| 10 TS mirror | ✅ oracle rejection branches now exercised; two were unreachable |
| CI gate | ✅ `contracts.yml` — forge, halmos, keystone nargo, sole-consumer. Nothing under contracts/ ran in CI before |
| codex loop | ⏳ the original 4 rounds landed real fixes but also regressed invariant I2 and the fork skip-gate, both undisclosed. A fresh per-arc loop is outstanding |

Original codex session: gpt-5.6-sol xhigh, session 01a025b9-a997-7e20-a075-122542ba69cd (no
transcript was saved; the round count is recorded inconsistently as r1 / rounds 1-3 / 4 rounds).
It caught partial-fill stranding (High), the reverse-unwrap gap, the immutable-vs-runtime-hash
deploy aborter, and the stack's own broken topology.

## Tracked follow-ups (still open)

- Hermetic partial-fill regression via a fake PoolManager harness. The current proof is
  fork-gated, and every settlement test seeds liquidity deep enough that a partial fill cannot
  occur — so "zero residue" passes vacuously with respect to the bug it should catch.
- Pin the `weth bridge shortfall` and reverse-unwrap revert paths, which needs the same harness.
- TXE in CI, once the oracle server is in a runner image AND its reader limit is raised.
- `PortalReinit.fork.t.sol` against the deployed bytecode, at the canary/cutover.
- L-5 `claim_public` zero-recipient guard, sequenced with the Arc 8 redeploy.
