// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

/// @notice The two `GenericSwapFacetV3` entrypoints the router accepts, declared locally (LI.FI's sources are
/// LGPL and never enter production builds). Both share the head `(bytes32, string, string, address, uint256, …)`,
/// so `_receiver` sits at calldata offset 100 in either.
interface ILiFiSwap {
    /// @dev `LibSwap.SwapData`, field for field.
    struct SwapData {
        address callTo;
        address approveTo;
        address sendingAssetId;
        address receivingAssetId;
        uint256 fromAmount;
        bytes callData;
        bool requiresDeposit;
    }

    function swapTokensSingleV3ERC20ToERC20(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        SwapData calldata _swapData
    ) external;

    function swapTokensMultipleV3ERC20ToERC20(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        address payable _receiver,
        uint256 _minAmountOut,
        SwapData[] calldata _swapData
    ) external;
}
