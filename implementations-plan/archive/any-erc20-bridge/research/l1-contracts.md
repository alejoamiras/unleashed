# Research: L1 contracts (`contracts/bridge/evm`)

Snapshot: the base branch (post hardening arc).

## Contracts in `src/`

| Contract | Shape | Owner / mutability | Per-token coupling |
|---|---|---|---|
| `SwapBridgeRouter.sol:49` `is Ownable2Step, ReentrancyGuard` | ctor `(permit2, feeJuicePortal, swapTarget)` `:130`; immutables `permit2` `:59`, `feeJuicePortal` `:60`; ONE storage slot `swapTarget` `:61` | owner = deployer; `setSwapTarget` `:143`, `sweep` `:290` | none — token + portal are call params |
| `UniswapFuelSwap.sol:33` `is IUnlockCallback, Ownable2Step` | ctor `(poolManager, feeJuice, weth)` `:55`; all three immutable `:37-39`; hand-rolled `_locked` guard `:42-49`; `receive()` `:66` | `sweep` `:279` only | feeJuice + weth baked per instance; input token is a `swap()` param |
| `MintableERC20.sol:17` | ctor `(name, symbol, decimals, maxWholePerTx)` `:29`; `PERMIT2` const `:19`; permissionless capped `mint` `:41`; **`allowance()` override → max for Permit2 for every holder** `:47-50` (L-4) | none | testnet-only |
| `TestUsdc.sol:20` | same minus the Permit2 override — exercises the real `approve(Permit2)` path | none | testnet-only |
| `InertSwapTarget.sol:13` | `fallback`/`receive` revert `Inert()` — fills the router's non-zero swapTarget slot on bridge-only deploys | none | — |
| `mocks/MockSwapTarget.sol:20` | `setRate` `:30` permissionless — sandbox only | none | — |
| `interfaces/ITokenPortal.sol:8` | ONLY `depositToAztecPublic(bytes32,uint256,bytes32)` + `depositToAztecPrivate(uint256,bytes32)` — no `underlying()` → router cannot introspect the portal | | |
| `interfaces/IFeeJuicePortal.sol:11` | deposit + `UNDERLYING()` | | |

## `SwapBridgeRouter` API (the A-1 surface)

- `bridgeWithFuel(BridgeParams p, PermitParams permit) nonReentrant` `:153`. `BridgeParams` `:83-96`: `tokenPortal, bridgeToken, totalAmount, fuelAmount, aztecRecipient, fuelRecipient, tokenSecretHash, fuelSecretHash, minFuelOutput, PoolKey[] path, bool[] zeroForOnes, isPrivate`. Guards `:154-158` require `0 < fuelAmount < totalAmount` (so "all fuel" is rejected today). Flow: witness pull `:163` → `forceApprove` + `swapTarget.swap` `:192-194` → three fuel guards (`>= minFuelOutput` `:198`; FJ balance delta `:201`; strict token-consumed equality `:206`) → `feeJuicePortal.depositToAztecPublic` `:213` → token leg `:220-227` → `BridgeWithFuel` event `:229`.
- `bridge(SimpleBridgeParams p, PermitParams)` `:244`; witness built with fuel fields zeroed but `swapTarget` still bound `:266`. Fuel-only reuses `bridge()` with `tokenPortal = FeeJuicePortal` (`test/SwapBridgeRouterPermit2Fork.t.sol:424`).
- Witness `struct BridgeWitness` `:113-126`, 12 flat fields: `tokenPortal, bridgeToken, totalAmount, fuelAmount, aztecRecipient, fuelRecipient, tokenSecretHash, fuelSecretHash, minFuelOutput, routeHash, isPrivate, swapTarget`. `_hashBridgeWitness` `:328`, `_hashRoute = keccak256(abi.encode(path, zeroForOnes))` `:348`. Pinned byte-for-byte to `packages/bridge-core/src/l1.ts` by `test/WitnessHash.t.sol:56-57`. **Any field change is a 3-way coordinated edit** (Solidity ↔ `l1.ts` ↔ `WitnessHash.t.sol`).
- **`tokenPortal` is a parameter, never stored** (`:84`, `:99`, checked only `!= 0` at `:158`/`:246`). README `:52-59` documents A-1: on-chain allowlist or immutable binding required before value tokens. `test/SwapBridgeRouterFuzz.t.sol:255 testFuzz_hostilePortal` asserts the strand, `:287` asserts `sweep` recovers.
- No allowlist anywhere.

## `UniswapFuelSwap` route grammar (`_validateRoute` `:228-268`)

1. first hop must sell `inputToken` (native side requires `inputToken == weth`) `:231-238`
2. last hop must output `feeJuice` `:242-244`
3. hookless only `:252`
4. continuity; the one sanctioned discontinuity is WETH→native on the FINAL boundary `:263-264` (tightened; reverse rejected).

`unlockCallback` `:119-190` is delta-driven: per-hop exact-input assert `"partial fill"` `:151-152`; take positives first `:169-171`, then settle negatives; native owed requires WETH balance `:179` (`"weth bridge shortfall"`).

Nothing hardcoded inside: pool constants live in scripts (`script/DeployBridge.s.sol:127-144`, `script/DeployBridgeMainnet.s.sol:63-78,86-89`, `script/DeployFuelLive.s.sol:41-74`). Quoting is off-chain (`IV4Quoter` `script/DeployBridgeMainnet.s.sol:22-33`, `_probeRoute` `:148-186` runs pre-broadcast).

## The forked portal

`@aztec/l1-artifacts@5.0.1` ships the canonical TokenPortal only as a compiled artifact; the vendored `upstream/TokenPortal.sol` was deleted. The living portal is the fork:

- no base contracts; storage `registry, underlying, l2Bridge, rollup, outbox, inbox, rollupVersion`; `address public immutable initializer` set in `constructor()` (H-1).
- `initialize(registry, underlying, l2Bridge)`: `NotInitializer`, `AlreadyInitialized` (F-001), derives rollup/outbox/inbox/version from `registry.getCanonicalRollup()`.
- `depositToAztecPublic` content `sha256ToField("mint_to_public(bytes32,uint256)", to, amount)`; `depositToAztecPrivate` content `"mint_to_private(uint256)"` (no recipient); `withdraw(recipient, amount, withCaller, epoch, numCheckpointsInEpoch, leafIndex, path)` reconstructs `L2ToL1Msg{sender: L2Actor(l2Bridge, rollupVersion), recipient: L1Actor(this, chainid), content: "withdraw(address,uint256,address)"}`, `outbox.consume`, `safeTransfer`.
- **One portal = one ERC20 + one L2 bridge, permanently.** `l2Bridge` is what authorizes withdrawals — the binding a factory must get right.
- Bytecode pinned three ways: `FORKED_PORTAL_KECCAK`, `PORTAL_PIN{solc 0.8.30, initCodeHash, runtimeCodeHash}` in `packages/bridge-core/scripts/portal-artifact.ts:27,34-38` + the committed forked portal artifact. Builds with solc 0.8.30 from the l1-contracts root vs 0.8.28 for `src/`. Now compiles in-project too (`allow_paths` + `@aztec-blob-lib/` remap in `foundry.toml`).
- Contrast: canonical `FeeJuicePortal` (`node_modules/@aztec/l1-artifacts/l1-contracts/src/core/messagebridge/FeeJuicePortal.sol:15`) is constructor-immutable (`ROLLUP/INBOX/UNDERLYING/VERSION` `:20-23`), content `"claim(bytes32,uint256)"` `:49`, no withdraw, no owner.

## Tests (19 files: 68 unit + 14 fuzz + 4 invariant + 5 halmos)

Hermetic (CI): `SwapBridgeRouter.t.sol` (mocks `MockPermit2:14`, `MockSwap:42`, `MaliciousPrefundSwap:67`, `MockTokenPortal:86`, `MockFeeJuicePortal:114`), `BlackhatAudit.t.sol` (F-A…F-H PoCs; exports `RecordingPermit2:35`), `RouteValidation.t.sol`, `WitnessHash.t.sol`, `ContentHash.t.sol` (3 fixed vectors `:24-26` ↔ Noir keystone), `PortalReinit.t.sol` (real portal), `MintableERC20.t.sol`, `TestUsdc.t.sol`, `SwapBridgeRouterFuzz.t.sol` (5 `testFuzz_`), `RouteGrammarFuzz.t.sol` (6), `PortalRoundtripFuzz.t.sol` (3; independent `sha256(preimage)>>8` model `:22`; exports `CapturingInbox/CapturingOutbox/FakeRollup/FakeRegistry` `:85-151`), `SwapBridgeRouterInvariant.t.sol` (handler `:59`; I1–I4), `FormalRouter.t.sol` (4 `check_`), `FormalPortal.t.sol` (1 `check_` + fixture-rot canary).

Fork-gated (`--no-match-contract Fork`, `SEPOLIA_RPC_URL` / `ETH_RPC_URL` via `vm.envOr` → `vm.skip`): `DeployBridge.fork`, `DeployFuelLive.fork`, `SwapBridgeRouterPermit2Fork` (12), `BlackhatV4Fork` (6; `:216 test_DEBUG_rawPmProbes` leftover), `MainnetFuel.fork`.

`foundry.toml`: `[profile.default.fuzz] runs = 256`, `[profile.default.invariant] runs = 256, depth = 500, fail_on_revert = false` (pinned deliberately).

CI: `.github/workflows/_bridge-contracts.yml` — Foundry **1.7.1** pinned (newer breaks halmos 0.3.3), libs pinned to commits (`forge-std@bf647bd6`, `openzeppelin-contracts@cab19933`, `v4-core@e50237c4`), `gen-remappings.ts`, `forge test --no-match-contract Fork`, halmos `--match-contract '^Formal'` with per-contract proof-count assertions; `noir` job runs the keystone; `sole-consumer` job runs `check-sole-consumer.sh`. Fork + TXE suites deliberately out of CI.

## Deploy scripts (`script/`)

`DeployBridge.s.sol` (Sepolia fixture; `PoolSetupHelper:31` reused by 3 files; `require(usdc < WETH)` `:185` depends on CREATE nonce luck), `DeployBridgeMainnet.s.sol` (pre-flight `EXPECTED_DEPLOYER`, chainid, code checks, `_probeRoute`; deploys swap + router only), `DeployFuelLive.s.sol` (idempotent via env reuse; `_guardPrice` ±10%), `SeedTokenPool.s.sol` (per-token TOKEN/WETH seeding; ETH/FJ leg carries across generations). **No CREATE2, no factory, no proxy, no registry, no config contract anywhere.** Addresses recorded via `console.log` + the TS journal.

OZ surface used: `IERC20`, `SafeERC20`, `ERC20`, `Ownable2Step`, `ReentrancyGuard`. Nothing else.

## Facts that constrain the redesign

1. `l2Bridge` authorizes withdrawals → the factory must bind it; per-token L2 addresses are Poseidon2+Grumpkin → not computable on L1 → **hub with constant `l2Bridge`** (owner-locked).
2. `bridgeWithFuel` rejects `fuelAmount == totalAmount` → swap-in-place needs a router change + halmos proof extension (`FormalRouter.t.sol:94`).
3. Witness is 3-way pinned; keep 12 fields if possible (bind the portal by DERIVING it from `bridgeToken`, not by adding fields).
4. Portal source change = regenerate + review + re-pin (`portal-artifact.ts`), and the ContentHash/PortalRoundtrip suites must stay green with zero vector edits.
5. `README.md:35-42` is stale (says 32 tests, canonical portal) — docs phase must fix.
