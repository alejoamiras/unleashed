# Phase 5 — App: real-USDC + private-fuel + per-network gating

**Status:** the app-layer scope is ✓. Two items re-attributed to Phase 7 after recon (below).

## 5a — Permit2 approve fallback (codex F2/F4)
Both `useDeposit` legs (fueled + bridge-only) threw when the token's Permit2 allowance was
insufficient, assuming the testnet MintableERC20's auto-grant. Real USDC + the DP7 permissionless-mint
token start at ZERO allowance → they'd have thrown. Added a shared closure `ensurePermit2Approval`
(one-time `approve(Permit2, max)`, short-circuits when sufficient). `id` is `string|null` and TS
narrowing doesn't flow into a closure → pass it as a `recordId: string` param.

## 5b — per-network UI gating
`IS_MAINNET` (build-time, from the resolved target) gates the testnet-only surfaces:
- Faucet tab hidden + FaucetView never mounts on mainnet; defaultTab = bridge.
- `useWalletConnection`: mainnet grants `buildBridgeManifest` (bridge-only) + registers only the
  bridge trio + PrivateFPC (no Dripper or faucet tokens — not deployed on mainnet).
- `MintTestUsdc` gated on `BRIDGE_TOKEN_MINTABLE`, `MintFuelAsset` on a present FeeAssetHandler.
- **`BRIDGE_TOKEN_SYMBOL`/`DECIMALS` now DERIVED from the manifest** (was hardcoded AZLO/18) →
  mainnet becomes USDC/6. A wrong decimals mis-scales every amount, so it must not be hardcoded.

## Recon findings that re-scoped 5c
- **Private-fuel needs NO app change for mainnet.** `getPrivateFpc()` derives the FPC from the
  canonical `PRIVATE_FPC_SALT` + ZERO deployer — network-INDEPENDENT, so the same address resolves on
  both networks. The manifest `privateFpc` block is a deploy-time PIN (verified == derivation at
  deploy), not something the app reads to function.
- **`check-fpc-version`/`runFpcGate` is script-only** (`check-fpc-version.ts` CLI + `fuel-testnet.ts`)
  — the faucet app never calls it. Its testnet-pinned `private-fpc-canonical.json` descriptor is what
  "rejects mainnet". Making it accept mainnet = adding a per-network descriptor pin + selecting by the
  live node — a **Phase 7 (deploy tooling)** change, run at deploy/canary time, NOT an app change.
- **`assertNodeChainMatches`** (manifest↔node async half) has no clean app seam: the wallet-sdk
  handshake already uses the target-driven `readChainInfo`, and the only `getNodeInfo` call is per-op
  in `useWithdraw`. The sync integrity gate (target↔manifest + hostname) already fails closed for the
  primary risks; the node URL is committed per-target. Wiring belongs with the Phase-7 deploy/node
  lifecycle (or a future dedicated startup node-check) — not forced into App.vue.

## Gate
- typecheck 0; faucet 514 + a bridge-deployments pin (symbol/decimals/mintable derive from manifest);
  lint 0; both target builds still green (5b changed no build wiring).

## Required pre-launch follow-up — DONE (5c)
- **Per-network COPY.** The Bridge/Fuel heroes are gated on IS_MAINNET: mainnet says "Real funds —
  keep amounts under $5" (the D15 communicated cap) / "Real funds"; testnet copy unchanged.
  MintTestUsdc needed no change (the whole component is gated off on mainnet).
