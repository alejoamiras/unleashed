// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@oz/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@oz/access/Ownable2Step.sol";
import {ILiFiSwap} from "./interfaces/ILiFiSwap.sol";
import {IFeeAssetHandler} from "./interfaces/IFeeAssetHandler.sol";

/**
 * @title TestnetFuelSwapper
 * @notice The router's `SWAP_TARGET` off mainnet, where no venue quotes Fee Juice. It answers
 * `swapTokensSingleV3ERC20ToERC20` with LI.FI's exact ABI, so the router's selector and `_receiver` checks, its
 * bytecode and the client's decoder are the same on every network. It pays at a fixed owner-set rate from
 * inventory, topped up from the permissionless testnet fee-asset faucet.
 * @dev Always pulls exactly `fromAmount` and returns no input. `callTo`, `approveTo`, `callData` and
 * `requiresDeposit` are ignored: nothing here calls out except the faucet and the two tokens.
 */
contract TestnetFuelSwapper is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @dev Bounds the faucet loop; a shortfall beyond it is an inventory problem, not a reason to loop.
    uint256 internal constant MAX_MINTS = 3;

    IERC20 public immutable FEE_ASSET;
    /// @dev Zero means inventory only.
    IFeeAssetHandler public immutable FEE_ASSET_HANDLER;

    /// @notice Fee-asset base units paid per whole input token (10**decimals units); zero means unsupported.
    mapping(address token => uint256 fjPerWholeToken) public rate;

    error MainnetRefused();
    error ZeroAddress();
    error UnsupportedToken();
    error WrongOutputAsset();
    error BelowMinimum();
    error InsufficientInventory();

    event RateSet(address indexed token, uint256 fjPerWholeToken);
    event Swapped(
        bytes32 indexed transactionId, address indexed token, address indexed receiver, uint256 amountIn, uint256 out
    );

    constructor(address feeAsset, address feeAssetHandler, address owner) Ownable(owner) {
        if (block.chainid == 1) revert MainnetRefused();
        if (feeAsset == address(0)) revert ZeroAddress();
        FEE_ASSET = IERC20(feeAsset);
        FEE_ASSET_HANDLER = IFeeAssetHandler(feeAssetHandler);
    }

    function swapTokensSingleV3ERC20ToERC20(
        bytes32 _transactionId,
        string calldata,
        string calldata,
        address payable _receiver,
        uint256 _minAmountOut,
        ILiFiSwap.SwapData calldata _swapData
    ) external {
        if (_swapData.receivingAssetId != address(FEE_ASSET)) {
            revert WrongOutputAsset();
        }
        address token = _swapData.sendingAssetId;
        uint256 out = quote(token, _swapData.fromAmount);
        if (out < _minAmountOut) revert BelowMinimum();

        IERC20(token).safeTransferFrom(msg.sender, address(this), _swapData.fromAmount);
        _ensureInventory(out);
        FEE_ASSET.safeTransfer(_receiver, out);
        emit Swapped(_transactionId, token, _receiver, _swapData.fromAmount, out);
    }

    /// @notice Fee-asset units `amountIn` of `token` buys; reverts for a token without a rate.
    function quote(address token, uint256 amountIn) public view returns (uint256) {
        uint256 r = rate[token];
        if (r == 0) revert UnsupportedToken();
        return amountIn * r / 10 ** IERC20Metadata(token).decimals();
    }

    function setRate(address token, uint256 fjPerWholeToken) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        rate[token] = fjPerWholeToken;
        emit RateSet(token, fjPerWholeToken);
    }

    /// @notice Moves collected input or surplus inventory out.
    function sweep(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) IERC20(token).safeTransfer(to, balance);
    }

    function _ensureInventory(uint256 out) internal {
        for (uint256 i; i < MAX_MINTS && FEE_ASSET.balanceOf(address(this)) < out; ++i) {
            if (address(FEE_ASSET_HANDLER) == address(0)) break;
            FEE_ASSET_HANDLER.mint(address(this));
        }
        if (FEE_ASSET.balanceOf(address(this)) < out) revert InsufficientInventory();
    }
}
