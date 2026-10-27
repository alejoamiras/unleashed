// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {ILiFiSwap} from "../../src/interfaces/ILiFiSwap.sol";

/// Across's relay tuple, as the deployed SpokePool's `fillRelay` takes it.
struct RelayData {
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

interface ISpokePoolFill {
    function fillRelay(RelayData calldata relayData, uint256 repaymentChainId, bytes32 repaymentAddress) external;
}

interface ILiFiExecutor {
    function swapAndCompleteBridgeTokens(
        bytes32 transactionId,
        ILiFiSwap.SwapData[] calldata swapData,
        address transferredAssetId,
        address payable receiver
    ) external payable;
}

/// What every LI.FI fork suite shares: the events discovery matches on, an Across fill as a relayer would send it,
/// the destination message LI.FI's receivers decode, and log plumbing for the recorded receipts.
abstract contract LifiForkBase is Test {
    bytes32 internal constant FUNDS_DEPOSITED = keccak256(
        "FundsDeposited(bytes32,bytes32,uint256,uint256,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes32,bytes)"
    );
    bytes32 internal constant FILLED_RELAY = keccak256(
        "FilledRelay(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint32,uint32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,bytes32,uint256,uint8))"
    );
    bytes32 internal constant TRANSFER_STARTED =
        keccak256("LiFiTransferStarted((bytes32,string,string,address,address,address,uint256,uint256,bool,bool))");
    bytes32 internal constant TRANSFER_COMPLETED =
        keccak256("LiFiTransferCompleted(bytes32,address,address,uint256,uint256)");
    bytes32 internal constant TRANSFER_RECOVERED =
        keccak256("LiFiTransferRecovered(bytes32,address,address,uint256,uint256)");
    bytes32 internal constant NONE = bytes32(0);
    uint256 internal constant NOT_FOUND = type(uint256).max;

    /// The one destination step our builders emit: the Executor approves `router` and calls it with `call`.
    function _routerStep(address router, address token, uint256 fromAmount, bytes memory call)
        internal
        pure
        returns (ILiFiSwap.SwapData[] memory steps)
    {
        steps = new ILiFiSwap.SwapData[](1);
        steps[0] = ILiFiSwap.SwapData({
            callTo: router,
            approveTo: router,
            sendingAssetId: token,
            receivingAssetId: token,
            fromAmount: fromAmount,
            callData: call,
            requiresDeposit: false
        });
    }

    /// `abi.encode(txId, SwapData[], receiver)`, what ReceiverAcrossV4 and ReceiverStargateV2 decode.
    function _lifiMessage(bytes32 txId, ILiFiSwap.SwapData[] memory steps, address receiver)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(txId, steps, receiver);
    }

    /// Fills `r` on the current fork as a fresh relayer that holds exactly the output.
    function _acrossFill(address spoke, address token, RelayData memory r) internal returns (Vm.Log[] memory) {
        address relayer = makeAddr("relayer");
        deal(token, relayer, r.outputAmount);
        vm.prank(relayer);
        IERC20(token).approve(spoke, r.outputAmount);
        vm.recordLogs();
        vm.prank(relayer);
        ISpokePoolFill(spoke).fillRelay(r, r.originChainId, bytes32(uint256(uint160(relayer))));
        return vm.getRecordedLogs();
    }

    /// Index of the first log from `emitter` with `topic0`, also matching `topic1` unless it is `NONE`.
    function _find(Vm.Log[] memory logs, address emitter, bytes32 topic0, bytes32 topic1)
        internal
        pure
        returns (uint256)
    {
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter != emitter || l.topics.length == 0 || l.topics[0] != topic0) continue;
            if (topic1 != NONE && (l.topics.length < 2 || l.topics[1] != topic1)) continue;
            return i;
        }
        return NOT_FOUND;
    }

    /// `receipt` is `recorded` minus one contiguous block: what a reverted call emitted, which Forge's recorder
    /// keeps and a chain's receipt drops.
    function _assertOneBlockDropped(Vm.Log[] memory recorded, Vm.Log[] memory receipt) internal pure {
        assertLt(receipt.length, recorded.length, "nothing reverted");
        uint256 dropped = recorded.length - receipt.length;
        uint256 i;
        while (i < receipt.length && _sameLog(recorded[i], receipt[i])) i++;
        for (uint256 j = i; j < receipt.length; j++) {
            assertTrue(_sameLog(recorded[j + dropped], receipt[j]), "the receipt is not the recording minus one call");
        }
    }

    function _sameLog(Vm.Log memory a, Vm.Log memory b) private pure returns (bool) {
        return a.emitter == b.emitter && keccak256(abi.encode(a.topics)) == keccak256(abi.encode(b.topics))
            && keccak256(a.data) == keccak256(b.data);
    }

    function _logOrder(Vm.Log[] memory logs) internal pure {
        for (uint256 i; i < logs.length; i++) {
            console2.log(i, logs[i].emitter, logs[i].topics.length == 0 ? "" : vm.toString(logs[i].topics[0]));
        }
    }

    function _logsJson(Vm.Log[] memory logs) internal pure returns (string memory s) {
        s = "[";
        for (uint256 i; i < logs.length; i++) {
            string memory topics = "[";
            for (uint256 t; t < logs[i].topics.length; t++) {
                topics = string.concat(topics, t == 0 ? "" : ",", '"', vm.toString(logs[i].topics[t]), '"');
            }
            s = string.concat(
                s,
                i == 0 ? "" : ",",
                '{"address":"',
                vm.toString(logs[i].emitter),
                '","topics":',
                topics,
                '],"data":"',
                vm.toString(logs[i].data),
                '"}'
            );
        }
        s = string.concat(s, "]");
    }

    function _recording() internal view returns (bool) {
        return vm.envOr("LIFI_RECORD", uint256(0)) == 1;
    }
}
