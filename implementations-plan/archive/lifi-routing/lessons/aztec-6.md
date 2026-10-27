# Aztec 6.0.0: the stack on the reset network

Main moved to Aztec 6.0.0 and a new testnet generation (#22–#26) while the stack waited, so the stack merged main
through every arc and redeployed its router on the new generation. The rc.3 router-only intent was retired unexecuted.

## Facts

- **The generation** (Sepolia, rollup version 679261766, wallet chain id 685146337): factory
  `0x2509411e06a3b9512eca3d9f2668afd7821b7817`, hub `0x1d500beb91a75ccd2e5376d14980b0cabd494fe3397e710faddc371376de7530`,
  FeeJuicePortal `0xe59acba462a0324b1d619a7a1b219419f156f505`, fee asset `0x762c132040fda6183066fa3b14d985ee55aa3c18`,
  FeeAssetHandler `0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9`. Main's Uniswap router
  `0xad08e65dda66eaed5ab9447f27b7610a850f4303` was its live router.
- **Main's token and gas send met arc 4's router.** #22 sizes an AZTEC slice without slippage up to all but one base
  unit and stops the stepper where the slice would clamp; arc 4 prices fuel through `FuelProvider` and the deposit
  router. The merge keeps arc 4's venue model and takes main's identity sizing (`maxFuelAmount`, `capped`,
  `maxTxTarget`) and the AmountStep's `:tx-max`.
- **One owner-approved live window.** The owner approved one `env-exec` run that stashed the four testnet values
  (`keyed/window.env.example`) in a mode-600 file on the runtime tmpfs. Each step ran through
  `keyed/with-window-env.sh <template> …`, which hands the command only its template's names and masks every
  stashed value in its output; `keyed/drop-window-env.sh` removed the stash when the window closed. The step
  scripts are in `keyed/`.
- **Arc 3, router-only deploy** (intent `v6/intent.json`, receipt `v6/promotion-receipt.json`):

  | Step | Result | Transaction |
  |---|---|---|
  | `TestnetFuelSwapper` | `0x2b2244a4d36ba117a273b0b5a810daa0b84c86ab`, six rates, 1,000 FJ inventory (one faucet call, floor 297.7 FJ) | `0x89c061a6422420bf21a1a489e554b1093ef4b1b9e3c5d2b6ae607d568877c446` |
  | `DepositRouter` | `0x6e5566894908e945a12245f9810b4055c4a1035b` | `0xb894f4ad013c58c1f7fc1eff4fd8c48117e3d406792483414f0572f8070c1495` |
  | Circle USDC, `--canonical` | portal `0x5dda1b3182bd0dd4c469461708a846edd395b188`, L2 `0x2452d54ee633021f35ede143dd916aed01db96f9987cfffb4fe626ea29bddc98` | `0x553cfa6dbc26e8001c3a28b9c4e76c90c9dce7adebf3764249788c6dfa227725` |
  | WETH, `--canonical` | portal `0xf5ab7b75495420b4eaaa6400e892e552747f106d`, L2 `0x0807b34ec61051997d940107021399e8736da66e55a02c0cdbd1e63a787f9add` | `0x6cb1a98107796379a03b9e2e1ffbdc7173d03712625677eb082636e22d37ebd7` |

  Rates as on the earlier generation: 32 FJ per whole test USDC, test USDT and Circle USDC, 36 per EURC, 42.5 per GBPC,
  86,850 per WETH. The routing re-run adopted both contracts and sent nothing. Strict `verify-l1` passed on the
  candidate, the FPC gate was green, and the candidate (sha256 `18ef1085…25c5`) was promoted. No calibration: the
  `fuel` block carries the budgets main calibrated on 6.0.0. The whole deploy spent under 0.000001 ETH.
- **Arc 5, the old router retired** (intent `v6-arc5/intent.json`, receipt `v6-arc5/promotion-receipt.json`). The
  arc's schema refuses `router`, `swap` and `swapTarget`, and the one-off `build --retire-router` left with them,
  so the retirement ran inside a revert and its re-application: the revert restored both for one promotion, with
  the 6.0.0 manifest as the retire test's fixture. `build --retire-router` derived the candidate (the Uniswap router
  first in `legacyRouters`, the V4 fields dropped, every other byte kept, sha256 `cf23bb75…28cf`); `verify
  --candidate` checked the listed router's code, factory and owner; `promote --bridge-only` wrote it.
- **The fueled validator settled both lanes through the new router** (arc 5's manifest, `FUEL_SLICE_UNITS=1500000`,
  under `v6-arc5/intent-gates.json`): 1.5 test USDC quoted 48 FJ against a 46.56 FJ floor; the public self-paying
  claim cost 1.656099 FJ, to the wei main's calibration sample (`fjPerTx` is it plus 20 %), and the private-FPC
  claim 1.137 FJ. Its one-sample `minFuelFj` suggestion (11.35 FJ) moves nothing: one sample may only raise the floor.
- **The LI.FI canary passed all five rows on the 6.0.0 router** (arc 5's manifest, under `v6-arc5/intent-gates.json`,
  between two green `verify`s). Each cross-chain row ran on an Across quote (6 USDC in, 5.997002 out) held exclusive
  to the canary, which self-filled it. Spend: source 18 of the 24 USDC cap, Ethereum at most 23 of 30 USDC; gas
  0.0000036 ETH on Base Sepolia and under 0.000001 ETH on Sepolia, inside both caps. Fuel priced at the swapper's
  32 FJ per USDC.

  | Row | Source tx | Ethereum tx (fill) | `Deposited` / outcome | L2 claim | Discovery |
  |---|---|---|---|---|---|
  | crosschain-public | `0x59ecafed106c0d38a335ddca2962a0d51eb21dc2e384ff03662b39588216321b` | `0x64aa867637c086ed45cc679bdb12468faa477e2cf23e335b128371b3a395a567` (self) | received 5,997,002; token 4,665,705 leaf 453; fuel 1,331,297 → 42.60 FJ leaf 452 | `0x2c3a0fbd7f402e4a48a9c0c22877ba271686250f8f7c30d03a37cb51d529ab73` | `deposited` |
  | crosschain-private | `0x71ecabd440c4850422be93ac1935cf1ec3d6e85c4be46d85d564c0ca48f497b2` | `0xfdf4ad189b0347bd6bf7343b36342aa3a3b2ec4b244493eafb62e81b95a7cb63` (self) | received 5,997,002; token 4,665,705 leaf 455; fuel 1,331,297 → 42.60 FJ leaf 454 | `0x0f9c04ee711970f94de8459f35d2365e4a03cabe27d04b45225af7764dc91ff5` | `deposited` |
  | ethereum-plain | — | `0x613daf01f3331d24b7589004eb701be154888cbb19ed9d45722b5988cb221cc4` | received 2,000,000; token leaf 456 | `0x239d9f83bdf5f24ea09cb212621b11b866efd1aaa956b712b21a1b635f09dc29` | — |
  | ethereum-fueled | — | `0x67a4a7b913e455a72bf837ebb0dd85d1d2b6d5fb39412da2a1144752363f689a` | received 3,000,000; token 1,668,703 leaf 458; fuel 1,331,297 → 42.60 FJ leaf 457 | `0x27c850de8ec48ef7a0271a5269a2bed8824b4264bf54b0e2ec649b170ceb4599` | — |
  | crosschain-recovery | `0x7a7e09aaf4625315fdaaa2ed6892b0b06799c3d905c90fd92ae289edad0b7e2c` | `0x98a5cd3cbac7751ede6a252efeb36234e9b5f015e263869d5294b64f029f1df4` (self) | `LiFiTransferRecovered` 5,997,002; the canary's Sepolia USDC unchanged across its own fill | — | `delivered-to-wallet` |

- **The sandbox fixture is a real arc 5 run on 6.0.0**: the deposit router, its swapper and fuel budgets, the
  fee-asset handler and no old router. The smoke passed every flow in 19.5 minutes.

## Attempts

1. **Arc 3's `build` failed with ENOENT** on the missing `v6/` directory after every probe passed. Arc 5's `build`
   creates its directory; arc 3 predates that fix. Creating the directory by hand was enough.
2. **The retire intent refused the fueled validator.** Re-applying the removal changed source after the retire
   intent's build commit, and `verify` stopped before anything signed (`deploy-relevant files changed since the
   intent was built`), as designed. The validator ran under a fresh router-only intent with no pre-creation
   (`v6-arc5/intent-gates.json`), which refuses any journal step.
3. **The LI.FI canary was short of source funds.** Its dry run against the 6.0.0 candidate built and verified all
   five rows through the new router, but the canary held 16 USDC on Base Sepolia where the three cross-chain rows
   need 18, and the live run refuses before any spend. The owner topped it up and the live run passed (Facts).
4. **The archived rc.1 arc 5 intent still named the old dRPC key** in `primaryRpc`. Main's keyless move scrubbed the
   other two archived intents; the close-out scrubbed this one to `<KEY>` the same way. The key stays in the
   branches' history until the owner rotates it. Arcs 5 and 6 still carried the unarchived copy, which main's
   node-key scan failed in their PR runs; it is scrubbed there too.
5. **The routing block's `destToken` was mis-cased.** The hand-written `--routing` input named Sepolia's Circle USDC
   with one letter in the wrong case. The schema took any 40-hex string, and the canary matches `destToken` to the
   manifest token and encodes that token's lower-case `erc20`, so only the owner's first Base Sepolia send in the app
   met viem's EIP-55 check, which refused it before any signature. The manifest now carries the EIP-55 spelling of the same address, and the schema refuses a stored
   address that is neither lower-case nor EIP-55.

## Review

Codex (`gpt-6.1-sol`, high) over the reconciliation only: the merge resolutions, arc 5's revert and re-application,
the promoted manifests, the regenerated fixture and the close-out. The fresh pass: "No actionable reconciliation
defects found; confidence: moderate." The resumed pass traced a prefilled AZTEC token+gas send from prefill to
signed amount (the stored target may sit above the stepper's stop, the effective target never does) and checked the
merged allowlist: "No new material findings (high confidence)."
