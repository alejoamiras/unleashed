// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Ownable2Step, Ownable} from "@oz/access/Ownable2Step.sol";
import {Clones} from "@oz/proxy/Clones.sol";
import {SafeCast} from "@oz/utils/math/SafeCast.sol";

import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

import {IPortalFactory} from "./interfaces/IPortalFactory.sol";
import {TokenPortalImpl} from "./TokenPortalImpl.sol";

/// @notice Creates one portal clone per ERC-20 and announces it to the L2 hub. The factory is the
/// L1 sender of every `register` message and the portal address inside it is the one `Clones`
/// just returned, so the hub learns the L1↔L2 pairing from the deployer of the clone itself — no
/// party can pair a foreign portal with a real token. Metadata is read once, here, and frozen.
///
/// The owner is the guardian: it can pause deposits and withdrawals (a delay, never a transfer of
/// funds) and nothing else. Renouncing is disabled so the pause bits can never become unownable.
contract PortalFactory is Ownable2Step, IPortalFactory {
    using SafeCast for uint256;

    TokenPortalImpl private immutable _implementation;
    IInbox public immutable INBOX;
    uint256 public immutable ROLLUP_VERSION;
    bytes32 public immutable L2_HUB;

    /// @dev `compute_secret_hash([0])`: registration is permissionless, so anyone may consume the
    /// message with the public secret 0. Pinned 3-way in Keystone.t.sol.
    bytes32 public constant REGISTER_SECRET_HASH = 0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250;

    /// @dev Gas ceiling for each metadata read. Enough for any honest ERC-20; a token that spends more
    /// is refused a portal rather than allowed to bill its first depositor.
    uint256 private constant METADATA_GAS = 100_000;

    mapping(address token => Registration) private _registrations;
    mapping(address portal => address token) public tokenOf;

    bool public depositsPaused;
    bool public withdrawsPaused;

    constructor(IRegistry registry, bytes32 l2Hub, address guardian) Ownable(guardian) {
        _implementation = new TokenPortalImpl(registry, l2Hub);
        IRollup rollup = IRollup(address(registry.getCanonicalRollup()));
        INBOX = rollup.getInbox();
        ROLLUP_VERSION = rollup.getVersion();
        L2_HUB = l2Hub;
    }

    function IMPLEMENTATION() external view returns (address) {
        return address(_implementation);
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function setPaused(bool deposits, bool withdraws) external onlyOwner {
        depositsPaused = deposits;
        withdrawsPaused = withdraws;
        emit PauseChanged(deposits, withdraws);
    }

    function salt(address token) public pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }

    function predictPortal(address token) public view returns (address) {
        return Clones.predictDeterministicAddressWithImmutableArgs(
            address(_implementation), abi.encodePacked(token), salt(token)
        );
    }

    function portalOf(address token) public view returns (address) {
        return _registrations[token].portal;
    }

    function registrationOf(address token) external view returns (Registration memory) {
        return _registrations[token];
    }

    function createPortal(address token) public returns (address portal) {
        portal = _registrations[token].portal;
        if (portal != address(0)) return portal;
        if (token.code.length == 0) revert NotAContract();

        uint8 decimals = _readDecimals(token);
        bytes32 nameWord = _readWord(token, 0x06fdde03); // name()
        bytes32 symbolWord = _readWord(token, 0x95d89b41); // symbol()

        portal = Clones.cloneDeterministicWithImmutableArgs(address(_implementation), abi.encodePacked(token), salt(token));

        bytes32 content = Hash.sha256ToField(
            abi.encodeWithSignature(
                "register(address,address,bytes32,bytes32,uint8)", token, portal, nameWord, symbolWord, decimals
            )
        );
        (bytes32 key, uint256 index) =
            INBOX.sendL2Message(DataStructures.L2Actor(L2_HUB, ROLLUP_VERSION), content, REGISTER_SECRET_HASH);

        _registrations[token] = Registration({
            portal: portal,
            decimals: decimals,
            registerIndex: index.toUint64(),
            nameWord: nameWord,
            symbolWord: symbolWord,
            registerKey: key
        });
        tokenOf[portal] = token;
        emit PortalCreated(token, portal, nameWord, symbolWord, decimals, key, index);
    }

    /// @dev `decimals()` is required: without it every bridged amount would be mis-scaled forever.
    /// Exactly one 32-byte word — a `string` return (offset word 0x20) must not read as 32 decimals.
    /// Copied into a one-word buffer, never `returndatacopy`'d whole, for the same reason as
    /// `_readWord`.
    function _readDecimals(address token) private view returns (uint8) {
        bool ok;
        uint256 size;
        uint256 d;
        assembly ("memory-safe") {
            mstore(0x00, 0x313ce567)
            ok := staticcall(METADATA_GAS, token, 0x1c, 0x04, 0x00, 0x20)
            size := returndatasize()
            d := mload(0x00)
        }
        if (!ok || size != 32 || d > 255) revert NoDecimals();
        return uint8(d);
    }

    /// @dev Reads `name()`/`symbol()` into a bounded 96-byte buffer (offset ‖ length ‖ first 32 data
    /// bytes) so a hostile token cannot bill the caller for an oversized return, accepts either a
    /// `string` or a `bytes32` (MKR-style) return, and defaults to empty on failure. Sanitized to 31
    /// printable-ASCII bytes and packed as `0x00 ‖ b0..b30`.
    function _readWord(address token, bytes4 selector) private view returns (bytes32) {
        bytes memory buf = new bytes(96);
        bool ok;
        uint256 size;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            ok := staticcall(METADATA_GAS, token, 0x00, 0x04, add(buf, 0x20), 96)
            size := returndatasize()
        }
        if (!ok) return bytes32(0);
        bytes32 raw;
        uint256 n;
        if (size == 32) {
            // bytes32-style: the string ends at its first zero byte.
            assembly ("memory-safe") {
                raw := mload(add(buf, 0x20))
            }
            while (n < 31 && raw[n] != 0) n++;
        } else if (size >= 64) {
            uint256 offset;
            uint256 len;
            assembly ("memory-safe") {
                offset := mload(add(buf, 0x20))
                len := mload(add(buf, 0x40))
                raw := mload(add(buf, 0x60))
            }
            // A non-empty string must carry its data word; without it the buffer's zeros would
            // sanitize into `len` underscores.
            if (offset != 0x20 || (len > 0 && size < 96)) return bytes32(0);
            n = len > 31 ? 31 : len;
        } else {
            return bytes32(0);
        }
        return _sanitize(raw, n);
    }

    function _sanitize(bytes32 raw, uint256 n) internal pure returns (bytes32) {
        uint256 acc;
        for (uint256 i = 0; i < 31; i++) {
            uint8 b = i < n ? uint8(raw[i]) : 0;
            if (i < n && (b < 0x20 || b > 0x7e)) b = 0x5f;
            acc = (acc << 8) | b;
        }
        return bytes32(acc);
    }
}
