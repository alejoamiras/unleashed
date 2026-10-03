# Solidity + Noir classics audit — scope + method

A deeper, classics-focused adversarial pass on the bridge's CONTRACT surface (Solidity + Noir),
requested while the candidate is under manual smoke-test. Complements the Phase 9 re-audit (which scoped
the *changed* surface) — this sweeps the *whole* contract surface against the classic web3 + Aztec/Noir
pitfall checklists, hunting for anything the prior audits missed.

## Method — three independent lenses + main-agent read

- **Codex xhigh** — full Solidity + Noir, classics checklist.
- **Fable subagent A** — deep Solidity/web3 classics (SwapBridgeRouter, UniswapFuelSwap, MintableERC20, portal).
- **Fable subagent B** — deep Aztec/Noir classics (token_bridge, token_minter_proxy, claim_secret, keystone).
- **Main agent** — independent read of the crux + consolidation.

## Surface

Solidity (`contracts/bridge/evm/src/`): `SwapBridgeRouter.sol` (355), `UniswapFuelSwap.sol` (305),
`MintableERC20.sol` (51), `interfaces/*`, `mocks/MockSwapTarget.sol`, the forked portal.
Noir (`contracts/bridge/aztec/`): `token_bridge/{main,config}.nr`, `token_minter_proxy/main.nr`,
`claim_secret/lib.nr`, `keystone/main.nr`.

## Main-agent independent read (pre-consolidation)

### SwapBridgeRouter.sol — clean modulo the accepted A-1
- **Witness binding is COMPLETE.** The `BridgeWitness` (typehash `:52-54`, struct `:113-126`, hash `:328-346`)
  binds all 12 fund-flow params: tokenPortal, bridgeToken, totalAmount, fuelAmount, aztecRecipient,
  fuelRecipient, tokenSecretHash, fuelSecretHash, minFuelOutput, `routeHash` (= `_hashRoute(path,zeroForOnes)`,
  `:348-354`), isPrivate, `swapTarget` (bound to the CURRENT on-chain value `:181,:266` — an owner
  `setSwapTarget` between sign+exec DoSes a pending sig, never redirects). The Permit2 `TokenPermissions`
  additionally binds token+amount (`:314-325`). No fund-flow parameter is left unsigned.
- **Reentrancy:** `bridge`/`bridgeWithFuel`/`sweep` all `nonReentrant` (`:153,:244,:290`); every `forceApprove`
  is zeroed after use (`:194,:214,:227,:281`) so the router holds zero allowance/balance between calls.
- **Hostile-swap-target defenses (`:198-206`):** the router enforces the SIGNED `minFuelOutput` itself
  (not the target's), verifies the FJ balance delta, AND asserts the input token was ACTUALLY consumed
  (`tokenBalBefore - balAfter == fuelAmount`) — closes the "satisfy the floor from prefunded FJ, strand
  the user's slice" theft. Sound (the approval caps the pull at fuelAmount, so strict equality holds).
- **Ownership:** `Ownable2Step` (no single-step footgun). Deadline + nonce enforced by Permit2.
- **Residual (known):** the generic `tokenPortal` param is attacker-supplyable via a phishing frontend
  (A-1) — the user signs a witness naming the portal, so a hostile portal that `transferFrom`s the
  router's just-pulled tokens is a "user signed a bad intent" attack, mitigated only by a trusted
  frontend. Accepted for testnet; on-chain portal allowlist is documented future work + a value-token blocker.

### UniswapFuelSwap.sol — F-006 + F-008 confirmed as-documented (no change)
`swap()` external `nonReentrant` but permissionless (`:88-94`, F-006: caller-supplied minOut → self-sandwich,
self-harm only); `unlockCallback` PoolManager-only (`:125`); `sweep()` `onlyOwner` but NO `nonReentrant`
(`:291`, F-008 latent — owner-only so not externally triggerable); `receive()` inert (`:75`).

Verdict pending the three auditors' sweep; consolidated findings + per-pitfall-class coverage in report.md.
