// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SwapBridgeRouter, IUniswapFuelSwap} from "../src/SwapBridgeRouter.sol";
import {WitnessHarness} from "./WitnessHash.t.sol";
import {RouterFixture} from "./mocks/RouterFixture.sol";
import {ConfigurableSwap} from "./mocks/RouterMocks.sol";

contract SwapBridgeRouterFuzzTest is RouterFixture {
    WitnessHarness harness;
    uint256 constant U128_MAX = type(uint128).max;

    function setUp() public {
        // decimals=0 + a 2^128-1 whole-token cap ⇒ a single mint() can fund any fuzzed
        // amount in [1, 2^128) without looping.
        _deployStack(0, U128_MAX);
        harness = new WitnessHarness();
        usdc.approve(address(permit2), type(uint256).max);
        fj.approve(address(permit2), type(uint256).max);
    }

    function _baseWitness() internal view returns (SwapBridgeRouter.BridgeWitness memory w) {
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _route();
        w = SwapBridgeRouter.BridgeWitness({
            tokenPortal: address(uint160(0x1111)),
            bridgeToken: address(uint160(0x2222)),
            totalAmount: 1_000_000,
            fuelAmount: 100_000,
            aztecRecipient: bytes32(uint256(0x1234)),
            fuelRecipient: bytes32(uint256(0x5678)),
            tokenSecretHash: bytes32(uint256(0x5EC7)),
            fuelSecretHash: bytes32(uint256(0xFEE)),
            minFuelOutput: 1 ether,
            routeHash: harness.hRoute(path, dirs),
            isPrivate: false,
            swapTarget: address(uint160(0x9ABC))
        });
    }

    // 1. Every one of the 12 witness fields must bind: mutating exactly one changes the hash.
    //    A field that hashes-but-doesn't-bind is invisible to the fixed-vector pin (WitnessHash.t.sol).
    function testFuzz_witnessTamperChangesHash(uint256 delta, uint8 whichRaw) public view {
        uint8 which = whichRaw % 12;
        SwapBridgeRouter.BridgeWitness memory w = _baseWitness();
        bytes32 base = harness.hWitness(w);

        if (which == 10) {
            w.isPrivate = !w.isPrivate; // bool: the flip is the mutation
        } else {
            vm.assume(delta != 0);
            // Address fields keep only the low 160 bits — a delta set only in the high bits would XOR
            // away under truncation, a silent non-mutation that would falsely pass. Require low 160 bits.
            if (which == 0 || which == 1 || which == 11) vm.assume(uint160(delta) != 0);
            if (which == 0) w.tokenPortal = address(uint160(uint256(uint160(w.tokenPortal)) ^ delta));
            else if (which == 1) w.bridgeToken = address(uint160(uint256(uint160(w.bridgeToken)) ^ delta));
            else if (which == 2) w.totalAmount ^= delta;
            else if (which == 3) w.fuelAmount ^= delta;
            else if (which == 4) w.aztecRecipient = bytes32(uint256(w.aztecRecipient) ^ delta);
            else if (which == 5) w.fuelRecipient = bytes32(uint256(w.fuelRecipient) ^ delta);
            else if (which == 6) w.tokenSecretHash = bytes32(uint256(w.tokenSecretHash) ^ delta);
            else if (which == 7) w.fuelSecretHash = bytes32(uint256(w.fuelSecretHash) ^ delta);
            else if (which == 8) w.minFuelOutput ^= delta;
            else if (which == 9) w.routeHash = bytes32(uint256(w.routeHash) ^ delta);
            else if (which == 11) w.swapTarget = address(uint160(uint256(uint160(w.swapTarget)) ^ delta));
        }
        assertTrue(harness.hWitness(w) != base, "witness field does not bind");
    }

    // 2. bridge() over the whole u128 domain: the clone receives EXACTLY `amount`, the message
    //    carries the same, and the router retains zero residue (residue == owner-sweepable ==
    //    the theft-shaped failure mode).
    function testFuzz_bridgeAccounting(uint256 amount, bool isPrivate) public {
        amount = bound(amount, 1, U128_MAX);
        usdc.mint(address(this), amount);

        router.bridge(_simpleParams(address(usdc), amount, isPrivate), _permit(1));

        assertEq(portalBalance(address(usdc)), amount, "portal amount mismatch");
        assertTrue(isPrivate ? lastMintWasPrivate(amount) : lastMintWasPublic(RECIPIENT, amount), "message mismatch");
        assertEq(usdc.balanceOf(address(router)), 0, "token residue");
        assertEq(usdc.allowance(address(router), portalFor(address(usdc))), 0, "allowance residue");
    }

    // 3. The fuel split boundary: over 0 < fuel < total the slices conserve exactly and leave zero
    //    residue. Integer edges (total==2/fuel==1, fuel==total-1) are the strand-a-wei risk.
    function testFuzz_fuelSplit(uint256 total, uint256 fuel) public {
        total = bound(total, 2, U128_MAX);
        fuel = bound(fuel, 1, total - 1);
        usdc.mint(address(this), total);
        swap.setOutput(1, 0); // returns 1 wei FJ, >= the 1-wei floor below; pulls exactly `fuel`

        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), total, fuel, false);
        p.minFuelOutput = 1;
        router.bridgeWithFuel(p, _permit(1));

        assertEq(portalBalance(address(usdc)), total - fuel, "bridge slice mismatch");
        assertTrue(lastMintWasPublic(RECIPIENT, total - fuel), "message mismatch");
        assertEq(feePortal.lastAmount(), 1, "fuel slice mismatch");
        assertEq(usdc.balanceOf(address(router)), 0, "token residue");
        assertEq(fj.balanceOf(address(router)), 0, "fj residue");
    }

    // 4. Fuel-only over the whole domain: everything is swapped, nothing is deposited as a token,
    //    no portal is created, zero residue.
    function testFuzz_fuelOnly(uint256 total) public {
        total = bound(total, 1, U128_MAX);
        usdc.mint(address(this), total);
        swap.setOutput(1, 0);

        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), total, total, false);
        p.tokenPortal = address(0);
        p.aztecRecipient = bytes32(0);
        p.tokenSecretHash = bytes32(0);
        p.minFuelOutput = 1;
        router.bridgeWithFuel(p, _permit(1));

        assertEq(factory.portalOf(address(usdc)), address(0), "fuel-only created a portal");
        assertEq(usdc.balanceOf(address(swap)), total, "swap target != total");
        assertEq(feePortal.lastAmount(), 1);
        assertEq(usdc.balanceOf(address(router)), 0, "token residue");
    }

    // 5. Identity swap over the whole domain: the fee asset splits 1:1 into the fee portal and its
    //    own clone; the swap target is never touched.
    function testFuzz_identitySplit(uint128 totalRaw, uint128 fuelRaw, bool isPrivate) public {
        uint256 total = bound(uint256(totalRaw), 1, 1_000_000_000 ether);
        uint256 fuel = bound(uint256(fuelRaw), 1, total);
        fj.mint(address(this), total);
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _noRoute();

        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(fj), total, fuel, isPrivate);
        p.path = path;
        p.zeroForOnes = dirs;
        p.minFuelOutput = fuel;
        if (fuel == total) {
            p.tokenPortal = address(0);
            p.aztecRecipient = bytes32(0);
            p.tokenSecretHash = bytes32(0);
        }
        uint256 swapBefore = fj.balanceOf(address(swap));
        router.bridgeWithFuel(p, _permit(1));

        assertEq(feePortal.lastAmount(), fuel, "fuel leg != fuel");
        assertEq(portalBalance(address(fj)), total - fuel, "token leg != total - fuel");
        assertEq(fj.balanceOf(address(swap)), swapBefore, "swap target touched");
        assertEq(fj.balanceOf(address(router)), 0, "fj residue");
    }

    // 6. Generalize MaliciousPrefundSwap to the full behavior lattice of the owner-replaceable target:
    //    bridgeWithFuel succeeds IFF the swap consumed exactly fuelAmount, returned >= the signed floor,
    //    AND actually transferred >= what it returned. Any other combination must revert (no residue theft).
    function testFuzz_hostileSwapConsumption(uint256 consumed, uint256 returned, uint256 transferred) public {
        uint256 total = 1_000_000;
        uint256 fuel = 100_000;
        uint256 floor = 5 ether;
        consumed = bound(consumed, 0, fuel); // approval caps the pull at fuelAmount
        returned = bound(returned, 0, 50 ether);
        transferred = bound(transferred, 0, 50 ether);

        ConfigurableSwap evil = new ConfigurableSwap(IERC20(address(fj)));
        fj.mint(address(evil), 100 ether);
        router.setSwapTarget(address(evil));
        evil.set(consumed, returned, transferred);
        usdc.mint(address(this), total);

        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), total, fuel, false);
        p.minFuelOutput = floor;

        bool shouldSucceed = (consumed == fuel && returned >= floor && transferred >= returned);
        if (shouldSucceed) {
            router.bridgeWithFuel(p, _permit(1));
            // The user's input token is FULLY consumed (no user-fund residue), and the router deposits
            // EXACTLY what the swap returned. A swap that over-transfers donates the excess FJ, which
            // strands as owner-sweepable residue (== transferred - returned) — the swap's loss, never
            // the user's; the router deposits `fuelReceived`, not the whole balance delta.
            assertEq(usdc.balanceOf(address(router)), 0, "token residue on success");
            assertEq(feePortal.lastAmount(), returned, "router bridged != returned");
            assertEq(fj.balanceOf(address(router)), transferred - returned, "fj residue != swap over-donation");
        } else {
            vm.expectRevert();
            router.bridgeWithFuel(p, _permit(1));
        }
    }

    // 7. The portal is derived from the token: ANY caller-named portal other than the factory's is
    //    rejected before a single wei moves, on both entrypoints. (The old generic-router phishing
    //    surface — a non-pulling portal stranding the pull in the router — no longer exists.)
    function testFuzz_foreignPortalRejectedBeforePull(address portal, uint256 amount, bool fueled) public {
        vm.assume(portal != portalFor(address(usdc)));
        amount = bound(amount, 2, U128_MAX);
        usdc.mint(address(this), amount);

        if (fueled) {
            SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), amount, 1, false);
            p.tokenPortal = portal;
            vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
            router.bridgeWithFuel(p, _permit(1));
        } else {
            SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(usdc), amount, false);
            p.tokenPortal = portal;
            vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
            router.bridge(p, _permit(1));
        }
        assertEq(permit2.calls(), 0, "a rejected intent pulled");
        assertEq(usdc.balanceOf(address(this)), amount, "user balance moved");
        assertEq(factory.portalOf(address(usdc)), address(0), "a rejected intent created a portal");
    }
}
