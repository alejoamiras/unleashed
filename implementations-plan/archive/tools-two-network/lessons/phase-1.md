# Phase 1 — Withdrawals never set a fee (DP3)

**Status:** code + unit ✓ ; network/manual proof deferred (see below).

## What changed
- `apps/faucet/src/composables/useWithdraw.ts`
  - Removed the hard-coded `SponsoredFeePaymentMethod` + `getSponsoredFpcInstance` (unavailable on
    mainnet).
  - Added `export function buildWithdrawSendOpts(from)` — the SINGLE source of the withdraw send
    options `{ from, wait: { waitForStatus: PROPOSED } }`, deliberately with **no** `fee`. All three
    sends (public authwit, public exit, private exit) route through it, so a fee can't be
    reintroduced on one path only.
  - Incidental: removed a pre-existing unused `computed` vue import (biome warned; the file was
    already carrying it on the base branch).
- `apps/faucet/src/composables/useWithdraw.test.ts` (new) — 2 unit tests pinning the DP3 invariant
  (no `fee`/`paymentMethod`; still carries `from` + PROPOSED wait).

## Gate result
- unit asserting no `paymentMethod`: **✓** (`bun run --cwd apps/faucet test useWithdraw` → 2/2).
- faucet typecheck (`vue-tsc --noEmit`): **✓** (clean).
- `bun run lint`: **✓** exit 0 (touched files clean; the 39 repo-wide warnings are pre-existing).
- full `test:faucet`: **✓** 505/505.
- **`+e2e` + manual testnet withdraw: DEFERRED to the network-proof layer.** These need a live
  network. The e2e closes on the PR's CI run; the manual testnet withdraw is the
  owner's smoke. Not claimed as run here.

## Notes for later phases (spotted while in this file)
- `useWithdraw.ts:40` hard-codes `NODE_URL` (`VITE_AZTEC_NODE_URL ?? "https://v5.testnet.rpc..."`) —
  one of the triplicated NODE_URLs **Phase 2** collapses into `network.ts`.
- `useWithdraw.ts:16` `import { sepolia } from "viem/chains"` — a **Phase 2** target (the
  `viem/chains` ban + single-source chain id).
