# F1 — tabbed Faucet|Bridge shell ✅

Pivoted the frontend into the faucet app: `App.vue` is now a tabbed shell (Faucet | Bridge); the faucet content moved verbatim into `views/FaucetView.vue`; `views/BridgeView.vue` is the placeholder the bridge UI fills from F2.

## What
- `App.vue` → shell: tab bar (testids `fa-tabs` / `fa-tab-faucet` / `fa-tab-bridge`) + `ref<'faucet'|'bridge'>` (hostname default: `bridge.*` → Bridge tab) + `Footer` + `AppToastRegion` (shared across tabs).
- **`v-show` (not `v-if`)** keeps both views mounted → each tab owns an independent, persistent wallet session (codex: two sessions, not one shared connection). Faucet wallet stays connected when you switch to Bridge and back.
- `FaucetView.vue` — the faucet content (hero + `WalletPanel` + `TokenCard`s + `useWalletConnection`), moved verbatim; testids + the `:key` connection-state re-mount logic preserved.
- `BridgeView.vue` — placeholder (bridge hero + note + `fa-bridge-view` testid); the bridge wallet (F3) + flows (F4+) land here.

## Validation
- `biome check` clean · `vue-tsc --noEmit` clean · **123 faucet tests green** (14 files — extraction broke nothing) · `bun run build` ✓.

## Notes
- No `App.test.ts` existed → no app-level test to update; the component tests cover the moved pieces.
- Tab bar uses design tokens (`--txt-primary/secondary`, `--font-headline`) with safe `var(--x, fallback)` for surfaces (didn't want to guess surface-token names).
- Next: F2 — L1 wallet (wagmi v2 + viem, Rabby/injected) into `BridgeView`.
