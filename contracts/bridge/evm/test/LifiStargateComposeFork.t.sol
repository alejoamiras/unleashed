// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {DepositRouter} from "../src/DepositRouter.sol";
import {ILiFiSwap} from "../src/interfaces/ILiFiSwap.sol";
import {
    MainnetStargateFork,
    LifiBridgeData,
    StargateData,
    DepositedData,
    IStargatePool
} from "./lifi/MainnetStargateFork.sol";

interface ILiFiExecutor {
    function swapAndCompleteBridgeTokens(
        bytes32 transactionId,
        ILiFiSwap.SwapData[] calldata swapData,
        address transferredAssetId,
        address payable receiver
    ) external payable;
}

/// LI.FI's Stargate V2 destination on an Ethereum fork: the real EndpointV2 runs the compose that LI.FI's recorded
/// Base quote carries (our worst-shape router call) through the real ReceiverStargateV2, Executor, Diamond and Aztec
/// portals. `lzCompose` is permissionless, so its gas is the caller's choice: these cases pin what each budget does,
/// and that no budget yields a partial deposit.
contract LifiStargateComposeFork is MainnetStargateFork {
    /// Stargate V2's native-ETH asset on Ethereum; the fork asserts its pool's `token()` is zero.
    uint16 constant STARGATE_ETH_ASSET_ID = 13;
    uint64 constant NONCE = 1;
    bytes32 constant GUID = keccak256("unleashed:lifi-stargate-compose");
    uint256 constant NATIVE_AMOUNT = 0.05 ether;
    uint256 constant SWEEP_STEP = 25_000;
    bytes32 constant APPROVAL = keccak256("Approval(address,address,uint256)");

    enum Outcome {
        Reverted,
        Recovered,
        Completed
    }

    bytes32 txId;
    uint256 amountLD;
    bytes quoteOptions;
    bytes appMessage;
    bytes message;
    Balances before;

    function setUp() public {
        if (bytes(vm.envOr("ETH_RPC_URL", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        _setUpEthereum();
        (LifiBridgeData memory b, StargateData memory s) = _baseQuote();
        _resolveStargate(s.assetId);
        txId = b.transactionId;
        quoteOptions = s.sendParams.extraOptions;
        assertEq(s.sendParams.dstEid, endpoint.eid(), "the quote targets another endpoint");
        assertEq(s.sendParams.to, bytes32(uint256(uint160(receiverStargateV2))), "the quote composes elsewhere");

        // LI.FI sizes the Executor step at the Stargate floor; the delivery is the quote's expected arrival.
        appMessage = _worstShapeAppMessage(txId, s.sendParams.minAmountLD);
        assertEq(appMessage, s.sendParams.composeMsg, "LI.FI's compose message is not our worst-shape call");
        string memory raw = vm.readFile(RAW_FIXTURE);
        assertEq(vm.parseJsonString(raw, ".baseUsdc.includedSteps[1].tool"), "stargateV2", "step order");
        amountLD = vm.parseJsonUint(raw, ".baseUsdc.includedSteps[1].estimate.toAmount");
        // Stargate delivers above the quoted amount; `maxPull`'s slack must cover it or the excess stays on L1.
        assertLe(amountLD, _maxPull(), "maxPull leaves part of the expected arrival with the user on Ethereum");

        message = _composeMessage(NONCE, BASE_EID, amountLD, bytes32(uint256(uint160(diamond))), appMessage);
        before = _balances();
        // Delivered in setUp so each case runs `lzCompose` as its own transaction, against the cold state a real
        // executor meets; a snapshot revert restores that coldness between probes.
        _deliver(usdcPool, GUID, message, amountLD);
    }

    /// The worst shape completes with exactly the decoder's minimum compose gas, the receiver's `recoverGas`
    /// reserve included; the router pulls the whole delivery.
    function test_worstShape_completesWithExactlyMinComposeGas() public {
        (, uint256 quoted) = _executorGas(quoteOptions);
        assertEq(
            quoted,
            vm.parseJsonUint(json, ".crossChain.baseUsdc.toContractGasLimit") + LIFI_STARGATE_COMPOSE_OVERHEAD,
            "LI.FI's lzCompose gas is not toContractGasLimit plus the overhead"
        );
        assertLe(recoverGas, LIFI_STARGATE_COMPOSE_OVERHEAD, "the overhead does not cover the recovery reserve");

        (bool ok, Vm.Log[] memory logs) = _compose(usdcPool, GUID, message, LIFI_MIN_COMPOSE_GAS);
        assertTrue(ok, "lzCompose reverted");
        DepositedData memory d = _assertLanded(logs, before, txId, amountLD);
        console2.log("lzCompose gas used", composeGasUsed);
        console2.log("fuelOut", d.fuelOut, "surplus to the user", amountLD - d.received);
    }

    /// `LIFI_MIN_COMPOSE_GAS` is at least the lowest budget that completes; one gas below it the receiver recovers.
    function test_minComposeGas_coversLowestCompletingGas() public {
        uint256 snap = vm.snapshotState();
        (Outcome high,) = _probe(snap, LIFI_MIN_COMPOSE_GAS);
        (Outcome low,) = _probe(snap, recoverGas);
        assertEq(uint8(high), uint8(Outcome.Completed), "the minimum does not complete");
        assertEq(uint8(low), uint8(Outcome.Recovered), "recoverGas does not recover");

        uint256 lo = recoverGas;
        uint256 hi = LIFI_MIN_COMPOSE_GAS;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            (Outcome o,) = _probe(snap, mid);
            if (o == Outcome.Completed) hi = mid;
            else lo = mid;
        }
        (Outcome below, bool executorRan) = _probe(snap, hi - 1);
        assertEq(uint8(below), uint8(Outcome.Recovered), "one gas short does not recover");
        assertTrue(executorRan, "one gas short never reached the Executor");

        console2.log("lowest completing lzCompose gas", hi);
        console2.log("LIFI_MIN_COMPOSE_GAS headroom over it (bps)", (LIFI_MIN_COMPOSE_GAS - hi) * 10_000 / hi);
        assertGe(LIFI_MIN_COMPOSE_GAS, hi, "LIFI_MIN_COMPOSE_GAS is below the lowest completing gas");
    }

    /// Below `recoverGas` the receiver skips the Executor and pays the user the whole delivery; the endpoint still
    /// marks the compose delivered.
    function test_composeBelowRecoverGas_recoversWithoutExecutor() public {
        vm.expectCall(executor, abi.encodePacked(ILiFiExecutor.swapAndCompleteBridgeTokens.selector), 0);
        (bool ok, Vm.Log[] memory logs) = _compose(usdcPool, GUID, message, recoverGas);
        assertTrue(ok, "lzCompose reverted below recoverGas");
        _assertRecovered(logs, before, txId, amountLD);
        _assertComposeDelivered(logs, usdcPool, GUID);
    }

    /// Between `recoverGas` and the minimum, a starved Executor reverts the whole router call (the router has no
    /// try/catch, so no 63/64 starvation skips a check) and the receiver recovers: every budget either completes in
    /// full or recovers in full, and completion is monotone in gas.
    function test_starvedCompose_recoversWholeOrCompletesInFull() public {
        uint256 snap = vm.snapshotState();
        uint256 starved;
        bool completed;
        for (uint256 gas = recoverGas; gas <= LIFI_MIN_COMPOSE_GAS; gas += SWEEP_STEP) {
            (Outcome o, bool executorRan) = _probe(snap, gas);
            assertTrue(o != Outcome.Reverted, "lzCompose reverted, leaving the compose queued");
            if (o == Outcome.Completed) {
                completed = true;
            } else {
                assertFalse(completed, "recovered above a budget that completed");
                if (executorRan) starved++;
            }
        }
        assertTrue(completed, "no budget in the sweep completed");
        assertGt(starved, 0, "no budget starved the Executor after the recovery check");
        console2.log("starved budgets that recovered", starved);
    }

    /// A native delivery (Stargate's ETH pool) under a USDC-shaped message: the router pulls nothing, the step
    /// reverts and the user receives the ETH.
    function test_nativeDelivery_recoversEthToUser() public {
        address ethPool = tokenMessaging.stargateImpls(STARGATE_ETH_ASSET_ID);
        assertEq(IStargatePool(ethPool).token(), address(0), "not Stargate's native pool");
        bytes32 guid = keccak256("unleashed:lifi-stargate-compose:native");
        bytes memory m =
            _composeMessage(NONCE + 1, BASE_EID, NATIVE_AMOUNT, bytes32(uint256(uint160(diamond))), appMessage);
        Balances memory b = _balances();
        uint256 receiverEth = receiverStargateV2.balance;
        uint256 executorEth = executor.balance;

        _deliver(ethPool, guid, m, NATIVE_AMOUNT);
        (bool ok, Vm.Log[] memory logs) = _compose(ethPool, guid, m, LIFI_MIN_COMPOSE_GAS);
        assertTrue(ok, "lzCompose reverted");

        uint256 i = _find(logs, receiverStargateV2, TRANSFER_RECOVERED, txId);
        assertTrue(i != NOT_FOUND, "no LiFiTransferRecovered");
        (address asset, address to, uint256 amount,) = abi.decode(logs[i].data, (address, address, uint256, uint256));
        assertEq(abi.encode(asset, to, amount), abi.encode(address(0), user, NATIVE_AMOUNT), "recovered fields");
        assertEq(user.balance - b.userEth, NATIVE_AMOUNT, "the user did not get the ETH");
        assertEq(receiverStargateV2.balance, receiverEth, "receiver ETH residue");
        assertEq(executor.balance, executorEth, "executor ETH residue");
        assertEq(router.balance, 0, "the router holds ETH");
        assertEq(IERC20(usdc).balanceOf(user), b.userUsdc, "USDC moved to the user");
        _assertNoResidue(usdc, b.usdcResidue);
        _assertNoResidue(aztec, b.aztecResidue);
        _assertComposeDelivered(logs, ethPool, guid);
    }

    /// EndpointV2's `ComposeDelivered(address,address,bytes32,uint16)` carries our guid, after the outcome markers
    /// of the same compose.
    function test_composeDelivered_carriesGuid() public {
        (bool ok, Vm.Log[] memory logs) = _compose(usdcPool, GUID, message, LIFI_MIN_COMPOSE_GAS);
        assertTrue(ok, "lzCompose reverted");
        _assertComposeDelivered(logs, usdcPool, GUID);
        uint256 delivered = _find(logs, address(endpoint), COMPOSE_DELIVERED, NONE);
        assertGt(delivered, _find(logs, executor, TRANSFER_COMPLETED, txId), "delivered before LI.FI completed");
        assertGt(delivered, _find(logs, router, DepositRouter.Deposited.selector, NONE), "delivered before Deposited");
    }

    /// One `lzCompose` of the setUp delivery with `gas`, from the post-setUp state; every non-reverting outcome is
    /// checked whole.
    function _probe(uint256 snap, uint256 gas) internal returns (Outcome, bool executorRan) {
        vm.revertToState(snap);
        (bool ok, Vm.Log[] memory logs) = _compose(usdcPool, GUID, message, gas);
        if (!ok) return (Outcome.Reverted, false);
        _assertComposeDelivered(logs, usdcPool, GUID);
        executorRan = _executorApproved(logs);
        if (_find(logs, receiverStargateV2, TRANSFER_RECOVERED, txId) != NOT_FOUND) {
            _assertRecovered(logs, before, txId, amountLD);
            return (Outcome.Recovered, executorRan);
        }
        _assertLanded(logs, before, txId, amountLD);
        return (Outcome.Completed, executorRan);
    }

    /// The receiver approves the Executor for the delivery only on the branch that calls it.
    function _executorApproved(Vm.Log[] memory logs) internal view returns (bool) {
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter != usdc || l.topics.length != 3 || l.topics[0] != APPROVAL) continue;
            if (l.topics[1] != bytes32(uint256(uint160(receiverStargateV2)))) continue;
            if (l.topics[2] == bytes32(uint256(uint160(executor))) && abi.decode(l.data, (uint256)) == amountLD) {
                return true;
            }
        }
        return false;
    }
}
