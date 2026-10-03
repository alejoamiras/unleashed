// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

/// @notice Subset of the canonical Aztec TokenPortal interface the router calls.
/// Both deposits are attestation-free: a portal is a `TokenPortalImpl` clone whose
/// message content hashes match the canonical TokenPortal's. The private deposit hashes
/// `mint_to_private(amount)` (no recipient), so the L2 claim chooses the recipient.
interface ITokenPortal {
    function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash)
        external
        returns (bytes32, uint256);

    function depositToAztecPrivate(uint256 _amount, bytes32 _secretHash) external returns (bytes32, uint256);
}
