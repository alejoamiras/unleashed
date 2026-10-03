// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IUniswapFuelSwap} from "../SwapBridgeRouter.sol";

/**
 * @title MockSwapTarget
 * @notice Local-sandbox stand-in for UniswapFuelSwap. Takes the input token and
 *         returns FeeJuice at a configurable rate — no real V4. Used ONLY for the
 *         local anvil+aztec e2e (the sandbox has no Uniswap V4); the REAL swap is
 *         exercised by the Sepolia-fork Foundry test: local = cross-chain
 *         correctness with a mock swap, fork = real V4.
 *
 * @dev Must be pre-funded with FeeJuice by the deploy harness. Honors minOutput
 *      and actually transfers `out`, so the router's balance-mismatch guard +
 *      slippage bound are exercised exactly as in production.
 */
contract MockSwapTarget is IUniswapFuelSwap {
    IERC20 public immutable feeJuice;
    uint256 public rateNum = 1; // output = inputAmount * rateNum / rateDen
    uint256 public rateDen = 1;

    constructor(address _feeJuice) {
        feeJuice = IERC20(_feeJuice);
    }

    /// @notice Set the mock exchange rate (output FeeJuice per input unit).
    function setRate(uint256 _num, uint256 _den) external {
        require(_den != 0, "MockSwapTarget: zero denominator");
        rateNum = _num;
        rateDen = _den;
    }

    function swap(address inputToken, uint256 inputAmount, uint256 minOutput, PoolKey[] calldata, bool[] calldata)
        external
        override
        returns (uint256)
    {
        IERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount);
        uint256 out = (inputAmount * rateNum) / rateDen;
        require(out >= minOutput, "MockSwapTarget: insufficient output");
        feeJuice.transfer(msg.sender, out);
        return out;
    }
}
