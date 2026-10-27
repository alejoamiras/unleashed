// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";

/// @notice The hook Across calls on a contract recipient after paying it a fill that carries a message.
interface IAcrossMessageHandler {
    function handleV3AcrossMessage(address tokenSent, uint256 amount, address relayer, bytes memory message) external;
}

/**
 * @title TestSpokePool
 * @notice Sandbox stand-in for the part of Across's SpokePool the LI.FI rail touches, with the deployed shapes:
 * `deposit` and `FundsDeposited` on the source chain; `fillRelay`, `getV3RelayHash`, `fillStatuses` and
 * `FilledRelay` on the destination. One contract serves both chains.
 * @dev A fill pays the recipient from the caller and then runs a non-empty message on a contract recipient inside
 * the same call, so a reverting handler reverts the whole fill: LI.FI's ReceiverAcrossV4 reserves no recovery gas
 * and relies on exactly that. A deposit refuses a quote older than `depositQuoteTimeBuffer` by this chain's clock, as
 * Across's does: discovery bounds its source scan by it. ERC-20 only. No refunds, slow fills, speed-ups or pausing:
 * nothing here settles.
 */
contract TestSpokePool is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @dev `V3SpokePoolInterface.V3RelayData`, field for field.
    struct V3RelayData {
        bytes32 depositor;
        bytes32 recipient;
        bytes32 exclusiveRelayer;
        bytes32 inputToken;
        bytes32 outputToken;
        uint256 inputAmount;
        uint256 outputAmount;
        uint256 originChainId;
        uint256 depositId;
        uint32 fillDeadline;
        uint32 exclusivityDeadline;
        bytes message;
    }

    /// @dev `V3SpokePoolInterface.V3RelayExecutionEventInfo`; `fillType` is the `FillType` enum, 0 for a fast fill.
    struct V3RelayExecutionEventInfo {
        bytes32 updatedRecipient;
        bytes32 updatedMessageHash;
        uint256 updatedOutputAmount;
        uint8 fillType;
    }

    /// @dev Across's boundary between an exclusivity offset and an absolute exclusivity timestamp.
    uint32 public constant MAX_EXCLUSIVITY_PERIOD_SECONDS = 31_536_000;
    /// @dev The value every deployed SpokePool the app pins reports.
    uint32 public constant depositQuoteTimeBuffer = 3_600;
    /// @dev `FillStatus.Filled`.
    uint256 internal constant FILLED = 2;
    uint8 internal constant FAST_FILL = 0;

    uint256 public numberOfDeposits;
    mapping(bytes32 relayHash => uint256 status) public fillStatuses;

    event FundsDeposited(
        bytes32 inputToken,
        bytes32 outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 indexed destinationChainId,
        uint256 indexed depositId,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        bytes32 indexed depositor,
        bytes32 recipient,
        bytes32 exclusiveRelayer,
        bytes message
    );

    event FilledRelay(
        bytes32 inputToken,
        bytes32 outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 repaymentChainId,
        uint256 indexed originChainId,
        uint256 indexed depositId,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        bytes32 exclusiveRelayer,
        bytes32 indexed relayer,
        bytes32 depositor,
        bytes32 recipient,
        bytes32 messageHash,
        V3RelayExecutionEventInfo relayExecutionInfo
    );

    error InvalidBytes32();
    error InvalidOutputToken();
    error InvalidQuoteTimestamp();
    error InvalidExclusiveRelayer();
    error NotExclusiveRelayer();
    error ExpiredFillDeadline();
    error RelayFilled();

    /// @notice Locks `inputAmount` of `inputToken` from the caller and logs the relay a filler must reproduce.
    function deposit(
        bytes32 depositor,
        bytes32 recipient,
        bytes32 inputToken,
        bytes32 outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        bytes32 exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityParameter,
        bytes calldata message
    ) external nonReentrant {
        _toAddress(depositor);
        if (outputToken == bytes32(0)) revert InvalidOutputToken();
        if (block.timestamp < quoteTimestamp || block.timestamp - quoteTimestamp > depositQuoteTimeBuffer) {
            revert InvalidQuoteTimestamp();
        }
        uint32 exclusivityDeadline = exclusivityParameter;
        if (exclusivityDeadline > 0) {
            if (exclusivityDeadline <= MAX_EXCLUSIVITY_PERIOD_SECONDS) exclusivityDeadline += uint32(block.timestamp);
            if (exclusiveRelayer == bytes32(0)) revert InvalidExclusiveRelayer();
        }
        IERC20(_toAddress(inputToken)).safeTransferFrom(msg.sender, address(this), inputAmount);
        emit FundsDeposited(
            inputToken,
            outputToken,
            inputAmount,
            outputAmount,
            destinationChainId,
            numberOfDeposits++,
            quoteTimestamp,
            fillDeadline,
            exclusivityDeadline,
            depositor,
            recipient,
            exclusiveRelayer,
            message
        );
    }

    /**
     * @notice Fills `relayData` once: pays `outputAmount` of `outputToken` from the caller to the recipient, then
     * hands a non-empty message to a contract recipient. Logs `FilledRelay` before paying, as Across does.
     * @param repaymentAddress Logged as the relayer; nothing is ever repaid here.
     */
    function fillRelay(V3RelayData calldata relayData, uint256 repaymentChainId, bytes32 repaymentAddress)
        external
        nonReentrant
    {
        if (relayData.exclusivityDeadline >= block.timestamp && _toAddress(relayData.exclusiveRelayer) != msg.sender) {
            revert NotExclusiveRelayer();
        }
        if (relayData.fillDeadline < block.timestamp) revert ExpiredFillDeadline();
        bytes32 relayHash = getV3RelayHash(relayData);
        if (fillStatuses[relayHash] == FILLED) revert RelayFilled();
        fillStatuses[relayHash] = FILLED;

        bytes32 messageHash = relayData.message.length == 0 ? bytes32(0) : keccak256(relayData.message);
        emit FilledRelay(
            relayData.inputToken,
            relayData.outputToken,
            relayData.inputAmount,
            relayData.outputAmount,
            repaymentChainId,
            relayData.originChainId,
            relayData.depositId,
            relayData.fillDeadline,
            relayData.exclusivityDeadline,
            relayData.exclusiveRelayer,
            repaymentAddress,
            relayData.depositor,
            relayData.recipient,
            messageHash,
            V3RelayExecutionEventInfo(relayData.recipient, messageHash, relayData.outputAmount, FAST_FILL)
        );

        address recipient = _toAddress(relayData.recipient);
        address token = _toAddress(relayData.outputToken);
        IERC20(token).safeTransferFrom(msg.sender, recipient, relayData.outputAmount);
        if (relayData.message.length > 0 && recipient.code.length > 0) {
            IAcrossMessageHandler(recipient)
                .handleV3AcrossMessage(token, relayData.outputAmount, msg.sender, relayData.message);
        }
    }

    /// @notice Every relay field and this chain's id: a fill that changes any of them is another relay.
    function getV3RelayHash(V3RelayData memory relayData) public view returns (bytes32) {
        return keccak256(abi.encode(relayData, block.chainid));
    }

    function _toAddress(bytes32 word) internal pure returns (address) {
        if (uint256(word) >> 160 != 0) revert InvalidBytes32();
        return address(uint160(uint256(word)));
    }
}
