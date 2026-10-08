// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@oz/token/ERC20/extensions/IERC20Metadata.sol";

import {
    MainnetStargateFork,
    LifiBridgeData,
    StargateData,
    DepositedData,
    IStargatePool
} from "./lifi/MainnetStargateFork.sol";

/// LayerZero's `Origin`, what an OApp's `lzReceive` authenticates against its peer.
struct LzOrigin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

interface ILayerZeroReceiver {
    function lzReceive(
        LzOrigin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable;
}

/// LayerZero `PacketV1Codec`: version, nonce, srcEid, sender, dstEid, receiver, guid, then the OApp's message.
struct Packet {
    uint64 nonce;
    uint32 srcEid;
    bytes32 sender;
    uint32 dstEid;
    bytes32 receiver;
    bytes32 guid;
    bytes message;
}

/// Stargate V2's taxi message: type, assetId, recipient, amount in shared decimals, then `composeFrom ‖ composeMsg`.
struct Taxi {
    uint8 kind;
    uint16 assetId;
    bytes32 sendTo;
    uint64 amountSD;
    bytes32 composeFrom;
    bytes composeMsg;
}

/// The recorded Base → Ethereum contract-call quote, end to end on two forks: the user's transaction runs against
/// LI.FI's Diamond and Stargate on Base at the fixture block, the packet LayerZero would carry is captured and
/// decoded, and Ethereum's real Stargate receive turns it into the compose that runs our router at the fixture
/// address. Under `LIFI_RECORD=1` the captured compose is written for the TypeScript decoder's tests.
contract LifiReplayFork is MainnetStargateFork {
    string constant COMPOSE_FIXTURE = "test/fixtures/lifi/mainnet.compose.json";
    bytes32 constant OFT_SENT = keccak256("OFTSent(bytes32,uint32,address,uint256,uint256)");
    bytes32 constant PACKET_SENT = keccak256("PacketSent(bytes,bytes,address)");
    uint8 constant PACKET_VERSION = 1;
    uint8 constant STARGATE_TAXI = 1;
    /// The quote's own slippage (`action.slippage` 0.005): `minAmountLD` is `toAmount` less this.
    uint256 constant QUOTE_SLIPPAGE_BPS = 50;

    bytes32 txId;
    StargateData quote;
    uint256 baseBlock;
    address basePool;
    address baseEndpoint;
    address sendLibrary;
    bytes32 oftGuid;
    uint256 amountSentLD;
    uint256 amountReceivedLD;
    Packet packet;
    Taxi taxi;
    bytes options;
    uint256 lzReceiveGas;
    uint256 composeGas;
    string sourceLogs;

    function setUp() public {
        string memory baseRpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(baseRpc).length == 0 || bytes(vm.envOr("ETH_RPC_URL", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        _loadFixture();
        LifiBridgeData memory b;
        (b, quote) = _baseQuote();
        txId = b.transactionId;
        baseBlock = vm.parseJsonUint(json, ".base.block");
        vm.createSelectFork(baseRpc, baseBlock);
        _sendOnBase();

        _setUpEthereum();
        _resolveStargate(taxi.assetId);
    }

    /// The Base transaction sends our compose (LI.FI's step around the fixture's router call) to ReceiverStargateV2
    /// under identities that agree with each other, with a delivered amount at or above `minAmountLD ≥ T` and close
    /// to the quote's arrival, and with the lzCompose gas LI.FI derives from our `toContractGasLimit`.
    function test_baseSource_sendsOurComposeAboveFloor() public view {
        assertEq(packet.guid, oftGuid, "OFTSent and PacketSent disagree on the guid");
        assertEq(
            packet.guid,
            keccak256(abi.encodePacked(packet.nonce, packet.srcEid, packet.sender, packet.dstEid, packet.receiver)),
            "guid is not LayerZero's GUID.generate"
        );
        assertEq(packet.srcEid, BASE_EID, "srcEid");
        assertEq(packet.dstEid, endpoint.eid(), "dstEid is not Ethereum's endpoint");
        assertEq(packet.receiver, bytes32(uint256(uint160(address(tokenMessaging)))), "not Stargate's Ethereum OApp");
        assertEq(taxi.kind, STARGATE_TAXI, "not a taxi message");
        assertEq(taxi.sendTo, bytes32(uint256(uint160(receiverStargateV2))), "sendTo is not ReceiverStargateV2");
        assertEq(taxi.composeFrom, bytes32(uint256(uint160(diamond))), "composeFrom is not LI.FI's Base Diamond");
        assertEq(taxi.composeMsg, quote.sendParams.composeMsg, "the packet's compose is not the quote's");
        assertEq(taxi.composeMsg, _worstShapeAppMessage(txId, quote.sendParams.minAmountLD), "not our call");

        uint256 amountLD = _amountLD();
        uint256 toAmount = vm.parseJsonUint(vm.readFile(RAW_FIXTURE), ".baseUsdc.includedSteps[1].estimate.toAmount");
        uint256 gapBps = (amountLD > toAmount ? amountLD - toAmount : toAmount - amountLD) * 10_000 / toAmount;
        console2.log("amountSentLD", amountSentLD, "amountLD", amountLD);
        console2.log("minAmountLD", quote.sendParams.minAmountLD, "T", _minReceived());
        console2.log("quote toAmount", toAmount, "gap (bps)", gapBps);
        assertEq(amountSentLD, quote.sendParams.amountLD, "Stargate sent another amount than the quote's");
        assertEq(amountLD, amountReceivedLD, "the packet's amount is not OFTSent's");
        assertGe(amountLD, quote.sendParams.minAmountLD, "delivered below minAmountLD");
        assertGe(quote.sendParams.minAmountLD, _minReceived(), "minAmountLD below T");
        assertLe(gapBps, QUOTE_SLIPPAGE_BPS, "delivered amount is not close to the quote's");

        (, uint256 quoted) = _executorGas(quote.sendParams.extraOptions);
        console2.log("lzReceive gas", lzReceiveGas, "lzCompose gas", composeGas);
        assertEq(composeGas, quoted, "Stargate's enforced options changed the compose gas");
        assertEq(
            composeGas,
            vm.parseJsonUint(json, ".crossChain.baseUsdc.toContractGasLimit") + LIFI_STARGATE_COMPOSE_OVERHEAD,
            "lzCompose gas is not toContractGasLimit plus the overhead"
        );
    }

    /// The captured packet through Ethereum's real Stargate receive queues exactly the compose rebuilt from it; with
    /// the captured lzCompose gas it deposits both legs, Fee Juice at or above the floor, and leaves nothing behind.
    function test_replayedDelivery_depositsWithCapturedComposeGas() public {
        uint256 amountLD = _amountLD();
        bytes memory message = _composeMessage(packet.nonce, packet.srcEid, amountLD, taxi.composeFrom, taxi.composeMsg);
        Balances memory b = _balances();
        uint256 receiverBefore = IERC20(usdc).balanceOf(receiverStargateV2);

        vm.recordLogs();
        vm.prank(address(endpoint));
        ILayerZeroReceiver(address(tokenMessaging))
            .lzReceive(
                LzOrigin(packet.srcEid, packet.sender, packet.nonce), packet.guid, packet.message, lzExecutor, ""
            );
        Vm.Log[] memory received = vm.getRecordedLogs();
        uint256 i = _find(received, address(endpoint), COMPOSE_SENT, NONE);
        assertTrue(i != NOT_FOUND, "Stargate queued no compose");
        (address from, address to, bytes32 guid, uint16 index, bytes memory queued) =
            abi.decode(received[i].data, (address, address, bytes32, uint16, bytes));
        assertEq(
            abi.encode(from, to, guid, index), abi.encode(usdcPool, receiverStargateV2, packet.guid, 0), "compose id"
        );
        assertEq(queued, message, "Stargate queued another compose than the rebuilt one");
        assertEq(IERC20(usdc).balanceOf(receiverStargateV2) - receiverBefore, amountLD, "receiver credit");

        (bool ok, Vm.Log[] memory logs) = _compose(usdcPool, packet.guid, message, composeGas);
        assertTrue(ok, "lzCompose reverted");
        _assertComposeDelivered(logs, usdcPool, packet.guid);
        DepositedData memory d = _assertLanded(logs, b, txId, amountLD);
        console2.log("lzCompose gas used", composeGasUsed, "of", composeGas);
        console2.log("fuelOut", d.fuelOut, "surplus to the user", amountLD - d.received);

        if (_recording()) _writeCompose(message, amountLD);
    }

    /// The user's transaction on Base: exactly the quote's input and LayerZero fee, then the send's events decoded.
    function _sendOnBase() internal {
        address baseUsdc = vm.parseJsonAddress(json, ".base.usdc");
        address baseDiamond = vm.parseJsonAddress(json, ".base.diamond");
        uint256 fromAmount = vm.parseJsonUint(vm.readFile(RAW_FIXTURE), ".baseUsdc.action.fromAmount");
        uint256 value = vm.parseJsonUint(json, ".crossChain.baseUsdc.value");
        deal(baseUsdc, user, fromAmount);
        vm.deal(user, value);
        vm.prank(user);
        IERC20(baseUsdc).approve(baseDiamond, fromAmount);

        vm.recordLogs();
        vm.startStateDiffRecording();
        vm.prank(user);
        (bool ok, bytes memory ret) =
            baseDiamond.call{value: value}(vm.parseJsonBytes(json, ".crossChain.baseUsdc.data"));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        // Recorded logs include those of reverted frames, which a real receipt drops; with no reverted frame the
        // recorded logs are the receipt's.
        Vm.AccountAccess[] memory frames = vm.stopAndReturnStateDiff();
        for (uint256 f; f < frames.length; f++) {
            assertFalse(frames[f].reverted, "a frame reverted; the recorded logs would not match the receipt");
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        sourceLogs = _logsJson(logs);
        assertEq(IERC20(baseUsdc).balanceOf(user), 0, "the Diamond did not take the whole input");
        uint256 started = _find(logs, baseDiamond, TRANSFER_STARTED, NONE);
        assertTrue(started != NOT_FOUND, "no LiFiTransferStarted");
        assertEq(abi.decode(logs[started].data, (LifiBridgeData)).transactionId, txId, "LiFiTransferStarted txId");
        _captureOftSent(logs, baseUsdc, baseDiamond);
        _capturePacket(logs);
    }

    function _captureOftSent(Vm.Log[] memory logs, address baseUsdc, address baseDiamond) internal {
        Vm.Log memory l = logs[_findTopic(logs, OFT_SENT)];
        basePool = l.emitter;
        assertEq(IStargatePool(basePool).token(), baseUsdc, "OFTSent from another pool");
        assertEq(l.topics[2], bytes32(uint256(uint160(baseDiamond))), "OFTSent.fromAddress");
        oftGuid = l.topics[1];
        uint32 dstEid;
        (dstEid, amountSentLD, amountReceivedLD) = abi.decode(l.data, (uint32, uint256, uint256));
        assertEq(dstEid, quote.sendParams.dstEid, "OFTSent.dstEid");
    }

    function _capturePacket(Vm.Log[] memory logs) internal {
        Vm.Log memory l = logs[_findTopic(logs, PACKET_SENT)];
        baseEndpoint = l.emitter;
        bytes memory encoded;
        (encoded, options, sendLibrary) = abi.decode(l.data, (bytes, bytes, address));
        packet = this.decodePacket(encoded);
        taxi = this.decodeTaxi(packet.message);
        (lzReceiveGas, composeGas) = _executorGas(options);
    }

    function decodePacket(bytes calldata p) external pure returns (Packet memory k) {
        assertEq(uint8(p[0]), PACKET_VERSION, "packet version");
        k.nonce = uint64(bytes8(p[1:9]));
        k.srcEid = uint32(bytes4(p[9:13]));
        k.sender = bytes32(p[13:45]);
        k.dstEid = uint32(bytes4(p[45:49]));
        k.receiver = bytes32(p[49:81]);
        k.guid = bytes32(p[81:113]);
        k.message = p[113:];
    }

    function decodeTaxi(bytes calldata m) external pure returns (Taxi memory t) {
        t.kind = uint8(m[0]);
        t.assetId = uint16(bytes2(m[1:3]));
        t.sendTo = bytes32(m[3:35]);
        t.amountSD = uint64(bytes8(m[35:43]));
        t.composeFrom = bytes32(m[43:75]);
        t.composeMsg = m[75:];
    }

    /// Stargate's `_sd2ld` on the destination pool.
    function _amountLD() internal view returns (uint256) {
        uint8 local = IERC20Metadata(usdc).decimals();
        return uint256(taxi.amountSD) * 10 ** (local - IStargatePool(usdcPool).sharedDecimals());
    }

    function _findTopic(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (uint256) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic0) return i;
        }
        revert("event not emitted");
    }

    /// What the TypeScript decoder and discovery tests read: the compose as Ethereum's Stargate queued it, its
    /// parts, the gas LayerZero's executor is paid to run it with, and the source transaction's logs.
    function _writeCompose(bytes memory message, uint256 amountLD) internal {
        string memory ids = string.concat(
            '{\n  "recorder": "LifiReplayFork",\n  "base": {"chainId": 8453, "block": ',
            vm.toString(baseBlock),
            ', "pool": "',
            vm.toString(basePool),
            '", "endpoint": "',
            vm.toString(baseEndpoint),
            '", "sendLibrary": "',
            vm.toString(sendLibrary),
            '"},\n  "guid": "',
            vm.toString(packet.guid),
            '",\n  "nonce": "',
            vm.toString(uint256(packet.nonce)),
            '",\n  "srcEid": ',
            vm.toString(uint256(packet.srcEid)),
            ',\n  "dstEid": ',
            vm.toString(uint256(packet.dstEid)),
            ',\n  "sender": "',
            vm.toString(packet.sender),
            '",\n  "receiver": "',
            vm.toString(packet.receiver),
            '",\n'
        );
        string memory amounts = string.concat(
            '  "amountSD": "',
            vm.toString(uint256(taxi.amountSD)),
            '",\n  "amountLD": "',
            vm.toString(amountLD),
            '",\n  "minAmountLD": "',
            vm.toString(quote.sendParams.minAmountLD),
            '",\n  "composeFrom": "',
            vm.toString(taxi.composeFrom),
            '",\n  "composeMsg": "',
            vm.toString(taxi.composeMsg),
            '",\n  "message": "',
            vm.toString(message),
            '",\n'
        );
        string memory gas = string.concat(
            '  "options": "',
            vm.toString(options),
            '",\n  "lzReceiveGas": "',
            vm.toString(lzReceiveGas),
            '",\n  "composeGas": "',
            vm.toString(composeGas),
            '",\n  "sourceLogs": ',
            sourceLogs,
            "\n}\n"
        );
        vm.writeFile(COMPOSE_FIXTURE, string.concat(ids, amounts, gas));
    }
}
