// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {DepositRouter} from "../src/DepositRouter.sol";
import {FuelOnlyGate} from "../src/FuelOnlyGate.sol";
import {MintableERC20} from "../src/MintableERC20.sol";
import {ILiFiSwap} from "../src/interfaces/ILiFiSwap.sol";
import {MockPermit2, MockFeeJuicePortal, FakePortalFactory} from "./mocks/CounterpartyMocks.sol";
import {MockLifiSwap} from "./mocks/DepositRouterMocks.sol";

/// SYMBOLIC checks for a `DepositRouter` bound to a `FuelOnlyGate` (run with `halmos`, not forge): function arguments
/// are symbolic, so each check proves its property over the WHOLE input domain.
///
///   check_gate_refusesEveryTokenLeg              — ∀ token-leg shape, split, privacy and entrypoint: reverts, nothing moves
///   check_gate_pausedRefusesFuelOnly             — ∀ fuel-only amount, venue and entrypoint: a paused gate refuses
///   check_gate_setDepositsPaused_revertsForNonOwner — no caller but the guardian can flip the bit
///
/// Same counterparties as `FormalDepositRouter` (success-always Permit2, `MockLifiSwap` with the facet's semantics).
/// Failure is signalled with assertions only. The forge canaries run each proof's body against a router bound to an
/// honest factory, where it must fail on its property assertion, and witness that fuel-only settles through the
/// gate, so neither proof is vacuous.
contract FormalFuelOnlyGateTest is Test {
    MintableERC20 internal usdc;
    MintableERC20 internal fj;
    MockPermit2 internal permit2;
    MockLifiSwap internal swap;
    MockFeeJuicePortal internal feePortal;
    FuelOnlyGate internal gate;
    DepositRouter internal router;

    address internal constant GUARDIAN = address(0x6A);
    address internal constant OWNER = address(0x0A11);
    address internal constant USER = address(0xDA0);
    address internal constant CALLER = address(0xCA11);
    bytes32 internal constant RECIPIENT = bytes32(uint256(0x1234));
    bytes32 internal constant FUEL_RECIPIENT = bytes32(uint256(0x5678));
    bytes32 internal constant SECRET = bytes32(uint256(0x5EC7E7));
    bytes32 internal constant FUEL_SECRET = bytes32(uint256(0xF5EC7E7));
    bytes32 internal constant TX_ID = bytes32(uint256(0x7D));
    uint256 internal constant CAP = 1e15;
    uint256 internal constant FUEL_OUT = 1 ether;

    uint8 internal constant PLAIN = 0;
    uint8 internal constant FUELED = 1;
    uint8 internal constant IDENTITY = 2;

    string internal constant TOKEN_LEG_ACCEPTED = "a token leg settled through the gate";
    string internal constant PAUSED_ACCEPTED = "a fuel-only deposit landed while the gate was paused";

    function setUp() public {
        usdc = new MintableERC20("USDC", "USDC", 6, 1_000_000_000);
        fj = new MintableERC20("FeeJuice", "FJ", 18, 1_000_000_000);
        permit2 = new MockPermit2();
        swap = new MockLifiSwap(IERC20(address(fj)));
        feePortal = new MockFeeJuicePortal(IERC20(address(fj)));
        gate = new FuelOnlyGate(GUARDIAN);
        router = new DepositRouter(address(permit2), address(feePortal), address(gate), address(swap), OWNER);

        usdc.mint(USER, CAP);
        fj.mint(USER, CAP);
        fj.mint(address(swap), 1_000_000 ether);
        vm.startPrank(USER);
        usdc.approve(address(permit2), type(uint256).max);
        fj.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
        swap.set(type(uint256).max, FUEL_OUT);
    }

    // ── Builders ─────────────────────────────────────────────────────────────────────────

    function _swapData(DepositRouter r, uint256 slice) internal view returns (bytes memory) {
        ILiFiSwap.SwapData memory step = ILiFiSwap.SwapData({
            callTo: address(0xDE7),
            approveTo: address(0xDE7),
            sendingAssetId: address(usdc),
            receivingAssetId: address(fj),
            fromAmount: slice,
            callData: "",
            requiresDeposit: true
        });
        return abi.encodeCall(
            ILiFiSwap.swapTokensSingleV3ERC20ToERC20, (TX_ID, "unleashed", "", payable(address(r)), FUEL_OUT, step)
        );
    }

    /// A token leg: USDC alone, USDC plus a swapped slice, or the fee asset with a slice passed 1:1.
    function _tokenLegIntent(DepositRouter r, uint8 shape, uint256 slice, bool isPrivate)
        internal
        view
        returns (DepositRouter.DepositIntent memory i, bytes memory swapData, MintableERC20 token)
    {
        token = shape == IDENTITY ? fj : usdc;
        i.token = address(token);
        i.tokenSecretHash = SECRET;
        i.isPrivate = isPrivate;
        i.aztecRecipient = isPrivate ? bytes32(0) : RECIPIENT;
        if (shape == PLAIN) return (i, swapData, token);
        i.fuelSlice = slice;
        i.fuelRecipient = FUEL_RECIPIENT;
        i.fuelSecretHash = FUEL_SECRET;
        if (shape == IDENTITY) {
            i.minFuelOutput = slice;
        } else {
            i.minFuelOutput = FUEL_OUT;
            swapData = _swapData(r, slice);
        }
    }

    function _fuelOnlyIntent(DepositRouter r, bool identity, uint256 amount)
        internal
        view
        returns (DepositRouter.DepositIntent memory i, bytes memory swapData, MintableERC20 token)
    {
        token = identity ? fj : usdc;
        i.token = address(token);
        i.fuelSlice = amount;
        i.fuelRecipient = FUEL_RECIPIENT;
        i.fuelSecretHash = FUEL_SECRET;
        i.minFuelOutput = identity ? amount : FUEL_OUT;
        if (!identity) swapData = _swapData(r, amount);
    }

    /// The permit path pays from USER's standing balance; the caller path mints `amount` to CALLER and approves `r`.
    function _fund(DepositRouter r, bool viaPermit, MintableERC20 token, uint256 amount)
        internal
        returns (address payer)
    {
        if (viaPermit) return USER;
        token.mint(CALLER, amount);
        vm.prank(CALLER);
        token.approve(address(r), type(uint256).max);
        return CALLER;
    }

    /// Runs one entrypoint under try; true when it settled.
    function _trySend(
        DepositRouter r,
        bool viaPermit,
        DepositRouter.DepositIntent memory i,
        bytes memory swapData,
        uint256 amount
    ) internal returns (bool ok) {
        if (viaPermit) {
            vm.prank(USER);
            try r.bridgeWithPermit(
                i,
                swapData,
                amount,
                DepositRouter.PermitParams({nonce: 1, deadline: type(uint256).max, signature: hex"00"})
            ) {
                return true;
            } catch {
                return false;
            }
        }
        vm.prank(CALLER);
        try r.bridgeFromCaller(i, swapData, amount, amount) {
            return true;
        } catch {
            return false;
        }
    }

    // ── Proofs ───────────────────────────────────────────────────────────────────────────

    /// For ANY token-leg shape, split, privacy flag and entrypoint, the gated router refuses, and the payer, the
    /// venue and the FeeJuicePortal are exactly as before.
    function check_gate_refusesEveryTokenLeg(
        uint8 shape,
        uint128 amountRaw,
        uint128 sliceRaw,
        bool isPrivate,
        bool viaPermit
    ) public {
        vm.assume(shape <= IDENTITY);
        uint256 amount = amountRaw;
        uint256 slice = sliceRaw;
        vm.assume(amount >= 2 && amount <= CAP);
        if (shape != PLAIN) vm.assume(slice >= 1 && slice < amount);
        _refusesTokenLeg(router, shape, amount, slice, isPrivate, viaPermit);
    }

    function runRefusesTokenLeg(
        DepositRouter r,
        uint8 shape,
        uint256 amount,
        uint256 slice,
        bool isPrivate,
        bool viaPermit
    ) external {
        _refusesTokenLeg(r, shape, amount, slice, isPrivate, viaPermit);
    }

    function _refusesTokenLeg(
        DepositRouter r,
        uint8 shape,
        uint256 amount,
        uint256 slice,
        bool isPrivate,
        bool viaPermit
    ) internal {
        (DepositRouter.DepositIntent memory i, bytes memory sd, MintableERC20 t) =
            _tokenLegIntent(r, shape, slice, isPrivate);
        address payer = _fund(r, viaPermit, t, amount);
        uint256 payerBefore = t.balanceOf(payer);
        uint256 portalBefore = fj.balanceOf(address(feePortal));
        uint256 venueCalls = swap.calls();

        assertFalse(_trySend(r, viaPermit, i, sd, amount), TOKEN_LEG_ACCEPTED);
        assertEq(t.balanceOf(payer), payerBefore, "a refused token leg moved the payer's funds");
        assertEq(fj.balanceOf(address(feePortal)), portalBefore, "a refused token leg reached the FeeJuicePortal");
        assertEq(swap.calls(), venueCalls, "a refused token leg reached the venue");
    }

    /// For ANY fuel-only amount, venue and entrypoint, a paused gate refuses before anything moves.
    function check_gate_pausedRefusesFuelOnly(bool identity, uint128 amountRaw, bool viaPermit) public {
        uint256 amount = amountRaw;
        vm.assume(amount >= 1 && amount <= CAP);
        vm.prank(GUARDIAN);
        gate.setDepositsPaused(true);
        _pausedRefuses(router, identity, amount, viaPermit);
    }

    function runPausedRefuses(DepositRouter r, bool identity, uint256 amount, bool viaPermit) external {
        _pausedRefuses(r, identity, amount, viaPermit);
    }

    function _pausedRefuses(DepositRouter r, bool identity, uint256 amount, bool viaPermit) internal {
        (DepositRouter.DepositIntent memory i, bytes memory sd, MintableERC20 t) = _fuelOnlyIntent(r, identity, amount);
        address payer = _fund(r, viaPermit, t, amount);
        uint256 payerBefore = t.balanceOf(payer);
        uint256 portalBefore = fj.balanceOf(address(feePortal));

        assertFalse(_trySend(r, viaPermit, i, sd, amount), PAUSED_ACCEPTED);
        assertEq(t.balanceOf(payer), payerBefore, "a paused gate let the payer's funds move");
        assertEq(fj.balanceOf(address(feePortal)), portalBefore, "a paused gate let fee juice reach the portal");
    }

    /// ∀ caller ≠ guardian, ∀ bit: the call reverts with the Ownable error and the bit stays open.
    function check_gate_setDepositsPaused_revertsForNonOwner(address caller, bool paused) public {
        vm.assume(caller != GUARDIAN);
        vm.prank(caller);
        try gate.setDepositsPaused(paused) {
            assertTrue(false, "non-owner flipped the pause bit");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), Ownable.OwnableUnauthorizedAccount.selector, "rejected for the wrong reason");
            assertFalse(gate.depositsPaused(), "pause bit changed");
        }
    }

    // ── Canaries (forge) ─────────────────────────────────────────────────────────────────

    /// Mutation: the same token-leg bodies against a router bound to an honest factory settle, so the proof's
    /// refusal comes from the gate and not from a malformed intent.
    function test_canary_refusesTokenLeg_failsBehindAFactory() public {
        DepositRouter honest = _routerBehindFactory();
        for (uint8 shape = PLAIN; shape <= IDENTITY; shape++) {
            vm.expectRevert(bytes(TOKEN_LEG_ACCEPTED));
            this.runRefusesTokenLeg(honest, shape, 10e6, 4e6, shape == FUELED, shape != IDENTITY);
        }
    }

    /// Mutation: the paused body against an open factory settles, so the proof's refusal is the pause bit.
    function test_canary_pausedRefuses_failsWhenOpen() public {
        DepositRouter open = _routerBehindFactory();
        vm.expectRevert(bytes(PAUSED_ACCEPTED));
        this.runPausedRefuses(open, false, 10e6, true);
        vm.expectRevert(bytes(PAUSED_ACCEPTED));
        this.runPausedRefuses(open, true, 10e6, false);
    }

    /// Fuel-only settles through the open gate on both venues and both entrypoints.
    function test_canary_fuelOnlySettlesThroughTheGate() public {
        for (uint256 k; k < 4; k++) {
            bool identity = k < 2;
            bool viaPermit = k % 2 == 0;
            (DepositRouter.DepositIntent memory i, bytes memory sd, MintableERC20 t) =
                _fuelOnlyIntent(router, identity, 10e6);
            _fund(router, viaPermit, t, 10e6);
            assertTrue(_trySend(router, viaPermit, i, sd, 10e6), "fuel-only did not settle through the gate");
        }
        assertEq(feePortal.calls(), 4);
    }

    function test_canary_guardianCanPause() public {
        vm.prank(GUARDIAN);
        gate.setDepositsPaused(true);
        assertTrue(gate.depositsPaused());
    }

    function _routerBehindFactory() internal returns (DepositRouter r) {
        FakePortalFactory factory = new FakePortalFactory();
        factory.bind(address(usdc));
        factory.bind(address(fj));
        r = new DepositRouter(address(permit2), address(feePortal), address(factory), address(swap), OWNER);
    }
}
