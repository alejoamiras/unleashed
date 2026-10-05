// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {DepositRouter} from "../src/DepositRouter.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {ILiFiSwap} from "../src/interfaces/ILiFiSwap.sol";
import {RelayData} from "./lifi/LifiForkBase.sol";
import {MainnetLifiFork, SameChainQuote} from "./lifi/MainnetLifiFork.sol";

/// Uniswap V4's pool key and swap parameters, declared locally so the suite does not depend on a Uniswap lib.
struct V4PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct V4SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IV4PoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(V4PoolKey memory key, V4SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// A front-runner that buys `currency1` with native ETH in one V4 pool, as any searcher could.
contract V4Buyer {
    /// `TickMath.MIN_SQRT_PRICE + 1`: no price limit on a zero-for-one swap.
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128739 + 1;
    IV4PoolManager internal immutable PM;

    constructor(address pm) {
        PM = IV4PoolManager(pm);
    }

    function buy(V4PoolKey calldata key, uint256 ethIn) external returns (uint256) {
        return abi.decode(PM.unlock(abi.encode(key, ethIn)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(PM), "not the PoolManager");
        (V4PoolKey memory key, uint256 ethIn) = abi.decode(data, (V4PoolKey, uint256));
        int256 delta = PM.swap(key, V4SwapParams(true, -int256(ethIn), MIN_SQRT_PRICE_LIMIT), "");
        // BalanceDelta packs amount0 in the high 128 bits and amount1 in the low 128.
        uint256 paid = uint256(uint128(-int128(delta >> 128)));
        uint256 out = uint256(uint128(int128(delta)));
        PM.settle{value: paid}();
        PM.take(key.currency1, address(this), out);
        return abi.encode(out);
    }

    receive() external payable {}
}

/// LI.FI's real Ethereum destination stack delivering into `DepositRouter`: a relayer's Across fill runs SpokePool →
/// ReceiverAcrossV4 → Executor → router → LI.FI Diamond (the recorded USDC → AZTEC calldata) → FeeJuicePortal and the
/// USDC clone, at the block `lifi-fixtures.ts mainnet` recorded. Needs an archive `ETH_RPC_URL`; skips without one.
contract LifiDestinationFork is MainnetLifiFork {
    /// `LIFI_TO_CONTRACT_GAS_LIMIT` in packages/bridge-core/src/lifi-gas.ts.
    uint256 internal constant LIFI_TO_CONTRACT_GAS_LIMIT = 1_000_000;
    /// The only entry of `LIFI_DENY_EXCHANGES` in packages/bridge-core/src/lifi-gas.ts.
    string internal constant LIFI_DENIED_EXCHANGE = "bitget";
    /// Across fills in seconds; the warp takes the larger of this and the quoted rail ETA.
    uint256 internal constant ACROSS_FILL_SECONDS = 10;
    uint256 internal constant SECONDS_PER_BLOCK = 12;
    /// `_minAmountOut` in `GenericSwapFacetV3`'s head: selector, id, two string offsets and `_receiver` precede it.
    uint256 internal constant MIN_AMOUNT_OUT_OFFSET = 132;
    /// The facet's revert when its `_minAmountOut` is not met.
    bytes4 internal constant CUMULATIVE_SLIPPAGE = bytes4(keccak256("CumulativeSlippageTooHigh(uint256,uint256)"));
    /// The deployed Inbox's event, older than the artifacts' `IInbox`: checkpoint (topic 1), index, message hash
    /// (topic 2, the key a portal returns), rolling hash.
    bytes32 internal constant INBOX_MESSAGE_SENT = keccak256("MessageSent(uint256,uint256,bytes32,bytes16)");
    bytes32 internal constant V4_SWAP = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
    address internal constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    /// The ETH/AZTEC pool the recorded deadline-free route sells into, as its calldata encodes it.
    address internal constant AZTEC_POOL_HOOKS = 0xd53006d1e3110fD319a79AEEc4c527a0d265E080;
    uint24 internal constant AZTEC_POOL_FEE = 500;
    int24 internal constant AZTEC_POOL_SPACING = 10;

    struct Deposited {
        bytes32 tokenSecretHash;
        bytes32 fuelSecretHash;
        address token;
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

    struct Balances {
        uint256[5] usdcResidue;
        uint256[5] aztecResidue;
        uint256 clone;
        uint256 feeJuicePortal;
        uint256 userUsdc;
        uint256 userAztec;
    }

    uint256 internal t;
    uint256 internal relayNonce;

    function setUp() public {
        _setUpEthereum();
        if (bytes(json).length == 0) return;
        t = vm.parseJsonUint(json, ".crossChain.baseUsdc.minReceived");
    }

    /// The fixture's worst shape (private token leg, fuel to the PrivateFPC) through the deadline-free venue.
    function test_worstShape_deliversTokenToTheCloneAndFuelToThePortal() public {
        SameChainQuote memory q = _sameChain("deadlineFree");
        DepositRouter.DepositIntent memory intent = _crossChainIntent("baseUsdc");
        assertEq(intent.fuelSlice, q.fromAmount, "the intent's slice is not the quote's input");

        Balances memory b = _balances();
        (Vm.Log[] memory logs, bytes32 txId) = _fill(t, _routerCall(intent, q.data, t, t));
        Deposited memory d = _assertDelivered(logs, txId, intent, t, intent.fuelSlice);
        _assertSettled(b, t - intent.fuelSlice, d.fuelOut);
    }

    function test_publicTokenAndPublicFuel_deliverToTheAztecRecipient() public {
        SameChainQuote memory q = _sameChain("deadlineFree");
        DepositRouter.DepositIntent memory intent = DepositRouter.DepositIntent({
            token: usdc,
            aztecRecipient: bytes32(uint256(0xa2ec1)),
            tokenSecretHash: bytes32(uint256(0x70ce)),
            isPrivate: false,
            fuelSlice: q.fromAmount,
            fuelRecipient: bytes32(uint256(0xa2ec1)),
            fuelSecretHash: bytes32(uint256(0xf0e1)),
            minFuelOutput: q.toAmountMin
        });

        Balances memory b = _balances();
        (Vm.Log[] memory logs, bytes32 txId) = _fill(t, _routerCall(intent, q.data, t, t));
        Deposited memory d = _assertDelivered(logs, txId, intent, t, intent.fuelSlice);
        _assertSettled(b, t - intent.fuelSlice, d.fuelOut);
    }

    function test_fuelOnly_consumesTheSliceExactly() public {
        SameChainQuote memory q = _sameChain("deadlineFree");
        DepositRouter.DepositIntent memory intent = _fuelOnly(q);
        uint256 slice = intent.fuelSlice;

        Balances memory b = _balances();
        (Vm.Log[] memory logs, bytes32 txId) = _fill(slice, _routerCall(intent, q.data, slice, slice));
        Deposited memory d = _assertDelivered(logs, txId, intent, slice, slice);
        assertEq(d.tokenAmount, 0, "a fuel-only deposit has a token leg");
        _assertSettled(b, 0, d.fuelOut);
    }

    /// The deadline-free venue still delivers after three times the rail's ETA, in time and in blocks.
    function test_deadlineFreeVenue_survivesThreeEtas() public {
        SameChainQuote memory q = _sameChain("deadlineFree");
        _assertDenyList();
        assertTrue(keccak256(bytes(q.tool)) != keccak256(bytes(LIFI_DENIED_EXCHANGE)), "the venue is denied");
        uint256 eta = vm.parseJsonUint(json, ".crossChain.baseUsdc.executionDuration");
        if (eta < ACROSS_FILL_SECONDS) eta = ACROSS_FILL_SECONDS;
        console2.log("deadline-free venue", q.tool, "warped seconds", 3 * eta);

        _warpTo(block.timestamp + 3 * eta);
        DepositRouter.DepositIntent memory intent = _crossChainIntent("baseUsdc");
        Balances memory b = _balances();
        (Vm.Log[] memory logs, bytes32 txId) = _fill(t, _routerCall(intent, q.data, t, t));
        Deposited memory d = _assertDelivered(logs, txId, intent, t, intent.fuelSlice);
        _assertSettled(b, t - intent.fuelSlice, d.fuelOut);
    }

    /// The denied venue's signed order carries an expiry: one second before it the fill delivers, one second after it
    /// the venue reverts and LI.FI hands the user the whole delivery.
    function test_rfqVenue_deliversBeforeItsExpiryAndRecoversAfter() public {
        SameChainQuote memory q = _sameChain("rfq");
        _assertDenyList();
        assertEq(q.tool, LIFI_DENIED_EXCHANGE, "the RFQ fixture is not the denied venue");
        uint256 expiry = _rfqExpiry(q.data);

        DepositRouter.DepositIntent memory intent = _crossChainIntent("baseUsdc");
        intent.minFuelOutput = q.toAmountMin;
        bytes memory call = _routerCall(intent, q.data, t, t);

        uint256 fresh = vm.snapshotState();
        _warpTo(expiry - 1);
        Balances memory b = _balances();
        (Vm.Log[] memory logs, bytes32 txId) = _fill(t, call);
        Deposited memory d = _assertDelivered(logs, txId, intent, t, intent.fuelSlice);
        _assertSettled(b, t - intent.fuelSlice, d.fuelOut);
        assertTrue(vm.revertToState(fresh));

        _warpTo(expiry + 1);
        assertEq(_directRevert(t, call), abi.encodeWithSignature("DeadlineExpired()"), "not the venue's expiry");
        b = _balances();
        (logs, txId) = _fill(t, call);
        _assertRecovered(logs, txId, b, t);
    }

    /// On the caller path a slice the swap does not pull joins the token leg; fuel-only demands exact consumption,
    /// so the same over-sized slice recovers there.
    function test_unpulledSlice_joinsTheTokenLeg_butFuelOnlyRecovers() public {
        SameChainQuote memory q = _sameChain("deadlineFree");
        uint256 extra = 1e6;
        DepositRouter.DepositIntent memory intent = _crossChainIntent("baseUsdc");
        intent.fuelSlice = q.fromAmount + extra;

        Balances memory b = _balances();
        (Vm.Log[] memory logs, bytes32 txId) = _fill(t, _routerCall(intent, q.data, t, t));
        Deposited memory d = _assertDelivered(logs, txId, intent, t, q.fromAmount);
        _assertSettled(b, t - q.fromAmount, d.fuelOut);

        DepositRouter.DepositIntent memory fuelOnly = _fuelOnly(q);
        fuelOnly.fuelSlice = q.fromAmount + extra;
        uint256 amount = fuelOnly.fuelSlice;
        bytes memory call = _routerCall(fuelOnly, q.data, amount, amount);
        assertEq(_directRevert(amount, call), abi.encodeWithSelector(DepositRouter.InexactFuelConsumption.selector));

        b = _balances();
        (logs, txId) = _fill(amount, call);
        _assertRecovered(logs, txId, b, amount);
    }

    /// USDC donated to the Diamond comes back with the facet's leftover return, lands in the router as residue
    /// outside the deposit, and the owner sweeps it.
    function test_donationToTheDiamond_isSweptNotDeposited() public {
        SameChainQuote memory q = _sameChain("deadlineFree");
        DepositRouter.DepositIntent memory intent = _crossChainIntent("baseUsdc");
        uint256 donation = 3e6;
        Balances memory b = _balances();
        address donor = makeAddr("donor");
        deal(usdc, donor, donation);
        vm.prank(donor);
        IERC20(usdc).transfer(diamond, donation);

        (Vm.Log[] memory logs, bytes32 txId) = _fill(t, _routerCall(intent, q.data, t, t));
        Deposited memory d = _assertDelivered(logs, txId, intent, t, intent.fuelSlice);
        assertEq(IERC20(usdc).balanceOf(router), b.usdcResidue[0] + donation, "the donation did not reach the router");
        assertEq(IERC20(usdc).balanceOf(diamond), b.usdcResidue[4], "the Diamond kept the donation");

        address sink = makeAddr("sink");
        vm.prank(routerOwner);
        depositRouter.sweep(usdc, sink);
        assertEq(IERC20(usdc).balanceOf(sink), b.usdcResidue[0] + donation, "the sweep missed the donation");
        _assertSettled(b, t - intent.fuelSlice, d.fuelOut);
    }

    /// At the largest slice the app sends (the fixture's 10 USDC), the fork's AZTEC out stays within 2 % of the
    /// quote and above its minimum.
    function test_priceImpact_atTheLargestSlice_isWithinTwoPercentOfTheQuote() public {
        SameChainQuote memory q = _sameChain("deadlineFree");
        DepositRouter.DepositIntent memory intent = _crossChainIntent("baseUsdc");
        assertEq(q.fromAmount, 10e6, "the fixture's slice is not the largest expected one");

        Balances memory b = _balances();
        (Vm.Log[] memory logs, bytes32 txId) = _fill(t, _routerCall(intent, q.data, t, t));
        Deposited memory d = _assertDelivered(logs, txId, intent, t, intent.fuelSlice);
        _assertSettled(b, t - intent.fuelSlice, d.fuelOut);

        string memory k = ".sameChain.deadlineFree";
        console2.log("quote fromAmountUSD", vm.parseJsonString(json, string.concat(k, ".fromAmountUSD")));
        console2.log("quote toAmountUSD", vm.parseJsonString(json, string.concat(k, ".toAmountUSD")));
        console2.log("quote toAmount", q.toAmount);
        console2.log("fork AZTEC out", d.fuelOut);
        console2.log("fork out / quote, bps", d.fuelOut * 10_000 / q.toAmount);
        assertGe(d.fuelOut, q.toAmountMin, "below the quote's minimum");
        assertApproxEqRel(d.fuelOut, q.toAmount, 0.02e18, "more than 2 % from the quote");
    }

    /// With LI.FI's `_minAmountOut` and the router floor lowered to F, a searcher's buy in the route's AZTEC pool
    /// moves the output between F and the venue's own inner minimum: the venue reverts and the fill recovers.
    function test_innerVenueMinimum_aboveTheRouterFloor_recovers() public {
        SameChainQuote memory q = _sameChain("deadlineFree");
        uint256 floor = q.toAmount / 2;
        DepositRouter.DepositIntent memory intent = _crossChainIntent("baseUsdc");
        intent.minFuelOutput = floor;
        bytes memory swapData = bytes.concat(q.data);
        assertEq(_word(swapData, MIN_AMOUNT_OUT_OFFSET), q.toAmountMin, "offset 132 is not the facet's minimum");
        _setWord(swapData, MIN_AMOUNT_OUT_OFFSET, floor);
        (bytes memory unguarded, uint256 innerMin) = _withoutInnerMinimum(q, floor);
        assertGt(innerMin, floor, "the venue's inner minimum is not above the floor");

        V4PoolKey memory pool = V4PoolKey(address(0), aztec, AZTEC_POOL_FEE, AZTEC_POOL_SPACING, AZTEC_POOL_HOOKS);
        _assertRouteTouches(intent, swapData, keccak256(abi.encode(pool)));
        V4Buyer buyer = new V4Buyer(POOL_MANAGER);
        uint256 ethIn = _priceMoveBetween(buyer, pool, intent, unguarded, innerMin);

        vm.deal(address(buyer), ethIn);
        buyer.buy(pool, ethIn);
        bytes memory call = _routerCall(intent, swapData, t, t);
        bytes memory reason = _directRevert(t, call);
        console2.log("front-run ETH", ethIn);
        console2.log("venue revert");
        console2.logBytes(reason);
        assertTrue(bytes4(reason) != DepositRouter.InsufficientFuel.selector, "the router floor caused the revert");
        assertTrue(bytes4(reason) != CUMULATIVE_SLIPPAGE, "the facet's minimum caused the revert");

        Balances memory b = _balances();
        (Vm.Log[] memory logs, bytes32 txId) = _fill(t, call);
        _assertRecovered(logs, txId, b, t);
    }

    /// The Executor's call into the router, worst shape, known portal: measured × 1.3 fits the quote's limit.
    function test_gas_worstShapeTimesMarginFitsTheQuotedLimit() public {
        SameChainQuote memory q = _sameChain("deadlineFree");
        DepositRouter.DepositIntent memory intent = _crossChainIntent("baseUsdc");
        Balances memory b = _balances();
        _fundExecutor(t);
        // All-cold token state overstates the real call, where the Executor has just touched its balance and
        // allowance: the margin errs high.
        vm.cool(usdc);
        vm.cool(aztec);

        vm.prank(executor);
        uint256 start = gasleft();
        (uint256 tokenAmount, uint256 fuelOut) = depositRouter.bridgeFromCaller(intent, q.data, t, t);
        uint256 used = start - gasleft();
        console2.log("worst-shape router gas", used);
        assertEq(tokenAmount, t - intent.fuelSlice, "tokenAmount");
        _assertSettled(b, tokenAmount, fuelOut);
        uint256 limit = vm.parseJsonUint(json, ".crossChain.baseUsdc.toContractGasLimit");
        assertLe(used * 13 / 10, limit, "the quote's toContractGasLimit is under 1.3x the measured gas");
        assertLe(used * 13 / 10, LIFI_TO_CONTRACT_GAS_LIMIT, "LIFI_TO_CONTRACT_GAS_LIMIT is under 1.3x");
    }

    /// The recorded quote carries the TS constant the builder sends.
    function test_gas_fixtureLimitIsTheTsConstant() public view {
        assertEq(
            vm.parseJsonUint(json, ".crossChain.baseUsdc.toContractGasLimit"),
            LIFI_TO_CONTRACT_GAS_LIMIT,
            "the fixture was not recorded with LIFI_TO_CONTRACT_GAS_LIMIT"
        );
    }

    // ---- delivery ----

    function _fill(uint256 amount, bytes memory routerCall) internal returns (Vm.Log[] memory logs, bytes32 txId) {
        uint256 depositId = ++relayNonce;
        txId = keccak256(abi.encode("LifiDestinationFork", depositId));
        RelayData memory r = RelayData({
            depositor: bytes32(uint256(uint160(user))),
            recipient: bytes32(uint256(uint160(receiverAcrossV4))),
            exclusiveRelayer: bytes32(0),
            inputToken: bytes32(uint256(uint160(vm.parseJsonAddress(json, ".base.usdc")))),
            outputToken: bytes32(uint256(uint160(usdc))),
            inputAmount: amount,
            outputAmount: amount,
            originChainId: vm.parseJsonUint(json, ".base.chainId"),
            depositId: depositId,
            fillDeadline: uint32(block.timestamp + 2 hours),
            exclusivityDeadline: 0,
            message: _lifiMessage(txId, _routerStep(router, usdc, amount, routerCall), user)
        });
        logs = _acrossFill(spokePool, usdc, r);
        assertTrue(_find(logs, spokePool, FILLED_RELAY, bytes32(r.originChainId)) != NOT_FOUND, "no FilledRelay");
    }

    /// Calls the router as the Executor would, holding `amount`, and returns its revert data (failing on success).
    function _directRevert(uint256 amount, bytes memory call) internal returns (bytes memory reason) {
        uint256 snap = vm.snapshotState();
        _fundExecutor(amount);
        vm.prank(executor);
        bool ok;
        (ok, reason) = router.call(call);
        assertFalse(ok, "the direct router call succeeded");
        assertTrue(vm.revertToState(snap));
    }

    function _fundExecutor(uint256 amount) internal {
        deal(usdc, executor, IERC20(usdc).balanceOf(executor) + amount);
        vm.prank(executor);
        IERC20(usdc).approve(router, type(uint256).max);
    }

    function _warpTo(uint256 timestamp) internal {
        uint256 elapsed = timestamp - block.timestamp;
        vm.warp(timestamp);
        vm.roll(block.number + (elapsed + SECONDS_PER_BLOCK - 1) / SECONDS_PER_BLOCK);
    }

    function _fuelOnly(SameChainQuote memory q) internal view returns (DepositRouter.DepositIntent memory i) {
        i = _crossChainIntent("baseUsdc");
        i.tokenSecretHash = bytes32(0);
        i.isPrivate = false;
        i.fuelSlice = q.fromAmount;
        i.minFuelOutput = q.toAmountMin;
    }

    // ---- outcome checks ----

    function _balances() internal view returns (Balances memory b) {
        b.usdcResidue = _residue(usdc);
        b.aztecResidue = _residue(aztec);
        b.clone = IERC20(usdc).balanceOf(usdcPortal);
        b.feeJuicePortal = IERC20(aztec).balanceOf(feeJuicePortal);
        b.userUsdc = IERC20(usdc).balanceOf(user);
        b.userAztec = IERC20(aztec).balanceOf(user);
    }

    function _assertSettled(Balances memory b, uint256 tokenLeg, uint256 fuelOut) internal view {
        assertEq(IERC20(usdc).balanceOf(usdcPortal) - b.clone, tokenLeg, "clone delta");
        assertEq(IERC20(aztec).balanceOf(feeJuicePortal) - b.feeJuicePortal, fuelOut, "FeeJuicePortal delta");
        assertEq(IERC20(usdc).balanceOf(user), b.userUsdc, "the user received USDC");
        assertEq(IERC20(aztec).balanceOf(user), b.userAztec, "the user received AZTEC");
        _assertNoResidue(usdc, b.usdcResidue);
        _assertNoResidue(aztec, b.aztecResidue);
    }

    function _assertRecovered(Vm.Log[] memory logs, bytes32 txId, Balances memory b, uint256 amount) internal view {
        assertTrue(_find(logs, receiverAcrossV4, TRANSFER_RECOVERED, txId) != NOT_FOUND, "no LiFiTransferRecovered");
        assertEq(_find(logs, executor, TRANSFER_COMPLETED, txId), NOT_FOUND, "completed");
        assertEq(_find(logs, router, DepositRouter.Deposited.selector, NONE), NOT_FOUND, "the router deposited");
        assertEq(_find(logs, address(factory.INBOX()), INBOX_MESSAGE_SENT, NONE), NOT_FOUND, "Inbox message");
        assertEq(IERC20(usdc).balanceOf(user) - b.userUsdc, amount, "the user did not get the whole delivery");
        assertEq(IERC20(aztec).balanceOf(user), b.userAztec, "the user received AZTEC");
        assertEq(IERC20(usdc).balanceOf(usdcPortal), b.clone, "clone delta");
        assertEq(IERC20(aztec).balanceOf(feeJuicePortal), b.feeJuicePortal, "FeeJuicePortal delta");
        _assertNoResidue(usdc, b.usdcResidue);
        _assertNoResidue(aztec, b.aztecResidue);
    }

    /// LI.FI completed `txId` after the transport event, and the router's `Deposited` matches the intent, the
    /// portals' events and the Inbox messages field by field.
    function _assertDelivered(
        Vm.Log[] memory logs,
        bytes32 txId,
        DepositRouter.DepositIntent memory intent,
        uint256 received,
        uint256 fuelIn
    ) internal view returns (Deposited memory d) {
        uint256 completed = _find(logs, executor, TRANSFER_COMPLETED, txId);
        assertTrue(completed != NOT_FOUND, "no LiFiTransferCompleted");
        assertTrue(_find(logs, spokePool, FILLED_RELAY, NONE) < completed, "the message ran before FilledRelay");
        assertEq(_find(logs, receiverAcrossV4, TRANSFER_RECOVERED, txId), NOT_FOUND, "recovered");

        d = _deposited(logs);
        assertEq(d.tokenSecretHash, intent.tokenSecretHash, "tokenSecretHash");
        assertEq(d.fuelSecretHash, intent.fuelSecretHash, "fuelSecretHash");
        assertEq(d.token, intent.token, "token");
        assertEq(d.payer, executor, "payer");
        assertEq(d.received, received, "received");
        assertEq(d.fuelIn, fuelIn, "fuelIn");
        assertEq(d.tokenAmount, received - fuelIn, "tokenAmount");
        assertGe(d.fuelOut, intent.minFuelOutput, "fuelOut under the floor");
        assertEq(d.isPrivate, intent.isPrivate, "isPrivate");

        Vm.Log memory fj = logs[_findOrFail(logs, feeJuicePortal, TokenPortalImpl.DepositToAztecPublic.selector)];
        (uint256 fjAmount, bytes32 fjSecret, bytes32 fjKey, uint256 fjIndex) =
            abi.decode(fj.data, (uint256, bytes32, bytes32, uint256));
        assertEq(fj.topics[1], intent.fuelRecipient, "fuel recipient");
        assertEq(fjAmount, d.fuelOut, "fuel amount");
        assertEq(fjSecret, intent.fuelSecretHash, "fuel secret hash");
        assertEq(fjKey, d.fuelKey, "fuelKey");
        assertEq(fjIndex, d.fuelIndex, "fuelIndex");
        assertTrue(_inboxHas(logs, d.fuelKey), "no Inbox fuel message");

        if (intent.tokenSecretHash == bytes32(0)) {
            assertEq(d.tokenKey, bytes32(0), "tokenKey without a token leg");
            assertEq(d.tokenIndex, 0, "tokenIndex without a token leg");
            assertEq(_find(logs, usdcPortal, TokenPortalImpl.DepositToAztecPublic.selector, NONE), NOT_FOUND);
            assertEq(_find(logs, usdcPortal, TokenPortalImpl.DepositToAztecPrivate.selector, NONE), NOT_FOUND);
            return d;
        }
        (uint256 amount, bytes32 secret, bytes32 key, uint256 index) = _cloneDeposit(logs, intent);
        assertEq(amount, d.tokenAmount, "clone amount");
        assertEq(secret, intent.tokenSecretHash, "clone secret hash");
        assertEq(key, d.tokenKey, "tokenKey");
        assertEq(index, d.tokenIndex, "tokenIndex");
        assertTrue(_inboxHas(logs, d.tokenKey), "no Inbox token message");
    }

    function _cloneDeposit(Vm.Log[] memory logs, DepositRouter.DepositIntent memory intent)
        internal
        view
        returns (uint256 amount, bytes32 secret, bytes32 key, uint256 index)
    {
        if (intent.isPrivate) {
            Vm.Log memory l = logs[_findOrFail(logs, usdcPortal, TokenPortalImpl.DepositToAztecPrivate.selector)];
            return abi.decode(l.data, (uint256, bytes32, bytes32, uint256));
        }
        Vm.Log memory p = logs[_findOrFail(logs, usdcPortal, TokenPortalImpl.DepositToAztecPublic.selector)];
        bytes32 to;
        (to, amount, secret, key, index) = abi.decode(p.data, (bytes32, uint256, bytes32, bytes32, uint256));
        assertEq(to, intent.aztecRecipient, "token recipient");
    }

    function _deposited(Vm.Log[] memory logs) internal view returns (Deposited memory d) {
        Vm.Log memory l = logs[_findOrFail(logs, router, DepositRouter.Deposited.selector)];
        d.tokenSecretHash = l.topics[1];
        d.fuelSecretHash = l.topics[2];
        d.token = address(uint160(uint256(l.topics[3])));
        (
            d.payer,
            d.received,
            d.tokenAmount,
            d.tokenKey,
            d.tokenIndex,
            d.fuelIn,
            d.fuelOut,
            d.fuelKey,
            d.fuelIndex,
            d.isPrivate
        ) = abi.decode(l.data, (address, uint256, uint256, bytes32, uint256, uint256, uint256, bytes32, uint256, bool));
    }

    function _inboxHas(Vm.Log[] memory logs, bytes32 key) internal view returns (bool) {
        address inbox = address(factory.INBOX());
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter == inbox && l.topics.length == 3 && l.topics[0] == INBOX_MESSAGE_SENT && l.topics[2] == key) {
                return true;
            }
        }
        return false;
    }

    function _findOrFail(Vm.Log[] memory logs, address emitter, bytes32 topic0) internal pure returns (uint256 i) {
        i = _find(logs, emitter, topic0, NONE);
        assertTrue(i != NOT_FOUND, "an expected event is missing");
    }

    function _assertDenyList() internal view {
        string[] memory recorded = vm.parseJsonStringArray(json, ".expiringRfqExchanges");
        assertEq(recorded.length, 1, "the fixture's expiring venues are not LIFI_DENY_EXCHANGES");
        assertEq(recorded[0], LIFI_DENIED_EXCHANGE, "the fixture's expiring venues are not LIFI_DENY_EXCHANGES");
    }

    // ---- calldata ----

    /// The facet call's swaps; the recorded quotes all use the multiple-swap selector.
    function _swaps(bytes memory data)
        internal
        pure
        returns (bytes32 id, string memory integrator, string memory referrer, ILiFiSwap.SwapData[] memory swaps)
    {
        assertEq(
            bytes32(bytes4(data)),
            bytes32(ILiFiSwap.swapTokensMultipleV3ERC20ToERC20.selector),
            "not the multiple-swap entry"
        );
        bytes memory args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; i++) {
            args[i] = data[i + 4];
        }
        (id, integrator, referrer,,, swaps) =
            abi.decode(args, (bytes32, string, string, address, uint256, ILiFiSwap.SwapData[]));
    }

    /// The one ABI word of the venue's call that reads as a timestamp in (fixture time, fixture time + 1 day].
    function _rfqExpiry(bytes memory data) internal view returns (uint256 expiry) {
        (,,, ILiFiSwap.SwapData[] memory swaps) = _swaps(data);
        bytes memory venue = swaps[swaps.length - 1].callData;
        uint256 recorded = vm.parseJsonUint(json, ".ethereum.timestamp");
        uint256 hits;
        for (uint256 j; 4 + 32 * (j + 1) <= venue.length; j++) {
            uint256 w = _word(venue, 4 + 32 * j);
            if (w > recorded && w <= recorded + 1 days) {
                (expiry, hits) = (w, hits + 1);
                console2.log("RFQ expiry: venue call word", j, "value", w);
                console2.log("seconds after the fixture block", w - recorded);
            }
        }
        assertEq(hits, 1, "the RFQ venue call does not carry exactly one expiry-shaped word");
    }

    /// The recorded swap with the venue's own minimum (a big-endian uint128 in its call, between the quote's minimum
    /// and its amount) and LI.FI's `_minAmountOut` both lowered to `floor`.
    function _withoutInnerMinimum(SameChainQuote memory q, uint256 floor)
        internal
        view
        returns (bytes memory data, uint256 innerMin)
    {
        (bytes32 id, string memory integrator, string memory referrer, ILiFiSwap.SwapData[] memory swaps) =
            _swaps(q.data);
        bytes memory venue = swaps[swaps.length - 1].callData;
        uint256 at;
        uint256 hits;
        for (uint256 o; o + 16 <= venue.length; o++) {
            uint256 v = _word(venue, o) >> 128;
            if (v >= q.toAmountMin && v <= q.toAmount) (at, innerMin, hits) = (o, v, hits + 1);
        }
        assertEq(hits, 1, "the venue call does not carry exactly one inner minimum");
        console2.log("venue inner minimum", innerMin, "at venue byte", at);
        for (uint256 k; k < 16; k++) {
            venue[at + k] = bytes1(uint8(floor >> (8 * (15 - k))));
        }
        data = abi.encodeWithSelector(bytes4(q.data), id, integrator, referrer, router, floor, swaps);
    }

    function _word(bytes memory b, uint256 at) internal pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(b, 32), at))
        }
    }

    function _setWord(bytes memory b, uint256 at, uint256 w) internal pure {
        assembly ("memory-safe") {
            mstore(add(add(b, 32), at), w)
        }
    }

    // ---- price move ----

    /// The recorded route swaps through the given V4 pool (the router call runs on a reverted snapshot).
    function _assertRouteTouches(DepositRouter.DepositIntent memory intent, bytes memory swapData, bytes32 poolId)
        internal
    {
        uint256 snap = vm.snapshotState();
        _fundExecutor(t);
        vm.recordLogs();
        vm.prank(executor);
        depositRouter.bridgeFromCaller(intent, swapData, t, t);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == POOL_MANAGER && logs[i].topics[0] == V4_SWAP) {
                console2.log("route swaps in V4 pool", vm.toString(logs[i].topics[1]));
            }
        }
        assertTrue(_find(logs, POOL_MANAGER, V4_SWAP, poolId) != NOT_FOUND, "the route does not use the AZTEC pool");
        assertTrue(vm.revertToState(snap));
    }

    /// The smallest power-of-two ETH buy of AZTEC after which the unguarded route delivers less than the venue's inner
    /// minimum, while still at least the router floor; each probe runs on a reverted snapshot.
    function _priceMoveBetween(
        V4Buyer buyer,
        V4PoolKey memory pool,
        DepositRouter.DepositIntent memory intent,
        bytes memory unguarded,
        uint256 innerMin
    ) internal returns (uint256 ethIn) {
        for (ethIn = 1 ether; ethIn <= 4096 ether; ethIn *= 2) {
            uint256 snap = vm.snapshotState();
            vm.deal(address(buyer), ethIn);
            buyer.buy(pool, ethIn);
            _fundExecutor(t);
            vm.prank(executor);
            (, uint256 fuelOut) = depositRouter.bridgeFromCaller(intent, unguarded, t, t);
            assertTrue(vm.revertToState(snap));
            if (fuelOut < innerMin) {
                console2.log("moved fuel out", fuelOut, "inner minimum", innerMin);
                assertGe(fuelOut, intent.minFuelOutput, "the move overshot the router floor");
                return ethIn;
            }
        }
        revert("no buy up to 4096 ETH moved the price below the venue's minimum");
    }
}
