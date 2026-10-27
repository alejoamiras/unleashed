// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {DepositRouter} from "../src/DepositRouter.sol";
import {MintableERC20} from "../src/MintableERC20.sol";
import {DepositRouterFixture} from "./mocks/DepositRouterFixture.sol";

/// Cross-call INVARIANT suite for `DepositRouter` over the REAL factory and clones. The handler drives an Executor
/// (`bridgeFromCaller` behind a standing max allowance), a Permit2 user, a donor (to the router and to the venue),
/// a hostile venue reconfigured per call, the guardian's pause and the owner's sweep. Every action that reaches the
/// router is measured across a fixed set of known holders, and the suite asserts after EVERY sequence:
///
///   I1  Funds never leave the known holders, and the venue nets at most the slice per call.
///   I2  No allowance the router grants (to the venue, either clone, the FeeJuicePortal) survives a call.
///   I3  The router's balance only grows during a call, and only by what the venue held beforehand; it is exactly
///       donations + strays − sweeps.
///   I4  User funds are conserved: received == token leg + fuel input, measured at the clones, the FeeJuicePortal
///       and the venue.
///   I5  Nothing lands while deposits are paused, and an honest call never reverts while they are open.
contract DepositRouterInvariantTest is Test {
    DepositRouterHandler internal handler;

    function setUp() public {
        handler = new DepositRouterHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = DepositRouterHandler.bridgeWithPermit.selector;
        selectors[1] = DepositRouterHandler.bridgeFromExecutor.selector;
        selectors[2] = DepositRouterHandler.hostileSwap.selector;
        selectors[3] = DepositRouterHandler.donate.selector;
        selectors[4] = DepositRouterHandler.setPaused.selector;
        selectors[5] = DepositRouterHandler.sweep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_fundsStayWithTheKnownHolders() public view {
        assertFalse(handler.escaped(), "funds reached an address outside the known holders during a call");
        assertFalse(handler.sliceExceeded(), "the venue netted more than the slice");
        assertEq(handler.usdcSupply(), handler.heldByKnown(true), "USDC outside the known holders");
        assertEq(handler.fjSupply(), handler.heldByKnown(false), "fee asset outside the known holders");
    }

    function invariant_noRouterAllowanceSurvives() public view {
        assertEq(handler.routerAllowances(), 0, "a router allowance survived a call");
    }

    function invariant_residueOnlyGrowsUntilSwept() public view {
        assertFalse(handler.residueDipped(), "a call took from the router's prior residue");
        for (uint256 k; k < 2; k++) {
            bool isUsdc = k == 0;
            assertEq(
                handler.routerBalance(isUsdc),
                handler.ghostDonatedRouter(isUsdc) + handler.ghostStray(isUsdc) - handler.ghostSwept(isUsdc),
                "router balance != donations + strays - sweeps"
            );
        }
    }

    /// Measured against the observed sinks, never ghost against ghost.
    function invariant_userFundsConserved() public view {
        assertFalse(handler.unconserved(), "a call's split did not match what moved");
        assertEq(handler.cloneBalance(true), handler.ghostTokenLeg(true), "USDC clone != cumulative token legs");
        assertEq(handler.cloneBalance(false), handler.ghostTokenLeg(false), "fee asset clone != cumulative token legs");
        assertEq(handler.feePortalBalance(), handler.ghostFuelOut(), "FeeJuicePortal != cumulative fuel");
        assertEq(
            handler.venueBalance(),
            handler.ghostDonatedTarget() + handler.ghostFuelIn() - handler.ghostStray(true),
            "venue != donations + consumed slices - strays returned"
        );
    }

    function invariant_pauseStopsEveryLegAndHonestCallsLand() public view {
        assertFalse(handler.pausedAccepted(), "a deposit landed while paused");
        assertFalse(handler.honestReverted(), "an honest call reverted while deposits were open");
    }

    /// Non-vacuity: every run settles deposits, so the invariants above are not about an idle router.
    function afterInvariant() public view {
        assertGt(handler.deposits(), 0, "the campaign never deposited");
    }
}

contract DepositRouterHandler is DepositRouterFixture {
    /// `MockLifiSwap.SINK`: where the venue's spent input goes.
    address internal constant SINK = address(0x5111C);
    address internal constant DIVERT = address(0xD1E7);
    address internal constant OWNER_SINK = address(0x5117);

    uint256 internal constant I_USER = 0;
    uint256 internal constant I_EXECUTOR = 1;
    uint256 internal constant I_ROUTER = 2;
    uint256 internal constant I_USDC_CLONE = 3;
    uint256 internal constant I_FJ_CLONE = 4;
    uint256 internal constant I_FEE_PORTAL = 5;
    uint256 internal constant I_VENUE = 6;
    uint256 internal constant I_SINK = 7;
    uint256 internal constant I_DIVERT = 8;
    uint256 internal constant I_OWNER_SINK = 9;

    address[] internal holders;

    bool public escaped;
    bool public sliceExceeded;
    bool public residueDipped;
    bool public unconserved;
    bool public pausedAccepted;
    /// `fail_on_revert = false` would otherwise swallow an honest call the router wrongly refuses.
    bool public honestReverted;
    bool public depositsPaused;

    mapping(address => uint256) internal tokenLeg;
    mapping(address => uint256) internal stray;
    mapping(address => uint256) internal donatedRouter;
    mapping(address => uint256) internal swept;
    uint256 public ghostDonatedTarget;
    uint256 public ghostFuelIn;
    uint256 public ghostFuelOut;
    uint256 public deposits;
    uint256 public hostileAccepted;
    uint256 internal nonce;

    struct Plan {
        DepositRouter.DepositIntent intent;
        bytes swapData;
        MintableERC20 token;
        uint256 amount;
        bool swapped;
    }

    constructor() {
        _deployStack();
        fj.mint(address(swap), 900_000 ether);
        holders.push(user);
        holders.push(address(executor));
        holders.push(address(router));
        holders.push(portalFor(address(usdc)));
        holders.push(portalFor(address(fj)));
        holders.push(address(feePortal));
        holders.push(address(swap));
        holders.push(SINK);
        holders.push(DIVERT);
        holders.push(OWNER_SINK);
    }

    // ─── Actors ──────────────────────────────────────────────────────

    function bridgeWithPermit(uint256 seed, uint256 outSeed) external {
        Plan memory p = _plan(seed, false);
        _honestVenue(p, outSeed);
        _fundForPermit(p.token, user, p.amount);
        _execute(p, true, p.amount, p.amount, true);
    }

    /// The Executor holds the bridged amount plus an optional surplus beyond `maxPull`, which must stay with it.
    function bridgeFromExecutor(uint256 seed, uint256 outSeed, uint256 pullSeed) external {
        Plan memory p = _plan(seed, false);
        _honestVenue(p, outSeed);
        p.token.mint(address(executor), p.amount + bound(pullSeed, 0, p.amount));
        uint256 minReceived = p.intent.tokenSecretHash == bytes32(0)
            ? p.amount
            : bound(pullSeed >> 128, p.intent.fuelSlice + 1, p.amount);
        _execute(p, false, minReceived, p.amount, true);
    }

    /// One fatal hostility at most (output below the floor, output diverted, re-entry, a pull beyond the approval)
    /// on top of any mix of benign ones (partial spend, partial return, partial or skipped pull, extra output).
    function hostileSwap(uint256 seed, uint256 dexSeed, bool viaPermit) external {
        Plan memory p = _plan(seed, true);
        uint256 slice = p.intent.fuelSlice;
        uint256 floor = p.intent.minFuelOutput;
        bool skipPull = (dexSeed >> 4) & 1 == 1;
        p.swapData = skipPull ? _swapDataMultiple(address(usdc), slice, 0, false) : _swapData(address(usdc), slice, 0);

        uint256 spend = (dexSeed >> 5) & 1 == 1 ? bound(dexSeed >> 64, 0, slice - 1) : type(uint256).max;
        uint256 fjOut = bound(dexSeed >> 128, floor, 50 ether);
        address fjTo;
        uint256 pullOverride = (dexSeed >> 6) & 1 == 1 ? bound(dexSeed >> 32, 1, slice) : 0;
        uint256 fatal = dexSeed % 8;
        if (fatal == 0) {
            fjOut = floor - 1;
        } else if (fatal == 1) {
            fjTo = DIVERT;
        } else if (fatal == 2) {
            pullOverride = slice + 1 + (dexSeed >> 200) % 1000;
        } else if (fatal == 3) {
            swap.armReenter(address(router), abi.encodeCall(router.bridgeFromCaller, (p.intent, "", 1, 1)));
        }
        swap.set(spend, fjOut);
        swap.setHostile(fjTo, pullOverride, (dexSeed >> 7) & 1 == 0);

        if (viaPermit) _fundForPermit(p.token, user, p.amount);
        else p.token.mint(address(executor), p.amount);
        if (_execute(p, viaPermit, p.amount, p.amount, false)) hostileAccepted++;
        swap.armReenter(address(0), "");
    }

    function donate(uint256 seed) external {
        uint256 where = seed % 3;
        if (where == 0) {
            uint256 amt = bound(seed >> 8, 1, 1e12);
            usdc.mint(address(router), amt);
            donatedRouter[address(usdc)] += amt;
        } else if (where == 1) {
            uint256 amt = bound(seed >> 8, 1, 1e24);
            fj.mint(address(router), amt);
            donatedRouter[address(fj)] += amt;
        } else {
            uint256 amt = bound(seed >> 8, 1, 1e12);
            usdc.mint(address(swap), amt);
            ghostDonatedTarget += amt;
        }
    }

    /// Pauses one call in four, so most of the campaign runs with deposits open.
    function setPaused(uint8 seed) external {
        bool paused = seed % 4 == 0;
        vm.prank(guardian);
        factory.setPaused(paused, false);
        depositsPaused = paused;
    }

    function sweep(bool isUsdc) external {
        MintableERC20 t = isUsdc ? usdc : fj;
        uint256 bal = t.balanceOf(address(router));
        vm.prank(owner);
        router.sweep(address(t), OWNER_SINK);
        swept[address(t)] += bal;
    }

    // ─── Read-backs ──────────────────────────────────────────────────

    function usdcSupply() external view returns (uint256) {
        return usdc.totalSupply();
    }

    function fjSupply() external view returns (uint256) {
        return fj.totalSupply();
    }

    function heldByKnown(bool isUsdc) external view returns (uint256) {
        return _sum(_balances(isUsdc ? usdc : fj));
    }

    /// Bitwise OR of every allowance the router could have granted: zero iff all are zero.
    function routerAllowances() external view returns (uint256 any) {
        address[4] memory spenders =
            [address(swap), portalFor(address(usdc)), portalFor(address(fj)), address(feePortal)];
        for (uint256 s; s < 4; s++) {
            any |= usdc.allowance(address(router), spenders[s]) | fj.allowance(address(router), spenders[s]);
        }
    }

    function routerBalance(bool isUsdc) external view returns (uint256) {
        return (isUsdc ? usdc : fj).balanceOf(address(router));
    }

    function cloneBalance(bool isUsdc) external view returns (uint256) {
        return portalBalance(address(isUsdc ? usdc : fj));
    }

    function feePortalBalance() external view returns (uint256) {
        return fj.balanceOf(address(feePortal));
    }

    function venueBalance() external view returns (uint256) {
        return usdc.balanceOf(address(swap)) + usdc.balanceOf(SINK);
    }

    function ghostTokenLeg(bool isUsdc) external view returns (uint256) {
        return tokenLeg[address(isUsdc ? usdc : fj)];
    }

    function ghostStray(bool isUsdc) external view returns (uint256) {
        return stray[address(isUsdc ? usdc : fj)];
    }

    function ghostDonatedRouter(bool isUsdc) external view returns (uint256) {
        return donatedRouter[address(isUsdc ? usdc : fj)];
    }

    function ghostSwept(bool isUsdc) external view returns (uint256) {
        return swept[address(isUsdc ? usdc : fj)];
    }

    // ─── Internals ───────────────────────────────────────────────────

    /// Six shapes: USDC plain / swapped slice / fuel-only, fee asset plain / 1:1 slice / fuel-only. `swapOnly`
    /// restricts to the two USDC shapes that reach the venue.
    function _plan(uint256 seed, bool swapOnly) internal view returns (Plan memory p) {
        uint256 shape = swapOnly ? 1 + seed % 2 : seed % 6;
        p.token = shape < 3 ? usdc : fj;
        p.amount = bound(seed >> 8, 2, shape < 3 ? 1e12 : 1e24);
        uint256 slice = bound(seed >> 72, 1, p.amount - 1);
        bool isPrivate = (seed >> 3) & 1 == 1;
        uint256 floor = bound(seed >> 140, 1, 1 ether);
        if (shape == 0 || shape == 3) {
            p.intent = _plainIntent(address(p.token), isPrivate);
        } else if (shape == 1 || shape == 2) {
            p.swapped = true;
            p.intent = shape == 1
                ? _fuelIntent(address(usdc), slice, floor, isPrivate)
                : _fuelOnlyIntent(address(usdc), p.amount, floor);
            uint256 s = p.intent.fuelSlice;
            p.swapData = (seed >> 200) & 1 == 0
                ? _swapData(address(usdc), s, floor)
                : _swapDataMultiple(address(usdc), s, floor, true);
        } else {
            p.intent = shape == 4
                ? _fuelIntent(address(fj), slice, slice, isPrivate)
                : _fuelOnlyIntent(address(fj), p.amount, p.amount);
        }
    }

    function _honestVenue(Plan memory p, uint256 outSeed) internal {
        if (!p.swapped) return;
        swap.set(type(uint256).max, bound(outSeed, p.intent.minFuelOutput, 5 ether));
        swap.setHostile(address(0), 0, true);
    }

    /// Runs one entrypoint and, on success, checks the call against what moved. Returns whether it settled.
    function _execute(Plan memory p, bool viaPermit, uint256 minReceived, uint256 maxPull, bool honest)
        internal
        returns (bool ok)
    {
        uint256[] memory bT = _balances(p.token);
        uint256[] memory bF = _balances(fj);
        uint256 tokenAmount;
        uint256 fuelOut;
        if (viaPermit) {
            vm.prank(user);
            try router.bridgeWithPermit(p.intent, p.swapData, p.amount, _permit(++nonce)) returns (
                uint256 a, uint256 f
            ) {
                (tokenAmount, fuelOut, ok) = (a, f, true);
            } catch {}
        } else {
            try executor.run(router, IERC20(address(p.token)), p.intent, p.swapData, minReceived, maxPull) returns (
                uint256 a, uint256 f
            ) {
                (tokenAmount, fuelOut, ok) = (a, f, true);
            } catch {}
        }
        if (!ok) {
            if (honest && !depositsPaused) honestReverted = true;
            return false;
        }
        if (depositsPaused) pausedAccepted = true;
        _check(p, viaPermit ? I_USER : I_EXECUTOR, bT, bF, tokenAmount, fuelOut, viaPermit);
    }

    /// Every comparison is made without reverting: a handler revert is swallowed by `fail_on_revert = false`,
    /// which would hide the very violation it was checking.
    function _check(
        Plan memory p,
        uint256 payer,
        uint256[] memory bT,
        uint256[] memory bF,
        uint256 tokenAmount,
        uint256 fuelOut,
        bool viaPermit
    ) internal {
        uint256[] memory aT = _balances(p.token);
        uint256[] memory aF = _balances(fj);
        if (_sum(aT) != _sum(bT) || _sum(aF) != _sum(bF)) escaped = true;
        if (aT[I_DIVERT] != bT[I_DIVERT] || aF[I_DIVERT] != bF[I_DIVERT]) escaped = true;
        if (aT[I_OWNER_SINK] != bT[I_OWNER_SINK] || aF[I_OWNER_SINK] != bF[I_OWNER_SINK]) escaped = true;

        bool isUsdc = p.token == usdc;
        int256 dPayer = _d(aT, bT, payer);
        int256 dRouter = _d(aT, bT, I_ROUTER);
        int256 dVenue = _d(aT, bT, I_VENUE) + _d(aT, bT, I_SINK);
        if (dPayer >= 0 || uint256(-dPayer) < tokenAmount || _d(aF, bF, I_ROUTER) != 0 && isUsdc) {
            unconserved = true;
            return;
        }
        uint256 received = uint256(-dPayer);
        uint256 fuelIn = received - tokenAmount;
        uint256 slice = p.intent.fuelSlice;

        if (p.intent.tokenSecretHash == bytes32(0) && tokenAmount != 0) unconserved = true;
        if (slice == 0 && (fuelIn != 0 || fuelOut != 0)) unconserved = true;
        if (slice > 0 && fuelOut < p.intent.minFuelOutput) unconserved = true;
        if (!isUsdc && slice > 0 && (fuelIn != slice || fuelOut != slice)) unconserved = true;
        if (_d(aT, bT, isUsdc ? I_USDC_CLONE : I_FJ_CLONE) != int256(tokenAmount)) unconserved = true;
        if (_d(aF, bF, I_FEE_PORTAL) != int256(fuelOut)) unconserved = true;
        if (dRouter < 0) residueDipped = true;

        if (p.swapped) {
            bool exact = viaPermit || p.intent.tokenSecretHash == bytes32(0);
            if (fuelIn > slice || dVenue > int256(slice)) sliceExceeded = true;
            if (exact && fuelIn != slice) unconserved = true;
            // Only what the venue held before the call may come back as residue.
            if (dRouter > int256(bT[I_VENUE])) unconserved = true;
            if (dVenue + dRouter != int256(fuelIn)) unconserved = true;
        } else if (dRouter != 0 || dVenue != 0) {
            unconserved = true;
        }

        if (dRouter > 0) stray[address(p.token)] += uint256(dRouter);
        tokenLeg[address(p.token)] += tokenAmount;
        if (isUsdc) ghostFuelIn += fuelIn;
        ghostFuelOut += fuelOut;
        deposits++;
    }

    function _balances(MintableERC20 t) internal view returns (uint256[] memory b) {
        b = new uint256[](holders.length);
        for (uint256 k; k < holders.length; k++) {
            b[k] = t.balanceOf(holders[k]);
        }
    }

    function _sum(uint256[] memory b) internal pure returns (uint256 s) {
        for (uint256 k; k < b.length; k++) {
            s += b[k];
        }
    }

    function _d(uint256[] memory a, uint256[] memory b, uint256 k) internal pure returns (int256) {
        return int256(a[k]) - int256(b[k]);
    }
}
