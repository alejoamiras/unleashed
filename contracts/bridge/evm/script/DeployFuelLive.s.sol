// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {MintableERC20} from "../src/MintableERC20.sol";
import {SwapBridgeRouter} from "../src/SwapBridgeRouter.sol";
import {UniswapFuelSwap} from "../src/UniswapFuelSwap.sol";
import {PoolSetupHelper, IWETH} from "./PoolSetupHelper.sol";
import {GenerationDeployer} from "./DeployGeneration.s.sol";

/**
 * @notice Sepolia fuel topology: UniswapFuelSwap + SwapBridgeRouter against the EXISTING
 *         AZLO token + canonical Aztec portals, and the two route pools (AZLO/WETH + our own
 *         ETH/FeeJuice tier). The fork fixture for `DeployFuelLive.fork.t.sol`; the live
 *         generation is deployed by the TypeScript conductor, which leaves this script one
 *         live job — re-seeding the token-independent ETH/FeeJuice pool when the fee asset
 *         moves (`SEED_AZLO_WETH=false SEED_ETH_FJ=true` with the reuse flags below).
 *
 * Idempotent split (partial-failure recovery): set `FUEL_SWAP_ADDRESS` / `ROUTER_ADDRESS`
 * to reuse already-deployed contracts and re-run seeding only.
 *
 * Pool-init front-run guard: V4 `initialize` is permissionless, so a third party can
 * pre-initialize our keys at a garbage price. The script ABORTS unless the pool is
 * uninitialized or already within tolerance of the target price - never seeds liquidity
 * into a mispriced pool.
 */
contract DeployFuelLive is GenerationDeployer {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    // ── Sepolia canonical addresses ──
    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant FEE_JUICE = 0x762C132040fdA6183066Fa3B14d985ee55aA3C18;
    address constant FEE_ASSET_HANDLER = 0x5602c39A6E9C5AcE589F64F754927bcDa4f4BFc9;
    address constant FEE_JUICE_PORTAL = 0x5Bb7523A95c1FDF1D2A3DD9fb7d497E7F5142D7F;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // ── The live AZLO (18 dec, permissionless capped mint, Permit2 pre-approved) ──
    address constant AZLO = 0xB8ebd156dC94cdE08ec9E7EF0501232B2DbedEcE;

    // ── AZLO/WETH pool: 100 AZLO per WETH (cheap-FJ economics) ──
    // currency0 = AZLO (0xa40a… < 0xfFf9…), price c1/c0 = 0.01, sqrt(0.01)·2^96:
    uint24 public constant AZLO_WETH_FEE = 500;
    int24 public constant AZLO_WETH_SPACING = 10;
    uint160 public constant AZLO_WETH_SQRT_PRICE = 7922816251426433759354395033;
    int24 public constant AZLO_WETH_TICK_LOWER = -69060; // init tick ≈ -46054, wide straddle
    int24 public constant AZLO_WETH_TICK_UPPER = -23040;

    // ── OUR ETH/FeeJuice tier (decision: own pool, never skew the shared fee-3000 one).
    // Fee 987: the conventional 500 tier is already squatted on live Sepolia at tick ~227931
    // (~8e9 FJ/ETH) and the shared 3000 tier drifted to ~191 FJ/ETH - an eccentric fee value
    // avoids convention collisions. Price + fee/spacing env-tunable; default 200,000 FJ/ETH. ──
    uint160 public constant ETH_FJ_SQRT_PRICE_200K = 35431911422859141528926554161152;
    int24 public constant ETH_FJ_TICK_LOWER_200K = 99060; // init tick ≈ 122067
    int24 public constant ETH_FJ_TICK_UPPER_200K = 145140;

    // Default liquidity derivations (validated empirically by the fork test):
    //   AZLO/WETH  L=2.9e18 → ~0.20 WETH + ~20 AZLO in range; each 500-FJ purchase
    //   consumes ~0.0025 WETH → ~80 purchases of depth.
    //   ETH/FJ     L=70e18  → ~0.11 ETH + ~21,400 FJ in range (FJ is free-minted);
    //   ~40 purchases before the FJ side thins.
    // Abort threshold for an already-initialized pool: sqrtPrice within ±10% of target
    // (≈ ±21% in price terms) counts as "ours from a prior partial run".
    uint256 public constant SQRT_TOLERANCE_BPS = 1000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address token = vm.envOr("TOKEN_ADDRESS", AZLO);
        require(token < WETH, "token must sort below WETH (currency0)");

        vm.startBroadcast(pk);

        // 1. Contracts (reuse via env for partial-failure re-runs).
        UniswapFuelSwap swapTarget = vm.envOr("FUEL_SWAP_ADDRESS", address(0)) == address(0)
            ? new UniswapFuelSwap(POOL_MANAGER, FEE_JUICE, WETH)
            : UniswapFuelSwap(payable(vm.envAddress("FUEL_SWAP_ADDRESS")));
        SwapBridgeRouter router = vm.envOr("ROUTER_ADDRESS", address(0)) == address(0)
            ? new SwapBridgeRouter(PERMIT2, FEE_JUICE_PORTAL, address(swapTarget), _resolveFactory())
            : SwapBridgeRouter(vm.envAddress("ROUTER_ADDRESS"));
        console.log("UniswapFuelSwap:", address(swapTarget));
        console.log("SwapBridgeRouter:", address(router));

        // Only deploy the seeding helper when at least one pool is actually being seeded — otherwise a
        // reuse-the-swap re-run (FUEL_SWAP_ADDRESS set, both SEED_* false) is genuinely router-only.
        bool seedAzloWeth = vm.envOr("SEED_AZLO_WETH", true);
        bool seedEthFj = vm.envOr("SEED_ETH_FJ", true);
        PoolSetupHelper helper;
        if (seedAzloWeth || seedEthFj) {
            helper = new PoolSetupHelper(POOL_MANAGER, FEE_ASSET_HANDLER);
        }

        // 2. AZLO/WETH pool.
        if (seedAzloWeth) {
            PoolKey memory key = PoolKey({
                currency0: Currency.wrap(token),
                currency1: Currency.wrap(WETH),
                fee: AZLO_WETH_FEE,
                tickSpacing: AZLO_WETH_SPACING,
                hooks: IHooks(address(0))
            });
            _guardPrice(key, AZLO_WETH_SQRT_PRICE);

            uint256 wethSeed = vm.envOr("WETH_SEED", uint256(0.22 ether));
            int256 liquidity = int256(vm.envOr("AZLO_WETH_LIQUIDITY", uint256(32e17)));
            // Over-provision AZLO via the permissionless capped mint; leftovers swept back.
            uint256 mintCalls = vm.envOr("AZLO_MINT_CALLS", uint256(1));
            MintableERC20 azlo = MintableERC20(token);
            for (uint256 i = 0; i < mintCalls; i++) {
                azlo.mint(address(helper), azlo.maxMintPerTx());
            }
            IWETH(WETH).deposit{value: wethSeed}();
            IERC20(WETH).safeTransfer(address(helper), wethSeed);

            helper.setup(0, key, AZLO_WETH_SQRT_PRICE, AZLO_WETH_TICK_LOWER, AZLO_WETH_TICK_UPPER, liquidity);
            _assertPrice(key, AZLO_WETH_SQRT_PRICE);
            helper.sweep(token);
            helper.sweep(WETH);
            console.log("AZLO/WETH seeded (100 AZLO per WETH)");
        }

        // 3. OUR ETH/FeeJuice tier (FJ side free via FeeAssetHandler; ETH side small).
        if (seedEthFj) {
            PoolKey memory fjKey = PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(FEE_JUICE),
                fee: uint24(vm.envOr("FJ_POOL_FEE", uint256(987))),
                tickSpacing: int24(int256(vm.envOr("FJ_POOL_SPACING", uint256(10)))),
                hooks: IHooks(address(0))
            });
            uint160 fjSqrt = uint160(vm.envOr("FJ_POOL_SQRT_PRICE", uint256(ETH_FJ_SQRT_PRICE_200K)));
            _guardPrice(fjKey, fjSqrt);

            uint256 ethSeed = vm.envOr("ETH_FJ_SEED", uint256(0.12 ether));
            uint256 mintCount = vm.envOr("FEE_MINT_COUNT", uint256(30));
            int256 fjLiquidity = int256(vm.envOr("ETH_FJ_LIQUIDITY", uint256(70e18)));
            int24 fjTickLower = int24(vm.envOr("FJ_TICK_LOWER", int256(ETH_FJ_TICK_LOWER_200K)));
            int24 fjTickUpper = int24(vm.envOr("FJ_TICK_UPPER", int256(ETH_FJ_TICK_UPPER_200K)));
            helper.setup{value: ethSeed}(mintCount, fjKey, fjSqrt, fjTickLower, fjTickUpper, fjLiquidity);
            _assertPrice(fjKey, fjSqrt);
            helper.sweep(address(0));
            helper.sweep(FEE_JUICE);
            console.log("ETH/FeeJuice tier seeded (our own fee tier)");
        }

        vm.stopBroadcast();
        console.log("done - record addresses + pool keys in deployments.md / testnet-bridge.json");
    }

    /// @dev Abort rather than seed into a pool someone pre-initialized at a garbage price.
    function _guardPrice(PoolKey memory key, uint160 target) internal view {
        (uint160 current,,,) = IPoolManager(POOL_MANAGER).getSlot0(key.toId());
        if (current == 0) return; // uninitialized - helper.setup will initialize at target.
        require(_withinTolerance(current, target), "pool pre-initialized at unexpected price - aborting");
    }

    function _assertPrice(PoolKey memory key, uint160 target) internal view {
        (uint160 current,,,) = IPoolManager(POOL_MANAGER).getSlot0(key.toId());
        require(current != 0 && _withinTolerance(current, target), "post-seed price mismatch");
    }

    function _withinTolerance(uint160 current, uint160 target) internal pure returns (bool) {
        uint256 diff = current > target ? current - target : target - current;
        return diff * 10_000 <= uint256(target) * SQRT_TOLERANCE_BPS;
    }
}
