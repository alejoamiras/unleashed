## Purpose

Research module covering Uniswap V4 on Sepolia: canonical deployment addresses, pool-seeding mechanics (from the Holonym reference), PoolKey + route construction, on-chain quoting, and — most importantly — the fee-juice-underlying reconciliation that determines whether a swap output can actually be deposited via `FeeJuicePortal`.

---

## V4 Sepolia addresses (sourced)

All addresses from the official Uniswap V4 deployments page:  
Source: https://developers.uniswap.org/contracts/v4/deployments (chain ID 11155111)

| Contract | Address |
|---|---|
| PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| PositionManager | `0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4` |
| V4 Quoter | `0x61b3f2011a92d183c7dbadbda940a7555ccf9227` |
| Universal Router | `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| StateView | `0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c` |
| WETH (Sepolia) | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |

These are the **only canonical addresses**. Holonym's scripts hardcode the PoolManager and Quoter — both match the docs exactly (confirmed by cross-referencing `SeedUniswapPools.s.sol` and `frontend/src/config/index.ts`).

Aztec protocol contracts (from the Holonym `deployments.json`, which tracks Aztec 4.1.2 testnet):

| Contract | Address |
|---|---|
| FeeJuice (L1 ERC-20) | `0x762c132040fdA6183066Fa3B14d985ee55aA3C18` |
| FeeJuicePortal | `0xd3361019e40026ce8a9745c19e67fd3acc10d596` |
| StakingAsset (separate) | `0x5595cb9ed193cac2c0bc5393313bc6115817954b` |
| FeeAssetHandler | `0x5602c39A6E9C5AcE589F64F754927bcDa4f4BFc9` |

These are deployment-specific and will change when the bridge deploys against **Aztec 4.2.0**. They must be read from `getNodeInfo().l1ContractAddresses` at runtime; do not hardcode them.

---

## Pool seeding recipe

Reference: [holonym] `l1-contracts/script/SeedUniswapPools.s.sol` and `l1-contracts/script/DeployUniswapFuelSwap.s.sol`

Holonym seeds **two or three pools** depending on env flags. The canonical seeding recipe for the USDC→FeeJuice headline flow is:

### Pool 1 — Native ETH / FeeJuice (primary fee pool)

This is the pool that `UniswapFuelSwap` uses for the final hop.

| Parameter | Value |
|---|---|
| `currency0` | `address(0)` (native ETH, must be < FeeJuice address numerically) |
| `currency1` | FeeJuice ERC-20 address |
| `fee` | 3000 (0.3%) |
| `tickSpacing` | 60 |
| `hooks` | `address(0)` |
| `sqrtPriceX96` | `7922816251426433759354395033600` (~10,000 FeeJuice per ETH: `sqrt(10000) * 2^96`) |
| Tick range (full) | `-887220` to `887220` |
| Seed liquidity | 1e18 (configurable via `LIQUIDITY_DELTA`) |
| ETH seed | 0.3–0.5 ether |
| FeeJuice seed | 100 × `FeeAssetHandler.mint()` = 100,000 FJ (each mint call mints 1,000 FJ to the seeder address) |

The `FeeAssetHandler.mint(address)` function is a testnet-only privileged mint on the Aztec-deployed `FeeAssetHandlerAddress`. It mints 1,000 FeeJuice per call into any address. This is how liquidity is bootstrapped — there is no other free source of the real FeeJuice on testnet.

### Pool 2 — USDC / WETH (intermediate hop)

| Parameter | Value |
|---|---|
| `currency0` | USDC address (lower address, so ordered first) |
| `currency1` | WETH address |
| `fee` | 3000 (0.3%) |
| `tickSpacing` | 60 |
| `hooks` | `address(0)` |
| `sqrtPriceX96` | `1728916962386276374966316084832192` (~2,100 USDC per WETH) |
| Tick range | `-887220` to `887220` (full range) |
| USDC seed | 3,000–5,000 USDC (minted via `TestERC20.mint()` — only works if our USDC is a test token with public mint) |
| WETH seed | 1.5 ether (ETH wrapped via `IWETH.deposit()`) |

### Pool 3 — ERC-20 / FeeJuice direct (optional, smart routing)

A direct USDC→FeeJuice pool that the `getBestRoute()` smart router quotes in parallel against the USDC→WETH→FeeJuice two-hop route, picking whichever gives more output. Seeded behind `SEED_DIRECT_POOL=true`.

### PoolSeeder helper pattern

Both scripts deploy a transient on-chain `PoolSeeder` / `PoolSetupHelper` contract that:
1. Receives tokens and ETH.
2. Calls `PoolManager.initialize(key, sqrtPriceX96)` (idempotent — catches `AlreadyInitialized` revert).
3. Calls `PoolManager.unlock(...)` → `unlockCallback` → `modifyLiquidity(...)` → settles deltas inline (sync+transfer+settle for ERC-20; `settle{value}()` for native ETH).
4. Returns leftovers via `sweep()`.

This helper is deployed per-run and discarded. Unleashed should reuse this exact pattern verbatim.

---

## PoolKey + route construction

### PoolKey struct

```solidity
struct PoolKey {
    Currency currency0;   // lower address (address(0) for native ETH)
    Currency currency1;   // higher address
    uint24 fee;
    int24 tickSpacing;
    IHooks hooks;         // address(0) = no hooks
}
```

**Ordering invariant**: `currency0` must be the numerically lower address. `address(0)` is always `currency0` when paired with any ERC-20.

### Route: USDC → WETH → FeeJuice (via native ETH pool)

Two-hop route. This is the primary path for `bridgeWithFuel`.

```
Hop 0:  USDC  → WETH      (USDC/WETH pool, currency0=USDC, currency1=WETH)
Hop 1:  ETH   → FeeJuice  (ETH/FeeJuice pool, currency0=address(0), currency1=FeeJuice)
```

`path` array (length 2):
```ts
[
  { currency0: USDC_ADDR,    currency1: WETH_ADDR,      fee: 3000, tickSpacing: 60, hooks: ZERO },
  { currency0: NATIVE_ETH,   currency1: FEE_JUICE_ADDR, fee: 3000, tickSpacing: 60, hooks: ZERO },
]
zeroForOnes = [
  BigInt(USDC_ADDR) < BigInt(WETH_ADDR),       // true: selling currency0 (USDC)
  BigInt(NATIVE_ETH) < BigInt(FEE_JUICE_ADDR), // true: selling currency0 (ETH = address(0))
]
```

For single-hop (WETH input → FeeJuice):
```
path = [{ currency0: NATIVE_ETH, currency1: FEE_JUICE_ADDR, fee: 3000, tickSpacing: 60, hooks: ZERO }]
zeroForOnes = [true]  // address(0) < any ERC-20 address
```

### Route building in TypeScript

Reference: [holonym] `frontend/src/utils/fuelPricing.ts` → `buildSwapRoute()` and `buildCandidateRoutes()`

Key logic:
```ts
function buildPoolKey(tokenA, tokenB, fee, tickSpacing): PoolKeyParam {
  const [currency0, currency1] = BigInt(tokenA) < BigInt(tokenB)
    ? [tokenA, tokenB] : [tokenB, tokenA]
  return { currency0, currency1, fee, tickSpacing, hooks: ZERO_ADDRESS }
}

function isZeroForOne(selling, buying): boolean {
  return BigInt(selling) < BigInt(buying)
}
```

`NATIVE_ETH = '0x0000000000000000000000000000000000000000'` — always `currency0`, always `zeroForOne = true`.

### UniswapFuelSwap settlement cases

Reference: [holonym] `l1-contracts/src/UniswapFuelSwap.sol` → `_settle()`

The contract handles three distinct settlement cases inside `unlockCallback`:

- **Case A — All ERC-20**: e.g. WETH/AZTEC pool without native ETH. Sync + transfer input token + settle.
- **Case B — Single-hop native**: e.g. WETH input to ETH/AZTEC pool. Unwrap WETH → ETH, `settle{value}()`.
- **Case C — Multi-hop, last pool native**: USDC→WETH→ETH/AZTEC. Settle USDC for first hop, take intermediate WETH from PoolManager, unwrap WETH→ETH, `settle{value}()` for last hop.

Case C is the primary flow.

---

## Quoting

Reference: [holonym] `frontend/src/utils/fuelPricing.ts` → `getV4Quote()`, `quoteExactInputSingleCall()`, `getBestRoute()`  
Reference: [holonym] `frontend/src/utils/fuelQuote.ts` → `getUniswapFuelQuote()`

### On-chain quote via `eth_call`

The V4 Quoter (`0x61b3f2011a92d183c7dbadbda940a7555ccf9227`) exposes `quoteExactInputSingle`:

```ts
quoteExactInputSingle(params: {
  poolKey: PoolKeyParam
  zeroForOne: boolean
  exactAmount: uint128
  hookData: bytes  // '0x' for hookless pools
}) => [amountOut: uint256, gasEstimate: uint256]
```

For multi-hop routes, Holonym chains single-hop quotes sequentially:
```ts
let currentAmount = inputAmount
for (const [poolKey, zeroForOne] of route) {
  currentAmount = await quoteExactInputSingle({ poolKey, zeroForOne, exactAmount: currentAmount, hookData: '0x' })
}
// currentAmount is the expected FeeJuice output
```

This is a simulation call — zero gas cost. Uses `createPublicClient` from viem with `sepolia` chain.

### Slippage calculation

```ts
const minOutput = expectedOutput - (expectedOutput * BigInt(slippageBps)) / 10000n
// Default: 300 bps = 3% slippage
```

The `minOutput` becomes `minFuelOutput` in `BridgeParams`, which `UniswapFuelSwap.swap()` enforces on-chain.

### Smart routing

`buildCandidateRoutes()` generates up to two candidates:
1. **direct**: USDC → FeeJuice (single hop via direct pool, if seeded)
2. **via-weth**: USDC → WETH → FeeJuice (two-hop, always available if USDC/WETH pool has liquidity)

Both are quoted in parallel via `Promise.allSettled`. Reverts on missing pools are caught and skipped. Best output wins. This is important for the UI — the UI should display the route label alongside the quote.

---

## CRITICAL: fee-juice-underlying reconciliation

**This is the highest-value finding in this module.**

### The constraint

`FeeJuicePortal.UNDERLYING()` is an immutable set at deployment time:
```solidity
IERC20 public immutable UNDERLYING;
constructor(IRollup _rollup, IERC20 _underlying, IInbox _inbox, uint256 _version) {
    UNDERLYING = _underlying; // set once, never changes
}
```

`SwapBridgeRouter.bridgeWithFuel()` calls:
```solidity
IERC20 feeJuiceToken = feeJuicePortal.UNDERLYING();
// ... then:
feeJuiceToken.forceApprove(address(feeJuicePortal), fuelReceived);
feeJuicePortal.depositToAztecPublic(p.fuelRecipient, fuelReceived, p.fuelSecretHash);
```

`depositToAztecPublic` calls `UNDERLYING.safeTransferFrom(msg.sender, address(this), _amount)`.

**If the swap output token ≠ `UNDERLYING`, the deposit call reverts.** There is no way around this — it is a hard constraint.

### What Holonym actually does

**Answer: Holonym seeds pools against the REAL fee-juice underlying, and this is confirmed by two independent data points.**

**Data point 1 — The `AZTEC` constant matches `feeJuiceAddress` from the testnet deployment:**

In `SeedUniswapPools.s.sol` and `DeployUniswapFuelSwap.s.sol`:
```solidity
address constant AZTEC = 0x762C132040fdA6183066Fa3B14d985ee55aA3C18;
```

In `deployments.json` (Aztec 4.1.2 testnet, as returned by `getNodeInfo()`):
```json
"feeJuiceAddress": "0x762c132040fda6183066fa3b14d985ee55aa3c18"
```

These are the same address (case-insensitive match confirmed). The pool is seeded with the **canonical Aztec FeeJuice ERC-20** that `FeeJuicePortal.UNDERLYING()` returns.

**Data point 2 — The minting mechanism proves it is the real asset:**

Holonym mints FeeJuice for liquidity via:
```solidity
address constant FEE_ASSET_HANDLER = 0x5602c39A6E9C5AcE589F64F754927bcDa4f4BFc9;
IFeeAssetHandler(FEE_ASSET_HANDLER).mint(address(seeder));
```

`FeeAssetHandler` is the Aztec protocol's official `feeAssetHandlerAddress` from the node info. It is an allowlisted minter for the real `FeeJuice` (fee asset) ERC-20. The fact that Holonym uses this specific handler — rather than a `TestERC20.mint()` call — proves `AZTEC` is the real protocol asset, not a standalone test token.

**Data point 3 — `stakingAssetAddress` is a distinct address:**

```
feeJuiceAddress:     0x762c132040fda6183066fa3b14d985ee55aa3c18  ← swap output token, FeeJuicePortal.UNDERLYING()
stakingAssetAddress: 0x5595cb9ed193cac2c0bc5393313bc6115817954b  ← separate staking asset (not fee juice)
```

These are different tokens. The swap must output the **`feeJuiceAddress`** asset, not the staking asset.

### The Aztec 4.2.0 implication

The `feeJuiceAddress` is **deployment-specific** — it will be a different address when the bridge deploys against Aztec 4.2.0. The Holonym address `0x762c...` is specific to the Aztec 4.1.2 testnet deployment. The bridge must:

1. Call `aztecNode.getNodeInfo()` to retrieve `l1ContractAddresses.feeJuiceAddress` and `l1ContractAddresses.feeJuicePortalAddress` for the target network.
2. Use those addresses — not hardcoded values — in `UniswapFuelSwap`'s constructor (`feeJuice` parameter) and in `SwapBridgeRouter`'s constructor (`feeJuicePortal` parameter).
3. Seed the V4 pool with that same dynamically-resolved `feeJuiceAddress` as the pool's `currency1`.

### The seeding bootstrap problem

To seed the ETH/FeeJuice pool, the bridge needs FeeJuice tokens. On Aztec testnet this is only available via `FeeAssetHandler.mint()`. Options:

**Option A (recommended — same as Holonym)**: Use `FeeAssetHandler.mint()` in the seeding script. This works on any Aztec testnet where the deployer has access to the handler. The handler address comes from `getNodeInfo().l1ContractAddresses.feeAssetHandlerAddress`. This approach requires no protocol-level changes and is proven working.

**Option B**: Acquire FeeJuice via a faucet or pre-minted allocation. Not applicable on testnet without a separate faucet contract that holds a real FeeJuice balance.

**Option C — Wrong approach (do not use)**: Deploy a separate test ERC-20, call it "FeeJuice", and seed the pool with that. The swap output would be this test token. The `FeeJuicePortal.depositToAztecPublic()` call in `SwapBridgeRouter` would then revert because `UNDERLYING != testToken`. This approach silently works in isolation tests but fails end-to-end.

---

## Seeding plan

Derived from the Holonym recipe, adapted for the Aztec 4.2.0 deployment.

**Prerequisites:**
- Aztec 4.2.0 L1 contracts deployed on Sepolia (or a fresh testnet with known addresses).
- `getNodeInfo()` output captured and saved (provides `feeJuiceAddress`, `feeJuicePortalAddress`, `feeAssetHandlerAddress`).
- Deployer wallet funded with ~3 ETH Sepolia (for gas + pool seeds).
- `USDC` test token deployed or existing (needs public `mint()` for seeding; the Holonym USDC at `0x1410930096b50ad7459eb8dea486a7236628c99d` is a `TestERC20` with public mint).

**Script sequence:**
1. Deploy `UniswapFuelSwap(POOL_MANAGER, feeJuiceAddress, WETH)` — constructor wires the `feeJuice` immutable.
2. Deploy `SwapBridgeRouter(PERMIT2, feeJuicePortalAddress, uniswapFuelSwapAddress)`.
3. Deploy `PoolSeeder(POOL_MANAGER)`.
4. Seed **ETH/FeeJuice pool**:
   - Call `FeeAssetHandler.mint(seeder_address)` × N (each mints 1,000 FJ; 100 calls = 100,000 FJ suggested).
   - Fund seeder with ~0.5 ETH.
   - Call `seeder.setup(ethFeeJuiceKey, ETH_FJ_SQRT_PRICE, -887220, 887220, 1e18)`.
5. Seed **USDC/WETH pool**:
   - Mint USDC to deployer, wrap ETH → WETH, transfer both to seeder.
   - Call `seeder.setup(usdcWethKey, USDC_WETH_SQRT_PRICE, -887220, 887220, 6e13)`.
6. Optionally seed **USDC/FeeJuice direct pool** for smart routing.
7. Sweep leftovers from seeder.
8. Record deployed addresses in `deployments.json`.

**Key pool parameters (reuse Holonym constants verbatim):**

| Pool | `sqrtPriceX96` | Implied price |
|---|---|---|
| ETH/FeeJuice | `7922816251426433759354395033600` | ~10,000 FJ per ETH |
| USDC/WETH | `1728916962386276374966316084832192` | ~2,100 USDC per WETH |
| USDC/FeeJuice | `250541396071120286692299382636675072` | ~10 FJ per USDC |

All pools use `fee=3000`, `tickSpacing=60`, `hooks=address(0)`.

**Note on sqrtPrice ordering**: the sqrtPrice encodes `price = (currency1 / currency0)`. For ETH/FeeJuice where `currency0 = address(0)`, price = FJ per ETH = 10,000. For USDC/WETH where `currency0 = USDC`, price = WETH per USDC ≈ 1/2100.

---

## Open questions

1. **Aztec 4.2.0 FeeJuice address on Sepolia**: The Holonym address `0x762c...` is specific to the 4.1.2 testnet deployment. The bridge must call `getNodeInfo()` against the 4.2.0 deployment to get the current `feeJuiceAddress`. Does a live 4.2.0 testnet deployment already exist? (Check Aztec docs / Discord — their public testnet may still be on 4.1.x.)

2. **FeeAssetHandler access control**: Does `FeeAssetHandler.mint()` require any allowlist / role grant for the seeding deployer? Holonym uses it freely, suggesting it is permissionless on testnet — but this needs verification against the 4.2.0 contract source.

3. **USDC test token**: The Holonym USDC (`0x1410...`) has a public `mint()` and is specific to the Holonym deployment. The bridge needs its own test USDC with public mint. Can it reuse the Holonym USDC address for testnet purposes, or must it deploy a new one?

4. **Pool reseeding vs reuse**: If Holonym's ETH/FeeJuice pool already exists on Sepolia V4, the bridge can add liquidity to the existing pool (the `initialize` call is idempotent — it catches the AlreadyInitialized revert and continues). It does not need to deploy a new pool. This is only safe if the existing pool's parameters (fee, tickSpacing, hooks) match the bridge's requirements — and they do (same constants).

5. **Quoter `stateMutability`**: The V4 Quoter's `quoteExactInputSingle` is declared `nonpayable` in the ABI, not `view` — this is by design (the quoter uses temporary state). The `eth_call` approach (no gas, no state change) is the correct off-chain quoting pattern.

6. **Slippage on testnet**: With thin liquidity, 3% slippage may be insufficient. Consider 5–10% slippage for the testnet UI default, with a configurable override.
