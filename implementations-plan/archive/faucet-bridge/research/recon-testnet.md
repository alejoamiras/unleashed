# P1 recon — live testnet snapshot (✅ GO)

Read-only recon (no key needed) via the public RPC. Reproduce:
`createAztecNodeClient("https://rpc.testnet.aztec-labs.com").getNodeInfo()` +
`cast call <addr> <sig> --rpc-url https://ethereum-sepolia-rpc.publicnode.com`.

- Node: `https://rpc.testnet.aztec-labs.com` · nodeVersion **4.3.1** · L1 = Sepolia (`11155111`) · **rollupVersion `4127419662`**.

## Go/no-go: ✅ GO (stop-the-line NOT triggered)
- **4.2.0-compatible:** `rollupVersion 4127419662` is exactly the faucet's 4.2.0 target (`packages/faucet/src/lib/chain-info.ts`), and the live faucet operates on it. The node *binary* is 4.3.1 (newer node, same rollup protocol) — not a blocker.
- **FeeAssetHandler wired:** `FEE_ASSET()` == `feeJuiceAddress` (`0x762c…`). `mint()` is permissionless; `mintAmount = 1000 FJ` (`1e21`) per call. FeeJuice is a live ERC20 (supply `1.15e28`).

## L1 contract addresses (Sepolia) — from getNodeInfo
| contract | address |
|---|---|
| rollup | `0xf6d0d42ace06829becb78c74f49879528fc632c1` |
| registry | `0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba` |
| inbox | `0xf1bb424ac888aa239f1e658b5bddabc65a1c94e6` |
| outbox | `0x5fe63c32b7ca20445e813bdb1019f1ffc5f52376` |
| **feeJuice (underlying)** | `0x762c132040fda6183066fa3b14d985ee55aa3c18` |
| feeJuicePortal | `0xd3361019e40026ce8a9745c19e67fd3acc10d596` |
| **feeAssetHandler** | `0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9` (mintAmount 1000 FJ; owner `0xdfe19Da6a717b7088621d8bBB66be59F2d78e924`) |
| stakingAsset | `0x5595cb9ed193cac2c0bc5393313bc6115817954b` (≠ feeJuice — do NOT confuse) |

## Implications for P2+
- **Fuel swap output MUST be feeJuice `0x762c…`** (== `FeeAssetHandler.FEE_ASSET()` == `feeJuicePortal.UNDERLYING()`). Seed V4 pools with handler-minted real FeeJuice (`mint()` → 1000 FJ/call, permissionless — loop N times to seed).
- `TokenPortal.initialize(registry=0xa0bf…, underlying=<our MintableERC20>, l2Bridge=<our token_bridge>)`.
- **Gas-sufficiency guard** (R2): FJ packet is 1000 FJ; the UI must ensure the claim covers `max_gas_cost`.
- **Recon gate CLEARED.** P2+ authoring unblocked. The remaining operator-gated steps are: actual **deploys** (need a Sepolia deployer key), the **P0.5 browser/MetaMask spike**, and **`e2e:agent`** (network sandbox).
