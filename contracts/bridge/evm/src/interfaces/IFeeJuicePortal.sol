// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";

/// @notice Minimal subset of the canonical Aztec FeeJuicePortal the router uses.
/// (Defined locally so the router doesn't pull the full aztec l1-artifacts
/// source tree + its deep deps into the Foundry build.) `UNDERLYING()` is the
/// real FeeJuice ERC20 the swap must output — the router reads it back and
/// approves exactly that for the deposit, so a mismatch reverts.
interface IFeeJuicePortal {
    function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash)
        external
        returns (bytes32, uint256);

    function UNDERLYING() external view returns (IERC20);
}
