// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

interface IFeeAssetHandler {
    function mint(address) external;
}

interface IWETH {
    function deposit() external payable;
}

/**
 * @notice V4 pool seeder (generic): batch-mints FeeJuice via the permissionless
 *         FeeAssetHandler, initializes a pool (idempotent), seeds liquidity through
 *         the PoolManager.unlock callback, and sweeps leftovers. Verbatim pattern
 *         from the Human-Tech bridge — it's asset-agnostic.
 */
contract PoolSetupHelper is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable pm;
    address public immutable feeAssetHandler;
    address public immutable deployer;

    constructor(address _pm, address _feeAssetHandler) {
        pm = IPoolManager(_pm);
        feeAssetHandler = _feeAssetHandler;
        deployer = msg.sender;
    }

    receive() external payable {}

    function setup(
        uint256 mintCount,
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external payable {
        require(msg.sender == deployer, "not deployer");
        for (uint256 i = 0; i < mintCount; i++) {
            IFeeAssetHandler(feeAssetHandler).mint(address(this));
        }
        try pm.initialize(key, sqrtPriceX96) returns (int24) {} catch {}
        pm.unlock(abi.encode(key, tickLower, tickUpper, liquidityDelta));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidityDelta) =
            abi.decode(data, (PoolKey, int24, int24, int256));

        (BalanceDelta delta,) = pm.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: liquidityDelta,
                salt: bytes32(0)
            }),
            ""
        );

        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();

        if (d0 < 0) _pay(key.currency0, uint256(uint128(-d0)));
        if (d1 < 0) _pay(key.currency1, uint256(uint128(-d1)));
        if (d0 > 0) pm.take(key.currency0, address(this), uint256(uint128(d0)));
        if (d1 > 0) pm.take(key.currency1, address(this), uint256(uint128(d1)));
        return "";
    }

    function _pay(Currency currency, uint256 owed) internal {
        if (Currency.unwrap(currency) == address(0)) {
            pm.settle{value: owed}();
        } else {
            pm.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(pm), owed);
            pm.settle();
        }
    }

    function sweep(address token) external {
        require(msg.sender == deployer, "not deployer");
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) payable(deployer).transfer(bal);
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(deployer, bal);
        }
    }
}
