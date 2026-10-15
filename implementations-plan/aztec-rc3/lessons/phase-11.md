# Phase 11 — the live generation

The owner chose to start the live window before arc 2's Codex loop converged. Findings are triaged by class:
docs and non-input tests apply at once; a frozen input that does not change what is deployed waits for the window
to end; anything that makes a deployed contract, the FPC address or a fund-moving step wrong stops the next
fund-moving run and goes to the owner.

## Step 1: the intent (`rc3-intent-build-9a1b1ffe`, testnet-l1)

Green at `4260741`. Identity: nodeVersion 6.0.0-rc.3, l1ChainId 11155111, rollupVersion 3409706519, wallet
chainId 3415328944; rollup `0xed1e…089d`, portal `0x6974…ce59`, both with code. Signer `0x7F42…6a9a`, starting
balance 2.904 ETH against the 2.0 ETH cap. Single L2 node posture. FPC `0x2e189d0c…6db4`, salt `0x…01`, artifact
sha256 `f9dd1229…4e96`, equal to the package's `canonical-deployment.json` at 6.0.0-rc.3.

## Step 2: tokens and pools (public Sepolia reads, block 11922359)

All four tokens have code (7806 bytes), 6 decimals, `maxMintPerTx` 1e12 and sort below WETH. Each TOKEN/WETH pool
holds liquidity 1.5e13; the ETH/FJ pool 3.64e20 (the fee asset did not move, so it carries over). Quotes in FJ for
0.25 / 0.5 / 1 / 1.5 / 2 tokens, against the carried 29.773 FJ floor:

| Token | 0.25 | 0.5 | 1 | 1.5 | 2 |
|---|---|---|---|---|---|
| USDC | 7.226 | 14.446 | 28.869 | 43.271 | 57.650 |
| USDT | 9.016 | 18.024 | 36.017 | 53.978 | 71.908 |
| EURC | 9.243 | 18.478 | 36.923 | 55.336 | 73.715 |
| GBPC | 9.215 | 18.421 | 36.809 | 55.164 | 73.487 |

`FUEL_SLICE_UNITS=1500000` for every fueled run: USDC's 43.27 FJ is 41.97 after the 300 bps slippage, which clears
the floor. The swap smoke's default slice (one whole token) would quote USDC under the floor.

## Ordering

EURC and GBPC are pre-created (`--no-register`) inside the deploy run, which already holds the deployer secret, so
the fuel runs go under testnet-l1 without it. The smokes only read `tokens[0..1]`, and pre-create appends, so the
reorder changes no sample.
