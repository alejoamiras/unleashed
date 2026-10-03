// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IV4Quoter} from "../interfaces/IV4Quoter.sol";
import {MockSwapTarget} from "./MockSwapTarget.sol";

/**
 * @title MockV4Quoter
 * @notice Local-sandbox stand-in for the Uniswap V4 Quoter, answering the two hop shapes the fuel
 *         route grammar produces so off-chain discovery finds a route where MockSwapTarget will
 *         settle one. The composed quote equals what the mock swap pays: the token→WETH hop is
 *         1:1 and the native→FeeJuice hop applies the target's live rate, so a floor signed from
 *         these quotes is met exactly at settlement.
 *
 * @dev Only allow-listed tokens quote; every other pool, and any hooked pool, reverts — the shape
 *      discovery treats as "no such pool". The revert reason is never decoded off-chain.
 */
contract MockV4Quoter is IV4Quoter {
    MockSwapTarget public immutable target;
    address public immutable weth;
    address public immutable feeJuice;
    mapping(address => bool) public routable;

    constructor(MockSwapTarget _target, address _weth, address _feeJuice) {
        target = _target;
        weth = _weth;
        feeJuice = _feeJuice;
    }

    function setRoutable(address token, bool ok) external {
        routable[token] = ok;
    }

    function quoteExactInputSingle(QuoteExactSingleParams calldata p)
        external
        view
        override
        returns (uint256 amountOut, uint256 gasEstimate)
    {
        require(address(p.poolKey.hooks) == address(0), "MockV4Quoter: hooked pool");
        address c0 = Currency.unwrap(p.poolKey.currency0);
        address c1 = Currency.unwrap(p.poolKey.currency1);
        address tokenIn = p.zeroForOne ? c0 : c1;
        address tokenOut = p.zeroForOne ? c1 : c0;
        if (tokenIn == address(0) && tokenOut == feeJuice) {
            // native ETH → FeeJuice: the terminal hop, priced at the target's live rate.
            return ((uint256(p.exactAmount) * target.rateNum()) / target.rateDen(), 0);
        }
        if (tokenOut == weth && routable[tokenIn]) {
            // token → WETH: 1:1, so the composition is the target's single conversion.
            return (uint256(p.exactAmount), 0);
        }
        revert("MockV4Quoter: no such pool");
    }
}
