// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {DepositRouter} from "../../src/DepositRouter.sol";
import {ILiFiSwap} from "../../src/interfaces/ILiFiSwap.sol";
import {MainnetLifiFork, SameChainQuote} from "./MainnetLifiFork.sol";

/// `ILiFi.BridgeData`, field for field.
struct LifiBridgeData {
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

/// Stargate V2's `SendParam`, field for field.
struct StargateSendParam {
    uint32 dstEid;
    bytes32 to;
    uint256 amountLD;
    uint256 minAmountLD;
    bytes extraOptions;
    bytes composeMsg;
    bytes oftCmd;
}

struct StargateFee {
    uint256 nativeFee;
    uint256 lzTokenFee;
}

/// `StargateFacetV2.StargateData`, field for field.
struct StargateData {
    uint16 assetId;
    StargateSendParam sendParams;
    StargateFee fee;
    address refundAddress;
}

/// `DepositRouter.Deposited`'s unindexed fields, in order (all static, so a struct decodes the flat tuple).
struct DepositedData {
    address payer;
    uint256 received;
    uint256 tokenAmount;
    bytes32 tokenKey;
    uint256 tokenIndex;
    uint256 fuelIn;
    uint256 fuelOut;
    bytes32 fuelKey;
    uint256 fuelIndex;
    bool isPrivate;
}

/// The Base-side entrypoint the recorded contract-call quote calls (selector `0xa6010a66`).
interface IStargateFacetV2 {
    function swapAndStartBridgeTokensViaStargate(
        LifiBridgeData calldata bridgeData,
        ILiFiSwap.SwapData[] calldata swapData,
        StargateData calldata stargateData
    ) external payable;
}

interface IReceiverStargateV2 {
    function executor() external view returns (address);
    function tokenMessaging() external view returns (address);
    function endpointV2() external view returns (address);
    function recoverGas() external view returns (uint256);
}

interface IStargateTokenMessaging {
    function stargateImpls(uint16 assetId) external view returns (address);
    function assetIds(address pool) external view returns (uint16);
}

interface IStargatePool {
    function token() external view returns (address);
    function sharedDecimals() external view returns (uint8);
}

/// LayerZero EndpointV2's compose queue.
interface IEndpointV2Compose {
    function eid() external view returns (uint32);
    function sendCompose(address to, bytes32 guid, uint16 index, bytes calldata message) external;
    function lzCompose(
        address from,
        address to,
        bytes32 guid,
        uint16 index,
        bytes calldata message,
        bytes calldata extraData
    ) external payable;
}

/// The Stargate V2 half of the mainnet LI.FI forks: LI.FI's ReceiverStargateV2 behind LayerZero's real EndpointV2,
/// fed the way Stargate's `lzReceive` feeds it (the pool credits the receiver, then queues the compose), with the
/// recorded Base quote decoded so the forks run the compose message LI.FI itself built around our router call.
abstract contract MainnetStargateFork is MainnetLifiFork {
    /// Mirrors of `packages/bridge-core/src/lifi-gas.ts`; change both together.
    uint256 internal constant LIFI_TO_CONTRACT_GAS_LIMIT = 1_000_000;
    uint256 internal constant LIFI_STARGATE_COMPOSE_OVERHEAD = 300_000;
    uint256 internal constant LIFI_MIN_COMPOSE_GAS = LIFI_TO_CONTRACT_GAS_LIMIT + LIFI_STARGATE_COMPOSE_OVERHEAD;

    string internal constant RAW_FIXTURE = "test/fixtures/lifi/mainnet.raw.json";
    /// LayerZero's endpoint id for Base (the compose message's `srcEid`); the replay reads it from the packet.
    uint32 internal constant BASE_EID = 30184;
    /// LayerZero executor option layout (`ExecutorOptions`): worker 1, types 1 (lzReceive) and 3 (lzCompose).
    uint8 internal constant EXECUTOR_WORKER = 1;
    uint8 internal constant OPTION_LZ_RECEIVE = 1;
    uint8 internal constant OPTION_LZ_COMPOSE = 3;

    bytes32 internal constant COMPOSE_SENT = keccak256("ComposeSent(address,address,bytes32,uint16,bytes)");
    bytes32 internal constant COMPOSE_DELIVERED = keccak256("ComposeDelivered(address,address,bytes32,uint16)");

    IEndpointV2Compose internal endpoint;
    IStargateTokenMessaging internal tokenMessaging;
    address internal usdcPool;
    uint256 internal recoverGas;
    address internal lzExecutor = makeAddr("lzExecutor");
    /// What the last `_compose` spent, the call's own overhead included.
    uint256 internal composeGasUsed;

    /// Every balance a deposit can move, taken before the receiver is credited.
    struct Balances {
        uint256[5] usdcResidue;
        uint256[5] aztecResidue;
        uint256 userUsdc;
        uint256 userEth;
        uint256 clone;
        uint256 feeJuicePortal;
    }

    /// Reads the receiver's wiring on the selected Ethereum fork; the USDC pool is the quote's asset's.
    function _resolveStargate(uint16 assetId) internal {
        IReceiverStargateV2 r = IReceiverStargateV2(receiverStargateV2);
        assertEq(r.executor(), executor, "ReceiverStargateV2 hands off to another Executor");
        endpoint = IEndpointV2Compose(r.endpointV2());
        tokenMessaging = IStargateTokenMessaging(r.tokenMessaging());
        recoverGas = r.recoverGas();
        usdcPool = tokenMessaging.stargateImpls(assetId);
        assertEq(IStargatePool(usdcPool).token(), usdc, "the quote's Stargate asset is not Ethereum USDC");
        assertEq(tokenMessaging.assetIds(usdcPool), assetId, "the receiver would refuse the pool");
    }

    /// The recorded Base → Ethereum quote's arguments.
    function _baseQuote() internal view returns (LifiBridgeData memory b, StargateData memory s) {
        return this.decodeStargateCall(vm.parseJsonBytes(json, ".crossChain.baseUsdc.data"));
    }

    function decodeStargateCall(bytes calldata data)
        external
        pure
        returns (LifiBridgeData memory b, StargateData memory s)
    {
        assertEq(bytes4(data[:4]), IStargateFacetV2.swapAndStartBridgeTokensViaStargate.selector, "selector");
        (b,, s) = abi.decode(data[4:], (LifiBridgeData, ILiFiSwap.SwapData[], StargateData));
    }

    /// The step the recorded quote embeds: the Executor calls our router with the worst shape (private token leg,
    /// fuel to the PrivateFPC through the deadline-free venue). Asserted byte-equal to the fixture's calldata, which
    /// the TS builder encoded, so the compose message is ours and not a reconstruction.
    function _worstShapeAppMessage(bytes32 txId, uint256 stepAmount) internal view returns (bytes memory) {
        SameChainQuote memory swap = _sameChain("deadlineFree");
        bytes memory call = _routerCall(_crossChainIntent("baseUsdc"), swap.data, _minReceived(), _maxPull());
        assertEq(call, vm.parseJsonBytes(json, ".crossChain.baseUsdc.routerCalldata"), "router calldata");
        ILiFiSwap.SwapData[] memory steps = _routerStep(router, usdc, stepAmount, call);
        // LI.FI marks a contract-call step `requiresDeposit`; the Executor's `LibSwap.swap` never reads the flag.
        steps[0].requiresDeposit = true;
        return _lifiMessage(txId, steps, user);
    }

    function _minReceived() internal view returns (uint256) {
        return vm.parseJsonUint(json, ".crossChain.baseUsdc.minReceived");
    }

    function _maxPull() internal view returns (uint256) {
        return vm.parseJsonUint(json, ".crossChain.baseUsdc.maxPull");
    }

    /// `OFTComposeMsgCodec.encode`: what the destination pool hands `EndpointV2.sendCompose`.
    function _composeMessage(uint64 nonce, uint32 srcEid, uint256 amountLD, bytes32 composeFrom, bytes memory app)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(nonce, srcEid, amountLD, composeFrom, app);
    }

    /// Sums the executor's lzReceive gas and index-0 lzCompose gas over type-3 options, as LayerZero's executor
    /// fee library does when the same option repeats.
    function _executorGas(bytes memory options) internal pure returns (uint256 receiveGas, uint256 composeGas) {
        assertEq(_word(options, 0, 2), 3, "not type-3 options");
        uint256 at = 2;
        while (at < options.length) {
            uint256 worker = _word(options, at, 1);
            uint256 size = _word(options, at + 1, 2);
            uint256 kind = _word(options, at + 3, 1);
            if (worker == EXECUTOR_WORKER && kind == OPTION_LZ_RECEIVE) {
                receiveGas += _word(options, at + 4, 16);
            } else if (worker == EXECUTOR_WORKER && kind == OPTION_LZ_COMPOSE && _word(options, at + 4, 2) == 0) {
                composeGas += _word(options, at + 6, 16);
            }
            at += 3 + size;
        }
        assertEq(at, options.length, "truncated option");
    }

    /// Big-endian unsigned read of `len` (≤ 32) bytes at `at`.
    function _word(bytes memory b, uint256 at, uint256 len) internal pure returns (uint256 v) {
        require(at + len <= b.length, "read past the end");
        for (uint256 i; i < len; i++) {
            v = (v << 8) | uint8(b[at + i]);
        }
    }

    function _balances() internal view returns (Balances memory b) {
        b.usdcResidue = _residue(usdc);
        b.aztecResidue = _residue(aztec);
        b.userUsdc = IERC20(usdc).balanceOf(user);
        b.userEth = user.balance;
        b.clone = IERC20(usdc).balanceOf(usdcPortal);
        b.feeJuicePortal = IERC20(aztec).balanceOf(feeJuicePortal);
    }

    /// Stargate's `lzReceive` for `pool`: the delivered amount reaches the receiver, then the pool queues the
    /// compose at index 0.
    function _deliver(address pool, bytes32 guid, bytes memory message, uint256 amountLD) internal {
        if (IStargatePool(pool).token() == address(0)) {
            vm.deal(receiverStargateV2, receiverStargateV2.balance + amountLD);
        } else {
            deal(usdc, receiverStargateV2, IERC20(usdc).balanceOf(receiverStargateV2) + amountLD);
        }
        vm.recordLogs();
        vm.prank(pool);
        endpoint.sendCompose(receiverStargateV2, guid, 0, message);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 i = _find(logs, address(endpoint), COMPOSE_SENT, NONE);
        assertTrue(i != NOT_FOUND, "no ComposeSent");
        (address from, address to, bytes32 g, uint16 index, bytes memory m) =
            abi.decode(logs[i].data, (address, address, bytes32, uint16, bytes));
        assertEq(
            abi.encode(from, to, g, index, keccak256(m)),
            abi.encode(pool, receiverStargateV2, guid, 0, keccak256(message)),
            "ComposeSent fields"
        );
    }

    /// `EndpointV2.lzCompose` with exactly `gas`, as a LayerZero executor would run it. `ok` is false when the whole
    /// compose reverted, which leaves it queued for a retry.
    function _compose(address pool, bytes32 guid, bytes memory message, uint256 gas)
        internal
        returns (bool ok, Vm.Log[] memory logs)
    {
        bytes memory call = abi.encodeCall(endpoint.lzCompose, (pool, receiverStargateV2, guid, 0, message, ""));
        vm.recordLogs();
        vm.prank(lzExecutor);
        uint256 start = gasleft();
        (ok,) = address(endpoint).call{gas: gas}(call);
        composeGasUsed = start - gasleft();
        logs = vm.getRecordedLogs();
    }

    /// LayerZero's per-compose marker, which discovery matches on: unindexed `(from, to, guid, index)`.
    function _assertComposeDelivered(Vm.Log[] memory logs, address pool, bytes32 guid) internal view {
        uint256 i = _find(logs, address(endpoint), COMPOSE_DELIVERED, NONE);
        assertTrue(i != NOT_FOUND, "no ComposeDelivered");
        assertEq(logs[i].topics.length, 1, "ComposeDelivered gained an indexed field");
        (address from, address to, bytes32 g, uint16 index) =
            abi.decode(logs[i].data, (address, address, bytes32, uint16));
        assertEq(from, pool, "ComposeDelivered.from");
        assertEq(to, receiverStargateV2, "ComposeDelivered.to");
        assertEq(g, guid, "ComposeDelivered.guid");
        assertEq(index, 0, "ComposeDelivered.index");
    }

    /// The worst shape landed: LI.FI completed, the router took `min(amountLD, maxPull)`, both deposits reached
    /// Aztec with Fee Juice at or above the floor, the Executor forwarded the rest to the user, nothing stayed behind.
    function _assertLanded(Vm.Log[] memory logs, Balances memory before, bytes32 txId, uint256 amountLD)
        internal
        view
        returns (DepositedData memory d)
    {
        DepositRouter.DepositIntent memory intent = _crossChainIntent("baseUsdc");
        assertTrue(_find(logs, executor, TRANSFER_COMPLETED, txId) != NOT_FOUND, "no LiFiTransferCompleted");
        assertEq(_find(logs, receiverStargateV2, TRANSFER_RECOVERED, NONE), NOT_FOUND, "recovered");
        uint256 i = _find(logs, router, DepositRouter.Deposited.selector, intent.tokenSecretHash);
        assertTrue(i != NOT_FOUND, "no Deposited");
        assertEq(logs[i].topics[2], intent.fuelSecretHash, "Deposited.fuelSecretHash");
        assertEq(logs[i].topics[3], bytes32(uint256(uint160(usdc))), "Deposited.token");
        d = abi.decode(logs[i].data, (DepositedData));

        uint256 pulled = amountLD < _maxPull() ? amountLD : _maxPull();
        assertEq(d.payer, executor, "payer");
        assertEq(d.received, pulled, "received");
        assertLe(d.fuelIn, intent.fuelSlice, "fuelIn");
        assertEq(d.tokenAmount, pulled - d.fuelIn, "tokenAmount");
        assertGe(d.fuelOut, intent.minFuelOutput, "Fee Juice below the floor");
        assertTrue(d.isPrivate && d.tokenKey != bytes32(0) && d.fuelKey != bytes32(0), "a leg did not reach the Inbox");
        assertEq(IERC20(usdc).balanceOf(usdcPortal) - before.clone, d.tokenAmount, "clone delta");
        assertEq(IERC20(aztec).balanceOf(feeJuicePortal) - before.feeJuicePortal, d.fuelOut, "FeeJuicePortal delta");
        assertEq(IERC20(usdc).balanceOf(user) - before.userUsdc, amountLD - pulled, "surplus to the user");
        _assertNoResidue(usdc, before.usdcResidue);
        _assertNoResidue(aztec, before.aztecResidue);
    }

    /// The receiver handed the user everything it was credited and nothing was deposited. Judged by balances:
    /// Foundry's recorded logs keep those of reverted frames, so a starved Executor's `Deposited` still shows.
    function _assertRecovered(Vm.Log[] memory logs, Balances memory before, bytes32 txId, uint256 amountLD)
        internal
        view
    {
        uint256 i = _find(logs, receiverStargateV2, TRANSFER_RECOVERED, txId);
        assertTrue(i != NOT_FOUND, "no LiFiTransferRecovered");
        assertEq(IERC20(usdc).balanceOf(user) - before.userUsdc, amountLD, "the user did not get the whole amount");
        assertEq(IERC20(usdc).balanceOf(usdcPortal), before.clone, "clone moved");
        assertEq(IERC20(aztec).balanceOf(feeJuicePortal), before.feeJuicePortal, "FeeJuicePortal moved");
        _assertNoResidue(usdc, before.usdcResidue);
        _assertNoResidue(aztec, before.aztecResidue);
    }
}
