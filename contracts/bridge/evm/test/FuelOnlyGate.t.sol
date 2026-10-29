// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Ownable} from "@oz/access/Ownable.sol";
import {DepositRouter} from "../src/DepositRouter.sol";
import {FuelOnlyGate} from "../src/FuelOnlyGate.sol";
import {DepositRouterFixture} from "./mocks/DepositRouterFixture.sol";

/// A `DepositRouter` bound to a `FuelOnlyGate` instead of a `PortalFactory`: the mainnet shape with no token portals.
contract FuelOnlyGateTest is DepositRouterFixture {
    uint256 internal constant AMOUNT = 1000e6;
    uint256 internal constant SLICE = 100e6;
    uint256 internal constant FLOOR = 4 ether;
    uint256 internal constant FJ_OUT = 5 ether;
    uint256 internal constant FUNDS = 10_000e6;

    FuelOnlyGate internal gate;

    function setUp() public {
        _deployStack();
        gate = new FuelOnlyGate(guardian);
        router = new DepositRouter(address(permit2), address(feePortal), address(gate), address(swap), owner);
        _fundForPermit(usdc, user, FUNDS);
        _fundForPermit(fj, user, 100 ether);
        vm.startPrank(user);
        usdc.approve(address(router), type(uint256).max);
        fj.approve(address(router), type(uint256).max);
        vm.stopPrank();
        swap.set(type(uint256).max, FJ_OUT);
    }

    /// Every token-leg shape, through both entrypoints, reverts with the gate's error and moves nothing.
    function test_tokenLegs_revertWithNothingMoved() public {
        _tokenLegRefused(_plainIntent(address(usdc), false), "");
        _tokenLegRefused(_plainIntent(address(usdc), true), "");
        _tokenLegRefused(_fuelIntent(address(usdc), SLICE, FLOOR, false), _swapData(address(usdc), SLICE, FLOOR));
        _tokenLegRefused(_fuelIntent(address(fj), 4 ether, 0, true), "");
    }

    function _tokenLegRefused(DepositRouter.DepositIntent memory i, bytes memory sd) internal {
        uint256 usdcBefore = usdc.balanceOf(user);
        uint256 fjBefore = fj.balanceOf(user);
        uint256 amount = i.token == address(fj) ? 10 ether : AMOUNT;
        vm.startPrank(user);
        vm.expectRevert(FuelOnlyGate.TokenLegsDisabled.selector);
        router.bridgeWithPermit(i, sd, amount, _permit(1));
        vm.expectRevert(FuelOnlyGate.TokenLegsDisabled.selector);
        router.bridgeFromCaller(i, sd, amount, amount);
        vm.stopPrank();
        assertEq(usdc.balanceOf(user), usdcBefore, "a refused token leg moved USDC");
        assertEq(fj.balanceOf(user), fjBefore, "a refused token leg moved the fee asset");
        assertEq(swap.calls(), 0, "a refused token leg reached the venue");
        assertEq(feePortal.lastAmount(), 0, "a refused token leg reached the FeeJuicePortal");
    }

    /// The success control: fuel-only, swapped and identity, settles through the gate on both entrypoints.
    function test_fuelOnly_settlesThroughTheGate() public {
        DepositRouter.DepositIntent memory i = _fuelOnlyIntent(address(usdc), SLICE, FLOOR);
        bytes memory sd = _swapData(address(usdc), SLICE, FLOOR);
        vm.startPrank(user);
        (uint256 tokenA, uint256 fuelA) = router.bridgeWithPermit(i, sd, SLICE, _permit(1));
        (uint256 tokenB, uint256 fuelB) = router.bridgeFromCaller(i, sd, SLICE, SLICE);
        (, uint256 fuelC) = router.bridgeWithPermit(_fuelOnlyIntent(address(fj), 3 ether, 0), "", 3 ether, _permit(2));
        vm.stopPrank();

        assertEq(tokenA + tokenB, 0, "no token leg");
        assertEq(fuelA + fuelB, 2 * FJ_OUT);
        assertEq(fuelC, 3 ether, "identity passes the fee asset 1:1");
        assertEq(fj.balanceOf(address(feePortal)), 2 * FJ_OUT + 3 ether);
        assertEq(usdc.balanceOf(user), FUNDS - 2 * SLICE, "exactly the slice, twice");
    }

    function test_pause_stopsFuelOnly_andReopens() public {
        vm.prank(guardian);
        vm.expectEmit(address(gate));
        emit FuelOnlyGate.DepositsPauseChanged(true);
        gate.setDepositsPaused(true);

        DepositRouter.DepositIntent memory i = _fuelOnlyIntent(address(usdc), SLICE, FLOOR);
        bytes memory sd = _swapData(address(usdc), SLICE, FLOOR);
        vm.startPrank(user);
        vm.expectRevert(DepositRouter.DepositsPaused.selector);
        router.bridgeWithPermit(i, sd, SLICE, _permit(1));
        vm.expectRevert(DepositRouter.DepositsPaused.selector);
        router.bridgeFromCaller(_fuelOnlyIntent(address(fj), 3 ether, 0), "", 3 ether, 3 ether);
        vm.stopPrank();
        assertEq(usdc.balanceOf(user), FUNDS, "a paused send moved funds");

        vm.prank(guardian);
        gate.setDepositsPaused(false);
        vm.prank(user);
        router.bridgeWithPermit(i, sd, SLICE, _permit(1));
        assertEq(fj.balanceOf(address(feePortal)), FJ_OUT, "reopened gate settles");
    }

    function test_onlyOwnerPauses() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        gate.setDepositsPaused(true);
        assertFalse(gate.depositsPaused());
    }

    function test_renounceRefused_transferIsTwoStep() public {
        vm.prank(guardian);
        vm.expectRevert(FuelOnlyGate.RenounceDisabled.selector);
        gate.renounceOwnership();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        gate.renounceOwnership();

        address next = address(0x2E);
        vm.prank(guardian);
        gate.transferOwnership(next);
        assertEq(gate.owner(), guardian, "ownership moved before acceptance");
        vm.prank(next);
        gate.acceptOwnership();
        assertEq(gate.owner(), next);
    }

    function test_createPortal_alwaysReverts() public {
        vm.expectRevert(FuelOnlyGate.TokenLegsDisabled.selector);
        gate.createPortal(address(usdc));
        vm.prank(guardian);
        vm.expectRevert(FuelOnlyGate.TokenLegsDisabled.selector);
        gate.createPortal(address(fj));
    }
}
