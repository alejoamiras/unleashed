# Phase 2: the generation

## Preflight

- **Signer** `0x7F42…6a9a` held 2.9698 Sepolia ETH at `build`, above the 2.0 ETH cap.
- **Identity** unmoved: `rollupVersion` 2914217885, `l1ChainId` 11155111, node 6.0.0-rc.1.
- **Seed tokens.** USDC `0x8648…51fc`, USDT `0x8bad…238f`, EURC `0xc10b…4d24` and GBPC `0x177e…efca`
  each have code, return 6 from `decimals()` and 1e12 from `maxMintPerTx()`, and sort below WETH.
- `contracts/bridge/evm/lib/v4-core/.env` is the dependency's own one-variable file
  (`FOUNDRY_FUZZ_SEED`). Forge reads `.env` from the project root, not from `lib/`, so it is inert,
  but `env-exec` refuses any `.env` in the tree. It was set aside for the live arc and restored after.

## The intent

- `intent-build-a3ce6ce5`. `primaryRpc` is the default testnet node, whose dRPC key is public by
  design (`src/testnet-node.ts`). Second endpoint: the documented single-node posture. Caps 2.0 ETH
  spend and 1.5 WETH seed.

## Deploy

- `gen-deploy-bc9f9fcc` (verify, dry run, deploy) in 5.6 min. Swap target `0x2247…60f7`, factory
  `0xd978…152c`, router `0xb6d6…cfab`, hub `0x1a0a…b715` (class `0x0acf…a58c`). USDC portal
  `0x3539…dc5f` and USDT portal `0xcc2c…7205`, both registered; pool seeds skipped
  (`SKIP_POOL_SEED=1`), both pools already exist.
- No forge script broadcast, so no `run-*.json` was written. The journal (10 steps) holds no URL.
- `verify:l1 --strict` on the candidate, with a keyless public Sepolia endpoint: code, the
  cross-bindings, both registrations and the four masked runtime hashes.

## Pre-creates

- EURC portal `0x8559…c329`, unregistered.
- **GBPC's first `createPortal` reverted out of gas.** It ran one block after EURC's and used its
  whole 306974 limit, while EURC's identical call had used 345130. Why the estimate came in that
  low is not established. `ensurePortal` waits for the receipt without reading its
  status, so the revert surfaced only as "createPortal landed but the factory has no registration".
  Nothing landed: the registration read zero, the predicted portal was unused, and the call
  simulated clean. The same pre-create, re-run alone, created portal `0x4398…6f5c` at the predicted
  address. A source fix mid-arc would have tripped `assertNoSourceDrift`, so it is a follow-up.

## Candidate smokes and first claims

- `smoke-existing`: USDC and USDT, public and private, in 3.5 min.
- `smoke-swap-existing`: a 1 USDC fueled send into a self-paying claim, in 0.9 min.
- `fuel-testnet`, each with a 1.5-token slice (the default quarter token quotes under the floor):
  - USDC, public lane only: `claim` 2734794166223900000 FJ-wei (≈1.32M L2 gas). This is the paid
    `claim_public` sample; without it `fjPerTx` would be sized from private claims alone.
  - EURC: `register+claim` 5188277546468800000 (≈2.38M L2 gas), then private-FPC claims of
    1986365799037200000, 1866115561742200000 and 1866115561742200000; `getFeeLimit` 4.96 FJ.
  - GBPC, `PUBLIC_RUNS=0 PRIVATE_RUNS=1`: the private first claim. `register_token`
    3849463914970200000 (≈1.76M L2 gas) and the claim 1793522191073400000, both paid through the
    PrivateFPC from the bridged fuel; `getFeeLimit` 14.88 FJ.

## Calibration

- Samples kept outside the repository: 1 `claim_public`, 4 `claim_private`, 1
  `register_and_claim_public`, 1 `register_token`. `fjPerTx` 3378216485545800000 →
  **3281752999468680000**; `fjRegister` 2785947429205560000 → **2944180056293880000**.
- **Floor kept at 29.77 FJ, provisionally.** The private first claim's ceiling, 14.88 FJ, sits under
  it with 2.0× margin, against the 4× the validator sizes the floor to (its printed 59.5 FJ). One
  sample may only raise the floor through a full calibration, so the floor stands until one runs
  (`follow-ups.md`).

## Promotion

- `verify-candidate-0e0737d1`: strict `verify-l1` over the four tokens, the hub
  initialization-hash readback and the owner readbacks agree. Candidate digest `1646c55b…16c0`.
- The previous live manifest was retired in a commit of its own. `promote --bridge-only` re-ran
  verify, the FPC gate and the faucet derivation, then took the first-promotion path.
- Once the candidate's digest was recorded, the testnet keys came from a mode-600 file the owner wrote with
  `op inject` outside the repository, in place of a per-run approval. It sits outside the tree
  because `env-exec` refuses any `.env` there and Bun auto-loads one from the working directory.
  The Cloudflare token stayed a keyed run.
