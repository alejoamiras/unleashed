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

## Step 3: the deploy (`keyed/step3-deploy.sh`, testnet-generation)

Green in one pass, no retry used: `verify`, the dry run (L1 deployer `0x7F42…6a9a`, L2 deployer
`0x15aa2cfc…e9e1`, chain 11155111/679261766, USDC and USDT), the L2 account, then the generation. The Token
class was already published on the reset network (class publication is permissionless and content-addressed);
the hub class was published by this run. Every readback passed: `factory.L2_HUB`, the router's `FACTORY`,
`FEE_ASSET`, `permit2`, `feeJuicePortal` and `swapTarget`, `hub.token_for`. EURC and GBPC were pre-created
unregistered in the same run. No forge broadcast ran (`SKIP_POOL_SEED=1`), so there is no broadcast cache to
delete.

| Contract | Address |
|---|---|
| UniswapFuelSwap | `0xab7a35ac6247328851880c1faa68e051fe8d8a84` |
| PortalFactory | `0x2509411e06a3b9512eca3d9f2668afd7821b7817` |
| SwapBridgeRouter | `0xad08e65dda66eaed5ab9447f27b7610a850f4303` |
| TokenBridgeHub | `0x1d500beb91a75ccd2e5376d14980b0cabd494fe3397e710faddc371376de7530` |

| Token | L1 | Portal | Hub registration |
|---|---|---|---|
| USDC | `0x8648…51fc` | `0x8128d00bb1349e1b21d2281167925e9e3187fb74` | registered |
| USDT | `0x8bad…238f` | `0xe4b6a28350ad82eb03b3167587d6cb06c096c247` | registered |
| EURC | `0xc10b…4d24` | `0x6535a0f1426524a8ed5bb64692e7645c033d15cc` | on the first claim |
| GBPC | `0x177e…efca` | `0x717ae3636685489c87cf331af663cfa75723d0d9` | on the first claim |

The candidate (gitignored until promotion) holds no URL; the journal has 12 lines.

## Step 4: verify and the faucet

`verify` on testnet-rpc was green (spend 0.000094 of 2 ETH). `deploy:testnet --output` on testnet-faucet, written
outside the repository, deployed the faucet account `0x029ca664…cc3e`, the Dripper `0x057ca596…634b` (its class
published in the same transaction), SIGNAL `0x1c313062…bfa3` and NOISE `0x26bc4fcf…73f3`, all paid through the
SponsoredFPC `0x2d8fff82…69d3`. The output equals the committed `deployments.json` byte for byte (`cmp` exit 0).
Nothing touched L1.

## Steps 5–6: the gate, the smokes and the fuel samples (`keyed/step6-smokes-fuel.sh`, testnet-l1)

Green with no retry, in minutes rather than the hour the runbook budgets. The FPC gate was green four times
("compat + identity + digest + live class all agree"). The candidate smoke bridged USDC and USDT, public and
private, in 4.1 minutes. The fueled smoke settled a self-paying claim in 1.6 minutes: 1.5 USDC in, 40.28 FJ
gained.

Fees in FJ-wei, each identical to rc.3's digit for digit: the same circuits burn the same L2 gas, and both
networks bill it at 1.25e12 FJ-wei per unit.

| Run | Path | Claim fee | Register fee | Ceiling (`getFeeLimit`) |
|---|---|---|---|---|
| EURC public | register+claim | 2970310475249600000 | (inside) | — |
| EURC private ×3 | claim | 1137202681952400000, 1068358920937400000 ×2 | — | 2838685858590000000 |
| GBPC private first | register,claim | 1026798914287800000 | 2203834102613400000 | 8516057575770000000 |
| GBPC private ×2 | claim | 1068358920937400000 ×2 | — | 2838685858590000000 |
| USDC public | claim | 1656099014975800000 | — | — |

## Step 7: calibrate

The Stop condition does not hold: the worst measured private ceiling, 8.516 FJ on GBPC's private first claim,
sits below `MIN_FUEL_FJ` (29.773 FJ). The nine samples, written outside the repository (1
`register_and_claim_public`, 6 `claim_private`, 1 `register_token`, 1 `claim_public`), give
`fjPerTx=1987318817970960000` and `fjRegister=1577053752328560000`, equal to the carried values, so the
candidate did not change (sha256 `e17942e5…58f8` before and after).

## Step 8: verify the candidate, retire the rc.3 manifest, promote

`verify --candidate` (testnet-rpc) was green: every token's registration, decimals and metadata words agree,
"L1 verification passed", "candidate strict-valid + privileged readbacks agree", and the hub's initialization
hash and class match the manifest. The four runtime code hashes equal rc.3's: TokenPortalImpl `0xb02b…2ea1`,
PortalFactory `0xc924…5d4d`, SwapBridgeRouter `0x3e87…e195`, UniswapFuelSwap `0xf1bf…78a8`. The intent now records
the candidate digest `e17942e5…58f8`.

`apps/tools/public/testnet-bridge.json` (rc.3's dead generation) was deleted in its own commit (`a12b6f5`). The FPC
gate was green again (the pinned address unpublished; wallets register it locally), then `promote --bridge-only`
(testnet-rpc) re-ran the strict verify and took the first-promotion path ("no live manifest yet"). The live
manifest's sha256 is the verified candidate's, `e17942e5…58f8`; the receipt records the faucet file unchanged
(`964fe449…242a`). Neither file holds a URL.

## Step 9: the L2 token addresses

For the wallet's repository, which mirrors a promoted generation by hand:

| Token | `l2Token` |
|---|---|
| USDC | `0x249038d2cc0a301b8cc7d2d87da06c5861112b983060405dcaa75240d5837f32` |
| USDT | `0x09273f734ea96c47a1eccf4bfc9ee08dab36fe11fad44af6a1b8a1867324c505` |
| EURC | `0x10b4653676004b7c5dd4d10d7a582b5968f350d71e1d6db1a5e792d5d455649d` |
| GBPC | `0x28af9cb09c9bd7cc9a01781c00893b5eea2de716cf49ce9c654cb154224ef06a` |

## Spend (gross, per broadcast group)

| Group | Run | ETH |
|---|---|---|
| Step 3 | generation, USDC, USDT, EURC, GBPC | 0.000094 (balance 2.903570 → 2.903475, public RPC) |
| Steps 5–6 | smokes and eight fee samples | 0.000013 (balance 2.903475 → 2.903462) |
