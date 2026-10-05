// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {DepositRouter} from "../src/DepositRouter.sol";
import {DepositRouterFixture} from "./mocks/DepositRouterFixture.sol";
import {FiatLikeERC20} from "./mocks/FiatLikeERC20.sol";

/// User funds are conserved (clone + venue spend == pulled), the pull is `min(balance, allowance, maxPull)`, and
/// the router's balances end at their pre-call residue plus whatever stray the venue forwarded, across an
/// OpenZeppelin token and a FiatToken-style one that decrements even a max allowance.
contract DepositRouterFuzzTest is DepositRouterFixture {
    /// One `MintableERC20.mint` of 6-decimal USDC is capped at 1e9 whole tokens.
    uint256 internal constant MAX_FUNDS = 1e15;
    uint256 internal constant MAX_SLICE = 1e12;
    uint256 internal constant DONATION = 123_456;
    uint256 internal constant FJ_DONATION = 0.5 ether;
    address internal constant CALLER = address(0xCA11);

    FiatLikeERC20 internal fiat;

    function setUp() public {
        _deployStack();
        fiat = new FiatLikeERC20(6);
    }

    function _mint(address token, address to, uint256 amount) internal {
        if (token == address(usdc)) usdc.mint(to, amount);
        else fiat.mint(to, amount);
    }

    /// Pre-call residue the router already holds in both assets.
    function _donate(address token) internal {
        _mint(token, address(router), DONATION);
        fj.mint(address(router), FJ_DONATION);
    }

    /// The venue pulls `pull` of the slice (zero: a skipped deposit step), spends `spend` of it, pays `fjOut`, and
    /// forwards its whole input balance, `stray` included.
    function _venue(address token, uint256 slice, uint256 pull, uint256 spend, uint256 fjOut, uint256 stray)
        internal
        returns (bytes memory)
    {
        swap.set(spend, fjOut);
        swap.setHostile(address(0), pull == slice ? 0 : pull, true);
        if (stray > 0) _mint(token, address(swap), stray);
        return pull == 0 ? _swapDataMultiple(token, slice, 0, false) : _swapData(token, slice, 0);
    }

    function _assertNoStandingApproval(address token) internal view {
        assertEq(IERC20(token).allowance(address(router), address(swap)), 0, "router -> swap target");
        assertEq(IERC20(token).allowance(address(router), portalFor(token)), 0, "router -> clone");
        assertEq(fj.allowance(address(router), address(feePortal)), 0, "router -> FeeJuicePortal");
    }

    /// Caller path: pull = min(balance, allowance, maxPull); any consumption ≤ slice; the unconsumed slice joins
    /// the token leg; a stray at the target ends as router residue.
    function testFuzz_fromCaller_pullBoundedAndFundsConserved(
        uint256 balance,
        uint256 allowance,
        uint256 maxPull,
        uint256 minReceived,
        uint256 slice,
        uint256 pull,
        uint256 spend,
        uint256 stray,
        uint256 fjOut,
        uint256 floor,
        uint8 flags
    ) public {
        address token = flags & 1 == 0 ? address(usdc) : address(fiat);
        bool withFuel = flags & 2 != 0;
        slice = withFuel ? bound(slice, 1, MAX_SLICE) : 0;
        minReceived = bound(minReceived, slice + 1, MAX_FUNDS);
        maxPull = bound(maxPull, minReceived, MAX_FUNDS);
        // `flags & 16` funds the caller past the minimum, so the success branch is never left to chance.
        uint256 least = flags & 16 != 0 ? minReceived : 0;
        balance = bound(balance, least, MAX_FUNDS);
        allowance = flags & 4 != 0 ? type(uint256).max : bound(allowance, least, MAX_FUNDS);
        pull = bound(pull, 0, slice);
        spend = bound(spend, 0, pull);
        stray = withFuel ? bound(stray, 0, MAX_SLICE) : 0;
        fjOut = bound(fjOut, 0, 1_000 ether);
        floor = bound(floor, 1, 1_000 ether);

        DepositRouter.DepositIntent memory i =
            withFuel ? _fuelIntent(token, slice, floor, flags & 8 != 0) : _plainIntent(token, flags & 8 != 0);
        bytes memory sd = withFuel ? _venue(token, slice, pull, spend, fjOut, stray) : bytes("");
        _donate(token);
        _mint(token, CALLER, balance);
        vm.prank(CALLER);
        IERC20(token).approve(address(router), allowance);

        uint256 pulled = Math.min(Math.min(balance, allowance), maxPull);
        if (pulled < minReceived) {
            vm.expectRevert(DepositRouter.BelowMinimum.selector);
        } else if (withFuel && fjOut < floor) {
            vm.expectRevert(DepositRouter.InsufficientFuel.selector);
        }
        vm.prank(CALLER);
        (uint256 tokenAmount, uint256 fuelOut) = router.bridgeFromCaller(i, sd, minReceived, maxPull);
        if (pulled < minReceived || (withFuel && fjOut < floor)) return;

        uint256 consumed = withFuel ? spend : 0;
        assertEq(tokenAmount, pulled - consumed, "token leg = pulled - consumed");
        assertEq(IERC20(token).balanceOf(portalFor(token)), pulled - consumed, "clone");
        assertEq(IERC20(token).balanceOf(swap.SINK()), consumed, "venue spend");
        assertEq(IERC20(token).balanceOf(CALLER), balance - pulled, "only the pull left the caller");
        uint256 allowanceLeft =
            token == address(usdc) && allowance == type(uint256).max ? type(uint256).max : allowance - pulled;
        assertEq(IERC20(token).allowance(CALLER, address(router)), allowanceLeft, "caller allowance");
        assertEq(IERC20(token).balanceOf(address(router)), DONATION + stray, "residue = pre-call + stray");
        assertEq(IERC20(token).balanceOf(address(swap)), 0, "the venue forwards its whole balance");
        assertEq(fj.balanceOf(address(router)), FJ_DONATION, "fee-asset residue untouched");
        assertEq(fuelOut, withFuel ? fjOut : 0);
        assertEq(fj.balanceOf(address(feePortal)), withFuel ? fjOut : 0, "fuel = the router's own delta");
        _assertNoStandingApproval(token);
    }

    /// Permit2 path and every fuel-only send: the venue consumes the whole slice or the call reverts.
    function testFuzz_exactPaths_wholeSliceOrRevert(
        uint256 amount,
        uint256 slice,
        uint256 pull,
        uint256 spend,
        uint256 stray,
        uint8 flags
    ) public {
        address token = flags & 1 == 0 ? address(usdc) : address(fiat);
        bool fuelOnly = flags & 2 != 0;
        bool viaPermit = !fuelOnly || flags & 4 != 0;
        slice = bound(slice, 1, MAX_SLICE);
        amount = fuelOnly ? slice : bound(amount, slice + 1, MAX_FUNDS);
        // `flags & 16` forces the full spend, so the success branch is never left to chance.
        pull = flags & 16 != 0 ? slice : bound(pull, 0, slice);
        spend = flags & 16 != 0 ? slice : bound(spend, 0, pull);
        stray = bound(stray, 0, MAX_SLICE);

        bytes memory sd = _venue(token, slice, pull, spend, 2 ether, stray);
        DepositRouter.DepositIntent memory i =
            fuelOnly ? _fuelOnlyIntent(token, slice, 1 ether) : _fuelIntent(token, slice, 1 ether, flags & 8 != 0);
        _donate(token);
        _mint(token, CALLER, amount);
        vm.startPrank(CALLER);
        IERC20(token).approve(address(permit2), type(uint256).max);
        IERC20(token).approve(address(router), type(uint256).max);

        // spend ≤ pull ≤ slice, so a full spend implies a full pull.
        bool exact = spend == slice;
        if (!exact) vm.expectRevert(DepositRouter.InexactFuelConsumption.selector);
        if (viaPermit) router.bridgeWithPermit(i, sd, amount, _permit(1));
        else router.bridgeFromCaller(i, sd, amount, amount);
        vm.stopPrank();
        if (!exact) return;

        assertEq(IERC20(token).balanceOf(portalFor(token)), amount - slice, "clone");
        assertEq(IERC20(token).balanceOf(swap.SINK()), slice, "venue spend");
        assertEq(IERC20(token).balanceOf(CALLER), 0, "exactly amount left the payer");
        assertEq(IERC20(token).balanceOf(address(router)), DONATION + stray, "residue = pre-call + stray");
        assertEq(fj.balanceOf(address(router)), FJ_DONATION);
        assertEq(fj.balanceOf(address(feePortal)), 2 ether);
        if (fuelOnly) assertEq(factory.portalOf(token), address(0), "fuel-only creates no clone");
        _assertNoStandingApproval(token);
    }

    /// The fee asset as the token: the slice goes to the FeeJuicePortal, the remainder only to the fee asset's
    /// own clone, and nothing swaps.
    function testFuzz_identity_sliceOnlyToFeeJuicePortal(uint256 amount, uint256 slice, uint8 flags) public {
        amount = bound(amount, 1, 1e27);
        slice = bound(slice, 1, amount);
        bool fuelOnly = slice == amount;
        DepositRouter.DepositIntent memory i =
            fuelOnly ? _fuelOnlyIntent(address(fj), slice, 0) : _fuelIntent(address(fj), slice, slice, flags & 1 != 0);
        _donate(address(usdc));
        fj.mint(CALLER, amount);
        vm.startPrank(CALLER);
        fj.approve(address(permit2), type(uint256).max);
        fj.approve(address(router), type(uint256).max);
        if (flags & 2 != 0) router.bridgeWithPermit(i, "", amount, _permit(1));
        else router.bridgeFromCaller(i, "", amount, amount);
        vm.stopPrank();

        assertEq(fj.balanceOf(address(feePortal)), slice, "the FeeJuicePortal receives the slice only");
        assertEq(fj.balanceOf(portalFor(address(fj))), amount - slice, "the remainder lands in the fee asset's clone");
        if (fuelOnly) assertEq(factory.portalOf(address(fj)), address(0));
        assertEq(fj.balanceOf(address(router)), FJ_DONATION, "fee-asset residue untouched");
        assertEq(swap.calls(), 0);
        _assertNoStandingApproval(address(fj));
    }
}
