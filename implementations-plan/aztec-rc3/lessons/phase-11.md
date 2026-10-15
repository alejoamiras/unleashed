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

## Step 3: the deploy

`rc3-deploy-5f856d18` (testnet-generation) went green through `verify`, the dry run, the L2 deployer account, the
UniswapFuelSwap `0xbc4b…5a64`, the class publications and the factory deploy at the predicted `0xc68a…565a`. Then
`readFactoryBindings` read `L2_HUB()` as `0x` straight after the receipt, although `IMPLEMENTATION()` had answered
in the same call. That is a lagging backend behind the keyed Sepolia RPC. Two public RPCs read the factory a
minute later: 19479 bytes of code, IMPLEMENTATION `0xdf4d…b047` (the predicted one), L2_HUB `0x08f3…39c9`. The
re-run adopts the landed factory (`adoptLandedFactory` checks both bindings), so the generation stays alive. The
read-after-receipt race is a follow-up: a source fix inside the window would void the intent.

The resume (`rc3-deploy-resume-9641ec7e`) adopted the factory and landed the router `0x9696…8df7`, the hub
`0x08f3…39c9` and every readback, then USDC's portal. It stopped on the same lag right after USDT's
`createPortal`; a public RPC showed the registration a minute later. The third run (`rc3-deploy-tokens-faf39129`)
wrapped each command in a bounded retry (4 attempts, 60 s apart, `verify` before each), the runbook's own
re-run recovery. It finished green: USDT registered on the hub, the candidate written, then EURC and GBPC
pre-created unregistered. GBPC's portal read lagged once and the retry recovered it. Spend: 0.000079 ETH.

| Token | L1 | Portal | L2 token |
|---|---|---|---|
| USDC | `0x8648…51fc` | `0x1d8a…772a` | `0x1d753361e33e8ceb41e07f621785a1db2297e29c6507a35af2cf4e5a5210e6db` |
| USDT | `0x8bad…238f` | `0x3c34…7cea` | `0x16d70d782cc2c94f5aad3461dd3d0272d037a143ac6f6db77f3541d8154116c5` |
| EURC | `0xc10b…4d24` | `0x1636…a2e7` | `0x1d7cf5ef4a2ed63584d4c915e94268a4ffb2c95cd91e2f2940d9a16a0ddb4813` |
| GBPC | `0x177e…efca` | `0xf633…3db2` | `0x0e2d0bbe86f69fe27272cb09539952cb055e83088d1419afbeda64da05e67cb5` |

Factory `0xc68a230a765ea13240785a88c7078712908a565a`, router `0x969652d23c3dddba2fa185e2cbbc36f9d6408df7`, swap
target `0xbc4b882477c03c144b90f24626017b51ec415a64`, hub
`0x08f380397b1978e0c6939d525c41695dd0e254d5214affe875061b8906b339c9`.

## Step 4: the faucet (`rc3-faucet-1f4e1cbe`, testnet-faucet)

Green. The Dripper was already at `0x0fda…95d4` (`[EXISTING]`): the address commits to its class, constructor
arguments and deployer, so the instance is the expected one; the drip canary proves it works. SIGNAL `0x1349…6599`
and NOISE `0x23f1…4537` were deployed. The output, written outside the repository, equals the committed
`deployments.json` byte for byte.

The faucet paid through the SponsoredFPC `0x2adfb70e860909f0db8268b3fec80bce52a94559963444f5c0341816b8412130`.
On the keyless node, `node_getContract` returns it with original and current class
`0x0d6670f2…2437`, salt zero and deployer zero. The app does not hard-code it:
`apps/tools/src/contracts/sponsored-fpc.ts` derives it from the installed SponsoredFPC artifact and
`SPONSORED_FPC_SALT`, and running that code yields the same address and class.

## Steps 5–6: the gate, the smokes and the fuel samples (`rc3-smokes-fuel-136846a5`, testnet-l1)

Green with no retry used. The FPC gate was green three times ("compat + identity + digest + live class all
agree"). The candidate smoke bridged USDC and USDT, public and private, in 2.9 minutes. The fueled smoke quoted
1.5 USDC at 43.27 FJ (floor 41.97 after slippage) and settled a self-paying claim.

The rc.3 testnet bills far less than rc.1 did. Fees in FJ-wei:

| Run | Path | Claim fee | Register fee | Ceiling (`getFeeLimit`) |
|---|---|---|---|---|
| EURC public | register+claim | 2970310475249600000 | (inside) | — |
| EURC private ×3 | claim | 1137202681952400000, 1068358920937400000 ×2 | — | 2838685858590000000 |
| GBPC private first | register,claim | 1026798914287800000 | 2203834102613400000 | 8516057575770000000 |
| GBPC private ×2 | claim | 1068358920937400000 ×2 | — | 2838685858590000000 |

## Step 7: calibrate

The Stop condition does not hold. The worst measured private ceiling, 8.516 FJ on GBPC's private first claim,
sits below `MIN_FUEL_FJ` (29.773 FJ), a margin of 3.5×. The validator's `4× worst getFeeLimit` heuristic prints
34.064 FJ. The follow-up that moves `MIN_FUEL_FJ` to the measured ceiling should decide between the two.

The samples were written outside the repository: 1 `register_and_claim_public`, 6 `claim_private`, 1
`register_token`. No plain `claim_public` was sampled; the public register+claim minus the private
`register_token` puts one near 0.77 FJ, under the private plain claim. The result: `fjPerTx=1364643218342880000`
and `fjRegister=2199729351956640000` (each worst value plus 20 %), down from the carried 3.28 and 2.94 FJ. The
candidate is final.
