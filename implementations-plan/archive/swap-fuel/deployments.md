# swap-fuel — live Sepolia deployment record

## P2 broadcast (DeployFuelLive.s.sol, defaults)

| Contract | Address | Verified |
|---|---|---|
| UniswapFuelSwap | `0xE223f59a8b0375aFea25C7eccF537bC18867823e` | [Etherscan ✓](https://sepolia.etherscan.io/address/0xe223f59a8b0375afea25c7eccf537bc18867823e#code) |
| SwapBridgeRouter | `0x8394D4e792e5b9Dd881829BB55f4956cc64a2206` | [Etherscan ✓](https://sepolia.etherscan.io/address/0x8394d4e792e5b9dd881829bb55f4956cc64a2206#code) |

Pools (V4 PoolManager `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`, both hookless):
- **AZLO/WETH** fee 500 / spacing 10, initialized at 100 AZLO per WETH (sqrtPriceX96 `7922816251426433759354395033`, tick ≈ −46055), L = 3.2e18 ≈ 0.22 WETH + ~22 AZLO in range, band [−69060, −23040].
- **ETH/FeeJuice** fee **987** / spacing 10 (OUR tier — fee 500 is squatted at ~8e9 FJ/ETH, fee 3000 is the drifted shared pool), initialized at 200,000 FJ per ETH (sqrtPriceX96 `35431911422859141528926554161152`, tick ≈ 122066), L = 70e18 ≈ 0.11 ETH + ~21.4k free-minted FJ, band [99060, 145140].

Post-deploy gate (all green):
- Wiring: `router.swapTarget == UniswapFuelSwap`, `feeJuicePortal == 0xd336…0596` (canonical), `permit2` canonical, `owner == 0xFcc2…F6F5` (deploy EOA — can re-point the swap target within the hardened bounds and sweep dust; gate Ask 3 accepted).
- Live quoter probe: 0.25 AZLO → 0.00248 WETH → **487.67 FJ** (expected band [450, 510] — matches the fork rehearsal).
- Spend ≈ 0.45 ETH incl. seeds; deployer leftover ≈ 9.67 ETH (re-seed headroom per the gate's top-up decision).
- Both contracts Etherscan-verified exact-match via the extended `verify:l1`.

Config: `packages/faucet/public/testnet-bridge.json` `l1.fuel` (router/swapTarget/quoter/pools/slippageBps 300/minFuelFj PROVISIONAL 100 FJ until P5 calibrates).
Tx log: forge broadcast journal (`packages/bridge-evm/broadcast/`, gitignored) on the deploy machine.
Re-runs: `DeployFuelLive.s.sol` is idempotent — set `FUEL_SWAP_ADDRESS`/`ROUTER_ADDRESS` to reuse contracts and re-seed only; price guards abort on out-of-tolerance pools.
