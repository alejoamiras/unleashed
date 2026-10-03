# F2 — L1 wallet (thin canonical-viem composable) ✅

Goal: connect an injected L1 wallet (Rabby / MetaMask) for the bridge's Sepolia side.

## Decision: dropped wagmi for a thin canonical-viem composable
First tried `@wagmi/vue`, but hit a hard monorepo conflict: the Aztec stack aliases `viem` → `@aztec/viem@2.38.2` (a fork), hoisted to root `node_modules/viem`. `@wagmi/core@3.5.0` (also hoisted to root) resolved that fork — but it imports `viem/tempo`, which the fork lacks (canonical viem ≥2.43.0 has it) → Vite build failed (`./tempo` not exported) + vue-tsc clashed (`sepolia` from canonical viem ≠ wagmi's `Chain` from the fork at `createConfig`).

**Codex consult (session `019ea43d-c1ef-7343-8e9c-261d39362601`):** bun has NO scoped/nested `overrides` (so `{"@wagmi/core":{"viem":...}}` is impossible — can't surgically force @wagmi/* onto canonical viem); the only keep-wagmi fix is bun's `install.linker = "isolated"`, a risky workspace-wide install-mode change. Verdict: **drop wagmi** for a thin canonical-viem composable. Guardrail: keep the bridge-core boundary at **primitives** (addresses / amounts / a request fn), never share viem `WalletClient`/`Chain` types across the canonical↔@aztec/viem line.

## Implementation
- Faucet `viem` = canonical `^2.43.0` (resolves 2.51.3); the Aztec stack keeps `@aztec/viem` (its own nested dep). Two viems coexist — fine at runtime, NOT one type universe.
- `src/composables/useL1Wallet.ts` — `createWalletClient(custom(window.ethereum))` + `createPublicClient(http)`, `eth_requestAccounts`, `accountsChanged`/`chainChanged` listeners, `wallet_switchEthereumChain` → Sepolia. Exposes `address`/`chainId`/`isConnected`/`wrongChain`/`isConnecting`/`error`/`walletClient`/`publicClient`/`connect`/`disconnect`/`switchToSepolia`.
- `src/components/L1WalletPanel.vue` — connect / disconnect / switch-chain UI (mirrors WalletPanel). Removed `@wagmi/vue` + `@tanstack/vue-query`; reverted `main.ts`; removed `lib/wagmi.ts`.

## Validation
- biome clean · vue-tsc clean · **123 faucet tests green** · `bun run build` ✓ (no more ./tempo).

## For F4
Pass the L1 side into bridge-core via primitives / a tiny local adapter interface — never a canonical-viem `WalletClient` into an `@aztec/viem`-typed param. window.ethereum (legacy) is enough for Rabby/MetaMask; EIP-6963 multi-wallet discovery is a future polish (F5).
