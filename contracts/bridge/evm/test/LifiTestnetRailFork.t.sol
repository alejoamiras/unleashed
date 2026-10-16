// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";

import {DepositRouter} from "../src/DepositRouter.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {TestnetFuelSwapper} from "../src/TestnetFuelSwapper.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {ILiFiSwap} from "../src/interfaces/ILiFiSwap.sol";
import {ILiFiExecutor, LifiForkBase, RelayData} from "./lifi/LifiForkBase.sol";

/// The FeeJuicePortal's Inbox getter, which the router's local interface leaves out.
interface IPortalInbox {
    function INBOX() external view returns (address);
}

/// The testnet rail with LI.FI's and Across's deployed contracts: our builder's bytes deposit through the real
/// Diamond on Base Sepolia, and the real Sepolia fill runs ReceiverAcrossV4 → Executor → either a portal deposit
/// or our `DepositRouter` swapping a slice through `TestnetFuelSwapper` into the live FeeJuicePortal, and hands the
/// whole amount to the user when the step reverts. Forks the blocks `lifi-fixtures.ts testnet-rail --run` pinned;
/// public RPCs prune them within minutes, so run it through that script, which also sets `LIFI_RECORD=1` to write
/// the receipts discovery's tests read.
contract LifiTestnetRailFork is LifiForkBase {
    string constant FIXTURE = "test/fixtures/lifi/testnet-rail.json";
    string constant RECEIPTS = "test/fixtures/lifi/testnet-rail.receipts.json";
    string constant RECOVERED_RECEIPTS = "test/fixtures/lifi/testnet-rail.recovered.receipts.json";
    string constant ROUTER_RECEIPTS = "test/fixtures/lifi/testnet-rail.router.receipts.json";
    string constant ROUTER_RECOVERED_RECEIPTS = "test/fixtures/lifi/testnet-rail.router-recovered.receipts.json";

    /// The FeeJuicePortal's `DepositToAztecPublic`, whose `to` is indexed (the token portal's is not).
    bytes32 constant FUEL_DEPOSITED = keccak256("DepositToAztecPublic(bytes32,uint256,bytes32,bytes32,uint256)");

    /// One recorded router message: its fixture key, LI.FI transaction id and the intent it delivers.
    struct Variant {
        string key;
        bytes32 id;
        DepositRouter.DepositIntent intent;
    }

    /// `DepositRouter.Deposited`'s data, in order.
    struct Settled {
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

    /// USDC and Fee Juice at receiver, Executor, router, swapper and user, plus both deposit targets' reserves.
    struct Holdings {
        uint256[5] usdc;
        uint256[5] fj;
        uint256 clone;
        uint256 fuelPortal;
    }

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

    DepositRouter router;
    TestnetFuelSwapper swapper;
    address feeJuicePortal;
    address feeAsset;

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
        _deployRouter();
    }

    /// F1 + F2 + F3: the deposit lands in the portal, LI.FI marks it completed, and the fill's events carry the
    /// identities discovery matches on.
    function test_rail_depositFillsIntoPortal() public {
        (RelayData memory r, Vm.Log[] memory depositLogs) = _depositOnSource("");

        vm.selectFork(dstFork);
        uint256 portalBefore = IERC20(dstUsdc).balanceOf(portal);
        uint256 receiverBefore = IERC20(dstUsdc).balanceOf(receiver);
        uint256 executorBefore = IERC20(dstUsdc).balanceOf(executor);
        Vm.Log[] memory fill = _fill(r);

        bytes32 key = _portalDepositKey(fill);
        address inbox = address(TokenPortalImpl(portal).INBOX());
        assertTrue(_find(fill, inbox, IInbox.MessageSent.selector, key) != NOT_FOUND, "no Inbox message");

        uint256 completed = _find(fill, executor, TRANSFER_COMPLETED, txId);
        uint256 filled = _find(fill, dstSpoke, FILLED_RELAY, bytes32(r.originChainId));
        assertTrue(completed != NOT_FOUND, "no LiFiTransferCompleted for our transaction id");
        assertTrue(filled != NOT_FOUND, "no FilledRelay indexed by origin chain");
        assertEq(fill[filled].topics[2], bytes32(r.depositId), "FilledRelay is not indexed by deposit id");
        // Discovery reads the outcome marker after the transport event: the SpokePool logs the fill, then runs it.
        assertTrue(filled < completed, "the message ran before the SpokePool logged FilledRelay");
        assertEq(_find(fill, receiver, TRANSFER_RECOVERED, txId), NOT_FOUND, "recovered on the happy path");

        assertEq(IERC20(dstUsdc).balanceOf(portal) - portalBefore, outputAmount, "portal reserve");
        assertEq(IERC20(dstUsdc).balanceOf(receiver), receiverBefore, "receiver residue");
        assertEq(IERC20(dstUsdc).balanceOf(executor), executorBefore, "executor residue");
        assertEq(IERC20(dstUsdc).balanceOf(user), 0, "user got a refund on the happy path");
        _logOrder(fill);

        if (_recording()) _writeReceipts(RECEIPTS, r, depositLogs, fill);
    }

    /// F2's failure branch: a reverting step leaves nothing in LI.FI's contracts and hands the user the whole
    /// delivered amount on Ethereum.
    function test_rail_revertingStepRecoversToUser() public {
        (RelayData memory r, Vm.Log[] memory depositLogs) = _depositOnSource("");

        vm.selectFork(dstFork);
        vm.mockCall(address(factory), abi.encodeCall(factory.depositsPaused, ()), abi.encode(true));
        uint256 receiverBefore = IERC20(dstUsdc).balanceOf(receiver);
        uint256 executorBefore = IERC20(dstUsdc).balanceOf(executor);
        Vm.Log[] memory fill = _fillRecovered(r);

        uint256 recovered = _find(fill, receiver, TRANSFER_RECOVERED, txId);
        uint256 filled = _find(fill, dstSpoke, FILLED_RELAY, bytes32(r.originChainId));
        assertTrue(recovered != NOT_FOUND, "no LiFiTransferRecovered");
        assertTrue(filled < recovered, "the message ran before the SpokePool logged FilledRelay");
        assertEq(_find(fill, executor, TRANSFER_COMPLETED, txId), NOT_FOUND, "completed despite the revert");
        assertEq(IERC20(dstUsdc).balanceOf(user), outputAmount, "the user did not receive the delivered amount");
        assertEq(IERC20(dstUsdc).balanceOf(receiver), receiverBefore, "receiver residue");
        assertEq(IERC20(dstUsdc).balanceOf(executor), executorBefore, "executor residue");
        _logOrder(fill);

        if (_recording()) _writeReceipts(RECOVERED_RECEIPTS, r, depositLogs, fill);
    }

    /// Public token leg and public fuel through the real fill: the clone takes the remainder, the FeeJuicePortal
    /// the swapper's whole output, and each leg's Inbox message is the key `Deposited` reports.
    function test_router_publicLegsDelivered() public {
        Variant memory v = _variant("public");
        (RelayData memory r, Vm.Log[] memory src) = _depositOnSource(v.key);
        Vm.Log[] memory fill = _assertDelivered(v, r);
        if (_recording()) _writeReceipts(ROUTER_RECEIPTS, r, src, fill);
    }

    /// Private token leg, fuel to the PrivateFPC (a field element, not the user).
    function test_router_privateLegDelivered() public {
        Variant memory v = _variant("private");
        (RelayData memory r,) = _depositOnSource(v.key);
        _assertDelivered(v, r);
    }

    /// Fuel-only (`T = fuelSlice`): the swap consumes the whole delivery and no token deposit happens.
    function test_router_fuelOnlyDelivered() public {
        Variant memory v = _variant("fuelOnly");
        (RelayData memory r,) = _depositOnSource(v.key);
        _assertDelivered(v, r);
    }

    /// A floor above what the swapper pays reverts the step, and LI.FI hands the user the whole delivery.
    function test_router_floorUnmetRecoversToUser() public {
        Variant memory v = _variant("floorUnmet");
        assertGt(v.intent.minFuelOutput, swapper.quote(dstUsdc, v.intent.fuelSlice), "the floor is reachable");
        (RelayData memory r, Vm.Log[] memory src) = _depositOnSource(v.key);
        Vm.Log[] memory fill = _assertRecovered(v, r);
        if (_recording()) _writeReceipts(ROUTER_RECOVERED_RECEIPTS, r, src, fill);
    }

    /// The live factory's pause stops the router before anything moves, and LI.FI recovers to the user.
    function test_router_pausedRecoversToUser() public {
        Variant memory v = _variant("public");
        (RelayData memory r,) = _depositOnSource(v.key);
        vm.selectFork(dstFork);
        vm.mockCall(address(factory), abi.encodeCall(factory.depositsPaused, ()), abi.encode(true));
        _assertRecovered(v, r);
    }

    /// Our router and swapper at the fixture's label addresses, bound to the live generation's FeeJuicePortal and
    /// factory. The swapper starts empty, so a swap mints its inventory from the live FeeAssetHandler.
    function _deployRouter() internal {
        feeJuicePortal = vm.parseJsonAddress(json, ".router.feeJuicePortal");
        feeAsset = vm.parseJsonAddress(json, ".router.feeAsset");
        address swapperAt = vm.parseJsonAddress(json, ".router.swapper");
        address routerAt = vm.parseJsonAddress(json, ".router.router");
        assertEq(swapperAt.code.length + routerAt.code.length, 0, "a fixture label address is taken on Sepolia");
        address owner = makeAddr("owner");

        deployCodeTo(
            "TestnetFuelSwapper.sol:TestnetFuelSwapper",
            abi.encode(feeAsset, vm.parseJsonAddress(json, ".router.feeAssetHandler"), owner),
            swapperAt
        );
        deployCodeTo(
            "DepositRouter.sol:DepositRouter",
            abi.encode(
                vm.parseJsonAddress(json, ".router.permit2"), feeJuicePortal, address(factory), swapperAt, owner
            ),
            routerAt
        );
        swapper = TestnetFuelSwapper(swapperAt);
        router = DepositRouter(routerAt);
        vm.prank(owner);
        swapper.setRate(dstUsdc, vm.parseJsonUint(json, ".router.fjPerWholeToken"));
        assertEq(router.FEE_ASSET(), feeAsset, "the FeeJuicePortal's underlying is not the recorded fee asset");
    }

    function _variant(string memory name) internal view returns (Variant memory v) {
        v.key = string.concat(".router.variants.", name);
        v.id = vm.parseJsonBytes32(json, string.concat(v.key, ".transactionId"));
        string memory k = string.concat(v.key, ".intent");
        v.intent.token = vm.parseJsonAddress(json, string.concat(k, ".token"));
        v.intent.aztecRecipient = vm.parseJsonBytes32(json, string.concat(k, ".aztecRecipient"));
        v.intent.tokenSecretHash = vm.parseJsonBytes32(json, string.concat(k, ".tokenSecretHash"));
        v.intent.isPrivate = vm.parseJsonBool(json, string.concat(k, ".isPrivate"));
        v.intent.fuelSlice = vm.parseJsonUint(json, string.concat(k, ".fuelSlice"));
        v.intent.fuelRecipient = vm.parseJsonBytes32(json, string.concat(k, ".fuelRecipient"));
        v.intent.fuelSecretHash = vm.parseJsonBytes32(json, string.concat(k, ".fuelSecretHash"));
        v.intent.minFuelOutput = vm.parseJsonUint(json, string.concat(k, ".minFuelOutput"));
        assertEq(
            keccak256(vm.parseJsonBytes(json, string.concat(v.key, ".message"))),
            keccak256(_routerMessage(v.id, v.intent)),
            "the recorded message is not the router call the compiled ABIs encode"
        );
    }

    /// What the recorder must have encoded: `bridgeFromCaller` bounded to exactly what Across delivers, its swap
    /// data LI.FI's `swapTokensSingleV3ERC20ToERC20` paying the router with the floor as `_minAmountOut`.
    function _routerMessage(bytes32 id, DepositRouter.DepositIntent memory i) internal view returns (bytes memory) {
        ILiFiSwap.SwapData memory swap = ILiFiSwap.SwapData({
            callTo: address(swapper),
            approveTo: address(swapper),
            sendingAssetId: i.token,
            receivingAssetId: feeAsset,
            fromAmount: i.fuelSlice,
            callData: "",
            requiresDeposit: true
        });
        bytes memory swapData = abi.encodeCall(
            ILiFiSwap.swapTokensSingleV3ERC20ToERC20,
            (id, "unleashed", "", payable(address(router)), i.minFuelOutput, swap)
        );
        bytes memory call = abi.encodeCall(DepositRouter.bridgeFromCaller, (i, swapData, outputAmount, outputAmount));
        return _lifiMessage(id, _routerStep(address(router), dstUsdc, outputAmount, call), user);
    }

    /// Fills `r` and proves the router settled it: transport, `Deposited`, then LI.FI's completion, both legs'
    /// deposits, and no residue anywhere but the swapper's collected input.
    function _assertDelivered(Variant memory v, RelayData memory r) internal returns (Vm.Log[] memory fill) {
        vm.selectFork(dstFork);
        Holdings memory before = _holdings();
        fill = _fill(r);

        uint256 filled = _find(fill, dstSpoke, FILLED_RELAY, bytes32(r.originChainId));
        uint256 deposited = _find(fill, address(router), DepositRouter.Deposited.selector, NONE);
        uint256 completed = _find(fill, executor, TRANSFER_COMPLETED, v.id);
        assertTrue(deposited != NOT_FOUND && completed != NOT_FOUND, "no Deposited or no LiFiTransferCompleted");
        assertTrue(filled < deposited && deposited < completed, "FilledRelay, Deposited, Completed out of order");
        assertEq(_find(fill, receiver, TRANSFER_RECOVERED, v.id), NOT_FOUND, "recovered on the happy path");

        Vm.Log memory l = fill[deposited];
        assertEq(l.topics[1], v.intent.tokenSecretHash, "token secret hash");
        assertEq(l.topics[2], v.intent.fuelSecretHash, "fuel secret hash");
        assertEq(l.topics[3], bytes32(uint256(uint160(dstUsdc))), "token");
        Settled memory s = abi.decode(l.data, (Settled));
        assertEq(s.payer, executor, "payer is not LI.FI's Executor");
        assertEq(s.received, outputAmount, "received");
        assertEq(s.fuelIn, v.intent.fuelSlice, "fuel slice not consumed exactly");
        assertEq(s.tokenAmount, outputAmount - v.intent.fuelSlice, "token leg");
        assertEq(s.fuelOut, swapper.quote(dstUsdc, v.intent.fuelSlice), "fuel out is not the swapper's quote");
        assertGe(s.fuelOut, v.intent.minFuelOutput, "fuel out below the floor");
        assertEq(s.isPrivate, v.intent.isPrivate, "privacy");

        _assertFuelLeg(v, s, fill);
        _assertTokenLeg(v, s, fill);
        _assertMoved(before, s.fuelIn, 0, s.tokenAmount, s.fuelOut);
    }

    function _assertFuelLeg(Variant memory v, Settled memory s, Vm.Log[] memory fill) internal view {
        uint256 i = _find(fill, feeJuicePortal, FUEL_DEPOSITED, v.intent.fuelRecipient);
        assertTrue(i != NOT_FOUND, "no FeeJuicePortal deposit to the fuel recipient");
        (uint256 amount, bytes32 secretHash, bytes32 key,) =
            abi.decode(fill[i].data, (uint256, bytes32, bytes32, uint256));
        assertEq(amount, s.fuelOut, "FeeJuicePortal amount");
        assertEq(secretHash, v.intent.fuelSecretHash, "FeeJuicePortal secret hash");
        assertEq(key, s.fuelKey, "FeeJuicePortal key");
        address inbox = IPortalInbox(feeJuicePortal).INBOX();
        assertTrue(_find(fill, inbox, IInbox.MessageSent.selector, key) != NOT_FOUND, "no Inbox message for the fuel");
    }

    function _assertTokenLeg(Variant memory v, Settled memory s, Vm.Log[] memory fill) internal view {
        bytes32 publicDeposit = TokenPortalImpl.DepositToAztecPublic.selector;
        bytes32 privateDeposit = TokenPortalImpl.DepositToAztecPrivate.selector;
        if (v.intent.tokenSecretHash == bytes32(0)) {
            assertEq(s.tokenKey, bytes32(0), "a fuel-only send reported a token deposit");
            assertEq(_find(fill, portal, publicDeposit, NONE), NOT_FOUND, "a fuel-only send deposited publicly");
            assertEq(_find(fill, portal, privateDeposit, NONE), NOT_FOUND, "a fuel-only send deposited privately");
            return;
        }
        uint256 i = _find(fill, portal, v.intent.isPrivate ? privateDeposit : publicDeposit, NONE);
        assertTrue(i != NOT_FOUND, "no clone deposit of the intent's kind");
        bytes32 to;
        uint256 amount;
        bytes32 secretHash;
        bytes32 key;
        if (v.intent.isPrivate) {
            (amount, secretHash, key,) = abi.decode(fill[i].data, (uint256, bytes32, bytes32, uint256));
        } else {
            (to, amount, secretHash, key,) = abi.decode(fill[i].data, (bytes32, uint256, bytes32, bytes32, uint256));
        }
        assertEq(to, v.intent.aztecRecipient, "clone recipient");
        assertEq(amount, s.tokenAmount, "clone amount");
        assertEq(secretHash, v.intent.tokenSecretHash, "clone secret hash");
        assertEq(key, s.tokenKey, "clone key");
        address inbox = address(TokenPortalImpl(portal).INBOX());
        assertTrue(_find(fill, inbox, IInbox.MessageSent.selector, key) != NOT_FOUND, "no Inbox message for the token");
    }

    /// Fills `r` and proves the step reverted whole: recovery after the transport event, nothing settled, and the
    /// user holds the entire delivery.
    function _assertRecovered(Variant memory v, RelayData memory r) internal returns (Vm.Log[] memory fill) {
        vm.selectFork(dstFork);
        Holdings memory before = _holdings();
        fill = _fillRecovered(r);

        uint256 recovered = _find(fill, receiver, TRANSFER_RECOVERED, v.id);
        uint256 filled = _find(fill, dstSpoke, FILLED_RELAY, bytes32(r.originChainId));
        assertTrue(recovered != NOT_FOUND, "no LiFiTransferRecovered");
        assertTrue(filled < recovered, "the message ran before the SpokePool logged FilledRelay");
        assertEq(_find(fill, executor, TRANSFER_COMPLETED, v.id), NOT_FOUND, "completed despite the revert");
        assertEq(_find(fill, address(router), DepositRouter.Deposited.selector, NONE), NOT_FOUND, "router settled");
        _assertMoved(before, 0, outputAmount, 0, 0);
    }

    function _holdings() internal view returns (Holdings memory h) {
        address[5] memory at = [receiver, executor, address(router), address(swapper), user];
        for (uint256 i; i < 5; i++) {
            h.usdc[i] = IERC20(dstUsdc).balanceOf(at[i]);
            h.fj[i] = IERC20(feeAsset).balanceOf(at[i]);
        }
        h.clone = IERC20(dstUsdc).balanceOf(portal);
        h.fuelPortal = IERC20(feeAsset).balanceOf(feeJuicePortal);
    }

    /// Every holding moved by exactly the given USDC credits and the FeeJuicePortal's Fee Juice; the swapper's Fee
    /// Juice is inventory it minted and paid out, so only a swap that never ran pins it.
    function _assertMoved(Holdings memory b, uint256 toSwapper, uint256 toUser, uint256 toClone, uint256 toFuelPortal)
        internal
        view
    {
        Holdings memory a = _holdings();
        uint256[5] memory credit = [uint256(0), 0, 0, toSwapper, toUser];
        string[5] memory names = ["receiver", "executor", "router", "swapper", "user"];
        for (uint256 i; i < 5; i++) {
            assertEq(a.usdc[i], b.usdc[i] + credit[i], string.concat(names[i], " USDC"));
            if (i != 3 || toFuelPortal == 0) assertEq(a.fj[i], b.fj[i], string.concat(names[i], " Fee Juice"));
        }
        assertEq(a.clone, b.clone + toClone, "USDC clone reserve");
        assertEq(a.fuelPortal, b.fuelPortal + toFuelPortal, "FeeJuicePortal reserve");
    }

    /// F1: the fixture's calldata at `key`, sent as the user to the real Diamond, makes the SpokePool emit exactly
    /// the deposit our builder described.
    function _depositOnSource(string memory key) internal returns (RelayData memory r, Vm.Log[] memory logs) {
        vm.selectFork(srcFork);
        deal(srcUsdc, user, inputAmount);
        uint256 diamondBefore = IERC20(srcUsdc).balanceOf(diamond);
        vm.prank(user);
        IERC20(srcUsdc).approve(diamond, inputAmount);

        vm.recordLogs();
        vm.prank(user);
        (bool ok, bytes memory ret) = diamond.call(vm.parseJsonBytes(json, string.concat(key, ".calldata")));
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        logs = vm.getRecordedLogs();

        assertEq(IERC20(srcUsdc).balanceOf(user), 0, "the Diamond did not pull the input");
        assertEq(IERC20(srcUsdc).balanceOf(diamond), diamondBefore, "the Diamond kept part of the input");
        assertTrue(_find(logs, diamond, TRANSFER_STARTED, NONE) != NOT_FOUND, "no LiFiTransferStarted");
        r = _relayFrom(logs, vm.parseJsonBytes(json, string.concat(key, ".message")));
        _logOrder(logs);
    }

    function _relayFrom(Vm.Log[] memory logs, bytes memory message) internal view returns (RelayData memory r) {
        uint256 i = _find(logs, srcSpoke, FUNDS_DEPOSITED, NONE);
        assertTrue(i != NOT_FOUND, "no FundsDeposited");
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
        assertEq(keccak256(r.message), keccak256(message), "message");
    }

    function _fill(RelayData memory r) internal returns (Vm.Log[] memory) {
        return _acrossFill(dstSpoke, dstUsdc, r);
    }

    /// Fills `r` when the Executor's call reverts and returns the logs the chain's receipt would hold. Forge keeps
    /// the logs of reverted frames, so the fill runs again from the same state with the Executor reverting at
    /// entry: ReceiverAcrossV4's `catch` ignores the reason, so its own frame emits the same logs either way. Both
    /// runs must leave the same holdings.
    function _fillRecovered(RelayData memory r) internal returns (Vm.Log[] memory receipt) {
        uint256 snapshot = vm.snapshotState();
        Vm.Log[] memory recorded = _fill(r);
        Holdings memory real = _holdings();
        vm.revertToState(snapshot);
        vm.mockCallRevert(executor, abi.encodePacked(ILiFiExecutor.swapAndCompleteBridgeTokens.selector), "");
        receipt = _fill(r);
        vm.clearMockedCalls();
        assertEq(abi.encode(_holdings()), abi.encode(real), "the receipt run moved different funds");
        _assertOneBlockDropped(recorded, receipt);
    }

    function _portalDepositKey(Vm.Log[] memory logs) internal view returns (bytes32 key) {
        uint256 i = _find(logs, portal, TokenPortalImpl.DepositToAztecPublic.selector, NONE);
        assertTrue(i != NOT_FOUND, "no DepositToAztecPublic");
        (bytes32 to, uint256 amount, bytes32 secretHash, bytes32 k,) =
            abi.decode(logs[i].data, (bytes32, uint256, bytes32, bytes32, uint256));
        assertEq(to, vm.parseJsonBytes32(json, ".inputs.aztecRecipient"), "Aztec recipient");
        assertEq(amount, outputAmount, "deposited amount");
        assertEq(secretHash, vm.parseJsonBytes32(json, ".inputs.secretHash"), "secret hash");
        key = k;
    }

    function _writeReceipts(string memory path, RelayData memory r, Vm.Log[] memory src, Vm.Log[] memory dst) internal {
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
