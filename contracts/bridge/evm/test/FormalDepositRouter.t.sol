// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {DepositRouter} from "../src/DepositRouter.sol";
import {MintableERC20} from "../src/MintableERC20.sol";
import {ILiFiSwap} from "../src/interfaces/ILiFiSwap.sol";
import {MockPermit2, MockTokenPortal, MockFeeJuicePortal, FakePortalFactory} from "./mocks/CounterpartyMocks.sol";
import {MockLifiSwap} from "./mocks/DepositRouterMocks.sol";
import {
    DepositRouterWithoutPause,
    DepositRouterWithoutSwapPin,
    DepositRouterFeeAssetLegIntoFeeJuicePortal,
    DepositRouterKeepsApprovals
} from "./mocks/DepositRouterMutants.sol";

/// SYMBOLIC checks for `DepositRouter` (run with `halmos`, not forge): function arguments are symbolic, so each
/// check proves its property over the WHOLE input domain, not sampled points like fuzzing.
///
///   check_permit_conservesUserFunds               — ∀ shape and split: the signer pays exactly `amount`, all of it lands
///   check_fromCaller_pullsOnlyFromCaller          — ∀ caller: a funded, max-approved bystander is never pulled
///   check_fromCaller_boundedPull                  — ∀ (balance, allowance, maxPull): the pull is exactly their minimum
///   check_fromCaller_conservesReceived            — ∀ spend ≤ slice and target donation: leftover → token leg, stray → residue
///   check_tokenLegIntoDerivedPortal               — ∀ token-leg shape: the leg lands whole in the factory's clone
///   check_partialFeeAssetNeverIntoFeeJuicePortal  — ∀ partial fee-asset split: the FeeJuicePortal gets the slice only
///   check_fuelOnly_noTokenLeg                     — ∀ fuel-only amount: no clone is created or credited
///   check_swap_rejectsUnpinnedSelectorOrReceiver  — ∀ (selector, receiver word) but the pinned pair: refused, nothing moves
///   check_revertsWhenPaused                       — ∀ shape and entrypoint: a paused factory refuses every leg
///   check_noStandingApproval                      — ∀ shape and partial DEX pull: every router allowance ends at zero
///   check_sweep_revertsForNonOwner                — authority boundary
///
/// Threat model: Permit2 is a success-always mock (signature validity is Permit2's own domain, pinned by the fork
/// suites); the swap target is `MockLifiSwap` with the real facet's semantics (pulls `fromAmount`, returns its WHOLE
/// input balance to `_receiver` once above one unit), made hostile only where a proof says so; the factory is an honest model binding
/// each token to a non-hashing portal stand-in, because halmos 0.3.3 cannot model sha256 and has no `deployCode`
/// (forge covers the real factory, clones and LI.FI facet). The properties are the router's OWN accounting and
/// gating guarantees under those semantics.
///
/// Failure is signalled with assertions only: halmos cannot observe `revert(string)`. The forge canaries keep the
/// proofs honest two ways: each guard-shaped proof's body runs against a router MUTANT with that guard broken and
/// must then fail on its property assertion (through an external `run*` wrapper, so `vm.expectRevert` catches it),
/// and every other proof has a witness that its success path and the complementary branch are reachable through
/// the same harness (no vacuous pruning).
contract FormalDepositRouterTest is Test {
    MintableERC20 internal usdc;
    MintableERC20 internal fj;
    MockPermit2 internal permit2;
    MockLifiSwap internal swap;
    MockFeeJuicePortal internal feePortal;
    FakePortalFactory internal factory;
    MockTokenPortal internal usdcPortal;
    MockTokenPortal internal fjPortal;
    DepositRouter internal router;

    address internal constant OWNER = address(0x0A11);
    address internal constant USER = address(0xDA0);
    address internal constant CALLER = address(0xCA11);
    /// Funded and max-approved to the router: the property is that it never pays.
    address internal constant BYSTANDER = address(0xB1);
    address internal constant SWEEP_SINK = address(0x5117);
    address internal constant FOREIGN = address(0xBAD);
    bytes32 internal constant RECIPIENT = bytes32(uint256(0x1234));
    bytes32 internal constant FUEL_RECIPIENT = bytes32(uint256(0x5678));
    bytes32 internal constant SECRET = bytes32(uint256(0x5EC7E7));
    bytes32 internal constant FUEL_SECRET = bytes32(uint256(0xF5EC7E7));
    bytes32 internal constant TX_ID = bytes32(uint256(0x7D));

    /// USDC's per-call mint cap (1e9 whole tokens), used as the amount domain for both tokens.
    uint256 internal constant CAP = 1e15;
    uint256 internal constant FUEL_OUT = 1 ether;

    uint8 internal constant PLAIN = 0;
    uint8 internal constant FUELED = 1;
    uint8 internal constant FUEL_ONLY = 2;
    uint8 internal constant IDENTITY = 3;
    uint8 internal constant IDENTITY_FULL = 4;

    string internal constant PAUSED_ACCEPTED = "a deposit landed while paused";
    string internal constant UNPINNED_ACCEPTED = "an unpinned selector or foreign receiver reached the swap";
    string internal constant FEE_ASSET_LEG_IN_FJP = "the fee asset's token leg entered the FeeJuicePortal";
    string internal constant APPROVAL_SURVIVED = "a router approval survived the call";

    struct Balances {
        uint256 payer;
        uint256 bystander;
        uint256 bystanderFj;
        uint256 router;
        uint256 routerFj;
        uint256 clone;
        uint256 sink;
        uint256 target;
        uint256 feePortal;
    }

    function setUp() public {
        usdc = new MintableERC20("USDC", "USDC", 6, 1_000_000_000);
        fj = new MintableERC20("FeeJuice", "FJ", 18, 1_000_000_000);
        permit2 = new MockPermit2();
        swap = new MockLifiSwap(IERC20(address(fj)));
        feePortal = new MockFeeJuicePortal(IERC20(address(fj)));
        factory = new FakePortalFactory();
        usdcPortal = MockTokenPortal(factory.bind(address(usdc)));
        fjPortal = MockTokenPortal(factory.bind(address(fj)));
        router = new DepositRouter(address(permit2), address(feePortal), address(factory), address(swap), OWNER);

        usdc.mint(USER, CAP);
        fj.mint(USER, CAP);
        usdc.mint(BYSTANDER, CAP);
        fj.mint(BYSTANDER, CAP);
        fj.mint(address(swap), 1_000_000 ether);
        vm.startPrank(USER);
        usdc.approve(address(permit2), type(uint256).max);
        fj.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(BYSTANDER);
        usdc.approve(address(router), type(uint256).max);
        fj.approve(address(router), type(uint256).max);
        vm.stopPrank();
        swap.set(type(uint256).max, FUEL_OUT);
    }

    // ── Builders ─────────────────────────────────────────────────────────────────────────

    function _word(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _step(uint256 slice) internal view returns (ILiFiSwap.SwapData memory) {
        return ILiFiSwap.SwapData({
            callTo: address(0xDE7),
            approveTo: address(0xDE7),
            sendingAssetId: address(usdc),
            receivingAssetId: address(fj),
            fromAmount: slice,
            callData: "",
            requiresDeposit: true
        });
    }

    /// `swapTokensSingleV3ERC20ToERC20`'s encoding with the selector and the `_receiver` word substituted; a canary
    /// pins it byte-equal to `abi.encodeCall` for the pinned pair.
    function _swapDataWith(bytes4 selector, bytes32 receiverWord, uint256 slice) internal view returns (bytes memory) {
        string memory integrator = "unleashed";
        string memory referrer = "";
        return abi.encodePacked(selector, abi.encode(TX_ID, integrator, referrer, receiverWord, FUEL_OUT, _step(slice)));
    }

    /// One intent per shape: USDC swaps its slice, the fee asset passes it 1:1; the `_FULL`/`FUEL_ONLY` shapes have
    /// no token leg and `slice == amount`.
    function _intent(DepositRouter r, uint8 shape, uint256 amount, uint256 slice, bool isPrivate)
        internal
        view
        returns (DepositRouter.DepositIntent memory i, bytes memory swapData, MintableERC20 token)
    {
        token = shape >= IDENTITY ? fj : usdc;
        i.token = address(token);
        bool fuelOnly = shape == FUEL_ONLY || shape == IDENTITY_FULL;
        if (!fuelOnly) {
            i.tokenSecretHash = SECRET;
            i.isPrivate = isPrivate;
            i.aztecRecipient = isPrivate ? bytes32(0) : RECIPIENT;
        }
        if (shape == PLAIN) return (i, swapData, token);
        i.fuelSlice = fuelOnly ? amount : slice;
        i.fuelRecipient = FUEL_RECIPIENT;
        i.fuelSecretHash = FUEL_SECRET;
        if (shape >= IDENTITY) {
            i.minFuelOutput = i.fuelSlice;
        } else {
            i.minFuelOutput = FUEL_OUT;
            swapData = _swapDataWith(ILiFiSwap.swapTokensSingleV3ERC20ToERC20.selector, _word(address(r)), i.fuelSlice);
        }
    }

    function _permit() internal pure returns (DepositRouter.PermitParams memory) {
        return DepositRouter.PermitParams({nonce: 1, deadline: type(uint256).max, signature: hex"00"});
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

    function _send(
        DepositRouter r,
        bool viaPermit,
        DepositRouter.DepositIntent memory i,
        bytes memory swapData,
        uint256 amount
    ) internal returns (uint256 tokenAmount, uint256 fuelOut) {
        if (viaPermit) {
            vm.prank(USER);
            return r.bridgeWithPermit(i, swapData, amount, _permit());
        }
        vm.prank(CALLER);
        return r.bridgeFromCaller(i, swapData, amount, amount);
    }

    function _snap(DepositRouter r, MintableERC20 token, address payer) internal view returns (Balances memory b) {
        b.payer = token.balanceOf(payer);
        b.bystander = usdc.balanceOf(BYSTANDER);
        b.bystanderFj = fj.balanceOf(BYSTANDER);
        b.router = token.balanceOf(address(r));
        b.routerFj = fj.balanceOf(address(r));
        b.clone = token.balanceOf(factory.portalOf(address(token)));
        b.sink = usdc.balanceOf(swap.SINK());
        b.target = usdc.balanceOf(address(swap));
        b.feePortal = fj.balanceOf(address(feePortal));
    }

    /// The settlement every successful honest call must show: the payer lost exactly `received`, the clone got the
    /// token leg, the venue (or the FeeJuicePortal, for the fee asset) got the slice, and the router kept nothing.
    function _assertSettled(
        DepositRouter r,
        MintableERC20 token,
        address payer,
        Balances memory b,
        DepositRouter.DepositIntent memory i,
        uint256 received,
        uint256 tokenAmount,
        uint256 fuelOut
    ) internal view {
        bool identity = address(token) == address(fj);
        bool fuelOnly = i.tokenSecretHash == bytes32(0);
        assertEq(b.payer - token.balanceOf(payer), received, "payer delta != received");
        assertEq(tokenAmount, fuelOnly ? 0 : received - i.fuelSlice, "token leg != received - slice");
        assertEq(token.balanceOf(factory.portalOf(address(token))) - b.clone, tokenAmount, "clone delta != token leg");
        uint256 expectedFuel = i.fuelSlice == 0 ? 0 : identity ? i.fuelSlice : FUEL_OUT;
        assertEq(fuelOut, expectedFuel, "reported fuel != delivered fuel");
        assertEq(fj.balanceOf(address(feePortal)) - b.feePortal, expectedFuel, "FeeJuicePortal delta != fuel");
        assertEq(usdc.balanceOf(swap.SINK()) - b.sink, identity ? 0 : i.fuelSlice, "venue spend != slice");
        assertEq(token.balanceOf(address(r)), b.router, "router kept the deposit token");
        assertEq(fj.balanceOf(address(r)), b.routerFj, "router kept fee juice");
    }

    // ── Proofs ───────────────────────────────────────────────────────────────────────────

    /// For ANY shape, split and privacy flag, the Permit2 path takes exactly `amount` from the signer and lands all
    /// of it: token leg in the clone, slice in the venue or the FeeJuicePortal, nothing in the router.
    function check_permit_conservesUserFunds(uint8 shape, uint128 amountRaw, uint128 sliceRaw, bool isPrivate) public {
        vm.assume(shape <= IDENTITY_FULL);
        uint256 amount = amountRaw;
        uint256 slice = sliceRaw;
        vm.assume(amount >= 2 && amount <= CAP);
        if (shape == FUELED || shape == IDENTITY) vm.assume(slice >= 1 && slice < amount);
        _permitConserves(router, shape, amount, slice, isPrivate);
    }

    function _permitConserves(DepositRouter r, uint8 shape, uint256 amount, uint256 slice, bool isPrivate) internal {
        (DepositRouter.DepositIntent memory i, bytes memory sd, MintableERC20 t) =
            _intent(r, shape, amount, slice, isPrivate);
        Balances memory b = _snap(r, t, USER);
        vm.prank(USER);
        (uint256 tokenAmount, uint256 fuelOut) = r.bridgeWithPermit(i, sd, amount, _permit());
        assertEq(permit2.lastOwner(), USER, "Permit2 pulled from someone other than the signer");
        assertEq(permit2.lastAmount(), amount, "Permit2 pulled other than the signed amount");
        _assertSettled(r, t, USER, b, i, amount, tokenAmount, fuelOut);
    }

    /// For ANY caller and shape, `bridgeFromCaller` takes only `msg.sender`'s funds: a bystander holding both tokens
    /// with a max allowance to the router (the Executor's standing approval) is never touched.
    function check_fromCaller_pullsOnlyFromCaller(address caller, uint8 shape, uint128 amountRaw, uint128 sliceRaw)
        public
    {
        vm.assume(caller != address(0) && caller != BYSTANDER && caller != USER && caller != address(this));
        vm.assume(caller != address(router) && caller != address(swap) && caller != swap.SINK());
        vm.assume(caller != address(usdcPortal) && caller != address(fjPortal) && caller != address(feePortal));
        vm.assume(caller != address(permit2) && caller != address(factory));
        vm.assume(caller != address(usdc) && caller != address(fj));
        vm.assume(shape <= IDENTITY_FULL);
        uint256 amount = amountRaw;
        uint256 slice = sliceRaw;
        vm.assume(amount >= 2 && amount <= CAP);
        if (shape == FUELED || shape == IDENTITY) vm.assume(slice >= 1 && slice < amount);
        _pullsOnlyFromCaller(router, caller, shape, amount, slice);
    }

    function _pullsOnlyFromCaller(DepositRouter r, address caller, uint8 shape, uint256 amount, uint256 slice)
        internal
    {
        (DepositRouter.DepositIntent memory i, bytes memory sd, MintableERC20 t) =
            _intent(r, shape, amount, slice, false);
        t.mint(caller, amount);
        vm.prank(caller);
        t.approve(address(r), type(uint256).max);
        Balances memory b = _snap(r, t, caller);

        vm.prank(caller);
        (uint256 tokenAmount, uint256 fuelOut) = r.bridgeFromCaller(i, sd, amount, amount);

        assertEq(usdc.balanceOf(BYSTANDER), b.bystander, "a bystander's USDC was pulled");
        assertEq(fj.balanceOf(BYSTANDER), b.bystanderFj, "a bystander's fee asset was pulled");
        _assertSettled(r, t, caller, b, i, amount, tokenAmount, fuelOut);
    }

    /// For ANY balance, allowance and `maxPull`, the caller path pulls exactly their minimum, and only when it meets
    /// `minReceived`: never more than the caller holds, approved or capped.
    function check_fromCaller_boundedPull(uint128 balance, uint128 allowance, uint128 maxPull, uint128 minReceived)
        public
    {
        vm.assume(balance <= CAP);
        vm.assume(minReceived >= 1 && minReceived <= maxPull);
        _boundedPull(router, balance, allowance, maxPull, minReceived);
    }

    function _boundedPull(DepositRouter r, uint256 balance, uint256 allowance, uint256 maxPull, uint256 minReceived)
        internal
    {
        (DepositRouter.DepositIntent memory i,,) = _intent(r, PLAIN, 0, 0, false);
        usdc.mint(CALLER, balance);
        vm.prank(CALLER);
        usdc.approve(address(r), allowance);
        uint256 held = usdc.balanceOf(CALLER);
        uint256 cloneBefore = usdc.balanceOf(address(usdcPortal));

        vm.prank(CALLER);
        (uint256 tokenAmount,) = r.bridgeFromCaller(i, "", minReceived, maxPull);

        uint256 bound_ = held < allowance ? held : allowance;
        bound_ = bound_ < maxPull ? bound_ : maxPull;
        uint256 received = held - usdc.balanceOf(CALLER);
        assertEq(received, bound_, "pull != min(balance, allowance, maxPull)");
        assertGe(received, minReceived, "pull below minReceived");
        assertEq(usdc.allowance(CALLER, address(r)), allowance - received, "allowance spent != pull");
        assertEq(tokenAmount, received, "token leg != pull");
        assertEq(usdc.balanceOf(address(usdcPortal)) - cloneBefore, received, "clone delta != pull");
    }

    /// For ANY split, ANY venue spend up to the slice and ANY input balance the venue held beforehand (a donation the
    /// real facet forwards whole): the unspent slice joins the token leg, the donation stays router residue, and
    /// received == token leg + consumed exactly, where a one-unit balance the facet keeps counts as consumed.
    function check_fromCaller_conservesReceived(
        uint128 amountRaw,
        uint128 sliceRaw,
        uint128 spendRaw,
        uint128 strayRaw,
        bool isPrivate
    ) public {
        uint256 amount = amountRaw;
        uint256 slice = sliceRaw;
        uint256 spend = spendRaw;
        uint256 stray = strayRaw;
        vm.assume(amount >= 2 && amount <= CAP && slice >= 1 && slice < amount && spend <= slice && stray <= CAP);
        _conservesReceived(router, amount, slice, spend, stray, isPrivate);
    }

    function _conservesReceived(
        DepositRouter r,
        uint256 amount,
        uint256 slice,
        uint256 spend,
        uint256 stray,
        bool isPrivate
    ) internal {
        (DepositRouter.DepositIntent memory i, bytes memory sd,) = _intent(r, FUELED, amount, slice, isPrivate);
        usdc.mint(address(swap), stray);
        swap.set(spend, FUEL_OUT);
        _fund(r, false, usdc, amount);
        Balances memory b = _snap(r, usdc, CALLER);

        (uint256 tokenAmount, uint256 fuelOut) = _send(r, false, i, sd, amount);

        uint256 held = stray + slice - spend;
        uint256 returned = held > 1 ? held : 0;
        uint256 strayBack = returned < stray ? returned : stray;
        uint256 consumed = slice - (returned - strayBack);
        assertEq(b.payer - usdc.balanceOf(CALLER), amount, "payer delta != received");
        assertEq(tokenAmount, amount - consumed, "token leg != received - consumed");
        assertEq(usdc.balanceOf(address(usdcPortal)) - b.clone, amount - consumed, "clone delta != received - consumed");
        assertEq(usdc.balanceOf(swap.SINK()) - b.sink, spend, "venue spend");
        assertEq(usdc.balanceOf(address(r)), b.router + strayBack, "router residue != prior residue + stray");
        assertEq(usdc.balanceOf(address(swap)), held - returned, "venue kept more than dust");
        assertEq(fuelOut, FUEL_OUT, "reported fuel != delivered fuel");
        assertEq(fj.balanceOf(address(feePortal)) - b.feePortal, FUEL_OUT, "FeeJuicePortal delta != fuel");
    }

    /// For ANY token-leg shape (plain, swapped slice, fee-asset slice), either entrypoint and either privacy flag,
    /// the token leg lands whole in the factory's clone for that token, with the intent's privacy and recipient.
    function check_tokenLegIntoDerivedPortal(
        uint8 shape,
        uint128 amountRaw,
        uint128 sliceRaw,
        bool isPrivate,
        bool viaPermit
    ) public {
        vm.assume(shape == PLAIN || shape == FUELED || shape == IDENTITY);
        uint256 amount = amountRaw;
        uint256 slice = sliceRaw;
        vm.assume(amount >= 2 && amount <= CAP);
        if (shape != PLAIN) vm.assume(slice >= 1 && slice < amount);
        _tokenLegIntoDerivedPortal(router, shape, amount, slice, isPrivate, viaPermit);
    }

    function _tokenLegIntoDerivedPortal(
        DepositRouter r,
        uint8 shape,
        uint256 amount,
        uint256 slice,
        bool isPrivate,
        bool viaPermit
    ) internal {
        (DepositRouter.DepositIntent memory i, bytes memory sd, MintableERC20 t) =
            _intent(r, shape, amount, slice, isPrivate);
        MockTokenPortal clone = MockTokenPortal(factory.portalOf(address(t)));
        MockTokenPortal other = clone == usdcPortal ? fjPortal : usdcPortal;
        _fund(r, viaPermit, t, amount);
        uint256 cloneBefore = t.balanceOf(address(clone));
        uint256 cloneCalls = clone.callCount();
        uint256 otherCalls = other.callCount();

        (uint256 tokenAmount,) = _send(r, viaPermit, i, sd, amount);

        assertEq(tokenAmount, amount - i.fuelSlice, "token leg != received - slice");
        assertEq(t.balanceOf(address(clone)) - cloneBefore, tokenAmount, "the derived clone did not get the token leg");
        assertEq(clone.callCount(), cloneCalls + 1, "the derived clone was not called exactly once");
        assertEq(clone.lastAmount(), tokenAmount, "clone deposit != token leg");
        assertEq(clone.lastPrivate(), isPrivate, "privacy flag lost");
        assertEq(clone.lastTo(), isPrivate ? bytes32(0) : RECIPIENT, "recipient lost");
        assertEq(other.callCount(), otherCalls, "another token's clone was called");
    }

    /// For ANY partial fee-asset split, either entrypoint and either privacy flag, the FeeJuicePortal receives the
    /// slice and nothing more: the remainder goes to the fee asset's own clone, never minted as gas.
    function check_partialFeeAssetNeverIntoFeeJuicePortal(
        uint128 amountRaw,
        uint128 sliceRaw,
        bool isPrivate,
        bool viaPermit
    ) public {
        uint256 amount = amountRaw;
        uint256 slice = sliceRaw;
        vm.assume(amount >= 2 && amount <= CAP && slice >= 1 && slice < amount);
        _partialFeeAsset(router, amount, slice, isPrivate, viaPermit);
    }

    function runPartialFeeAsset(DepositRouter r, uint256 amount, uint256 slice, bool isPrivate, bool viaPermit)
        external
    {
        _partialFeeAsset(r, amount, slice, isPrivate, viaPermit);
    }

    function _partialFeeAsset(DepositRouter r, uint256 amount, uint256 slice, bool isPrivate, bool viaPermit) internal {
        (DepositRouter.DepositIntent memory i, bytes memory sd,) = _intent(r, IDENTITY, amount, slice, isPrivate);
        _fund(r, viaPermit, fj, amount);
        uint256 feeBefore = fj.balanceOf(address(feePortal));
        uint256 cloneBefore = fj.balanceOf(address(fjPortal));

        _send(r, viaPermit, i, sd, amount);

        assertTrue(fj.balanceOf(address(feePortal)) - feeBefore == slice, FEE_ASSET_LEG_IN_FJP);
        assertEq(feePortal.lastAmount(), slice, "FeeJuicePortal's last deposit != slice");
        assertEq(fj.balanceOf(address(fjPortal)) - cloneBefore, amount - slice, "fee asset's clone != remainder");
    }

    /// For ANY fuel-only amount (swapped or fee asset) on either entrypoint, no clone is created or credited and the
    /// whole amount becomes fuel.
    function check_fuelOnly_noTokenLeg(bool identity, uint128 amountRaw, bool viaPermit) public {
        uint256 amount = amountRaw;
        vm.assume(amount >= 1 && amount <= CAP);
        _fuelOnlyNoTokenLeg(router, identity, amount, viaPermit);
    }

    function _fuelOnlyNoTokenLeg(DepositRouter r, bool identity, uint256 amount, bool viaPermit) internal {
        (DepositRouter.DepositIntent memory i, bytes memory sd, MintableERC20 t) =
            _intent(r, identity ? IDENTITY_FULL : FUEL_ONLY, amount, amount, false);
        address payer = _fund(r, viaPermit, t, amount);
        uint256 creates = factory.creates();
        uint256 usdcCalls = usdcPortal.callCount();
        uint256 fjCalls = fjPortal.callCount();
        Balances memory b = _snap(r, t, payer);

        (uint256 tokenAmount, uint256 fuelOut) = _send(r, viaPermit, i, sd, amount);

        assertEq(tokenAmount, 0, "fuel-only reported a token leg");
        assertEq(factory.creates(), creates, "fuel-only created a clone");
        assertEq(usdcPortal.callCount(), usdcCalls, "fuel-only called the USDC clone");
        assertEq(fjPortal.callCount(), fjCalls, "fuel-only called the fee asset's clone");
        _assertSettled(r, t, payer, b, i, amount, tokenAmount, fuelOut);
    }

    /// For ANY selector and ANY `_receiver` word except a pinned selector paying this router, both entrypoints refuse
    /// before a wei moves or the venue is called.
    function check_swap_rejectsUnpinnedSelectorOrReceiver(bytes4 selector, bytes32 receiverWord, bool viaPermit)
        public
    {
        bool pinned = selector == ILiFiSwap.swapTokensSingleV3ERC20ToERC20.selector
            || selector == ILiFiSwap.swapTokensMultipleV3ERC20ToERC20.selector;
        vm.assume(!(pinned && receiverWord == _word(address(router))));
        _rejectsUnpinned(router, selector, receiverWord, viaPermit);
    }

    function runRejectsUnpinned(DepositRouter r, bytes4 selector, bytes32 receiverWord, bool viaPermit) external {
        _rejectsUnpinned(r, selector, receiverWord, viaPermit);
    }

    function _rejectsUnpinned(DepositRouter r, bytes4 selector, bytes32 receiverWord, bool viaPermit) internal {
        (DepositRouter.DepositIntent memory i,,) = _intent(r, FUELED, 10e6, 4e6, false);
        bytes memory sd = _swapDataWith(selector, receiverWord, 4e6);
        address payer = _fund(r, viaPermit, usdc, 10e6);
        uint256 payerBefore = usdc.balanceOf(payer);
        uint256 permitCalls = permit2.calls();
        uint256 swapCalls = swap.calls();

        bool accepted = _try(r, viaPermit, i, sd, 10e6);
        assertTrue(!accepted, UNPINNED_ACCEPTED);
        bytes4 reason = _lastReason;
        assertTrue(
            reason == DepositRouter.UnpinnedSelector.selector || reason == DepositRouter.ForeignReceiver.selector,
            "rejected for the wrong reason"
        );
        assertEq(usdc.balanceOf(payer), payerBefore, "a rejected intent moved funds");
        assertEq(permit2.calls(), permitCalls, "a rejected intent reached Permit2");
        assertEq(swap.calls(), swapCalls, "a rejected intent reached the venue");
    }

    /// For ANY shape, amount, split, privacy flag and entrypoint, a paused factory refuses the call with
    /// `DepositsPaused` before anything moves, fuel-only included.
    function check_revertsWhenPaused(uint8 shape, uint128 amountRaw, uint128 sliceRaw, bool isPrivate, bool viaPermit)
        public
    {
        vm.assume(shape <= IDENTITY_FULL);
        uint256 amount = amountRaw;
        uint256 slice = sliceRaw;
        vm.assume(amount >= 2 && amount <= CAP);
        if (shape == FUELED || shape == IDENTITY) vm.assume(slice >= 1 && slice < amount);
        _revertsWhenPaused(router, shape, amount, slice, isPrivate, viaPermit);
    }

    function runRevertsWhenPaused(
        DepositRouter r,
        uint8 shape,
        uint256 amount,
        uint256 slice,
        bool isPrivate,
        bool viaPermit
    ) external {
        _revertsWhenPaused(r, shape, amount, slice, isPrivate, viaPermit);
    }

    function _revertsWhenPaused(
        DepositRouter r,
        uint8 shape,
        uint256 amount,
        uint256 slice,
        bool isPrivate,
        bool viaPermit
    ) internal {
        factory.setPaused(true, false);
        (DepositRouter.DepositIntent memory i, bytes memory sd, MintableERC20 t) =
            _intent(r, shape, amount, slice, isPrivate);
        address payer = _fund(r, viaPermit, t, amount);
        uint256 payerBefore = t.balanceOf(payer);
        uint256 permitCalls = permit2.calls();

        bool accepted = _try(r, viaPermit, i, sd, amount);
        assertTrue(!accepted, PAUSED_ACCEPTED);
        assertTrue(_lastReason == DepositRouter.DepositsPaused.selector, "rejected for the wrong reason");
        assertEq(t.balanceOf(payer), payerBefore, "a paused call moved funds");
        assertEq(permit2.calls(), permitCalls, "a paused call reached Permit2");
    }

    /// For ANY shape and entrypoint, and a venue that pulls ANY part of its exact slice approval, every allowance the
    /// router grants (to the venue, either clone, the FeeJuicePortal) is zero once the call returns.
    function check_noStandingApproval(uint8 shape, uint128 amountRaw, uint128 sliceRaw, uint128 pullRaw, bool viaPermit)
        public
    {
        vm.assume(shape <= IDENTITY_FULL);
        uint256 amount = amountRaw;
        uint256 slice = sliceRaw;
        uint256 pull = pullRaw;
        vm.assume(amount >= 2 && amount <= CAP);
        if (shape == FUELED || shape == IDENTITY) vm.assume(slice >= 1 && slice < amount);
        vm.assume(pull >= 1 && pull <= (shape == FUEL_ONLY ? amount : slice));
        _noStandingApproval(router, shape, amount, slice, pull, viaPermit);
    }

    function runNoStandingApproval(
        DepositRouter r,
        uint8 shape,
        uint256 amount,
        uint256 slice,
        uint256 pull,
        bool viaPermit
    ) external {
        _noStandingApproval(r, shape, amount, slice, pull, viaPermit);
    }

    function _noStandingApproval(
        DepositRouter r,
        uint8 shape,
        uint256 amount,
        uint256 slice,
        uint256 pull,
        bool viaPermit
    ) internal {
        (DepositRouter.DepositIntent memory i, bytes memory sd, MintableERC20 t) =
            _intent(r, shape, amount, slice, false);
        swap.setHostile(address(0), pull, true);
        _fund(r, viaPermit, t, amount);

        _send(r, viaPermit, i, sd, amount);

        assertTrue(_allowancesOf(usdc, address(r)) == 0 && _allowancesOf(fj, address(r)) == 0, APPROVAL_SURVIVED);
    }

    /// Bitwise OR of every allowance `owner` could have granted: zero iff all are zero.
    function _allowancesOf(MintableERC20 t, address owner) internal view returns (uint256) {
        return t.allowance(owner, address(swap)) | t.allowance(owner, address(usdcPortal))
            | t.allowance(owner, address(fjPortal)) | t.allowance(owner, address(feePortal));
    }

    /// Authority boundary: sweep is unreachable for any non-owner, and a failed attempt mutates nothing. The
    /// recipient is a fixed literal: a zero `caller` as recipient would trip `to != 0` and mask an unauthorized success.
    function check_sweep_revertsForNonOwner(address caller) public {
        vm.assume(caller != router.owner());
        usdc.mint(address(router), 5e6);
        uint256 before = usdc.balanceOf(address(router));
        vm.prank(caller);
        try router.sweep(address(usdc), SWEEP_SINK) {
            assertTrue(false, "sweep succeeded for a non-owner");
        } catch {
            assertEq(usdc.balanceOf(address(router)), before, "rejected sweep mutated state");
        }
    }

    // ── try plumbing ─────────────────────────────────────────────────────────────────────

    bytes4 internal _lastReason;

    /// Runs one entrypoint under try; returns whether it succeeded and keeps the revert selector.
    function _try(
        DepositRouter r,
        bool viaPermit,
        DepositRouter.DepositIntent memory i,
        bytes memory swapData,
        uint256 amount
    ) internal returns (bool) {
        if (viaPermit) {
            vm.prank(USER);
            try r.bridgeWithPermit(i, swapData, amount, _permit()) {
                return true;
            } catch (bytes memory reason) {
                _lastReason = bytes4(reason);
                return false;
            }
        }
        vm.prank(CALLER);
        try r.bridgeFromCaller(i, swapData, amount, amount) {
            return true;
        } catch (bytes memory reason) {
            _lastReason = bytes4(reason);
            return false;
        }
    }

    // ── Canaries (forge) ─────────────────────────────────────────────────────────────────

    /// Mutation: without the pause guard, the paused proof's body reaches its failure branch on every shape,
    /// fuel-only included.
    function test_canary_revertsWhenPaused_failsWithoutTheGuard() public {
        DepositRouter mutant =
            new DepositRouterWithoutPause(address(permit2), address(feePortal), address(factory), address(swap), OWNER);
        for (uint8 shape = PLAIN; shape <= IDENTITY_FULL; shape++) {
            vm.expectRevert(bytes(PAUSED_ACCEPTED));
            this.runRevertsWhenPaused(mutant, shape, 10e6, 4e6, false, shape % 2 == 0);
        }
    }

    /// Mutation: without the swap pin, a pinned selector paying a foreign `_receiver` reaches the venue and settles
    /// (the venue happens to pay the router anyway).
    function test_canary_rejectsUnpinned_failsWithoutTheGuard() public {
        DepositRouter mutant = new DepositRouterWithoutSwapPin(
            address(permit2), address(feePortal), address(factory), address(swap), OWNER
        );
        swap.setHostile(address(mutant), 0, true);
        vm.expectRevert(bytes(UNPINNED_ACCEPTED));
        this.runRejectsUnpinned(mutant, ILiFiSwap.swapTokensSingleV3ERC20ToERC20.selector, _word(FOREIGN), true);
    }

    /// Mutation: routing the fee asset's token leg to the FeeJuicePortal mints the remainder as gas.
    function test_canary_partialFeeAsset_failsWithoutTheGuard() public {
        DepositRouter mutant = new DepositRouterFeeAssetLegIntoFeeJuicePortal(
            address(permit2), address(feePortal), address(factory), address(swap), OWNER
        );
        vm.expectRevert(bytes(FEE_ASSET_LEG_IN_FJP));
        this.runPartialFeeAsset(mutant, 10e6, 4e6, false, true);
        vm.expectRevert(bytes(FEE_ASSET_LEG_IN_FJP));
        this.runPartialFeeAsset(mutant, 10e6, 4e6, false, false);
    }

    /// Mutation: without the revoke, a venue that pulls half its slice on the caller path leaves the rest approved.
    function test_canary_noStandingApproval_failsWithoutTheRevoke() public {
        DepositRouter mutant = new DepositRouterKeepsApprovals(
            address(permit2), address(feePortal), address(factory), address(swap), OWNER
        );
        vm.expectRevert(bytes(APPROVAL_SURVIVED));
        this.runNoStandingApproval(mutant, FUELED, 10e6, 4e6, 2e6, false);
    }

    /// Every shape settles through the permit proof's body: its assertions are reached, not pruned.
    function test_canary_permitConserves_everyShapeSettles() public {
        for (uint8 shape = PLAIN; shape <= IDENTITY_FULL; shape++) {
            uint256 calls = permit2.calls();
            _permitConserves(router, shape, 10e6, 4e6, shape % 2 == 1);
            assertEq(permit2.calls(), calls + 1);
        }
    }

    /// The caller is pulled through the proof's body, while a caller without an allowance is refused rather than
    /// served from the bystander's standing approval.
    function test_canary_pullsOnlyFromCaller_reachableAndNoFallback() public {
        _pullsOnlyFromCaller(router, address(0xC0FFEE), FUELED, 10e6, 4e6);
        (DepositRouter.DepositIntent memory i,,) = _intent(router, PLAIN, 0, 0, false);
        usdc.mint(CALLER, 10e6);
        vm.prank(CALLER);
        vm.expectRevert(DepositRouter.BelowMinimum.selector);
        router.bridgeFromCaller(i, "", 1, 10e6);
    }

    /// Each of the three bounds binds through the proof's body, and a minimum above them is refused.
    function test_canary_boundedPull_eachBoundBindsAndMinimumRefuses() public {
        _boundedPull(router, 3e6, 9e6, 9e6, 1);
        _boundedPull(router, 9e6, 3e6, 9e6, 1);
        _boundedPull(router, 9e6, 9e6, 3e6, 1);
        (DepositRouter.DepositIntent memory i,,) = _intent(router, PLAIN, 0, 0, false);
        vm.prank(CALLER);
        usdc.approve(address(router), 3e6);
        vm.prank(CALLER);
        vm.expectRevert(DepositRouter.BelowMinimum.selector);
        router.bridgeFromCaller(i, "", 3e6 + 1, 9e6);
    }

    /// A partial spend with a venue donation settles through the proof's body; the same venue on the permit path,
    /// where consumption is exact, is refused.
    function test_canary_conservesReceived_reachableAndExactOnPermit() public {
        _conservesReceived(router, 10e6, 4e6, 1e6, 7e6, true);
        (DepositRouter.DepositIntent memory i, bytes memory sd,) = _intent(router, FUELED, 10e6, 4e6, false);
        vm.prank(USER);
        vm.expectRevert(DepositRouter.InexactFuelConsumption.selector);
        router.bridgeWithPermit(i, sd, 10e6, _permit());
    }

    /// Both clones receive their token legs through the proof's body, public and private.
    function test_canary_tokenLegIntoDerivedPortal_reachable() public {
        _tokenLegIntoDerivedPortal(router, PLAIN, 10e6, 0, true, true);
        _tokenLegIntoDerivedPortal(router, FUELED, 10e6, 4e6, false, false);
        _tokenLegIntoDerivedPortal(router, IDENTITY, 10e6, 4e6, true, false);
    }

    /// A FULL fee-asset amount does enter the FeeJuicePortal whole: the partial proof is about the split.
    function test_canary_fullFeeAssetIntoFeeJuicePortal() public {
        _fuelOnlyNoTokenLeg(router, true, 3e6, true);
        assertEq(feePortal.lastAmount(), 3e6);
        _partialFeeAsset(router, 10e6, 4e6, true, false);
    }

    /// Fuel-only settles through the proof's body, and the same amount with a token leg creates and credits a clone.
    function test_canary_fuelOnly_reachableAndTokenLegCreates() public {
        _fuelOnlyNoTokenLeg(router, false, 5e6, false);
        _fuelOnlyNoTokenLeg(router, true, 5e6, true);
        uint256 creates = factory.creates();
        _permitConserves(router, FUELED, 5e6, 2e6, false);
        assertEq(factory.creates(), creates + 1);
        assertEq(usdcPortal.lastAmount(), 3e6);
    }

    /// The pinned pair is accepted for both selectors, so the proof's assumption excludes a reachable point; the
    /// hand-built swap data is byte-equal to `abi.encodeCall`.
    function test_canary_pinnedSwapAccepted() public {
        bytes memory built =
            _swapDataWith(ILiFiSwap.swapTokensSingleV3ERC20ToERC20.selector, _word(address(router)), 4e6);
        string memory integrator = "unleashed";
        bytes memory encoded = abi.encodeCall(
            ILiFiSwap.swapTokensSingleV3ERC20ToERC20,
            (TX_ID, integrator, "", payable(address(router)), FUEL_OUT, _step(4e6))
        );
        assertEq(built, encoded);
        _permitConserves(router, FUELED, 10e6, 4e6, false);

        ILiFiSwap.SwapData[] memory steps = new ILiFiSwap.SwapData[](1);
        steps[0] = _step(4e6);
        (DepositRouter.DepositIntent memory i,,) = _intent(router, FUELED, 10e6, 4e6, false);
        bytes memory multiple = abi.encodeCall(
            ILiFiSwap.swapTokensMultipleV3ERC20ToERC20,
            (TX_ID, integrator, "", payable(address(router)), FUEL_OUT, steps)
        );
        vm.prank(USER);
        (uint256 tokenAmount,) = router.bridgeWithPermit(i, multiple, 10e6, _permit());
        assertEq(tokenAmount, 6e6);
    }

    /// A venue pulling part of its slice settles on the caller path through the proof's body.
    function test_canary_noStandingApproval_partialPullReachable() public {
        _noStandingApproval(router, FUELED, 10e6, 4e6, 2e6, false);
        assertEq(usdcPortal.lastAmount(), 8e6);
    }

    /// The owner CAN sweep: the authority proof is not blind to success.
    function test_canary_ownerCanSweep() public {
        usdc.mint(address(router), 5e6);
        vm.prank(OWNER);
        router.sweep(address(usdc), SWEEP_SINK);
        assertEq(usdc.balanceOf(SWEEP_SINK), 5e6);
    }
}
