// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SwapBridgeRouter, IUniswapFuelSwap} from "../src/SwapBridgeRouter.sol";
import {MintableERC20} from "../src/MintableERC20.sol";
import {
    MockPermit2,
    MockSwap,
    MockTokenPortal,
    MockFeeJuicePortal,
    FakePortalFactory,
    RouterWithoutPortalRule
} from "./mocks/RouterMocks.sol";

/// SYMBOLIC checks (run with `halmos`, not forge): function arguments are symbolic, so each
/// check proves its property over the WHOLE input domain, not sampled points like fuzzing.
///
///   check_bridge_conservesUserFunds                     — plain bridge: exact-in, exact-deposit, zero residue
///   check_bridgeWithFuel_conservesUserFunds             — fueled bridge: split accounting holds for ANY split
///   check_bridgeWithFuel_fuelOnly_conservesUserFunds    — fuel-only: everything swapped, no token leg, zero residue
///   check_bridgeWithFuel_identity_conservesUserFunds    — fee asset: 1:1 pass-through for ANY split, swap untouched
///   check_bridge_rejectsForeignPortal                   — ANY portal but the factory's is refused before any pull
///   check_bridgeWithFuel_partialRejectsFeeJuicePortal   — a partial fee-asset intent can never enter the FeeJuicePortal
///   check_sweep_revertsForNonOwner                      — authority boundary
///   check_setSwapTarget_revertsForNonOwner              — authority boundary
///
/// Threat model note: Permit2 is a success-always mock (signature validity is Permit2's own
/// domain, pinned by the real-fork tests), the swap target is the HONEST mock (reports ==
/// transfers, consumes exactly its input), and the factory is an honest model binding each token
/// to a non-hashing portal stand-in — halmos 0.3.3 cannot model the sha256 precompile, so the real
/// factory + clones are out of its reach (forge covers them). The properties proven are the
/// router's OWN accounting + gating guarantees under those semantics.
///
/// Signal failure with assertions only — halmos cannot observe `revert(string)`. The forge-level
/// canaries below keep the proofs honest two ways: the gating proofs are re-run against a router
/// MUTANT with the guard deleted and must then fail (the property is load-bearing), and every
/// other proof has a witness that its complementary branch is reachable through the same harness
/// (the proof did not prune to vacuity).
contract FormalRouterTest is Test {
    MintableERC20 usdc;
    MintableERC20 fj;
    MockPermit2 permit2;
    MockSwap swap;
    MockFeeJuicePortal feePortal;
    FakePortalFactory factory;
    MockTokenPortal usdcPortal;
    MockTokenPortal fjPortal;
    SwapBridgeRouter router;

    address constant USER = address(0xDA0);
    address constant SWEEP_SINK = address(0x5117);
    bytes32 constant RECIPIENT = bytes32(uint256(0x1234));
    bytes32 constant FUEL_RECIPIENT = bytes32(uint256(0x5678));
    bytes32 constant SECRET = bytes32(uint256(0x5EC7E7));

    uint256 constant USER_BALANCE = 1_000_000 * 1e6;
    uint256 constant USER_FJ = 1_000 ether;

    function setUp() public {
        usdc = new MintableERC20("USDC", "USDC", 6, 1_000_000_000);
        fj = new MintableERC20("FeeJuice", "FJ", 18, 1_000_000_000);
        permit2 = new MockPermit2();
        swap = new MockSwap(IERC20(address(fj)));
        feePortal = new MockFeeJuicePortal(IERC20(address(fj)));
        factory = new FakePortalFactory();
        usdcPortal = MockTokenPortal(factory.bind(address(usdc)));
        fjPortal = MockTokenPortal(factory.bind(address(fj)));
        router = new SwapBridgeRouter(address(permit2), address(feePortal), address(swap), address(factory));

        usdc.mint(USER, USER_BALANCE);
        fj.mint(USER, USER_FJ);
        fj.mint(address(swap), 100_000 ether);
        vm.startPrank(USER);
        usdc.approve(address(permit2), type(uint256).max);
        fj.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
        swap.setOutput(1 ether, 0);
    }

    function _route() internal pure returns (IUniswapFuelSwap.PoolKey[] memory p, bool[] memory d) {
        p = new IUniswapFuelSwap.PoolKey[](1);
        p[0] = IUniswapFuelSwap.PoolKey(address(0), address(0), 3000, 60, address(0));
        d = new bool[](1);
        d[0] = true;
    }

    function _noRoute() internal pure returns (IUniswapFuelSwap.PoolKey[] memory p, bool[] memory d) {
        p = new IUniswapFuelSwap.PoolKey[](0);
        d = new bool[](0);
    }

    function _permit() internal pure returns (SwapBridgeRouter.PermitParams memory) {
        return SwapBridgeRouter.PermitParams({nonce: 1, deadline: type(uint256).max, signature: hex"00"});
    }

    function _fuelParams(address token, address portal, uint256 total, uint256 fuel, bool identity)
        internal
        pure
        returns (SwapBridgeRouter.BridgeParams memory p)
    {
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = identity ? _noRoute() : _route();
        p = SwapBridgeRouter.BridgeParams({
            tokenPortal: portal,
            bridgeToken: token,
            totalAmount: total,
            fuelAmount: fuel,
            aztecRecipient: RECIPIENT,
            fuelRecipient: FUEL_RECIPIENT,
            tokenSecretHash: SECRET,
            fuelSecretHash: SECRET,
            minFuelOutput: identity ? fuel : 1 ether,
            path: path,
            zeroForOnes: dirs,
            isPrivate: false
        });
    }

    function _simple(address token, address portal, uint256 amount, bool isPrivate)
        internal
        pure
        returns (SwapBridgeRouter.SimpleBridgeParams memory)
    {
        return SwapBridgeRouter.SimpleBridgeParams({
            tokenPortal: portal,
            bridgeToken: token,
            amount: amount,
            aztecRecipient: RECIPIENT,
            secretHash: SECRET,
            isPrivate: isPrivate
        });
    }

    /// For ANY amount the user can afford, a plain bridge moves EXACTLY that amount to the
    /// portal, leaves NOTHING in the router, and takes nothing else from the user.
    function check_bridge_conservesUserFunds(uint128 amountRaw) public {
        uint256 amount = bound(uint256(amountRaw), 1, USER_BALANCE);
        uint256 userBefore = usdc.balanceOf(USER);
        uint256 portalBefore = usdc.balanceOf(address(usdcPortal));

        vm.prank(USER);
        router.bridge(_simple(address(usdc), address(usdcPortal), amount, false), _permit());

        assertEq(usdc.balanceOf(USER), userBefore - amount, "user delta != amount");
        assertEq(usdc.balanceOf(address(usdcPortal)) - portalBefore, amount, "portal deposit != amount");
        assertEq(usdc.balanceOf(address(router)), 0, "router retained tokens");
    }

    /// For ANY affordable total and ANY partial split, the fueled bridge deposits total−fuel to
    /// the token portal, swaps exactly fuel, lands the reported output in the fee portal, and
    /// strands nothing anywhere.
    function check_bridgeWithFuel_conservesUserFunds(uint128 totalRaw, uint128 fuelRaw) public {
        uint256 total = bound(uint256(totalRaw), 2, USER_BALANCE);
        uint256 fuel = bound(uint256(fuelRaw), 1, total - 1);
        uint256 userBefore = usdc.balanceOf(USER);
        uint256 portalBefore = usdc.balanceOf(address(usdcPortal));
        uint256 feePortalBefore = fj.balanceOf(address(feePortal));

        vm.prank(USER);
        router.bridgeWithFuel(_fuelParams(address(usdc), address(usdcPortal), total, fuel, false), _permit());

        assertEq(usdc.balanceOf(USER), userBefore - total, "user delta != total");
        assertEq(usdc.balanceOf(address(usdcPortal)) - portalBefore, total - fuel, "token leg != total - fuel");
        assertEq(fj.balanceOf(address(feePortal)) - feePortalBefore, 1 ether, "fuel leg != reported output");
        assertEq(usdc.balanceOf(address(router)), 0, "router retained bridge token");
        assertEq(fj.balanceOf(address(router)), 0, "router retained fee juice");
    }

    /// For ANY affordable total, a fuel-only intent swaps everything, deposits no token, and
    /// strands nothing.
    function check_bridgeWithFuel_fuelOnly_conservesUserFunds(uint128 totalRaw) public {
        uint256 total = bound(uint256(totalRaw), 1, USER_BALANCE);
        uint256 userBefore = usdc.balanceOf(USER);
        uint256 portalBefore = usdc.balanceOf(address(usdcPortal));
        uint256 feePortalBefore = fj.balanceOf(address(feePortal));
        uint256 swapBefore = usdc.balanceOf(address(swap));

        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), address(0), total, total, false);
        p.aztecRecipient = bytes32(0);
        p.tokenSecretHash = bytes32(0);
        vm.prank(USER);
        router.bridgeWithFuel(p, _permit());

        assertEq(usdc.balanceOf(USER), userBefore - total, "user delta != total");
        assertEq(usdc.balanceOf(address(swap)) - swapBefore, total, "swap input != total");
        assertEq(usdc.balanceOf(address(usdcPortal)), portalBefore, "a token leg ran");
        assertEq(fj.balanceOf(address(feePortal)) - feePortalBefore, 1 ether, "fuel leg != reported output");
        assertEq(usdc.balanceOf(address(router)), 0, "router retained bridge token");
        assertEq(fj.balanceOf(address(router)), 0, "router retained fee juice");
    }

    /// For ANY affordable fee-asset total and ANY split (partial or full), the identity swap
    /// lands exactly `fuel` in the fee portal and `total − fuel` in the fee asset's own portal,
    /// never touches the swap target, and strands nothing.
    function check_bridgeWithFuel_identity_conservesUserFunds(uint128 totalRaw, uint128 fuelRaw) public {
        uint256 total = bound(uint256(totalRaw), 1, USER_FJ);
        uint256 fuel = bound(uint256(fuelRaw), 1, total);
        uint256 userBefore = fj.balanceOf(USER);
        uint256 portalBefore = fj.balanceOf(address(fjPortal));
        uint256 feePortalBefore = fj.balanceOf(address(feePortal));
        uint256 swapBefore = fj.balanceOf(address(swap));

        SwapBridgeRouter.BridgeParams memory p =
            _fuelParams(address(fj), fuel == total ? address(0) : address(fjPortal), total, fuel, true);
        if (fuel == total) {
            p.aztecRecipient = bytes32(0);
            p.tokenSecretHash = bytes32(0);
        }
        vm.prank(USER);
        router.bridgeWithFuel(p, _permit());

        assertEq(fj.balanceOf(USER), userBefore - total, "user delta != total");
        assertEq(fj.balanceOf(address(feePortal)) - feePortalBefore, fuel, "fuel leg != fuel");
        assertEq(fj.balanceOf(address(fjPortal)) - portalBefore, total - fuel, "token leg != total - fuel");
        assertEq(fj.balanceOf(address(swap)), swapBefore, "swap target touched");
        assertEq(fj.balanceOf(address(router)), 0, "router retained fee juice");
    }

    /// ANY portal other than the factory's binding for the token is refused, on both entrypoints,
    /// before a single wei moves. (USDC is not the fee asset, so the FeeJuicePortal carve-out
    /// cannot apply.)
    function check_bridge_rejectsForeignPortal(address portal, uint128 amountRaw, bool fueled) public {
        vm.assume(portal != address(usdcPortal));
        uint256 amount = bound(uint256(amountRaw), 2, USER_BALANCE);
        uint256 userBefore = usdc.balanceOf(USER);

        vm.prank(USER);
        if (fueled) {
            try router.bridgeWithFuel(_fuelParams(address(usdc), portal, amount, 1, false), _permit()) {
                assertTrue(false, "fueled bridge accepted a foreign portal");
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), SwapBridgeRouter.ForeignPortal.selector, "rejected for the wrong reason");
            }
        } else {
            try router.bridge(_simple(address(usdc), portal, amount, false), _permit()) {
                assertTrue(false, "bridge accepted a foreign portal");
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), SwapBridgeRouter.ForeignPortal.selector, "rejected for the wrong reason");
            }
        }
        assertEq(usdc.balanceOf(USER), userBefore, "a rejected intent moved funds");
        assertEq(permit2.calls(), 0, "a rejected intent reached Permit2");
    }

    /// A partial fee-asset intent ("AZTEC + gas") can never name the FeeJuicePortal as its token
    /// portal — that would mint gas from the remainder — for ANY split and either privacy flag.
    function check_bridgeWithFuel_partialRejectsFeeJuicePortal(uint128 totalRaw, uint128 fuelRaw, bool isPrivate)
        public
    {
        uint256 total = bound(uint256(totalRaw), 2, USER_FJ);
        uint256 fuel = bound(uint256(fuelRaw), 1, total - 1);
        uint256 userBefore = fj.balanceOf(USER);

        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(fj), address(feePortal), total, fuel, true);
        p.isPrivate = isPrivate;
        vm.prank(USER);
        try router.bridgeWithFuel(p, _permit()) {
            assertTrue(false, "partial fee-asset intent entered the FeeJuicePortal");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), SwapBridgeRouter.ForeignPortal.selector, "rejected for the wrong reason");
        }
        assertEq(fj.balanceOf(USER), userBefore, "a rejected intent moved funds");
        assertEq(permit2.calls(), 0, "a rejected intent reached Permit2");
    }

    /// Authority boundary: sweep is unreachable for any non-owner, and a failed attempt mutates
    /// nothing. The unwanted-success branch MUST signal with assertTrue(false): halmos only
    /// detects forge-std assertion failures and EVM panics, so a `revert(string)` there would be
    /// indistinguishable from the guarded revert under proof. The recipient is a fixed literal
    /// rather than `caller`: a zero caller would trip sweep's own `to != 0` require and mask an
    /// unauthorized success.
    function check_sweep_revertsForNonOwner(address caller) public {
        vm.assume(caller != router.owner());
        usdc.mint(address(router), 5 * 1e6);
        uint256 balBefore = usdc.balanceOf(address(router));
        vm.prank(caller);
        try router.sweep(address(usdc), SWEEP_SINK) {
            assertTrue(false, "sweep succeeded for a non-owner");
        } catch {
            assertEq(usdc.balanceOf(address(router)), balBefore, "rejected sweep mutated state");
        }
    }

    /// Authority boundary: swap-target rotation is unreachable for any non-owner.
    function check_setSwapTarget_revertsForNonOwner(address caller) public {
        vm.assume(caller != router.owner());
        address before = address(router.swapTarget());
        MockSwap next = new MockSwap(IERC20(address(fj)));
        vm.prank(caller);
        try router.setSwapTarget(address(next)) {
            assertTrue(false, "setSwapTarget succeeded for a non-owner");
        } catch {
            assertEq(address(router.swapTarget()), before, "rejected rotation mutated state");
        }
    }

    // ── Canaries (forge) ─────────────────────────────────────────────────────────────────

    /// Mutation: with the portal rule deleted, the foreign-portal proof's body reaches its failure
    /// branch — a foreign portal is accepted and the pull happens.
    function test_canary_rejectsForeignPortal_failsWithoutTheGuard() public {
        RouterWithoutPortalRule mutant =
            new RouterWithoutPortalRule(address(permit2), address(feePortal), address(swap), address(factory));
        MockTokenPortal foreign = new MockTokenPortal(IERC20(address(usdc)));
        vm.prank(USER);
        mutant.bridge(_simple(address(usdc), address(foreign), 5 * 1e6, false), _permit());
        assertEq(foreign.lastAmount(), 5 * 1e6, "the mutant must accept what the proof forbids");
        assertEq(permit2.calls(), 1);
    }

    /// Mutation: with the portal rule deleted, a partial fee-asset intent enters the FeeJuicePortal.
    function test_canary_partialRejectsFeeJuicePortal_failsWithoutTheGuard() public {
        RouterWithoutPortalRule mutant =
            new RouterWithoutPortalRule(address(permit2), address(feePortal), address(swap), address(factory));
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(fj), address(feePortal), 10 ether, 4 ether, true);
        vm.prank(USER);
        mutant.bridgeWithFuel(p, _permit());
        assertEq(feePortal.lastAmount(), 6 ether, "the remainder was minted as gas");
    }

    /// The factory's OWN portal is accepted: the foreign-portal proof is not vacuous.
    function test_canary_factoryPortalAccepted() public {
        vm.prank(USER);
        router.bridge(_simple(address(usdc), address(usdcPortal), 5 * 1e6, false), _permit());
        assertEq(usdcPortal.lastAmount(), 5 * 1e6);
        assertEq(permit2.calls(), 1);
    }

    /// A FULL fee-asset intent through the FeeJuicePortal is the legal direct-gas path on
    /// `bridge()` — so the partial rejection is about the split, not the portal.
    function test_canary_fullFeeAssetIntoFeeJuicePortalAccepted() public {
        vm.prank(USER);
        router.bridge(_simple(address(fj), address(feePortal), 3 ether, false), _permit());
        assertEq(feePortal.lastAmount(), 3 ether);
    }

    /// Fuel-only with a token-leg field set is refused: the fuel-only proof exercises the gate.
    function test_canary_fuelOnlyWithTokenLegRefused() public {
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), address(usdcPortal), 7, 7, false);
        vm.prank(USER);
        vm.expectRevert(SwapBridgeRouter.FuelOnlyLeg.selector);
        router.bridgeWithFuel(p, _permit());
    }

    /// An empty route for a non-fee token is refused: the identity proof's premise is enforced.
    function test_canary_identityRefusedForOtherTokens() public {
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), address(usdcPortal), 10, 3, true);
        vm.prank(USER);
        vm.expectRevert(SwapBridgeRouter.RouteRequired.selector);
        router.bridgeWithFuel(p, _permit());
    }

    /// The owner CAN sweep and rotate: the authority proofs are not blind to success.
    function test_canary_ownerCanSweepAndRotate() public {
        usdc.mint(address(router), 5 * 1e6);
        router.sweep(address(usdc), SWEEP_SINK);
        assertEq(usdc.balanceOf(SWEEP_SINK), 5 * 1e6);
        MockSwap next = new MockSwap(IERC20(address(fj)));
        router.setSwapTarget(address(next));
        assertEq(address(router.swapTarget()), address(next));
    }
}
