// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {DepositRouter} from "../src/DepositRouter.sol";
import {ILiFiSwap} from "../src/interfaces/ILiFiSwap.sol";
import {DepositRouterFixture} from "./mocks/DepositRouterFixture.sol";
import {MockFeeJuicePortal} from "./mocks/RouterMocks.sol";

contract DepositRouterTest is DepositRouterFixture {
    uint256 internal constant AMOUNT = 1000e6;
    uint256 internal constant SLICE = 100e6;
    uint256 internal constant FLOOR = 4 ether;
    uint256 internal constant FJ_OUT = 5 ether;
    uint256 internal constant FUNDS = 10_000e6;
    /// Holds nothing and approves nothing: any pull it reaches ends in `BelowMinimum`.
    address internal constant PAUPER = address(0xDEAD);

    function setUp() public {
        _deployStack();
        _fundForPermit(usdc, user, FUNDS);
        vm.prank(user);
        usdc.approve(address(router), type(uint256).max);
        swap.set(type(uint256).max, FJ_OUT);
    }

    // ── helpers ─────────────────────────────────────────────────────────────────────────────

    /// Both entrypoints refuse with `err` while every pull is booby-trapped (Permit2 rejects, the caller holds
    /// nothing), so `err` can only come from a check that runs before anything moves.
    function _refusedBeforePull(DepositRouter.DepositIntent memory intent, bytes memory swapData, bytes4 err) internal {
        permit2.setRevert(true);
        vm.expectRevert(err);
        router.bridgeWithPermit(intent, swapData, AMOUNT, _permit(1));
        permit2.setRevert(false);
        vm.prank(PAUPER);
        vm.expectRevert(err);
        router.bridgeFromCaller(intent, swapData, AMOUNT, AMOUNT);
    }

    function _assertNoStandingApproval(address token) internal view {
        assertEq(IERC20(token).allowance(address(router), address(swap)), 0, "router -> swap target");
        assertEq(IERC20(token).allowance(address(router), portalFor(token)), 0, "router -> clone");
        assertEq(fj.allowance(address(router), address(feePortal)), 0, "router -> FeeJuicePortal");
    }

    function _assertRouterEmpty() internal view {
        assertEq(usdc.balanceOf(address(router)), 0, "usdc residue");
        assertEq(fj.balanceOf(address(router)), 0, "fee-asset residue");
    }

    function _truncate(bytes memory b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 k; k < n; ++k) {
            out[k] = b[k];
        }
    }

    function _word(bytes memory b, uint256 offset) internal pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(b, 0x20), offset))
        }
    }

    function _withSelector(bytes memory b, bytes4 selector) internal pure returns (bytes memory) {
        for (uint256 k; k < 4; ++k) {
            b[k] = selector[k];
        }
        return b;
    }

    // ── Shape rules: every one refused before any pull ───────────────────────────────────────

    function test_shape_fuelOnlyCarryingTokenFields_refused() public {
        DepositRouter.DepositIntent memory i = _fuelOnlyIntent(address(usdc), SLICE, FLOOR);
        i.aztecRecipient = RECIPIENT;
        _refusedBeforePull(i, _swapData(address(usdc), SLICE, 0), DepositRouter.FuelOnlyShape.selector);

        DepositRouter.DepositIntent memory nothing = _plainIntent(address(usdc), true);
        nothing.tokenSecretHash = bytes32(0);
        _refusedBeforePull(nothing, "", DepositRouter.FuelOnlyShape.selector);
    }

    function test_shape_privateWithRecipient_refused() public {
        DepositRouter.DepositIntent memory i = _plainIntent(address(usdc), true);
        i.aztecRecipient = RECIPIENT;
        _refusedBeforePull(i, "", DepositRouter.PrivateWithRecipient.selector);
    }

    function test_shape_fuelFieldsWithoutSlice_refused() public {
        bytes4 err = DepositRouter.FuelFieldsWithoutSlice.selector;
        DepositRouter.DepositIntent memory i = _plainIntent(address(usdc), false);
        _refusedBeforePull(i, _swapData(address(usdc), SLICE, 0), err);
        i.fuelRecipient = FUEL_RECIPIENT;
        _refusedBeforePull(i, "", err);
        i = _plainIntent(address(usdc), false);
        i.fuelSecretHash = FUEL_SECRET;
        _refusedBeforePull(i, "", err);
        i = _plainIntent(address(usdc), false);
        i.minFuelOutput = 1;
        _refusedBeforePull(i, "", err);
    }

    function test_shape_identityWithSwapData_refused() public {
        _refusedBeforePull(
            _fuelIntent(address(fj), 4 ether, 0, false),
            _swapData(address(fj), 4 ether, 0),
            DepositRouter.IdentityWithSwapData.selector
        );
    }

    /// 164 bytes is exactly the head through `_minAmountOut`: one byte less is refused, 164 passes the shape and
    /// reaches the (booby-trapped) pull.
    function test_shape_swapDataTooShort_refusedBelow164() public {
        DepositRouter.DepositIntent memory i = _fuelIntent(address(usdc), SLICE, FLOOR, false);
        bytes memory full = _swapData(address(usdc), SLICE, 0);
        _refusedBeforePull(i, "", DepositRouter.SwapDataTooShort.selector);
        _refusedBeforePull(i, _truncate(full, 163), DepositRouter.SwapDataTooShort.selector);

        permit2.setRevert(true);
        vm.expectRevert(bytes("MockPermit2: bad signature"));
        router.bridgeWithPermit(i, _truncate(full, 164), AMOUNT, _permit(1));
    }

    function test_shape_unpinnedSelector_refused() public {
        DepositRouter.DepositIntent memory i = _fuelIntent(address(usdc), SLICE, FLOOR, false);
        bytes4[3] memory foreign = [IERC20.transfer.selector, IERC20.approve.selector, bytes4(0x4666fc81)];
        for (uint256 k; k < foreign.length; ++k) {
            _refusedBeforePull(
                i,
                _withSelector(_swapData(address(usdc), SLICE, 0), foreign[k]),
                DepositRouter.UnpinnedSelector.selector
            );
        }
    }

    function test_shape_foreignReceiver_refusedIncludingDirtyUpperBits() public {
        DepositRouter.DepositIntent memory i = _fuelIntent(address(usdc), SLICE, FLOOR, false);
        bytes memory elsewhere = abi.encodeCall(
            ILiFiSwap.swapTokensSingleV3ERC20ToERC20,
            (TX_ID, "unleashed", "", payable(address(0xA77AC4)), 0, _swapStep(address(usdc), SLICE))
        );
        _refusedBeforePull(i, elsewhere, DepositRouter.ForeignReceiver.selector);

        // The low 20 bytes still name the router; only the word's top byte is dirty.
        bytes memory dirty = _swapData(address(usdc), SLICE, 0);
        dirty[100] = 0x01;
        _refusedBeforePull(i, dirty, DepositRouter.ForeignReceiver.selector);
    }

    function test_shape_zeroFuelFloorWithSwap_refused() public {
        _refusedBeforePull(
            _fuelIntent(address(usdc), SLICE, 0, false),
            _swapData(address(usdc), SLICE, 0),
            DepositRouter.ZeroFuelFloor.selector
        );
    }

    function test_pause_blocksEveryLegIncludingFuelOnly() public {
        vm.prank(guardian);
        factory.setPaused(true, false);
        bytes4 err = DepositRouter.DepositsPaused.selector;
        bytes memory sd = _swapData(address(usdc), SLICE, 0);
        _refusedBeforePull(_plainIntent(address(usdc), false), "", err);
        _refusedBeforePull(_fuelIntent(address(usdc), SLICE, FLOOR, true), sd, err);
        _refusedBeforePull(_fuelIntent(address(fj), 4 ether, 0, false), "", err);
        _refusedBeforePull(_fuelOnlyIntent(address(usdc), SLICE, FLOOR), sd, err);
        _refusedBeforePull(_fuelOnlyIntent(address(fj), 4 ether, 0), "", err);
    }

    // ── Selector and offset pins ────────────────────────────────────────────────────────────

    /// The router reads `_receiver` at byte 100 and requires 164 bytes; Solidity's own encoder must agree for both
    /// pinned functions whatever the dynamic strings hold.
    function test_pin_receiverAtOffset100InBothSelectors() public view {
        assertEq(ILiFiSwap.swapTokensSingleV3ERC20ToERC20.selector, bytes4(0x4666fc80), "single selector");
        assertEq(ILiFiSwap.swapTokensMultipleV3ERC20ToERC20.selector, bytes4(0x5fd9ae2e), "multiple selector");

        address receiver = address(0xC0FFEE);
        ILiFiSwap.SwapData[] memory steps = new ILiFiSwap.SwapData[](2);
        steps[0] = _swapStep(address(usdc), SLICE);
        steps[1] = _swapStep(address(usdc), SLICE);
        string memory longIntegrator = "an integrator string long enough to span more than one abi word";
        bytes memory single = abi.encodeCall(
            ILiFiSwap.swapTokensSingleV3ERC20ToERC20,
            (TX_ID, longIntegrator, "ref", payable(receiver), 7, _swapStep(address(usdc), SLICE))
        );
        bytes memory multiple = abi.encodeCall(
            ILiFiSwap.swapTokensMultipleV3ERC20ToERC20, (TX_ID, "", longIntegrator, payable(receiver), 7, steps)
        );
        bytes32 expected = bytes32(uint256(uint160(receiver)));
        assertEq(_word(single, 100), expected, "single: _receiver at 100");
        assertEq(_word(multiple, 100), expected, "multiple: _receiver at 100");
        assertEq(uint256(_word(single, 132)), 7, "single: _minAmountOut ends the 164-byte head");
        assertEq(uint256(_word(multiple, 132)), 7, "multiple: _minAmountOut ends the 164-byte head");
    }

    function test_pin_bothSelectorsAccepted() public {
        DepositRouter.DepositIntent memory i = _fuelIntent(address(usdc), SLICE, FLOOR, false);
        vm.startPrank(user);
        router.bridgeFromCaller(i, _swapData(address(usdc), SLICE, FLOOR), AMOUNT, AMOUNT);
        router.bridgeWithPermit(i, _swapDataMultiple(address(usdc), SLICE, FLOOR, true), AMOUNT, _permit(1));
        vm.stopPrank();
        assertEq(swap.calls(), 2);
        assertEq(feePortal.calls(), 2);
        assertEq(portalBalance(address(usdc)), 2 * (AMOUNT - SLICE));
    }

    // ── Token legs into the real derived clone ──────────────────────────────────────────────

    function test_permit_publicTokenLeg_intoDerivedClone() public {
        DepositRouter.DepositIntent memory i = _plainIntent(address(usdc), false);
        vm.prank(user);
        (uint256 tokenAmount, uint256 fuelOut) = router.bridgeWithPermit(i, "", AMOUNT, _permit(1));

        assertEq(tokenAmount, AMOUNT);
        assertEq(fuelOut, 0);
        assertEq(factory.portalOf(address(usdc)), portalFor(address(usdc)), "created on first use");
        assertEq(portalBalance(address(usdc)), AMOUNT);
        assertTrue(lastMintWasPublic(RECIPIENT, AMOUNT), "public mint content");
        assertEq(inbox.lastSecretHash(), SECRET);
        assertEq(permit2.lastOwner(), user, "the Permit2 owner is msg.sender");
        assertEq(permit2.lastAmount(), AMOUNT);
        assertEq(permit2.lastWitness(), router.hashWitness(i, ""), "the witness Permit2 verifies");
        assertEq(feePortal.calls(), 0);
        _assertRouterEmpty();
        _assertNoStandingApproval(address(usdc));
    }

    function test_fromCaller_privateTokenLeg_intoDerivedClone() public {
        vm.prank(user);
        (uint256 tokenAmount,) = router.bridgeFromCaller(_plainIntent(address(usdc), true), "", AMOUNT, AMOUNT);

        assertEq(tokenAmount, AMOUNT);
        assertEq(portalBalance(address(usdc)), AMOUNT);
        assertTrue(lastMintWasPrivate(AMOUNT), "private mint content");
        assertEq(usdc.balanceOf(user), FUNDS - AMOUNT);
        _assertRouterEmpty();
        _assertNoStandingApproval(address(usdc));
    }

    function test_permit_privateTokenAndFuel() public {
        DepositRouter.DepositIntent memory i = _fuelIntent(address(usdc), SLICE, FLOOR, true);
        vm.prank(user);
        (uint256 tokenAmount, uint256 fuelOut) =
            router.bridgeWithPermit(i, _swapData(address(usdc), SLICE, FLOOR), AMOUNT, _permit(1));

        assertEq(tokenAmount, AMOUNT - SLICE);
        assertEq(fuelOut, FJ_OUT);
        assertEq(portalBalance(address(usdc)), AMOUNT - SLICE);
        assertTrue(lastMintWasPrivate(AMOUNT - SLICE));
        assertEq(feePortal.lastAmount(), FJ_OUT);
        assertEq(feePortal.lastTo(), FUEL_RECIPIENT);
        assertEq(usdc.balanceOf(swap.SINK()), SLICE, "exactly the slice was spent");
        _assertRouterEmpty();
        _assertNoStandingApproval(address(usdc));
    }

    // ── Identity leg (the token is the fee asset) ───────────────────────────────────────────

    function test_identity_sliceToFeeJuicePortal_remainderToOwnClone() public {
        _fundForPermit(fj, user, 30 ether);
        vm.prank(user);
        fj.approve(address(router), type(uint256).max);

        vm.prank(user);
        router.bridgeWithPermit(_fuelIntent(address(fj), 4 ether, 4 ether, false), "", 10 ether, _permit(1));
        assertEq(fj.balanceOf(address(feePortal)), 4 ether, "only the slice reaches the FeeJuicePortal");
        assertEq(portalBalance(address(fj)), 6 ether, "the remainder goes to the fee asset's own clone");
        assertTrue(lastMintWasPublic(RECIPIENT, 6 ether));

        vm.prank(user);
        router.bridgeFromCaller(_fuelIntent(address(fj), 3 ether, 0, true), "", 10 ether, 10 ether);
        assertEq(fj.balanceOf(address(feePortal)), 7 ether);
        assertEq(portalBalance(address(fj)), 13 ether);
        assertTrue(lastMintWasPrivate(7 ether));

        assertEq(feePortal.calls(), 2);
        assertEq(swap.calls(), 0, "the identity leg never swaps");
        assertEq(fj.balanceOf(address(router)), 0);
        _assertNoStandingApproval(address(fj));
    }

    function test_identity_fuelOnly_noClone() public {
        _fundForPermit(fj, user, 10 ether);
        vm.prank(user);
        router.bridgeWithPermit(_fuelOnlyIntent(address(fj), 10 ether, 0), "", 10 ether, _permit(1));
        assertEq(fj.balanceOf(address(feePortal)), 10 ether);
        assertEq(factory.portalOf(address(fj)), address(0), "fuel-only creates no clone");
    }

    // ── Fuel-only ───────────────────────────────────────────────────────────────────────────

    function test_fuelOnly_bothEntrypoints_noTokenLeg() public {
        DepositRouter.DepositIntent memory i = _fuelOnlyIntent(address(usdc), SLICE, FLOOR);
        bytes memory sd = _swapData(address(usdc), SLICE, FLOOR);
        vm.startPrank(user);
        (uint256 tokenA, uint256 fuelA) = router.bridgeWithPermit(i, sd, SLICE, _permit(1));
        (uint256 tokenB, uint256 fuelB) = router.bridgeFromCaller(i, sd, SLICE, SLICE);
        vm.stopPrank();

        assertEq(tokenA + tokenB, 0, "no token leg");
        assertEq(fuelA + fuelB, 2 * FJ_OUT);
        assertEq(fj.balanceOf(address(feePortal)), 2 * FJ_OUT);
        assertEq(usdc.balanceOf(user), FUNDS - 2 * SLICE, "exactly the slice, twice");
        assertEq(factory.portalOf(address(usdc)), address(0), "no clone created");
        assertEq(inbox.sent(), 0, "no L2 message besides the fuel");
        _assertRouterEmpty();
    }

    function test_fuelOnly_sliceMustEqualEveryBound() public {
        DepositRouter.DepositIntent memory i = _fuelOnlyIntent(address(usdc), SLICE, FLOOR);
        bytes memory sd = _swapData(address(usdc), SLICE, FLOOR);
        bytes4 err = DepositRouter.SliceOutOfBounds.selector;
        vm.startPrank(user);
        vm.expectRevert(err);
        router.bridgeWithPermit(i, sd, SLICE + 1, _permit(1));
        vm.expectRevert(err);
        router.bridgeFromCaller(i, sd, SLICE, SLICE + 1);
        vm.expectRevert(err);
        router.bridgeFromCaller(i, sd, SLICE - 1, SLICE);
        vm.stopPrank();
    }

    // ── Consumption: leftover joins the token leg on the caller path, exact elsewhere ───────

    function test_fromCaller_unspentSliceJoinsTokenLeg() public {
        swap.set(60e6, FJ_OUT);
        vm.prank(user);
        (uint256 tokenAmount,) = router.bridgeFromCaller(
            _fuelIntent(address(usdc), SLICE, FLOOR, false), _swapData(address(usdc), SLICE, FLOOR), AMOUNT, AMOUNT
        );
        assertEq(tokenAmount, AMOUNT - 60e6);
        assertEq(portalBalance(address(usdc)), AMOUNT - 60e6);
        assertTrue(lastMintWasPublic(RECIPIENT, AMOUNT - 60e6));
        _assertRouterEmpty();
    }

    function test_fromCaller_unpulledSliceJoinsTokenLeg_approvalRevoked() public {
        swap.setHostile(address(0), 70e6, true);
        vm.prank(user);
        (uint256 tokenAmount,) = router.bridgeFromCaller(
            _fuelIntent(address(usdc), SLICE, FLOOR, false), _swapData(address(usdc), SLICE, FLOOR), AMOUNT, AMOUNT
        );
        assertEq(tokenAmount, AMOUNT - 70e6);
        assertEq(portalBalance(address(usdc)), AMOUNT - 70e6);
        _assertRouterEmpty();
        _assertNoStandingApproval(address(usdc));
    }

    function test_exactConsumption_requiredOnPermitAndFuelOnly() public {
        DepositRouter.DepositIntent memory withToken = _fuelIntent(address(usdc), SLICE, FLOOR, false);
        DepositRouter.DepositIntent memory fuelOnly = _fuelOnlyIntent(address(usdc), SLICE, FLOOR);
        bytes memory sd = _swapData(address(usdc), SLICE, FLOOR);
        bytes4 err = DepositRouter.InexactFuelConsumption.selector;

        swap.set(60e6, FJ_OUT); // spends part of what it pulled
        vm.startPrank(user);
        vm.expectRevert(err);
        router.bridgeWithPermit(withToken, sd, AMOUNT, _permit(1));
        vm.expectRevert(err);
        router.bridgeWithPermit(fuelOnly, sd, SLICE, _permit(2));
        vm.expectRevert(err);
        router.bridgeFromCaller(fuelOnly, sd, SLICE, SLICE);
        vm.stopPrank();

        swap.set(type(uint256).max, FJ_OUT);
        swap.setHostile(address(0), 70e6, true); // pulls part of the slice
        vm.startPrank(user);
        vm.expectRevert(err);
        router.bridgeWithPermit(withToken, sd, AMOUNT, _permit(3));
        vm.expectRevert(err);
        router.bridgeFromCaller(fuelOnly, sd, SLICE, SLICE);
        vm.stopPrank();
    }

    /// The facet keeps a one-unit balance as dust, so one unspent unit of the slice counts as consumed on either path
    /// and stays at the target.
    function test_oneUnspentUnit_isConsumedDustAtTheTarget() public {
        DepositRouter.DepositIntent memory i = _fuelIntent(address(usdc), SLICE, FLOOR, false);
        bytes memory sd = _swapData(address(usdc), SLICE, FLOOR);
        swap.set(SLICE - 1, FJ_OUT);
        uint256 snapshot = vm.snapshotState();

        vm.prank(user);
        (uint256 tokenAmount,) = router.bridgeFromCaller(i, sd, AMOUNT, AMOUNT);
        assertEq(tokenAmount, AMOUNT - SLICE, "the caller path credited the dust unit to the token leg");
        assertEq(usdc.balanceOf(address(swap)), 1, "dust at the target");

        vm.revertToState(snapshot);
        vm.prank(user);
        router.bridgeWithPermit(i, sd, AMOUNT, _permit(1));
        assertEq(portalBalance(address(usdc)), AMOUNT - SLICE, "the exact path refused one unit of dust");
        assertEq(usdc.balanceOf(address(swap)), 1, "dust at the target");
        _assertRouterEmpty();
    }

    // ── Donations stay residue ──────────────────────────────────────────────────────────────

    function test_donations_toRouterAndSwapTarget_stayResidue() public {
        usdc.mint(address(router), 500e6);
        fj.mint(address(router), 3 ether);
        usdc.mint(address(swap), 7e6); // the facet forwards its whole balance, so this comes back to the router
        DepositRouter.DepositIntent memory i = _fuelIntent(address(usdc), SLICE, FLOOR, false);
        bytes memory sd = _swapData(address(usdc), SLICE, FLOOR);

        vm.prank(user);
        router.bridgeFromCaller(i, sd, AMOUNT, AMOUNT);
        assertEq(portalBalance(address(usdc)), AMOUNT - SLICE, "the token leg is the caller's funds only");
        assertEq(fj.balanceOf(address(feePortal)), FJ_OUT, "the fuel leg is the swap's delta only");
        assertEq(usdc.balanceOf(address(router)), 507e6, "donation + target stray");
        assertEq(fj.balanceOf(address(router)), 3 ether);

        usdc.mint(address(swap), 2e6);
        vm.prank(user);
        router.bridgeWithPermit(i, sd, AMOUNT, _permit(1));
        assertEq(portalBalance(address(usdc)), 2 * (AMOUNT - SLICE), "exact path unaffected by the stray");
        assertEq(usdc.balanceOf(address(router)), 509e6);
        assertEq(fj.balanceOf(address(router)), 3 ether);
    }

    function test_sweep_ownerOnly_ownable2Step() public {
        usdc.mint(address(router), 5e6);
        address next = address(0x2E57);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.sweep(address(usdc), user);

        vm.prank(owner);
        router.transferOwnership(next);
        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, next));
        router.sweep(address(usdc), next);

        vm.prank(next);
        router.acceptOwnership();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        router.sweep(address(usdc), owner);
        vm.prank(next);
        vm.expectRevert(DepositRouter.ZeroAddress.selector);
        router.sweep(address(usdc), address(0));

        vm.prank(next);
        router.sweep(address(usdc), next);
        assertEq(usdc.balanceOf(next), 5e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    // ── Event ───────────────────────────────────────────────────────────────────────────────

    /// `fuelIn` is the slice actually consumed, not the signed slice.
    function test_depositedEvent_fields() public {
        factory.createPortal(address(usdc)); // the register message takes Inbox index 0
        swap.set(60e6, FJ_OUT);
        uint256 tokenAmount = AMOUNT - 60e6;
        bytes32 tokenKey = keccak256(
            abi.encode(
                _model(abi.encodeWithSignature("mint_to_public(bytes32,uint256)", RECIPIENT, tokenAmount)), SECRET
            )
        );

        vm.expectEmit(address(router));
        emit DepositRouter.Deposited(
            SECRET,
            FUEL_SECRET,
            address(usdc),
            user,
            AMOUNT,
            tokenAmount,
            tokenKey,
            1,
            60e6,
            FJ_OUT,
            bytes32(uint256(0xFEE)),
            0,
            false
        );
        vm.prank(user);
        router.bridgeFromCaller(
            _fuelIntent(address(usdc), SLICE, FLOOR, false), _swapData(address(usdc), SLICE, FLOOR), AMOUNT, AMOUNT
        );
    }

    // ── bridgeFromCaller bounds and floors ──────────────────────────────────────────────────

    function test_fromCaller_bounds() public {
        DepositRouter.DepositIntent memory plain = _plainIntent(address(usdc), false);
        DepositRouter.DepositIntent memory fueled = _fuelIntent(address(usdc), SLICE, FLOOR, false);
        bytes memory sd = _swapData(address(usdc), SLICE, FLOOR);

        vm.startPrank(user);
        vm.expectRevert(DepositRouter.BadBounds.selector);
        router.bridgeFromCaller(plain, "", 0, AMOUNT);
        vm.expectRevert(DepositRouter.BadBounds.selector);
        router.bridgeFromCaller(plain, "", AMOUNT + 1, AMOUNT);
        vm.expectRevert(DepositRouter.SliceOutOfBounds.selector);
        router.bridgeFromCaller(fueled, sd, SLICE, AMOUNT);
        vm.expectRevert(DepositRouter.SliceOutOfBounds.selector);
        router.bridgeWithPermit(fueled, sd, SLICE, _permit(1));
        vm.expectRevert(DepositRouter.BelowMinimum.selector);
        router.bridgeFromCaller(plain, "", FUNDS + 1, FUNDS + 1);
        usdc.approve(address(router), AMOUNT - 1);
        vm.expectRevert(DepositRouter.BelowMinimum.selector);
        router.bridgeFromCaller(plain, "", AMOUNT, AMOUNT);
        vm.stopPrank();
    }

    function test_fromCaller_pullsMinOfBalanceAllowanceAndMaxPull() public {
        DepositRouter.DepositIntent memory plain = _plainIntent(address(usdc), false);
        vm.startPrank(user);
        (uint256 a,) = router.bridgeFromCaller(plain, "", 1, AMOUNT); // maxPull binds
        usdc.approve(address(router), 300e6);
        (uint256 b,) = router.bridgeFromCaller(plain, "", 1, AMOUNT); // allowance binds
        usdc.approve(address(router), type(uint256).max);
        usdc.transfer(address(0xB1AC), usdc.balanceOf(user) - 200e6);
        (uint256 c,) = router.bridgeFromCaller(plain, "", 1, AMOUNT); // balance binds
        vm.stopPrank();
        assertEq(a, AMOUNT);
        assertEq(b, 300e6);
        assertEq(c, 200e6);
        assertEq(portalBalance(address(usdc)), AMOUNT + 500e6);
    }

    function test_insufficientFuel_reverts() public {
        swap.set(type(uint256).max, FLOOR - 1);
        vm.prank(user);
        vm.expectRevert(DepositRouter.InsufficientFuel.selector);
        router.bridgeFromCaller(
            _fuelIntent(address(usdc), SLICE, FLOOR, false), _swapData(address(usdc), SLICE, 0), AMOUNT, AMOUNT
        );

        _fundForPermit(fj, user, 10 ether);
        vm.prank(user);
        vm.expectRevert(DepositRouter.InsufficientFuel.selector);
        router.bridgeWithPermit(_fuelIntent(address(fj), 4 ether, 4 ether + 1, false), "", 10 ether, _permit(1));
    }

    // ── Constructor ─────────────────────────────────────────────────────────────────────────

    function test_constructor_checks() public {
        address p2 = address(permit2);
        address fjp = address(feePortal);
        address f = address(factory);
        address st = address(swap);
        vm.expectRevert(DepositRouter.ZeroAddress.selector);
        new DepositRouter(address(0), fjp, f, st, owner);
        vm.expectRevert(DepositRouter.ZeroAddress.selector);
        new DepositRouter(p2, address(0), f, st, owner);
        vm.expectRevert(DepositRouter.ZeroAddress.selector);
        new DepositRouter(p2, fjp, address(0), st, owner);
        vm.expectRevert(DepositRouter.NotAContract.selector);
        new DepositRouter(p2, fjp, f, address(0x5EA), owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new DepositRouter(p2, fjp, f, st, address(0));

        DepositRouter other =
            new DepositRouter(p2, address(new MockFeeJuicePortal(IERC20(address(usdc)))), f, st, owner);
        assertEq(other.FEE_ASSET(), address(usdc), "FEE_ASSET is the portal's UNDERLYING");
        assertEq(router.FEE_ASSET(), address(fj));
        assertEq(address(router.PERMIT2()), p2);
        assertEq(address(router.FEE_JUICE_PORTAL()), fjp);
        assertEq(address(router.FACTORY()), f);
        assertEq(router.SWAP_TARGET(), st);
        assertEq(router.owner(), owner);
    }

    // ── Gas (snapshotted) ───────────────────────────────────────────────────────────────────

    function test_gas_permit_firstTime() public {
        vm.pauseGasMetering();
        DepositRouter.DepositIntent memory i = _plainIntent(address(usdc), false);
        DepositRouter.PermitParams memory p = _permit(1);
        vm.startPrank(user);
        vm.resumeGasMetering();
        router.bridgeWithPermit(i, "", AMOUNT, p);
    }

    function test_gas_permit_known() public {
        vm.pauseGasMetering();
        factory.createPortal(address(usdc));
        DepositRouter.DepositIntent memory i = _plainIntent(address(usdc), false);
        DepositRouter.PermitParams memory p = _permit(1);
        vm.startPrank(user);
        vm.resumeGasMetering();
        router.bridgeWithPermit(i, "", AMOUNT, p);
    }

    function test_gas_fromCaller_withFuel() public {
        vm.pauseGasMetering();
        factory.createPortal(address(usdc));
        DepositRouter.DepositIntent memory i = _fuelIntent(address(usdc), SLICE, FLOOR, false);
        bytes memory sd = _swapData(address(usdc), SLICE, FLOOR);
        vm.startPrank(user);
        vm.resumeGasMetering();
        router.bridgeFromCaller(i, sd, AMOUNT, AMOUNT);
    }
}
