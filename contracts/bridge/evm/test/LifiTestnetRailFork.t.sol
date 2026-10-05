// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";

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

/// The testnet rail with LI.FI's and Across's deployed contracts and nothing of ours in between: our builder's
/// bytes deposit through the real Diamond on Base Sepolia, and the real Sepolia fill runs ReceiverAcrossV4 →
/// Executor → a portal deposit, or hands the whole amount to the user when the step reverts. Forks the blocks
/// `lifi-fixtures.ts testnet-rail --run` pinned; public RPCs prune them within minutes, so run it through that
/// script, which also sets `LIFI_RECORD=1` to write the receipts discovery's tests read.
contract LifiTestnetRailFork is Test {
    string constant FIXTURE = "test/fixtures/lifi/testnet-rail.json";
    string constant RECEIPTS = "test/fixtures/lifi/testnet-rail.receipts.json";
    string constant RECOVERED_RECEIPTS = "test/fixtures/lifi/testnet-rail.recovered.receipts.json";

    bytes32 constant FUNDS_DEPOSITED = keccak256(
        "FundsDeposited(bytes32,bytes32,uint256,uint256,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes32,bytes)"
    );
    bytes32 constant FILLED_RELAY = keccak256(
        "FilledRelay(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint32,uint32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,bytes32,uint256,uint8))"
    );
    bytes32 constant TRANSFER_STARTED =
        keccak256("LiFiTransferStarted((bytes32,string,string,address,address,address,uint256,uint256,bool,bool))");
    bytes32 constant TRANSFER_COMPLETED = keccak256("LiFiTransferCompleted(bytes32,address,address,uint256,uint256)");
    bytes32 constant TRANSFER_RECOVERED = keccak256("LiFiTransferRecovered(bytes32,address,address,uint256,uint256)");

    string json;
    uint256 srcFork;
    uint256 dstFork;

    address user;
    address diamond;
    address srcSpoke;
    address srcUsdc;
    address dstSpoke;
    address receiver;
    address executor;
    address dstUsdc;
    PortalFactory factory;
    address portal;
    bytes32 txId;
    uint256 inputAmount;
    uint256 outputAmount;

    function setUp() public {
        string memory srcRpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        string memory dstRpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(srcRpc).length == 0 || bytes(dstRpc).length == 0) {
            vm.skip(true);
            return;
        }
        json = vm.readFile(FIXTURE);
        user = vm.parseJsonAddress(json, ".inputs.user");
        diamond = vm.parseJsonAddress(json, ".source.diamond");
        srcSpoke = vm.parseJsonAddress(json, ".source.spokePool");
        srcUsdc = vm.parseJsonAddress(json, ".source.usdc");
        dstSpoke = vm.parseJsonAddress(json, ".destination.spokePool");
        receiver = vm.parseJsonAddress(json, ".destination.receiverAcrossV4");
        executor = vm.parseJsonAddress(json, ".destination.executor");
        dstUsdc = vm.parseJsonAddress(json, ".destination.usdc");
        factory = PortalFactory(vm.parseJsonAddress(json, ".destination.factory"));
        portal = vm.parseJsonAddress(json, ".destination.portal");
        txId = vm.parseJsonBytes32(json, ".inputs.transactionId");
        inputAmount = vm.parseJsonUint(json, ".inputs.inputAmount");
        outputAmount = vm.parseJsonUint(json, ".inputs.outputAmount");

        srcFork = vm.createFork(srcRpc, vm.parseJsonUint(json, ".source.block"));
        dstFork = vm.createFork(dstRpc, vm.parseJsonUint(json, ".destination.block"));
        vm.selectFork(dstFork);
        assertEq(factory.createPortal(dstUsdc), portal, "the fixture predicted another portal");
    }

    /// F1 + F2 + F3: the deposit lands in the portal, LI.FI marks it completed, and the fill's events carry the
    /// identities discovery matches on.
    function test_rail_depositFillsIntoPortal() public {
        (RelayData memory r, Vm.Log[] memory depositLogs) = _depositOnSource();

        vm.selectFork(dstFork);
        uint256 portalBefore = IERC20(dstUsdc).balanceOf(portal);
        uint256 receiverBefore = IERC20(dstUsdc).balanceOf(receiver);
        uint256 executorBefore = IERC20(dstUsdc).balanceOf(executor);
        Vm.Log[] memory fill = _fill(r);

        bytes32 key = _portalDepositKey(fill);
        address inbox = address(TokenPortalImpl(portal).INBOX());
        assertTrue(_find(fill, inbox, IInbox.MessageSent.selector, key) != type(uint256).max, "no Inbox message");

        uint256 completed = _find(fill, executor, TRANSFER_COMPLETED, txId);
        uint256 filled = _find(fill, dstSpoke, FILLED_RELAY, bytes32(r.originChainId));
        assertTrue(completed != type(uint256).max, "no LiFiTransferCompleted for our transaction id");
        assertTrue(filled != type(uint256).max, "no FilledRelay indexed by origin chain");
        assertEq(fill[filled].topics[2], bytes32(r.depositId), "FilledRelay is not indexed by deposit id");
        // Discovery reads the outcome marker after the transport event: the SpokePool logs the fill, then runs it.
        assertTrue(filled < completed, "the message ran before the SpokePool logged FilledRelay");
        assertEq(_find(fill, receiver, TRANSFER_RECOVERED, txId), type(uint256).max, "recovered on the happy path");

        assertEq(IERC20(dstUsdc).balanceOf(portal) - portalBefore, outputAmount, "portal reserve");
        assertEq(IERC20(dstUsdc).balanceOf(receiver), receiverBefore, "receiver residue");
        assertEq(IERC20(dstUsdc).balanceOf(executor), executorBefore, "executor residue");
        assertEq(IERC20(dstUsdc).balanceOf(user), 0, "user got a refund on the happy path");
        _logOrder(fill);

        if (vm.envOr("LIFI_RECORD", uint256(0)) == 1) _writeReceipts(RECEIPTS, r, depositLogs, fill);
    }

    /// F2's failure branch: a reverting step leaves nothing in LI.FI's contracts and hands the user the whole
    /// delivered amount on Ethereum.
    function test_rail_revertingStepRecoversToUser() public {
        (RelayData memory r, Vm.Log[] memory depositLogs) = _depositOnSource();

        vm.selectFork(dstFork);
        vm.mockCall(address(factory), abi.encodeCall(factory.depositsPaused, ()), abi.encode(true));
        uint256 receiverBefore = IERC20(dstUsdc).balanceOf(receiver);
        uint256 executorBefore = IERC20(dstUsdc).balanceOf(executor);
        Vm.Log[] memory fill = _fill(r);

        uint256 recovered = _find(fill, receiver, TRANSFER_RECOVERED, txId);
        uint256 filled = _find(fill, dstSpoke, FILLED_RELAY, bytes32(r.originChainId));
        assertTrue(recovered != type(uint256).max, "no LiFiTransferRecovered");
        assertTrue(filled < recovered, "the message ran before the SpokePool logged FilledRelay");
        assertEq(_find(fill, executor, TRANSFER_COMPLETED, txId), type(uint256).max, "completed despite the revert");
        assertEq(IERC20(dstUsdc).balanceOf(user), outputAmount, "the user did not receive the delivered amount");
        assertEq(IERC20(dstUsdc).balanceOf(receiver), receiverBefore, "receiver residue");
        assertEq(IERC20(dstUsdc).balanceOf(executor), executorBefore, "executor residue");
        _logOrder(fill);

        if (vm.envOr("LIFI_RECORD", uint256(0)) == 1) _writeReceipts(RECOVERED_RECEIPTS, r, depositLogs, fill);
    }

    /// F1: the fixture's calldata, sent as the user to the real Diamond, makes the SpokePool emit exactly the
    /// deposit our builder described.
    function _depositOnSource() internal returns (RelayData memory r, Vm.Log[] memory logs) {
        vm.selectFork(srcFork);
        deal(srcUsdc, user, inputAmount);
        uint256 diamondBefore = IERC20(srcUsdc).balanceOf(diamond);
        vm.prank(user);
        IERC20(srcUsdc).approve(diamond, inputAmount);

        vm.recordLogs();
        vm.prank(user);
        (bool ok, bytes memory ret) = diamond.call(vm.parseJsonBytes(json, ".calldata"));
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        logs = vm.getRecordedLogs();

        assertEq(IERC20(srcUsdc).balanceOf(user), 0, "the Diamond did not pull the input");
        assertEq(IERC20(srcUsdc).balanceOf(diamond), diamondBefore, "the Diamond kept part of the input");
        assertTrue(_find(logs, diamond, TRANSFER_STARTED, bytes32(0)) != type(uint256).max, "no LiFiTransferStarted");
        r = _relayFrom(logs);
        _logOrder(logs);
    }

    function _relayFrom(Vm.Log[] memory logs) internal view returns (RelayData memory r) {
        uint256 i = _find(logs, srcSpoke, FUNDS_DEPOSITED, bytes32(0));
        assertTrue(i != type(uint256).max, "no FundsDeposited");
        Vm.Log memory l = logs[i];
        assertEq(uint256(l.topics[1]), 11155111, "destination chain");
        r.depositId = uint256(l.topics[2]);
        r.depositor = l.topics[3];
        r.originChainId = 84532;
        uint32 quoteTimestamp;
        (
            r.inputToken,
            r.outputToken,
            r.inputAmount,
            r.outputAmount,
            quoteTimestamp,
            r.fillDeadline,
            r.exclusivityDeadline,
            r.recipient,
            r.exclusiveRelayer,
            r.message
        ) = abi.decode(l.data, (bytes32, bytes32, uint256, uint256, uint32, uint32, uint32, bytes32, bytes32, bytes));

        assertEq(r.depositor, bytes32(uint256(uint160(user))), "depositor");
        assertEq(r.recipient, bytes32(uint256(uint160(receiver))), "recipient is not ReceiverAcrossV4");
        assertEq(r.inputToken, bytes32(uint256(uint160(srcUsdc))), "input token");
        assertEq(r.outputToken, bytes32(uint256(uint160(dstUsdc))), "output token");
        assertEq(r.inputAmount, inputAmount, "input amount");
        assertEq(r.outputAmount, outputAmount, "output amount");
        assertEq(quoteTimestamp, vm.parseJsonUint(json, ".inputs.quoteTimestamp"), "quote timestamp");
        assertEq(r.fillDeadline, vm.parseJsonUint(json, ".inputs.fillDeadline"), "fill deadline");
        assertEq(r.exclusiveRelayer, bytes32(0), "exclusive relayer");
        assertEq(keccak256(r.message), keccak256(vm.parseJsonBytes(json, ".message")), "message");
    }

    function _fill(RelayData memory r) internal returns (Vm.Log[] memory) {
        address relayer = makeAddr("relayer");
        deal(dstUsdc, relayer, r.outputAmount);
        vm.prank(relayer);
        IERC20(dstUsdc).approve(dstSpoke, r.outputAmount);
        vm.recordLogs();
        vm.prank(relayer);
        ISpokePoolFill(dstSpoke).fillRelay(r, r.originChainId, bytes32(uint256(uint160(relayer))));
        return vm.getRecordedLogs();
    }

    function _portalDepositKey(Vm.Log[] memory logs) internal view returns (bytes32 key) {
        uint256 i = _find(logs, portal, TokenPortalImpl.DepositToAztecPublic.selector, bytes32(0));
        assertTrue(i != type(uint256).max, "no DepositToAztecPublic");
        (bytes32 to, uint256 amount, bytes32 secretHash, bytes32 k,) =
            abi.decode(logs[i].data, (bytes32, uint256, bytes32, bytes32, uint256));
        assertEq(to, vm.parseJsonBytes32(json, ".inputs.aztecRecipient"), "Aztec recipient");
        assertEq(amount, outputAmount, "deposited amount");
        assertEq(secretHash, vm.parseJsonBytes32(json, ".inputs.secretHash"), "secret hash");
        key = k;
    }

    /// Index of the first log from `emitter` with `topic0`, also matching `topic1` unless it is zero; max if none.
    function _find(Vm.Log[] memory logs, address emitter, bytes32 topic0, bytes32 topic1)
        internal
        pure
        returns (uint256)
    {
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter != emitter || l.topics.length == 0 || l.topics[0] != topic0) continue;
            if (topic1 != bytes32(0) && (l.topics.length < 2 || l.topics[1] != topic1)) continue;
            return i;
        }
        return type(uint256).max;
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

    function _writeReceipts(string memory path, RelayData memory r, Vm.Log[] memory src, Vm.Log[] memory dst)
        internal
    {
        string memory out = string.concat(
            '{"recorder":"LifiTestnetRailFork","depositId":"',
            vm.toString(r.depositId),
            '","source":{"chainId":84532,"block":',
            vm.toString(vm.parseJsonUint(json, ".source.block")),
            ',"logs":',
            _logsJson(src),
            '},"destination":{"chainId":11155111,"block":',
            vm.toString(vm.parseJsonUint(json, ".destination.block")),
            ',"logs":',
            _logsJson(dst),
            "}}"
        );
        vm.writeFile(path, out);
    }
}
