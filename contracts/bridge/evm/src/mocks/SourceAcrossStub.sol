// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {TestSpokePool} from "./TestSpokePool.sol";

/**
 * @title SourceAcrossStub
 * @notice Sandbox stand-in for the LI.FI Diamond on a source chain: `startBridgeTokensViaAcrossV4` with
 * `AcrossFacetV4`'s exact ABI, so the bytes the app and the canary build run unchanged. It applies the facet's
 * checks, pulls the input from the caller, deposits into a `TestSpokePool` with the fields the facet derives
 * (depositor = the refund address, recipient = the destination receiver, the message and the output terms as
 * given), and logs `LiFiTransferStarted` after the rail event, as the Diamond does.
 * @dev ERC-20 only and no source swaps, the only shape our routes take. The real facet is proven on a Base Sepolia
 * fork and by the live canary.
 */
contract SourceAcrossStub {
    using SafeERC20 for IERC20;

    /// @dev `ILiFi.BridgeData`, field for field.
    struct BridgeData {
        bytes32 transactionId;
        string bridge;
        string integrator;
        address referrer;
        address sendingAssetId;
        address receiver;
        uint256 minAmount;
        uint256 destinationChainId;
        bool hasSourceSwaps;
        bool hasDestinationCall;
    }

    /// @dev `AcrossFacetV4.AcrossV4Data`, field for field.
    struct AcrossV4Data {
        bytes32 receiverAddress;
        bytes32 refundAddress;
        bytes32 sendingAssetId;
        bytes32 receivingAssetId;
        uint256 outputAmount;
        uint128 outputAmountMultiplier;
        bytes32 exclusiveRelayer;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        uint32 exclusivityParameter;
        bytes message;
    }

    TestSpokePool public immutable SPOKEPOOL;

    event LiFiTransferStarted(BridgeData bridgeData);

    error NativeAssetNotSupported();
    error InvalidReceiver();
    error InvalidAmount();
    error CannotBridgeToSameNetwork();
    error InformationMismatch();
    error InvalidCallData();

    constructor(TestSpokePool spokePool) {
        SPOKEPOOL = spokePool;
    }

    function startBridgeTokensViaAcrossV4(BridgeData memory _bridgeData, AcrossV4Data calldata _acrossData)
        external
        payable
    {
        if (msg.value != 0) revert NativeAssetNotSupported();
        if (_bridgeData.receiver == address(0)) revert InvalidReceiver();
        if (_bridgeData.minAmount == 0) revert InvalidAmount();
        if (_bridgeData.destinationChainId == block.chainid) revert CannotBridgeToSameNetwork();
        if (_bridgeData.hasSourceSwaps) revert InformationMismatch();
        if ((_acrossData.message.length > 0) != _bridgeData.hasDestinationCall) revert InformationMismatch();
        // With a destination call the Across recipient is LI.FI's receiver, not `BridgeData.receiver`.
        if (
            !_bridgeData.hasDestinationCall
                && bytes32(uint256(uint160(_bridgeData.receiver))) != _acrossData.receiverAddress
        ) revert InvalidReceiver();
        if (_acrossData.receiverAddress == bytes32(0)) revert InvalidReceiver();
        if (_acrossData.refundAddress == bytes32(0)) revert InvalidCallData();

        IERC20 token = IERC20(_bridgeData.sendingAssetId);
        token.safeTransferFrom(msg.sender, address(this), _bridgeData.minAmount);
        token.forceApprove(address(SPOKEPOOL), _bridgeData.minAmount);
        SPOKEPOOL.deposit(
            _acrossData.refundAddress,
            _acrossData.receiverAddress,
            _acrossData.sendingAssetId,
            _acrossData.receivingAssetId,
            _bridgeData.minAmount,
            _acrossData.outputAmount,
            _bridgeData.destinationChainId,
            _acrossData.exclusiveRelayer,
            _acrossData.quoteTimestamp,
            _acrossData.fillDeadline,
            _acrossData.exclusivityParameter,
            _acrossData.message
        );
        emit LiFiTransferStarted(_bridgeData);
    }
}
