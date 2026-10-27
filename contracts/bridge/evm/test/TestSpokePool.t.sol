// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test, Vm} from "forge-std/Test.sol";
import {MintableERC20} from "../src/MintableERC20.sol";
import {SourceAcrossStub} from "../src/mocks/SourceAcrossStub.sol";
import {TestSpokePool} from "../src/mocks/TestSpokePool.sol";

/// Records the hook's arguments, or reverts when told to.
contract RecordingHandler {
    bool public reverts;
    bytes public lastCall;

    function setReverts(bool r) external {
        reverts = r;
    }

    function handleV3AcrossMessage(address token, uint256 amount, address relayer, bytes memory message) external {
        require(!reverts, "handler refused");
        lastCall = abi.encode(msg.sender, token, amount, relayer, message);
    }
}

/// The sandbox's Across stand-ins keep the deployed shapes the TS decoders and `relayer.ts` read.
contract TestSpokePoolTest is Test {
    bytes32 internal constant FUNDS_DEPOSITED = keccak256(
        "FundsDeposited(bytes32,bytes32,uint256,uint256,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes32,bytes)"
    );
    bytes32 internal constant FILLED_RELAY = keccak256(
        "FilledRelay(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint32,uint32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,bytes32,uint256,uint8))"
    );
    bytes32 internal constant TRANSFER_STARTED =
        keccak256("LiFiTransferStarted((bytes32,string,string,address,address,address,uint256,uint256,bool,bool))");
    uint256 internal constant DESTINATION = 31337;

    TestSpokePool internal pool;
    SourceAcrossStub internal stub;
    MintableERC20 internal token;
    RecordingHandler internal handler;
    address internal user = makeAddr("user");
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        vm.chainId(31338);
        pool = new TestSpokePool();
        stub = new SourceAcrossStub(pool);
        token = new MintableERC20("Test USDC", "USDC", 6, 1_000_000);
        handler = new RecordingHandler();
        token.mint(relayer, 1_000e6);
        vm.prank(relayer);
        token.approve(address(pool), type(uint256).max);
    }

    function _w(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _relay(bytes memory message) internal view returns (TestSpokePool.V3RelayData memory) {
        return TestSpokePool.V3RelayData({
            depositor: _w(user),
            recipient: _w(address(handler)),
            exclusiveRelayer: bytes32(0),
            inputToken: _w(address(token)),
            outputToken: _w(address(token)),
            inputAmount: 100e6,
            outputAmount: 99e6,
            originChainId: 84532,
            depositId: 7,
            fillDeadline: uint32(block.timestamp + 1 hours),
            exclusivityDeadline: 0,
            message: message
        });
    }

    function _fill(TestSpokePool.V3RelayData memory r, address filler) internal {
        vm.prank(filler);
        pool.fillRelay(r, r.originChainId, _w(filler));
    }

    function test_stub_depositsTheFacetFieldsThenLogsTheStart() public {
        token.mint(user, 100e6);
        SourceAcrossStub.BridgeData memory b = SourceAcrossStub.BridgeData({
            transactionId: keccak256("tx"),
            bridge: "acrossV4",
            integrator: "unleashed",
            referrer: address(0),
            sendingAssetId: address(token),
            receiver: user,
            minAmount: 100e6,
            destinationChainId: DESTINATION,
            hasSourceSwaps: false,
            hasDestinationCall: true
        });
        SourceAcrossStub.AcrossV4Data memory a = SourceAcrossStub.AcrossV4Data({
            receiverAddress: _w(address(handler)),
            refundAddress: _w(user),
            sendingAssetId: _w(address(token)),
            receivingAssetId: _w(address(0xD5)),
            outputAmount: 99e6,
            outputAmountMultiplier: 0,
            exclusiveRelayer: bytes32(0),
            quoteTimestamp: uint32(block.timestamp),
            fillDeadline: uint32(block.timestamp + 1 hours),
            exclusivityParameter: 0,
            message: hex"c0ffee"
        });
        vm.startPrank(user);
        token.approve(address(stub), 100e6);
        vm.recordLogs();
        stub.startBridgeTokensViaAcrossV4(b, a);
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory deposited = logs[logs.length - 2];
        Vm.Log memory started = logs[logs.length - 1];
        assertEq(deposited.emitter, address(pool));
        assertEq(deposited.topics[0], FUNDS_DEPOSITED, "the deployed FundsDeposited signature");
        assertEq(deposited.topics[1], bytes32(DESTINATION));
        assertEq(deposited.topics[3], _w(user), "the depositor is the refund address, not the stub");
        (,,,,,,, bytes32 recipient,, bytes memory message) = abi.decode(
            deposited.data, (bytes32, bytes32, uint256, uint256, uint32, uint32, uint32, bytes32, bytes32, bytes)
        );
        assertEq(recipient, _w(address(handler)));
        assertEq(message, hex"c0ffee");
        assertEq(started.emitter, address(stub));
        assertEq(started.topics[0], TRANSFER_STARTED, "the Diamond's LiFiTransferStarted signature");
        assertEq(token.balanceOf(address(pool)), 100e6);
        assertEq(token.balanceOf(address(stub)), 0);
    }

    function test_fill_paysThenRunsTheMessageOnce() public {
        TestSpokePool.V3RelayData memory r = _relay(hex"beef");
        bytes32 relayHash = keccak256(abi.encode(r, block.chainid));
        assertEq(pool.getV3RelayHash(r), relayHash, "every relay field and the filling chain's id");
        vm.recordLogs();
        _fill(r, relayer);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[0], FILLED_RELAY, "FilledRelay, logged before the payment and the hook");
        assertEq(logs[0].topics[3], _w(relayer), "the repayment address is the logged relayer");
        assertEq(token.balanceOf(address(handler)), 99e6);
        assertEq(handler.lastCall(), abi.encode(address(pool), address(token), uint256(99e6), relayer, hex"beef"));
        assertEq(pool.fillStatuses(relayHash), 2);

        vm.expectRevert(TestSpokePool.RelayFilled.selector);
        _fill(r, relayer);
    }

    function test_fill_aRevertingHandlerRevertsTheWholeFill() public {
        handler.setReverts(true);
        TestSpokePool.V3RelayData memory r = _relay(hex"beef");
        vm.expectRevert(bytes("handler refused"));
        _fill(r, relayer);
        assertEq(pool.fillStatuses(pool.getV3RelayHash(r)), 0);
        assertEq(token.balanceOf(address(handler)), 0);
    }

    function test_fill_refusesPastTheDeadlineAndInsideAnotherRelayersWindow() public {
        TestSpokePool.V3RelayData memory r = _relay(hex"beef");
        r.fillDeadline = uint32(block.timestamp - 1);
        vm.expectRevert(TestSpokePool.ExpiredFillDeadline.selector);
        _fill(r, relayer);

        r = _relay(hex"beef");
        address exclusive = makeAddr("exclusive");
        r.exclusiveRelayer = _w(exclusive);
        r.exclusivityDeadline = uint32(block.timestamp);
        vm.expectRevert(TestSpokePool.NotExclusiveRelayer.selector);
        _fill(r, relayer);

        vm.warp(block.timestamp + 1);
        _fill(r, relayer);
        assertEq(pool.fillStatuses(pool.getV3RelayHash(r)), 2, "anyone fills once the window has passed");
    }

    function test_deposit_refusesAQuoteOlderThanTheBufferOrAheadOfTheClock() public {
        vm.warp(10 hours);
        token.mint(user, 3e6);
        vm.startPrank(user);
        token.approve(address(pool), 3e6);
        uint32 quote = uint32(block.timestamp);
        vm.warp(block.timestamp + pool.depositQuoteTimeBuffer());
        _deposit(quote);
        vm.expectRevert(TestSpokePool.InvalidQuoteTimestamp.selector);
        _deposit(quote - 1);
        vm.expectRevert(TestSpokePool.InvalidQuoteTimestamp.selector);
        _deposit(uint32(block.timestamp + 1));
        vm.stopPrank();
    }

    function _deposit(uint32 quoteTimestamp) internal {
        pool.deposit(
            _w(user),
            _w(user),
            _w(address(token)),
            _w(address(0xD5)),
            1e6,
            1e6,
            DESTINATION,
            bytes32(0),
            quoteTimestamp,
            quoteTimestamp + 2 hours,
            0,
            ""
        );
    }
}
