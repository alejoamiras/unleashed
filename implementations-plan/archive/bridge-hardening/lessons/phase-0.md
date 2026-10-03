# P0 — honest baseline

Re-establishing what this arc actually passes, because no number recorded in any of the ten PR
bodies had ever been reproduced by CI or by a second machine.

## Finding 1 (blocking): the forge suite does not build from a clean checkout

`forge build` fails at the bottom of the stack with:

```
Unable to resolve imports:
  "@aztec-blob-lib/BlobLib.sol" in .../l1-contracts/src/core/libraries/rollup/FeeLib.sol
  "@aztec-blob-lib/BlobLib.sol" in .../l1-contracts/src/core/libraries/rollup/ProposeLib.sol
```

**Cause.** This repo sets `linker = "isolated"` (`bunfig.toml:14`), so there is no root
`node_modules/@aztec/` — `@aztec/l1-artifacts` resolves under
`packages/bridge-core/node_modules/`. `contracts/bridge/evm/foundry.toml` carries two static
hoisted-layout remaps (`@aztec/` and `@aztec-blob-lib/`), and `gen-remappings.ts` exists precisely
to override them with linker-correct paths — but it only emitted `@aztec/`. The
`@aztec-blob-lib/` alias, added alongside `allow_paths` so the suite could compile the REAL
upstream portal in-project, kept its hoisted TOML value and pointed at a directory that does not
exist under this repo's own linker.

`assertEffectiveRemapping` did not catch it: it validated only the `@aztec/` line, so the guard
reported "remappings OK" on a tree that cannot compile.

**Fix.** `gen-remappings.ts` now emits `@aztec-blob-lib/` derived from the same resolved
`@aztec/l1-artifacts` root, and the assertion loops over both aliases instead of one. Landed at
the bottom of the stack so every arc inherits it.

**Why it went unnoticed.** Nothing under `contracts/` runs in CI or in `audit:vue`, so the only
signal was a local run on a machine that still had a hoisted `node_modules` from before the
isolated-linker migration. This is the concrete cost of the ungated-contracts gap that P4 closes:
a build-breaking regression survived ten PRs and a codex pass.

## Baseline runs

Measured at the bottom of the stack once the remap fix
above made the project compile at all.

| Suite | Command | Result |
|---|---|---|
| forge (hermetic) | `forge test --no-match-contract Fork` | **46 passed / 0 failed**, 9 suites |
| forge (fork) | needs `SEPOLIA_RPC_URL` | not run |
| TXE | `contracts/bridge/aztec/scripts/run-txe-tests.sh` | pending |
| keystone | `aztec-nargo test` | pending |
| halmos | `halmos --contract FormalRouterTest` | pending |

**Count correction.** The bottom PR's body and its test-plan checkbox claim "50 passed"; the real hermetic
figure is 46 (`BlackhatAudit` 8, `SwapBridgeRouter` 10, `MintableERC20` 7, `RouteValidation` 7,
`SwapBridgeRouterFuzz` 5, `TestUsdc` 4, `ContentHash` 3, `PortalReinit` 1, `WitnessHash` 1). The
same PR also claims 4 `BlackhatV4Fork` tests where 3 exist — a debug probe with no assertions was
dropped in the branch's last commit and neither number was refreshed. Treat every self-reported
count in this arc as unverified until re-run.

Toolchain on this host: forge 1.7.1, aztec-nargo 5.0.1 available, node v24.18.0, halmos 0.3.3
(installs cleanly, whole symbolic suite runs in ~6s — it was never the blocker it looked like).

## Finding 2 (high): two of the four halmos proofs could not fail

`check_sweep_revertsForNonOwner` and `check_setSwapTarget_revertsForNonOwner` signalled an
unwanted success with `revert("...")`. halmos only recognises forge-std assertion failures and
EVM panics, so that revert is indistinguishable from the guarded revert the check exists to prove.

Verified by mutation on the real tree, not by reading: with `onlyOwner` removed from `sweep` —
a direct fund-drain primitive — halmos still reported `[PASS] check_sweep_revertsForNonOwner`.

A second, independent masking bug sat underneath it: the check passed the symbolic `caller` as
the sweep *recipient*, so the `caller == address(0)` path tripped sweep's own
`to != address(0)` require, producing a legitimate revert that reached the catch branch. Even
with correct signalling, that one path would have hidden every unauthorized success.

Both now signal with `assertTrue(false, ...)` and sweep to a fixed sink. Re-verified by mutation
in both directions: each check fails with a counterexample against the stripped guard and passes
once it is restored. The two accounting proofs were genuinely sound throughout.

## Finding 3 (high): the router invariant campaign could not fail either

Three compounding defects, all found by mutation testing rather than review:

1. The only swap target ever installed reported exactly what it transferred — on construction
   and again after every rotation — so I3 ("fee portal received exactly what swaps reported")
   held by construction across 128,000 calls.
2. The handler held no FJ. `MintableERC20`'s fourth constructor argument is a per-transaction
   mint cap, not an initial supply, so every FJ donation reverted on insufficient balance and
   was swallowed by the invariant runner's default `fail_on_revert = false`. That branch had
   never executed once; I1's FJ leg only ever compared zero to zero. The 6-vs-18 decimal scaling
   bug in `donate()` was invisible for the same reason.
3. Fuzz and invariant settings were entirely unpinned, so coverage was whatever the installed
   Foundry happened to default to.

Fixed by adding a hostile under-delivering target plus a fourth invariant asserting the router
refuses it, varying the honest reported output per call, minting the handler an FJ float,
scaling FJ donations by `1 ether`, and pinning `[fuzz]`/`[invariant]` explicitly.

**Mutation evidence.** Disabling the router's balance-delta guard is caught by all four
invariants now; before this change it was caught by none. An intermediate version of the new
hostile action signalled with `revert(...)` and was itself silently swallowed by
`fail_on_revert = false` — the same defect class as Finding 2, caught in new code before it
shipped. Detection now goes through a ghost flag that I4 asserts on.

## Finding 4: the invariant regression was real and undisclosed

The codex fix round rewrote I2 from observed-sink measurement back to a ghost-against-ghost
comparison, and deleted the read-backs and rotation tracking it depended on. Both sides of that
comparison are incremented from the same computed values in the handler, so it held regardless
of router behaviour. An earlier commit in this same arc had specifically replaced that
tautology. Neither the PR description nor the commit message mentions the change. Restored.
