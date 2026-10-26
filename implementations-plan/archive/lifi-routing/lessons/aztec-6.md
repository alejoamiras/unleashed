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
- **The sandbox fixture is a real arc 5 run on 6.0.0**: the deposit router, its swapper and fuel budgets, the
  fee-asset handler and no old router. The smoke passed every flow in 19.5 minutes.

## Attempts

1. **Arc 3's `build` failed with ENOENT** on the missing `v6/` directory after every probe passed. Arc 5's `build`
   creates its directory; arc 3 predates that fix. Creating the directory by hand was enough.
2. **The retire intent refused the fueled validator.** Re-applying the removal changed source after the retire
   intent's build commit, and `verify` stopped before anything signed (`deploy-relevant files changed since the
   intent was built`), as designed. The validator ran under a fresh router-only intent with no pre-creation
   (`v6-arc5/intent-gates.json`), which refuses any journal step.
3. **The LI.FI canary is short of source funds.** Its dry run against the 6.0.0 candidate built and verified all
   five rows through the new router, but the canary holds 16 USDC on Base Sepolia where the three cross-chain rows
   need 18 (Sepolia: 24.5 USDC, enough). The live run refuses before any spend until it is topped up.
4. **The archived rc.1 arc 5 intent still named the old dRPC key** in `primaryRpc`. Main's keyless move scrubbed the
   other two archived intents; the close-out scrubbed this one to `<KEY>` the same way. The key stays in the
   branches' history until the owner rotates it.
