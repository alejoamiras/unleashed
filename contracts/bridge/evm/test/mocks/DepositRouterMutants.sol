// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {DepositRouter} from "../../src/DepositRouter.sol";

/// `DepositRouter` with one guard broken each: the mutants the symbolic proofs' canaries run against, so a proof
/// that stops depending on its guard is caught in forge.

contract DepositRouterWithoutPause is DepositRouter {
    constructor(address p2, address fjp, address factory, address swap, address owner)
        DepositRouter(p2, fjp, factory, swap, owner)
    {}

    function _requireDepositsOpen() internal view override {}
}

contract DepositRouterWithoutSwapPin is DepositRouter {
    constructor(address p2, address fjp, address factory, address swap, address owner)
        DepositRouter(p2, fjp, factory, swap, owner)
    {}

    function _requirePinnedSwap(bytes calldata, uint256) internal view override {}
}

/// Sends the fee asset's token leg to the FeeJuicePortal, minting the remainder as gas.
contract DepositRouterFeeAssetLegIntoFeeJuicePortal is DepositRouter {
    constructor(address p2, address fjp, address factory, address swap, address owner)
        DepositRouter(p2, fjp, factory, swap, owner)
    {}

    function _tokenPortal(address token) internal override returns (address) {
        return token == FEE_ASSET ? address(FEE_JUICE_PORTAL) : super._tokenPortal(token);
    }
}

contract DepositRouterKeepsApprovals is DepositRouter {
    constructor(address p2, address fjp, address factory, address swap, address owner)
        DepositRouter(p2, fjp, factory, swap, owner)
    {}

    function _revokeApproval(IERC20, address) internal override {}
}
