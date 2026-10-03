# Phase 3 — candidate smoke → checkpoint-defined → promote

## What shipped
- Updated `testnet-bridge.candidate.json` `l1.fuel`: `router` → new `0xa2003149`, `feeJuicePortal` → V5 `0x7c4176bf` (swapTarget unchanged `0x459ea79d`). `biome format` to tabs.
- Ran the candidate smoke: `bun run --cwd packages/bridge-core scripts/smoke-swap-existing-testnet.ts --config <ABS>/testnet-bridge.candidate.json` (deployer key; throwaway sponsored L2 account; full deposit→swap→bridge→self-paying claim).
  - **Path gotcha**: the script `readFileSync`s the raw `--config` argv relative to cwd; with `bun run --cwd packages/bridge-core` a repo-relative path ENOENTs. Pass an **absolute** path.

## DECISIVE PROOF — the fix works
The smoke's bridge step logged: `bridged: tokenLeaf 3451905, fuelLeaf 3451904`. The fuel + token leaves are now **consecutive canonical V5-inbox indices** (~3.45M). Before the fix the fuel leaf was the garbage ~117M (the dead V4 portal's space).

Independent on-chain confirmation (L1 Inbox `MessageSent` + node `getL1ToL2MessageCheckpoint`):
- **FUEL** idx 3451904, hash `0x0062ab7f…`, `getL1ToL2MessageCheckpoint = 3372` (**defined** — folded into the V5 inbox). Pre-fix this was `undefined`.
- token idx 3451905, hash `0x00a0470a…`, checkpoint 3372 (defined).
- Both claimable once the L2 anchor checkpoint (3370 at check time) reaches 3372 — 2 behind, i.e. the legitimate 5.0 checkpoint-sync wait, NOT a stuck message.

This is the root-cause fix validated end-to-end: `bridgeWithFuel` → V5 `FeeJuicePortal.depositToAztecPublic` → real V5-inbox message → claimable. The faucet's checkpoint gate now resolves because the FJ key is finally present.

## Result — both gates GREEN
- Corroborating gate (FJ message folds, checkpoint defined): ✓ (FUEL idx 3451904 → checkpoint 3372 defined).
- **Primary gate (smoke self-paying claim confirmed): ✓** — `✅ CANDIDATE fueled smoke PASSED — deposit+swap→self-paying claim in 3.2m.` The anchor reached checkpoint 3372, the message became claimable, and the self-paying claim (the FJ claimed in the same tx paid that tx's fee) completed against the candidate manifest. Exit 0.
- **Promotion: ✓** — candidate→live (`cp …candidate.json …testnet-bridge.json` + biome format); confirmed `live == candidate` (router `0xa2003149`, feeJuicePortal V5 `0x7c4176bf`). The local faucet at :5176 now serves the fixed fuel set.

`LESSONS_FILE=implementations-plan/archive/fuel-portal-v5-fix/lessons/phase-3.md`

## Phase 3: ✓ (candidate smoke self-paying claim PASSED + FJ checkpoint defined + promoted live)
