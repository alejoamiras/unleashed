# Phase 9: the live generation

The window opened after Phase 7's gate (`323041d`). From here to Phase 10's final verify, only
`OPERATIONAL_ALLOWLIST` files change, one signing run at a time.

## Step 1: the build and the intent

`bun packages/bridge-core/scripts/gen-remappings.ts` left `remappings.txt` unchanged, and
`/opt/foundry/bin/forge build --force --root contracts/bridge/evm` exited 0 (lint notes only). That binary
is the one a keyed run resolves (D18):

```
forge Version: 1.4.1-v1.4.1
Commit SHA: cf7746048646f2ecff48246dd61e265e49ab16f0
```

No sandbox and no other forge build runs from here to the final verify.

`v6-intent-build-686040e0` (testnet-l1) was green at `8e76e6c`. Identity: nodeVersion 6.0.0, l1ChainId
11155111, rollupVersion 679261766, wallet chainId 685146337; rollup `0x1f43…efba` and portal `0xe59a…f505`,
both with code on the direct Sepolia read; fee asset, handler and registry equal to `reset-baseline.json`.
Signer `0x7F42…6a9a`, starting balance 2.9036 ETH against the 2.0 ETH cap. Single L2 node posture. FPC
`0x0516ebb4…6915`, salt `0x…01`, artifact sha256 `bc1e27b0…9bde`, equal to `private-fpc-canonical.json`.
The intent holds no URL.

## Step 2: tokens and pools (public Sepolia reads, block 11983793)

All four tokens have code (3902 bytes; rc.3's "7806" was the same code's hex length with its `0x`), 6 decimals,
`maxMintPerTx` 1e12, and sort below WETH. Each TOKEN/WETH pool (fee 3000, tick spacing 60) holds liquidity
1.5e13; the ETH/FJ pool 3.64e20. The fee asset did not move, so every pool carries over. Quotes in FJ through
the repository's own `buildFuelRoute` and `quoteFuelPath`, against the carried 29.773 FJ floor:

| Token | 0.25 | 0.5 | 1 | 1.5 | 2 | 1.5 after 300 bps |
|---|---|---|---|---|---|---|
| USDC | 7.002 | 13.999 | 27.978 | 41.935 | 55.871 | 40.677 |
| USDT | 8.876 | 17.745 | 35.458 | 53.141 | 70.792 | 51.546 |
| EURC | 8.975 | 17.942 | 35.852 | 53.731 | 71.579 | 52.119 |
| GBPC | 8.985 | 17.963 | 35.894 | 53.794 | 71.662 | 52.180 |

`FUEL_SLICE_UNITS=1500000` for every fueled run, as on rc.3: USDC's 1.5 clears the floor after slippage, and
the swap smoke's default whole token (27.978 FJ) would not.

## The window's keys

The owner, after approving the intent build: "I'd love for you to push through all the deployment and
everything without my intervention, basically just calling me / or waiting for me at the end, so I can
smoke-test it manually. Is there a way I can send you my credentials via an op-remote run that rights it to the
mainframe with specific permissions and when you finished, you delete it? Im good with that risk, specially for
a disposable / testnet project."

So the rest of the window runs from one stash instead of one approval per step (`keyed/`):

- `stash-window-env.sh` is the one owner-approved keyed run, on `keyed/window.env.example` (the union of the
  four run templates). It writes the six testnet values to `aztec-6-stable-window.env` in the per-user runtime
  dir (tmpfs, mode 700), mode 600, and prints names only.
- `with-window-env.sh <template> <cmd>` runs each step the way env-exec does: only the names that step's own
  template lists, env-exec's keyed PATH, no stdin, and env-exec's own masker over every stashed value.
- `drop-window-env.sh` removes the stash when the window closes.

The residuals the owner accepted: every agent session on the host runs as the same user, so the mode keeps out
other users, not other sessions; and `DRPC_API_KEY` is the owner's shared CLI key, not a testnet one, so it is
worth rotating after the window. A dummy-value test passed: least privilege per template, case-insensitive hex
masking, the exit code carried, the stash refused twice, the drop.

## Spend (gross, per broadcast group)

| Group | Run | ETH |
|---|---|---|
