// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

/// @notice Aztec's testnet fee-asset faucet (`l1-contracts/src/mock/FeeAssetHandler.sol`): permissionless,
/// no rate limit, `mintAmount()` per call. Testnet only; mainnet has no such contract.
interface IFeeAssetHandler {
    function mint(address _recipient) external;
    function mintAmount() external view returns (uint256);
}
