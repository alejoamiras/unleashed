# Phase B2 — F-004 (swapTarget in witness) + F-006 (minOutput floor) (PR B)

**Done.**
- **F-004:** `swapTarget` added as the 12th `BridgeWitness` field, appended LAST (least churn, consistent), across Solidity (`SwapBridgeRouter` TYPEHASH + TYPE_STRING + struct + `_hashBridgeWitness` + both call sites → bound to `address(swapTarget)`) AND the JS mirror (`l1.ts` `BRIDGE_WITNESS_TYPE` + `BridgeWitness` iface + `BRIDGE_WITNESS_PERMIT_TYPES` + `hashBridgeWitness`; `flows.ts` `runSwapBridge` witness + new `SwapBridgeParams.swapTarget`). `setSwapTarget` now voids every outstanding signature. (Threat framing: a consent-to-target gap — the router already binds `routeHash`+`minFuelOutput` + self-enforces the floor — not a live drain.)
- **F-006:** `require(minOutput > 0)` in `UniswapFuelSwap.swap`.
- **Cross-pin:** `WitnessHash.t.sol` flipped `console2.log`→`assertEq` with the new 12-field hash `0xf910b941…313b`; `l1.test.ts` `WITNESS_HASH` updated to match (the bidirectional pin the disconnected-CI F-003 would have run); the `BRIDGE_WITNESS_PERMIT_TYPES == BRIDGE_WITNESS_TYPE` drift-check stays green. `ROUTE_HASH` unchanged (the route excludes swapTarget).
- **Fixtures updated:** both fork-test `_sign` witnesses (`+swapTarget: address(router.swapTarget())`), both `l1.test.ts` vectors (`+addr(0x9abc)` = Solidity `0x…09ABC`), `flows.test.ts` baseParams + `swap.test.ts` params() (`+swapTarget`).

**Validation gate (passed):** `forge test` → **35 passed** excluding `DeployFuelLive.fork.t.sol` (its 2 live-Sepolia-pool tests fail on the PRE-B2 tree too → pre-existing pool-state flake, NOT B2; deferred to B5). The **5 real-Permit2 fork tests pass** → the 12-field witness verifies end-to-end with real Permit2. `bun run --cwd packages/bridge-core typecheck` clean + **109 tests** (cross-pin consistent).

**PoC split:** unit (`PortalReinit.t.sol`) done in B1. `PortalReinit.fork.t.sol` (asserts a 2nd-init revert against the NEW deployed portal) deferred to B-canary — nothing on-chain to assert against until B6.

**Decision (no codex):** mechanical 12th-field append; correctness guaranteed by the Solidity↔JS cross-pin + the real-Permit2 fork validation. **Held local** (public repo, PR-B disclosure).
