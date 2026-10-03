// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@oz/proxy/Clones.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";

import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

import {IPortalFactory} from "./interfaces/IPortalFactory.sol";

/// @notice The portal every token's clone delegates to. A clone has NO storage and NO initializer:
/// its token is an immutable arg in its own bytecode (`Clones.fetchCloneArgs`), the Aztec pointers
/// and the L2 hub are immutables of this implementation, and the guardian's pause bits live on the
/// factory. There is nothing to repoint. The deposit/withdraw content hashes are the canonical
/// TokenPortal's, byte for byte (pinned by ContentHash.t.sol + the Noir keystone); the only
/// additions are guards that never touch the hashed preimage.
contract TokenPortalImpl is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error ImplementationOnly();
    error DepositsPaused();
    error WithdrawsPaused();
    error AmountExceedsL2Max();
    error InexactTransfer();

    event DepositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index);
    event DepositToAztecPrivate(uint256 amount, bytes32 secretHashForL2MessageConsumption, bytes32 key, uint256 index);

    IPortalFactory public immutable FACTORY;
    IInbox public immutable INBOX;
    IOutbox public immutable OUTBOX;
    uint256 public immutable ROLLUP_VERSION;
    bytes32 public immutable L2_HUB;
    /// @dev Deposits and withdrawals must run in a clone, never in this contract itself.
    address private immutable SELF;

    constructor(IRegistry registry, bytes32 l2Hub) {
        FACTORY = IPortalFactory(msg.sender);
        IRollup rollup = IRollup(address(registry.getCanonicalRollup()));
        INBOX = rollup.getInbox();
        OUTBOX = rollup.getOutbox();
        ROLLUP_VERSION = rollup.getVersion();
        L2_HUB = l2Hub;
        SELF = address(this);
    }

    function underlying() public view returns (IERC20) {
        if (address(this) == SELF) revert ImplementationOnly();
        return IERC20(address(bytes20(Clones.fetchCloneArgs(address(this)))));
    }

    function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash)
        external
        nonReentrant
        returns (bytes32, uint256)
    {
        _requireDeposit(_amount);
        DataStructures.L2Actor memory actor = DataStructures.L2Actor(L2_HUB, ROLLUP_VERSION);
        bytes32 contentHash = Hash.sha256ToField(abi.encodeWithSignature("mint_to_public(bytes32,uint256)", _to, _amount));
        _pullExact(_amount);
        (bytes32 key, uint256 index) = INBOX.sendL2Message(actor, contentHash, _secretHash);
        emit DepositToAztecPublic(_to, _amount, _secretHash, key, index);
        return (key, index);
    }

    function depositToAztecPrivate(uint256 _amount, bytes32 _secretHashForL2MessageConsumption)
        external
        nonReentrant
        returns (bytes32, uint256)
    {
        _requireDeposit(_amount);
        DataStructures.L2Actor memory actor = DataStructures.L2Actor(L2_HUB, ROLLUP_VERSION);
        bytes32 contentHash = Hash.sha256ToField(abi.encodeWithSignature("mint_to_private(uint256)", _amount));
        _pullExact(_amount);
        (bytes32 key, uint256 index) = INBOX.sendL2Message(actor, contentHash, _secretHashForL2MessageConsumption);
        emit DepositToAztecPrivate(_amount, _secretHashForL2MessageConsumption, key, index);
        return (key, index);
    }

    function withdraw(
        address _recipient,
        uint256 _amount,
        bool _withCaller,
        Epoch _epoch,
        uint256 _numCheckpointsInEpoch,
        uint256 _leafIndex,
        bytes32[] calldata _path
    ) external nonReentrant {
        _requireWithdraw();
        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor(L2_HUB, ROLLUP_VERSION),
            recipient: DataStructures.L1Actor(address(this), block.chainid),
            content: Hash.sha256ToField(
                abi.encodeWithSignature(
                    "withdraw(address,uint256,address)", _recipient, _amount, _withCaller ? msg.sender : address(0)
                )
            )
        });
        OUTBOX.consume(message, _epoch, _numCheckpointsInEpoch, _leafIndex, _path);

        // Exact debit protects the reserve; what the recipient nets is the token's business.
        IERC20 token = underlying();
        uint256 before = token.balanceOf(address(this));
        token.safeTransfer(_recipient, _amount);
        if (before - token.balanceOf(address(this)) != _amount) revert InexactTransfer();
    }

    /// @dev The L2 side holds amounts as u128; a larger deposit would be unclaimable forever.
    function _requireDeposit(uint256 amount) internal view virtual {
        if (FACTORY.depositsPaused()) revert DepositsPaused();
        if (amount > type(uint128).max) revert AmountExceedsL2Max();
    }

    function _requireWithdraw() internal view virtual {
        if (FACTORY.withdrawsPaused()) revert WithdrawsPaused();
    }

    /// @dev Fee-on-transfer tokens are refused: the message would mint more than the reserve holds.
    function _pullExact(uint256 amount) private {
        IERC20 token = underlying();
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - before != amount) revert InexactTransfer();
    }
}
