// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @notice The Uniswap V4 quoter's single-hop entry point. Declared locally so a caller can probe
/// a route's liveness without pulling the v4-periphery source tree into the Foundry build.
/// NOT a view function upstream — it reverts internally and decodes the revert, so a caller must
/// treat it as state-changing even though it changes nothing.
interface IV4Quoter {
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactSingleParams calldata params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}
