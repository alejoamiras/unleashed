// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SwapBridgeRouter, IUniswapFuelSwap} from "../src/SwapBridgeRouter.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {RouterFixture} from "./mocks/RouterFixture.sol";
import {MaliciousPrefundSwap} from "./mocks/RouterMocks.sol";
import {FeeOnTransferERC20} from "./mocks/MetadataERC20s.sol";

contract SwapBridgeRouterTest is RouterFixture {
    function setUp() public {
        _deployStack(6, 1_000_000_000);
        usdc.mint(address(this), 10_000 * 1e6);
        usdc.approve(address(permit2), type(uint256).max);
        fj.mint(address(this), 1_000 ether);
        fj.approve(address(permit2), type(uint256).max);
    }

    function _fuel(bool isPrivate) internal view returns (SwapBridgeRouter.BridgeParams memory) {
        return _fuelParams(address(usdc), 1000 * 1e6, 100 * 1e6, isPrivate);
    }

    // ── Fueled bridge ───────────────────────────────────────────────────────────────────────

    function test_bridgeWithFuelPublic_createsPortalAndSplits() public {
        swap.setOutput(5 ether, 0);
        assertEq(factory.portalOf(address(usdc)), address(0), "portal must not exist yet");
        router.bridgeWithFuel(_fuel(false), _permit(1));

        assertEq(factory.portalOf(address(usdc)), portalFor(address(usdc)), "router created the portal");
        assertEq(portalBalance(address(usdc)), 900 * 1e6, "token leg = total - fuel");
        assertTrue(lastMintWasPublic(RECIPIENT, 900 * 1e6), "public mint content");
        assertEq(feePortal.lastAmount(), 5 ether);
        assertEq(feePortal.lastTo(), FUEL_RECIPIENT);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(fj.balanceOf(address(router)), 0);
    }

    function test_bridgeWithFuelPrivate() public {
        swap.setOutput(5 ether, 0);
        router.bridgeWithFuel(_fuel(true), _permit(1));
        assertEq(portalBalance(address(usdc)), 900 * 1e6);
        assertTrue(lastMintWasPrivate(900 * 1e6), "private mint content");
    }

    function test_bridgeWithFuel_knownPortalIsReused() public {
        swap.setOutput(5 ether, 0);
        address portal = factory.createPortal(address(usdc));
        uint256 registers = inbox.sent();
        router.bridgeWithFuel(_fuel(false), _permit(1));
        assertEq(factory.portalOf(address(usdc)), portal);
        assertEq(inbox.sent(), registers + 1, "exactly one deposit message, no second register");
    }

    function test_balanceMismatchGuardReverts() public {
        swap.setOutput(5 ether, 4 ether);
        SwapBridgeRouter.BridgeParams memory hp = _fuel(false);
        vm.expectRevert(bytes("SwapBridgeRouter: balance mismatch"));
        router.bridgeWithFuel(hp, _permit(1));
    }

    function test_insufficientFuelReverts() public {
        swap.setOutput(0.5 ether, 0);
        SwapBridgeRouter.BridgeParams memory hp = _fuel(false);
        vm.expectRevert(bytes("SwapBridgeRouter: insufficient fuel"));
        router.bridgeWithFuel(hp, _permit(1));
    }

    function test_prefundedTargetNotConsumingSliceReverts() public {
        MaliciousPrefundSwap evil = new MaliciousPrefundSwap(IERC20(address(fj)));
        fj.mint(address(evil), 100 ether);
        router.setSwapTarget(address(evil));
        SwapBridgeRouter.BridgeParams memory hp = _fuel(false);
        vm.expectRevert(bytes("SwapBridgeRouter: fuel not consumed"));
        router.bridgeWithFuel(hp, _permit(1));
    }

    function test_permit2RejectionReverts() public {
        permit2.setRevert(true);
        swap.setOutput(5 ether, 0);
        SwapBridgeRouter.BridgeParams memory hp = _fuel(false);
        vm.expectRevert(bytes("MockPermit2: bad signature"));
        router.bridgeWithFuel(hp, _permit(1));
    }

    function test_zeroFuelReverts() public {
        SwapBridgeRouter.BridgeParams memory p = _fuel(false);
        p.fuelAmount = 0;
        vm.expectRevert(bytes("SwapBridgeRouter: invalid fuelAmount"));
        router.bridgeWithFuel(p, _permit(1));
    }

    // ── The portal is derived from the token, never taken from calldata ───────────────────────────────────────────

    function test_bridge_foreignPortalRevertsBeforeAnyPull() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(usdc), 500 * 1e6, false);
        p.tokenPortal = address(0xDEAD);
        vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
        router.bridge(p, _permit(1));
        assertEq(permit2.calls(), 0, "a rejected intent must not pull");
        assertEq(factory.portalOf(address(usdc)), address(0), "nor create");
    }

    function test_bridgeWithFuel_foreignPortalRevertsBeforeAnyPull() public {
        SwapBridgeRouter.BridgeParams memory p = _fuel(false);
        p.tokenPortal = address(feePortal);
        vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
        router.bridgeWithFuel(p, _permit(1));
        assertEq(permit2.calls(), 0);
    }

    function test_bridge_zeroPortalIsForeign() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(usdc), 500 * 1e6, false);
        p.tokenPortal = address(0);
        vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
        router.bridge(p, _permit(1));
    }

    /// A token the factory refuses (no `decimals()`) cannot be bridged — the create reverts first.
    function test_bridge_unbridgeableTokenRevertsAtCreate() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(feePortal), 1, false);
        vm.expectRevert(IPortalFactory.NoDecimals.selector);
        router.bridge(p, _permit(1));
        assertEq(permit2.calls(), 0);
    }

    function test_bridge_directGas_feeAssetIntoFeeJuicePortal() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(fj), 3 ether, false);
        p.tokenPortal = address(feePortal);
        router.bridge(p, _permit(1));
        assertEq(feePortal.lastAmount(), 3 ether);
        assertEq(feePortal.lastTo(), RECIPIENT);
        assertEq(factory.portalOf(address(fj)), address(0), "direct gas needs no clone");
        assertEq(fj.balanceOf(address(router)), 0);
    }

    /// The FeeJuicePortal has no private deposit, so a private fee-asset bridge must use a clone.
    function test_bridge_privateFeeAssetRejectsFeeJuicePortal() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(fj), 3 ether, true);
        p.tokenPortal = address(feePortal);
        vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
        router.bridge(p, _permit(1));

        // Through its own clone it works (wrapped AZTEC on L2).
        p.tokenPortal = portalFor(address(fj));
        router.bridge(p, _permit(2));
        assertEq(portalBalance(address(fj)), 3 ether);
        assertTrue(lastMintWasPrivate(3 ether));
    }

    /// A non-fee token can never name the FeeJuicePortal, on either entrypoint.
    function test_feeJuicePortalRejectedForOtherTokens() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(usdc), 500 * 1e6, false);
        p.tokenPortal = address(feePortal);
        vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
        router.bridge(p, _permit(1));
    }

    // ── Fuel-only ───────────────────────────────────────────────────────────────────────────

    function test_bridgeWithFuel_fuelOnly() public {
        swap.setOutput(5 ether, 0);
        SwapBridgeRouter.BridgeParams memory p = _fuel(false);
        p.fuelAmount = p.totalAmount;
        p.tokenPortal = address(0);
        p.aztecRecipient = bytes32(0);
        p.tokenSecretHash = bytes32(0);

        vm.expectEmit(true, true, true, true, address(router));
        emit SwapBridgeRouter.BridgeWithFuel(bytes32(0), bytes32(0), 0, 0, bytes32(0), bytes32(uint256(0xFEE)), 0, 5 ether, SECRET, false);
        router.bridgeWithFuel(p, _permit(1));

        assertEq(feePortal.lastAmount(), 5 ether);
        assertEq(factory.portalOf(address(usdc)), address(0), "fuel-only creates no portal");
        assertEq(usdc.balanceOf(address(swap)), 1000 * 1e6, "the whole amount was swapped");
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_bridgeWithFuel_fuelOnlyRejectsTokenLegFields() public {
        SwapBridgeRouter.BridgeParams memory p = _fuel(false);
        p.fuelAmount = p.totalAmount;
        p.aztecRecipient = bytes32(0);
        p.tokenSecretHash = bytes32(0);
        vm.expectRevert(SwapBridgeRouter.FuelOnlyLeg.selector); // tokenPortal still set
        router.bridgeWithFuel(p, _permit(1));

        p.tokenPortal = address(0);
        p.aztecRecipient = RECIPIENT;
        vm.expectRevert(SwapBridgeRouter.FuelOnlyLeg.selector);
        router.bridgeWithFuel(p, _permit(1));

        p.aztecRecipient = bytes32(0);
        p.tokenSecretHash = SECRET;
        vm.expectRevert(SwapBridgeRouter.FuelOnlyLeg.selector);
        router.bridgeWithFuel(p, _permit(1));
        assertEq(permit2.calls(), 0);
    }

    // ── Identity swap (the fee asset needs no route) ────────────────────────────────────────

    function test_bridgeWithFuel_identity_partialAztecPlusGas() public {
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _noRoute();
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(fj), 10 ether, 4 ether, true);
        p.path = path;
        p.zeroForOnes = dirs;
        p.minFuelOutput = 4 ether;
        router.bridgeWithFuel(p, _permit(1));

        assertEq(feePortal.lastAmount(), 4 ether, "fuel leg passes through 1:1");
        assertEq(feePortal.lastTo(), FUEL_RECIPIENT);
        assertEq(portalBalance(address(fj)), 6 ether, "remainder into the fee asset's own clone");
        assertTrue(lastMintWasPrivate(6 ether));
        assertEq(usdc.balanceOf(address(swap)), 0, "the swap target was never involved");
        assertEq(fj.balanceOf(address(router)), 0);
    }

    function test_bridgeWithFuel_identity_fuelOnly() public {
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _noRoute();
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(fj), 10 ether, 10 ether, false);
        p.path = path;
        p.zeroForOnes = dirs;
        p.tokenPortal = address(0);
        p.aztecRecipient = bytes32(0);
        p.tokenSecretHash = bytes32(0);
        p.minFuelOutput = 10 ether;
        router.bridgeWithFuel(p, _permit(1));
        assertEq(feePortal.lastAmount(), 10 ether);
        assertEq(fj.balanceOf(address(router)), 0);
    }

    function test_bridgeWithFuel_identityRejectedForOtherTokens() public {
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _noRoute();
        SwapBridgeRouter.BridgeParams memory p = _fuel(false);
        p.path = path;
        p.zeroForOnes = dirs;
        vm.expectRevert(SwapBridgeRouter.RouteRequired.selector);
        router.bridgeWithFuel(p, _permit(1));
        assertEq(permit2.calls(), 0);
    }

    function test_bridgeWithFuel_identityHonorsSignedFloor() public {
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _noRoute();
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(fj), 10 ether, 4 ether, false);
        p.path = path;
        p.zeroForOnes = dirs;
        p.minFuelOutput = 4 ether + 1;
        vm.expectRevert(bytes("SwapBridgeRouter: insufficient fuel"));
        router.bridgeWithFuel(p, _permit(1));
    }

    // ── Caps + exact-in ─────────────────────────────────────────────────────────────────────

    function test_amountAboveU128Rejected() public {
        SwapBridgeRouter.SimpleBridgeParams memory sp = _simpleParams(address(usdc), uint256(type(uint128).max) + 1, false);
        vm.expectRevert(SwapBridgeRouter.AmountExceedsL2Max.selector);
        router.bridge(sp, _permit(1));

        SwapBridgeRouter.BridgeParams memory fp = _fuel(false);
        fp.totalAmount = uint256(type(uint128).max) + 1;
        vm.expectRevert(SwapBridgeRouter.AmountExceedsL2Max.selector);
        router.bridgeWithFuel(fp, _permit(1));
        assertEq(permit2.calls(), 0);
    }

    /// A fee-on-transfer token is refused at the router's own exact-in check on the Permit2 pull,
    /// before any leg runs. (A direct clone deposit is refused by the clone's — PortalFactory.t.sol.)
    function test_bridge_feeOnTransferRejected() public {
        FeeOnTransferERC20 tax = new FeeOnTransferERC20(100);
        tax.mint(address(this), 1000 ether);
        tax.approve(address(permit2), type(uint256).max);
        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(tax), 100 ether, false);
        vm.expectRevert(SwapBridgeRouter.InexactPull.selector);
        router.bridge(p, _permit(1));
        assertEq(tax.balanceOf(address(this)), 1000 ether, "nothing left the user");
    }

    /// Guardian pause propagates: the clone refuses the deposit, the router reverts whole.
    function test_bridge_revertsWhileDepositsPaused() public {
        vm.prank(guardian);
        factory.setPaused(true, false);
        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(usdc), 500 * 1e6, false);
        vm.expectRevert(TokenPortalImpl.DepositsPaused.selector);
        router.bridge(p, _permit(1));
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    // ── Plain bridge ────────────────────────────────────────────────────────────────────────

    function test_simpleBridgePublic() public {
        router.bridge(_simpleParams(address(usdc), 500 * 1e6, false), _permit(1));
        assertEq(portalBalance(address(usdc)), 500 * 1e6);
        assertTrue(lastMintWasPublic(RECIPIENT, 500 * 1e6));
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_simpleBridgePrivate() public {
        router.bridge(_simpleParams(address(usdc), 500 * 1e6, true), _permit(1));
        assertTrue(lastMintWasPrivate(500 * 1e6));
    }

    function test_sweepOnlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        router.sweep(address(usdc), address(0xBEEF));
    }

    // ── Gas (metered around the router call only; pinned in .gas-snapshot) ─────────────────

    /// A token's first bridge pays for the clone + the register message; every later bridge of
    /// that token pays only the deposit. The delta is the whole cost of "no pre-deploy step".
    function test_gas_bridge_firstTime() public {
        vm.pauseGasMetering();
        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(usdc), 500 * 1e6, false);
        SwapBridgeRouter.PermitParams memory permit = _permit(1);
        vm.resumeGasMetering();
        router.bridge(p, permit);
    }

    function test_gas_bridge_known() public {
        vm.pauseGasMetering();
        factory.createPortal(address(usdc));
        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(usdc), 500 * 1e6, false);
        SwapBridgeRouter.PermitParams memory permit = _permit(1);
        vm.resumeGasMetering();
        router.bridge(p, permit);
    }
}
