# Phase B1 — F-001: forked init-guarded portal (PR B)

**Done.**
- The forked portal = canonical `TokenPortal` byte-for-byte EXCEPT: renamed contract, `error AlreadyInitialized()`, and `if (address(registry) != address(0)) revert AlreadyInitialized();` as line 1 of `initialize`. Real `@aztec` interfaces (compiled/deployed/verified from the l1-contracts root). The content-hash-critical `depositToAztec*`/`withdraw` bodies are untouched → hashes don't drift.
- The forked portal's test shim = minimal LOCAL interfaces (`IRegistryMin.getCanonicalRollup()→IHaveVersion`, then `IRollupMin` getters) mirroring the guard + the registry→rollup double-cast, so it compiles in the bridge-evm Foundry project (the real @aztec tree does not). Omits deposit/withdraw (the guard test never calls them).
- `test/PortalReinit.t.sol` = always-on regression (shim + FakeRegistry/FakeRollup): first `initialize` wires storage; a second `initialize` by ANY caller reverts `AlreadyInitialized`; state unchanged.

**Validation gate (passed):** `forge test --root packages/bridge-evm --no-match-path 'test/*.fork.t.sol'` → **34 passed** (incl. PortalReinit + ContentHash 3/3 unchanged → no content-hash drift). Staged the forked portal into `node_modules/@aztec/l1-artifacts/l1-contracts/test/portals/` + `forge build` → **"Compiler run successful!"** (real-interface body compiles in the l1-root). Staged copy removed (B4 wires the staging into `verify-l1.ts`).

**Decision (no codex needed — mechanical mirror):** the shim reproduces the double-cast so its `initialize` exercises the same external-call shape as the deployed portal; the guard reverts on line 1, so the 2nd-init revert needs no @aztec messaging stack.

**Disclosure hold:** PR B commits stay LOCAL (not pushed) until B6 deploys the fix — the forked portal's header + the commits describe the STILL-LIVE F-001 (the canonical portal is re-initializable until cutover); pushing to a public branch would telegraph the live exploit. Deliberate deviation from the loop's "push" for PR B, consistent with the audit-report disclosure hold.
