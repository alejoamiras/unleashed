# Phase 2 — the proof and the repaired regression

## What changed

- **`contracts/bridge/evm/test/FormalPortal.t.sol`** (new) — `check_initializedBindingsCannotChange`,
  one halmos proof, plus `test_registryBBindsAFreshPortal`, a plain forge positive control.
- **The portal shim** — deleted.
- **`contracts/bridge/evm/test/PortalReinit.t.sol`** — rewritten against the real portal,
  trimmed to the init-once regression. Its front-run test is dropped: `BlackhatAudit.t.sol`'s
  `test_FA_portalInitFrontRun_reverts` already covers that guard on the real contract, and the
  mutation matrix below shows it does.

All mocks are imported from `PortalRoundtripFuzz.t.sol` rather than copied — three near-duplicate
fake-registry sets already existed and a fourth would have been drift.

## Mutation matrix — the acceptance evidence

`forge build --ast --force` was re-run after every apply and every restore, immediately before halmos:
a stale-AST run reads identically to "the mutation was not caught" and would be grounds for deleting a
good proof.

### Row 1 — remove `if (address(registry) != address(0)) revert AlreadyInitialized();`

The proof fails, on the unwanted-success branch:

```
Counterexample:
    p_candidateUnderlying_address_1d312ad_00 = 0x00
[FAIL] check_initializedBindingsCannotChange(address,bytes32) (paths: 3, time: 0.13s)
Symbolic test result: 0 passed; 1 failed
```

and so does the rewritten concrete regression:

```
[FAIL: next call did not revert as expected] test_F001_initialize_is_once_only()
```

while `test_FA_portalInitFrontRun_reverts` stays green — it is about the other guard.

**The failure is for the right reason.** With the guard gone the second `initialize` returns normally
and trips `assertTrue(false, "re-initialized an already-initialized portal")`. It is not an incidental
revert reaching the catch branch, and not a value comparison: the unwanted-success assertion fires
whatever the candidate arguments are, so the proof holds even where a candidate happens to equal what
is already bound.

### Row 2 — remove `if (msg.sender != initializer) revert NotInitializer();`

```
test_FA_portalInitFrontRun_reverts      → FAIL
check_initializedBindingsCannotChange   → PASS (1 passed; 0 failed)
test_F001_initialize_is_once_only       → PASS
```

This row is what distinguishes the proof from a duplicate of the concrete tests. It targets the
init-once guard specifically and correctly does **not** react to the deployer-only guard, which
`test_FA` owns. A proof that reddened on both would be evidence of a coincidental failure rather than a
property.

### Restore

Both guards restored, everything green again: `1 passed; 0 failed` symbolically, 62/62 on forge.

## Gate result

| Check | Result |
|---|---|
| `halmos --contract FormalPortalTest` | `Symbolic test result: 1 passed; 0 failed` — no truncation warning |
| `forge test --no-match-contract Fork` | 62 passed, 0 failed |
| mutation matrix | both rows hold, in both directions |
| orphaned shim references | only the forked portal's header, deliberately stale |

### The count was degenerate — assert by name

`forge test --list` shows **0** of `FormalRouter`'s 4 `check_` functions, so proofs never enter the
forge total. Dropping `PortalReinit`'s front-run test (−1) and adding the positive control (+1) leaves
62 either way, meaning a count could not distinguish the intended swap from a silently dropped test.
Verified by name instead:

```
test_registryBBindsAFreshPortal      present
test_F001_initialize_is_once_only      present
test_F001_initialize_frontRun_reverts  ABSENT   ← intentional
```

This is the same "counts do not preserve identity" trap the plan's audit caught in the CI gate design,
recurring one layer down. Worth remembering that it applies to forge totals, not just halmos ones.

## Two harness properties that must survive future edits

> **Superseded in part by the arc-2 review.** As written below, both were *soundness* requirements —
> true of the version described here, which used a bare `catch`. The selector assertion added since
> (`assertEq(bytes4(reason), AlreadyInitialized.selector)`) makes either failure produce the
> wrong selector and red the proof, so neither can now cause a silent pass. They remain **targeting and
> diagnostic** choices, which is why they stay. See `phase-3.md`.

1. **No symbolic caller, no prank.** The test contract deploys `locked`, so it *is* the initializer and
   a direct call clears the deployer-only guard to land on the init-once guard. The plan's first draft
   reused the router's `vm.assume(caller != owner)` shape; with a symbolic caller assumed
   non-initializer, every path exits through `NotInitializer`. Before the selector assertion that meant
   staying green with the guard deleted; now it means failing on a selector mismatch. Calling directly
   is what *aims* the proof at the right branch.
2. **Registry B stays operational.** If its rollup calls began reverting, the second `initialize` would
   revert for that unrelated reason — again caught now by the selector, but as an obscure symbolic
   failure. `test_registryBBindsAFreshPortal` turns that into an immediate forge-level diagnosis.
