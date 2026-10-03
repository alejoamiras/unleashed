# Phase 9 — swap+fuel orchestration + real-V4/Permit2 fork validation

**Status:** ✅ contract + bridge-core orchestration + fork validation DONE (app UI + L2 claims remain, sandbox-gated). Closes audit #6.

## What's proven
- **bridge-core `runSwapBridge`** (`flows.ts`): signs the Permit2 witness-bound transfer → `bridgeWithFuel` → reads BOTH leaf indices from the **`BridgeWithFuel` event** (not deposit-order guessing — the contract emits `tokenIndex` + `fuelIndex` explicitly). 2 vitest unit tests (mocked L1 + hand-built event log).
- **`SwapBridgeRouterPermit2Fork.t.sol`** — forks Sepolia, drives the **REAL Uniswap V4 + REAL Permit2** through `bridgeWithFuel`: public swap, private swap (`isPrivate=true`), nonce-replay revert, deadline-expiry revert, **witness-tamper revert**. 5 fork tests; 32 forge tests total.

## The Permit2-witness digest in Solidity (I'd wrongly judged this intractable)
No permit2 npm/lib is vendored, but the `PermitWitnessTransferFrom` digest is fully **constructible** from what's on-chain + the router:
1. `permitTypehash = keccak256(abi.encodePacked("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,", router.BRIDGE_WITNESS_TYPE_STRING()))` — the router exposes the witness type-string as a `public constant`.
2. `tokenPermissions = keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), token, amount))`.
3. `witnessHash` — via a `Harness is SwapBridgeRouter` exposing `_hashBridgeWitness` (cross-pinned to `BRIDGE_WITNESS_TYPEHASH` by WitnessHash.t.sol, so no drift).
4. `structHash = keccak256(abi.encode(permitTypehash, tokenPermissions, spender, nonce, deadline, witnessHash))`.
5. `digest = keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR(), structHash))` — Permit2's `DOMAIN_SEPARATOR()` is public.
6. `(v,r,s) = vm.sign(userPk, digest); sig = abi.encodePacked(r, s, v)`.

## Fork-harness techniques
- **Mock only the Aztec portals**; keep the swap + Permit2 REAL. `MockFeeJuicePortal.UNDERLYING()` returns the real FeeJuice address so the router's balance-readback works; `MockTokenPortal` just `transferFrom`s the bridged remainder. This isolates the V4 + Permit2 validation from the (separately-proven) L1→L2 message portals.
- **Route USDC→FeeJuice = 2 hops**: USDC/WETH pool (our new pool) → ETH/FeeJuice pool (live), with the WETH→ETH unwrap at the **last** boundary (the only place `_validateRoute` + `_settle` allow it). `path` uses `IUniswapFuelSwap.PoolKey` (plain addresses); the helper's pool seed uses the V4 `PoolKey` (Currency-wrapped) — different types, same pools.
- **Swap amounts**: totalAmount 10 USDC, fuelAmount 2 USDC, `minFuelOutput 1` swap cleanly through the seeded pools (6e13 USDC/WETH liquidity).
- **Witness-tamper test**: sign for params `p`, then mutate a bound field (`aztecRecipient`) before the call — the router re-derives the witness from the mutated `p`, the Permit2 signature no longer matches, the transfer reverts. Runtime proof of codex's static finding ("no relayer path to change recipients/amounts after signing").
- The fork is **opt-in** (`vm.envOr("SEPOLIA_RPC_URL","")` → `vm.skip` if absent); forge auto-loads `.env`. Skipped in CI, runs locally.

## Remaining (sandbox-gated)
The L2 claims of the bridged token (claim_*) + the fuel (publicFeeJuicePayment) + the app swap UI need a live aztec sandbox. The L1 swap+bridge + Permit2 are now proven against mainnet-shaped contracts.
