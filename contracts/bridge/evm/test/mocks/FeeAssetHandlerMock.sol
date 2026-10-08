// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IFeeAssetHandler} from "../../src/interfaces/IFeeAssetHandler.sol";
import {MintableERC20} from "../../src/MintableERC20.sol";

/// Aztec's testnet `FeeAssetHandler`: anyone may call `mint(to)`, and `to` receives `mintAmount` of the fee asset.
/// `mints` counts the calls, so a suite can see how many top-ups a shortfall took.
contract FeeAssetHandlerMock is IFeeAssetHandler {
    MintableERC20 public immutable FEE_ASSET;
    uint256 public mintAmount;
    uint256 public mints;

    constructor(MintableERC20 feeAsset, uint256 mintAmount_) {
        FEE_ASSET = feeAsset;
        mintAmount = mintAmount_;
    }

    function setMintAmount(uint256 amount) external {
        mintAmount = amount;
    }

    function mint(address recipient) external {
        mints++;
        FEE_ASSET.mint(recipient, mintAmount);
    }
}
