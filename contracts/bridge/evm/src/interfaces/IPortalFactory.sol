// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

/// @notice The permissionless L1 side of the any-ERC-20 bridge: one storage-less portal clone per
/// token, created on demand, plus the guardian's two pause bits every clone consults.
interface IPortalFactory {
    /// @dev The frozen registration record: what the factory read from the token at creation and what
    /// it sent to the L2 hub. Clients derive the L2 token from these words, never from live metadata.
    struct Registration {
        address portal;
        uint8 decimals;
        uint64 registerIndex;
        bytes32 nameWord;
        bytes32 symbolWord;
        bytes32 registerKey;
    }

    event PortalCreated(
        address indexed token,
        address indexed portal,
        bytes32 nameWord,
        bytes32 symbolWord,
        uint8 decimals,
        bytes32 registerKey,
        uint256 registerIndex
    );
    event PauseChanged(bool deposits, bool withdraws);

    error NotAContract();
    error NoDecimals();
    error RenounceDisabled();

    function IMPLEMENTATION() external view returns (address);
    function L2_HUB() external view returns (bytes32);
    function REGISTER_SECRET_HASH() external view returns (bytes32);

    function depositsPaused() external view returns (bool);
    function withdrawsPaused() external view returns (bool);

    function salt(address token) external pure returns (bytes32);
    function predictPortal(address token) external view returns (address);
    function portalOf(address token) external view returns (address);
    function tokenOf(address portal) external view returns (address);
    function registrationOf(address token) external view returns (Registration memory);

    /// @notice Idempotent: returns the existing portal, or creates it and sends the L2 `register`
    /// message (the factory is the message's L1 sender).
    function createPortal(address token) external returns (address portal);

    function setPaused(bool deposits, bool withdraws) external;
}
