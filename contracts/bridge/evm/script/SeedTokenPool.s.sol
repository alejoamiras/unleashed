// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {PoolSetupHelper, IWETH} from "./PoolSetupHelper.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
    function maxMintPerTx() external view returns (uint256);
    function decimals() external view returns (uint8);
}

/**
 * @notice The "new bridged token ⇒ create + seed its TOKEN/WETH pool" pipeline step (TESTNET).
 *         A token cutover retires the OLD token's pool (V4 pools are keyed by token address); this
 *         script gives the NEW token its swap-fuel route leg. The ETH/FeeJuice leg is
 *         token-independent and carries across generations — only TOKEN/WETH is per-token.
 *
 *         Token-agnostic: the token, its price shape, and the seed sizes come from env. Mainnet
 *         needs NO seeding (the route rides existing canonical liquidity) — this script is the
 *         testnet-only counterpart of mainnet's pool DISCOVERY step.
 *
 * Env:
 *   PRIVATE_KEY          broadcaster (the plan-pinned testnet signer)
 *   TOKEN                the bridged token (must sort below WETH → currency0; must be IMintable)
 *   POOL_FEE             fee tier (default 3000)
 *   POOL_TICK_SPACING    (default 60)
 *   POOL_SQRT_PRICE_X96  target sqrtPriceX96 for token/WETH (currency0=token). Default = the
 *                        DeployBridge fork-fixture's ~2,100 6-dec-USDC-per-WETH shape.
 *   TICK_LOWER/TICK_UPPER liquidity band (defaults match the fixture shape)
 *   WETH_SEED            WETH side of the liquidity (default 0.25 ether; must be ≤ the intent cap)
 *   POOL_LIQUIDITY       liquidityDelta (default 7.5e12 — the fixture's 6e13 scaled to 0.25 WETH)
 *   TOKEN_MINT_CALLS     how many maxMintPerTx mints to fund the helper (default 10)
 *
 * Front-run guard (from DeployFuelLive): V4 initialize is permissionless — the script ABORTS unless
 * the pool is uninitialized or already within ±10% of the target price; post-seed it re-asserts.
 *
 * Rehearse on a fork first:  anvil --fork-url $SEPOLIA_RPC_URL &  then run with --rpc-url anvil.
 */
contract SeedTokenPool is Script {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    // ── Sepolia canonical addresses (same pins as DeployBridge/DeployFuelLive) ──
    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant FEE_ASSET_HANDLER = 0x5602c39A6E9C5AcE589F64F754927bcDa4f4BFc9;

    uint256 constant SQRT_TOLERANCE_BPS = 1_000; // ±10%

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address token = vm.envAddress("TOKEN");
        uint24 fee = uint24(vm.envOr("POOL_FEE", uint256(3000)));
        int24 tickSpacing = int24(int256(vm.envOr("POOL_TICK_SPACING", uint256(60))));
        // The DeployBridge fork-fixture's 6-dec USDC/WETH shape (~2,100 token per WETH).
        uint160 sqrtPrice = uint160(vm.envOr("POOL_SQRT_PRICE_X96", uint256(1728916962386276374966316084832192)));
        int24 tickLower = int24(int256(vm.envOr("TICK_LOWER", uint256(169800))));
        int24 tickUpper = int24(int256(vm.envOr("TICK_UPPER", uint256(229800))));
        uint256 wethSeed = vm.envOr("WETH_SEED", uint256(0.25 ether));
        int256 liquidity = int256(vm.envOr("POOL_LIQUIDITY", uint256(7.5e12)));
        uint256 mintCalls = vm.envOr("TOKEN_MINT_CALLS", uint256(10));

        require(token < WETH, "token must sort below WETH (currency0) - redeploy the token (nonce bump)");
        require(IMintable(token).decimals() == 6, "price-shape default assumes a 6-dec token; set POOL_SQRT_PRICE_X96 for others");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token),
            currency1: Currency.wrap(WETH),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(0))
        });
        _guardPrice(key, sqrtPrice);

        vm.startBroadcast(pk);

        PoolSetupHelper helper = new PoolSetupHelper(POOL_MANAGER, FEE_ASSET_HANDLER);
        console.log("PoolSetupHelper:", address(helper));

        // Fund the helper: token side via permissionless capped mints, WETH side via deposit+transfer.
        uint256 perMint = IMintable(token).maxMintPerTx();
        for (uint256 i = 0; i < mintCalls; i++) {
            IMintable(token).mint(address(helper), perMint);
        }
        IWETH(WETH).deposit{value: wethSeed}();
        IERC20(WETH).safeTransfer(address(helper), wethSeed);

        helper.setup(0, key, sqrtPrice, tickLower, tickUpper, liquidity);
        console.log("token/WETH pool seeded (fee %s, tickSpacing %s)", fee, uint256(int256(tickSpacing)));

        helper.sweep(token);
        helper.sweep(WETH);
        helper.sweep(address(0));

        vm.stopBroadcast();

        _assertPrice(key, sqrtPrice);
        console.log("post-seed price within tolerance - record pools.tokenWeth {fee, tickSpacing} in the manifest");
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
