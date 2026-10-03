# Phase 1 — `TokenPortalImpl` + `PortalFactory` + Arc-1 keystones

The task branch (Arc 1).

## What shipped

- `contracts/bridge/evm/src/{TokenPortalImpl,PortalFactory}.sol` + `interfaces/IPortalFactory.sol`: immutable-args clones (OZ 5.7.0 `Clones.cloneDeterministicWithImmutableArgs`, salt = `bytes32(uint160(token))`), `ReentrancyGuardTransient` on the clone, `Ownable2Step` guardian with renounce disabled, two pause bits, bounded metadata reads (`METADATA_GAS = 100_000`, 96-byte return buffer, string OR bytes32 metadata, `_sanitize` to `0x00 ‖ 31 printable-ASCII bytes`), `decimals()` mandatory (exactly one word, ≤ 255), factory-sent `register` message with the public secret hash, `Registration` stored with `registerIndex` (`uint64`), `tokenOf` inverse map.
- `packages/bridge-core/src/{portal-address,register-hash,factory-abi}.ts` (+ tests; `factory-abi.test.ts` pins every const entry against the forge artifacts, lazily, skip-if-unbuilt like `router-abi.test.ts`).
- Tests: `Keystone.t.sol` (4), `PortalFactory.t.sol` (20), `PortalFactoryFuzz.t.sol` (2), `CloneRoundtripFuzz.t.sol` (3 — the legacy model replayed against a clone, with the hub as the L2 actor and the clone as sender/recipient), `PortalFactoryInvariant.t.sol` (4, 128k calls), `FormalFactory.t.sol` (2 halmos + 3 canaries), `FormalClone.t.sol` (2 halmos + 2 canaries), `BlackhatFactory.t.sol` (9 PoCs F-1…F-8), `FactoryFork.t.sol` (4, live Sepolia).

## Deviations from the plan (recorded, not silent)

- **halmos cannot traverse `createPortal`.** halmos 0.3.3's sha256 precompile stub declares its uninterpreted function by the wrong Z3 sort for the 164-byte register preimage (`Sort mismatch … f_sha256_164 ((_ BitVec 164)) supplied sort is (_ BitVec 1312)`), so `setUp` fails before any path runs. Per I6 the affected proofs concretized: `FormalClone` builds the clone through `Clones` directly (the pause checks precede any hashing, so the two pause proofs are still fully symbolic over their arguments); `check_createPortal_frontrunPreservesAddress` / `check_createPortal_idempotent` were replaced by `check_predictPortal_isCreate2OfInitcode` (∀ token, the prediction equals CREATE2 over the hand-built OZ initcode — with a canary proving the hand-built initcode is what the factory deploys) plus the forge coverage they already had (unit front-run/idempotence, fuzz, invariant I1/I4, blackhat F-1). Halmos table is now `FormalRouterTest 4 · FormalPortalTest 1 · FormalFactoryTest 2 · FormalCloneTest 2` (4 summaries) — plan gates for P1/P2/P8 and `_bridge-contracts.yml` updated to match.
- **`ContentHash.t.sol +register vector` folded into `Keystone.t.sol`**: the register hash + selector + secret hash are already the forge leg of the three-way keystone; a second forge literal for the same vector would be duplication, not coverage.
- **`PortalRoundtripFuzz` against a clone** lives in its own `CloneRoundtripFuzz.t.sol` (legacy file untouched except the `lastSender`/`sent` capture fields added earlier for the D1 tuple test) — zero legacy vector edits.

## Gate (all commands exit 0 unless noted)

- fast ✓ (`bun run lint` — 29 warnings / 13 infos pre-existing on the base branch; `typecheck:all` ✓)
- forge ✓ 106 passed / 0 failed (`--no-match-contract Fork`; the four compiler warnings are legacy: `UniswapFuelSwap.sol:122`, `BlackhatAudit.t.sol:371`, `FormalRouter.t.sol:61`)
- halmos ✓ 4/1/2/2, 4 summaries, no proof failures
- fork — `FactoryForkTest` 4/4, `DeployBridgeForkTest` 1/1, `BlackhatV4ForkTest` 6/6 ✓. **Two LEGACY suites fail against live Sepolia for environmental reasons unrelated to this arc** (their source files are byte-identical to the base branch):
  - `SwapBridgeRouterPermit2ForkTest` 7 failures: the suite signs as `vm.addr(0xA11CE)` = `0xe05f…cfF7`, and that well-known address now carries an **EIP-7702 delegation on Sepolia** (`cast code` → `0xef0100db53cf…`), so Permit2 routes the signature to `isValidSignature` on the delegate, which reverts. Fix = a non-famous signer key; scheduled for P2, which rewrites the router fork suite anyway.
  - `DeployFuelLiveForkTest` 3 failures: `PoolAlreadyInitialized()` (`0x7983c051`) — the "attacker pre-initializes our key" scenario now collides with the pool the live deploy actually initialized. Belongs to the legacy fuel deploy path retired in P8; re-evaluate when the deploy scripts move (P6).
- core ✓ 292 passed / 1 skipped (+ `factory-abi` 2 passed once forge `out/` exists)

## Tooling notes

- `vm.expectRevert` binds to the NEXT call, including a `view` getter used as an argument (`factory.createPortal(factory.IMPLEMENTATION())` attached the expectation to `IMPLEMENTATION()`); hoist argument reads into locals first.
- `vm.snapshotState()` / `vm.revertToState()` (forge-std ≥ 1.9) give an honest "same inputs, different first caller" comparison for the front-run PoC without a second fixture.
- The `Epoch` user-defined type is `uint256` in the ABI (`_epoch`), not the `uint32` its name suggests — the ABI pin caught it.
- Public Sepolia RPC (`https://ethereum-sepolia-rpc.publicnode.com`, per `.env.example`) is enough for the fork gate; no key, no `.env`.
