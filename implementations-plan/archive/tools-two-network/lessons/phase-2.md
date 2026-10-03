# Phase 2 — Single-source the network identity

**Status:** code + unit ✓ (behaviour-preserving; still testnet/Sepolia).

## What changed
- **New `apps/faucet/src/lib/network.ts`** — the app-side single source: `NETWORK` = `{ l1ChainId,
  walletChainId, viemChain, nodeUrl, l1ExplorerBaseUrl }`. Layers `viem` + endpoints on top of the
  Node-safe `chain-constants.ts`. Module-load guard: `viemChain.id === l1ChainId`.
- **9 files** (`useL1FeeAsset`, `useL1Usdc`, `useFuel`, `useBridgeBackup`, `useL1Wallet`,
  `useBridgeJournal`, `useWithdraw`, `useDeposit`, `BridgeForm.vue`): `sepolia.id` → `NETWORK.l1ChainId`,
  `chain: sepolia` → `chain: NETWORK.viemChain`, and `import { sepolia } from "viem/chains"` →
  `import { NETWORK } from "@/lib/network"`. Mechanical sed of two patterns covered every non-import
  use (verified: only import lines left `sepolia`).
- **NODE_URL** collapsed in `useFuel`/`useWithdraw`/`useDeposit` → `NETWORK.nodeUrl` (the env-override
  now lives once, in network.ts).
- **`explorer.ts`** — the two hard-coded `sepolia.etherscan.io` bases → `NETWORK.l1ExplorerBaseUrl`.
- **`chain-info.ts`** — the `?chainId=&version=` override is now gated behind `import.meta.env.DEV`
  (integrity layer 3): a production build dead-code-eliminates it, so a prod visitor can't repoint the
  handshake. Dev/vitest keep it (DEV=true).
- **`biome.json`** — new faucet override banning `viem/chains` everywhere except `network.ts`
  (`noRestrictedImports`, level error). **Proven to fire** with a throwaway probe import.

## Gate result
- `viem/chains` ban fires (probe): **✓**. No stray `viem/chains` in app (only network.ts): **✓**.
- 6-dec + 18-dec BridgeForm tests: **✓** (all pre-existing BridgeForm tests still green).
- faucet typecheck: **✓** exit 0. `bun run lint`: **✓** exit 0 (warnings unchanged at 39 — none added).
- full `test:faucet`: **✓** 509/509 (+4: network's 3, chain-info prod-neuter 1).
- New pins: two L1 chain-id sources agree; Permit2 domain chainId === NETWORK.l1ChainId (F3);
  `?chainId=` inert in a prod build.

## Gotchas
- **zsh doesn't word-split unquoted `$FILES`** — the first sed loop silently passed the whole string
  as one path. Use a zsh array `FILES=(...)` + `for f in $FILES`.
- `grep` is aliased to `ugrep` in this shell; `--include` globbing differs — iterate files explicitly
  or use `grep -Hn` per file.
- Order the two sed patterns so `sepolia.id` is replaced before the bare `chain: sepolia`.

## Carry-forward to Phase 3
- `network.ts` is intentionally still testnet-hardcoded. Phase 3's config factory makes `NETWORK`
  (and `chain-constants.ts`, which gains MAINNET_* constants) target-driven via the build target.
