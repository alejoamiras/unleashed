// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

// Every test is an attack on DepositRouter; its name states the attack and the outcome it asserts.

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {ERC20} from "@oz/token/ERC20/ERC20.sol";
import {IERC20Errors} from "@oz/interfaces/draft-IERC6093.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";
import {stdError} from "forge-std/StdError.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Inbox} from "@aztec/core/messagebridge/Inbox.sol";
import {Errors} from "@aztec/core/libraries/Errors.sol";

import {DepositRouter} from "../src/DepositRouter.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {MintableERC20} from "../src/MintableERC20.sol";
import {ILiFiSwap} from "../src/interfaces/ILiFiSwap.sol";
import {DepositRouterFixture} from "./mocks/DepositRouterFixture.sol";
import {CapturingOutbox, FakeRegistry} from "./mocks/AztecFakes.sol";
import {FeeOnTransferERC20, PlainERC20} from "./mocks/MetadataERC20s.sol";

// ═══════════════════════════ hostile actors ═══════════════════════════

/// The entry shape of LI.FI's `AcrossFacetV4` (`ILiFi.BridgeData`, `AcrossV4Data`), declared locally.
interface IAcrossFacetV4Shape {
    struct BridgeData {
        bytes32 transactionId;
        string bridge;
        string integrator;
        address referrer;
        address sendingAssetId;
        address receiver;
        uint256 minAmount;
        uint256 destinationChainId;
        bool hasSourceSwaps;
        bool hasDestinationCall;
    }

    struct AcrossV4Data {
        bytes32 receiverAddress;
        bytes32 refundAddress;
        bytes32 sendingAssetId;
        bytes32 receivingAssetId;
        uint256 outputAmount;
        uint128 outputAmountMultiplier;
        bytes32 exclusiveRelayer;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        uint32 exclusivityParameter;
        bytes message;
    }

    function startBridgeTokensViaAcrossV4(BridgeData calldata, AcrossV4Data calldata) external payable;
}

/// What the Diamond does with a selector-valid Across call: bridges `minAmount` of the caller's approval to
/// `receiver`, returning nothing.
contract AcrossShapedFacet is IAcrossFacetV4Shape {
    function startBridgeTokensViaAcrossV4(BridgeData calldata b, AcrossV4Data calldata) external payable {
        IERC20(b.sendingAssetId).transferFrom(msg.sender, b.receiver, b.minAmount);
    }
}

/// The router with its swap pin deleted: the selector-free design the pin replaced.
contract BlackhatUnpinnedRouter is DepositRouter {
    constructor(address p2, address fjp, address factory, address target, address owner)
        DepositRouter(p2, fjp, factory, target, owner)
    {}

    function _requirePinnedSwap(bytes calldata, uint256) internal view override {}
}

/// A token whose `transferFrom` re-enters `target` once and records how that inner call ended.
contract ReenteringToken is ERC20 {
    address public target;
    bytes public payload;
    bytes4 public innerRevert;

    constructor() ERC20("Reenter", "RE") {}

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        bool ok = super.transferFrom(from, to, value);
        if (payload.length > 0) {
            bytes memory p = payload;
            payload = "";
            (bool success, bytes memory ret) = target.call(p);
            innerRevert = success ? bytes4(0xffffffff) : bytes4(ret);
        }
        return ok;
    }
}

/// A rollup whose Inbox is set after construction: Aztec's real `Inbox` takes the rollup in its constructor.
contract SettableInboxRollup {
    address public inbox;
    address public immutable outbox;

    constructor() {
        outbox = address(new CapturingOutbox());
    }

    function setInbox(address inbox_) external {
        inbox = inbox_;
    }

    function getInbox() external view returns (address) {
        return inbox;
    }

    function getOutbox() external view returns (address) {
        return outbox;
    }

    function getVersion() external pure returns (uint256) {
        return 4242;
    }
}

// ═══════════════════════════ the suite ═══════════════════════════

contract DepositRouterBlackhatTest is DepositRouterFixture {
    uint256 internal constant AMOUNT = 1000e6;
    uint256 internal constant SLICE = 100e6;
    uint256 internal constant FLOOR = 4 ether;
    uint256 internal constant FJ_OUT = 5 ether;
    uint256 internal constant FUNDS = 10_000e6;
    /// The BN254 scalar field modulus: the Inbox refuses any secret hash at or above it.
    uint256 internal constant BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    address internal constant ATTACKER = address(0xA77AC4);

    function setUp() public {
        _deployStack();
        _fundForPermit(usdc, user, FUNDS);
        vm.prank(user);
        usdc.approve(address(router), type(uint256).max);
        swap.set(type(uint256).max, FJ_OUT);
    }

    function _usdcFuel() internal view returns (DepositRouter.DepositIntent memory i) {
        i = _fuelIntent(address(usdc), SLICE, FLOOR, false);
    }

    function _acrossCall(address token, uint256 amount, address to) internal pure returns (bytes memory) {
        IAcrossFacetV4Shape.BridgeData memory b = IAcrossFacetV4Shape.BridgeData({
            transactionId: TX_ID,
            bridge: "acrossV4",
            integrator: "unleashed",
            referrer: address(0),
            sendingAssetId: token,
            receiver: to,
            minAmount: amount,
            destinationChainId: 8453,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        IAcrossFacetV4Shape.AcrossV4Data memory a;
        a.receiverAddress = bytes32(uint256(uint160(to)));
        a.refundAddress = bytes32(uint256(uint160(to)));
        a.sendingAssetId = bytes32(uint256(uint160(token)));
        a.outputAmount = amount;
        a.fillDeadline = type(uint32).max;
        return abi.encodeCall(IAcrossFacetV4Shape.startBridgeTokensViaAcrossV4, (b, a));
    }

    // ─────────────── the selector-free counterexample ───────────────

    /// An Across call through the Diamond, attacker as receiver, `minFuelOutput = 0`: every delta check of a
    /// selector-free router passes and the slice is bridged away. The pin refuses it before any pull; the pinned
    /// selectors cannot name a foreign receiver or drop the floor either.
    function test_attack_selectorFreeAcrossCall_refusedByPin() public {
        bytes memory across = _acrossCall(address(usdc), SLICE, ATTACKER);
        DepositRouter.DepositIntent memory i = _usdcFuel();
        i.minFuelOutput = 0;

        vm.startPrank(user);
        vm.expectRevert(DepositRouter.UnpinnedSelector.selector);
        router.bridgeFromCaller(i, across, AMOUNT, AMOUNT);
        i.minFuelOutput = FLOOR;
        vm.expectRevert(DepositRouter.UnpinnedSelector.selector);
        router.bridgeFromCaller(i, across, AMOUNT, AMOUNT);

        bytes memory toAttacker = abi.encodeCall(
            ILiFiSwap.swapTokensSingleV3ERC20ToERC20,
            (TX_ID, "", "", payable(ATTACKER), FLOOR, _swapStep(address(usdc), SLICE))
        );
        vm.expectRevert(DepositRouter.ForeignReceiver.selector);
        router.bridgeFromCaller(i, toAttacker, AMOUNT, AMOUNT);
        i.minFuelOutput = 0;
        vm.expectRevert(DepositRouter.ZeroFuelFloor.selector);
        router.bridgeFromCaller(i, _swapData(address(usdc), SLICE, 0), AMOUNT, AMOUNT);
        vm.stopPrank();
        assertEq(usdc.balanceOf(user), FUNDS);

        // The counterexample is real: with the pin deleted, the same call pays the attacker and succeeds.
        BlackhatUnpinnedRouter unpinned = new BlackhatUnpinnedRouter(
            address(permit2), address(feePortal), address(factory), address(new AcrossShapedFacet()), owner
        );
        vm.startPrank(user);
        usdc.approve(address(unpinned), type(uint256).max);
        unpinned.bridgeFromCaller(i, across, AMOUNT, AMOUNT);
        vm.stopPrank();
        assertEq(usdc.balanceOf(ATTACKER), SLICE, "without the pin the slice is bridged to the attacker");
    }

    // ─────────────── the swap target is the token itself ───────────────

    /// With `SWAP_TARGET = token`, a padded `transfer`/`approve` that keeps the router's address at byte 100 is
    /// refused by the selector pin, and a pinned call reverts in the token (no such function). Without the pin the
    /// delta accounting still underflows on a target that spends the router's own balance.
    function test_attack_swapTargetIsTheToken_refused() public {
        DepositRouter tokenRouter =
            new DepositRouter(address(permit2), address(feePortal), address(factory), address(usdc), owner);
        vm.prank(user);
        usdc.approve(address(tokenRouter), type(uint256).max);
        DepositRouter.DepositIntent memory i = _usdcFuel();

        bytes memory steal = _padWithReceiver(abi.encodeCall(IERC20.transfer, (ATTACKER, SLICE)), address(tokenRouter));
        bytes memory allow =
            _padWithReceiver(abi.encodeCall(IERC20.approve, (ATTACKER, type(uint256).max)), address(tokenRouter));
        vm.startPrank(user);
        vm.expectRevert(DepositRouter.UnpinnedSelector.selector);
        tokenRouter.bridgeFromCaller(i, steal, AMOUNT, AMOUNT);
        vm.expectRevert(DepositRouter.UnpinnedSelector.selector);
        tokenRouter.bridgeFromCaller(i, allow, AMOUNT, AMOUNT);

        bytes memory pinned = abi.encodeCall(
            ILiFiSwap.swapTokensSingleV3ERC20ToERC20,
            (TX_ID, "", "", payable(address(tokenRouter)), FLOOR, _swapStep(address(usdc), SLICE))
        );
        vm.expectRevert(bytes(""));
        tokenRouter.bridgeFromCaller(i, pinned, AMOUNT, AMOUNT);
        vm.stopPrank();

        BlackhatUnpinnedRouter unpinned =
            new BlackhatUnpinnedRouter(address(permit2), address(feePortal), address(factory), address(usdc), owner);
        bytes memory stealUnpinned =
            _padWithReceiver(abi.encodeCall(IERC20.transfer, (ATTACKER, SLICE)), address(unpinned));
        i.minFuelOutput = 0;
        vm.startPrank(user);
        usdc.approve(address(unpinned), type(uint256).max);
        vm.expectRevert(stdError.arithmeticError);
        unpinned.bridgeFromCaller(i, stealUnpinned, AMOUNT, AMOUNT);
        vm.stopPrank();
        assertEq(usdc.balanceOf(ATTACKER), 0);
    }

    /// Pads `call` to the 164-byte minimum and writes `receiver` into the word at offset 100.
    function _padWithReceiver(bytes memory call, address receiver) internal pure returns (bytes memory out) {
        out = bytes.concat(call, new bytes(164 - call.length));
        bytes32 word = bytes32(uint256(uint160(receiver)));
        assembly ("memory-safe") {
            mstore(add(add(out, 0x20), 100), word)
        }
    }

    // ─────────────── hostile venue ───────────────

    /// The venue honours the slice but pays the Fee Juice to the attacker: the router's own fee-asset delta is zero.
    function test_attack_hostileDexDivertsOutput_caughtByDeltaFloor() public {
        swap.setHostile(ATTACKER, 0, true);
        vm.startPrank(user);
        vm.expectRevert(DepositRouter.InsufficientFuel.selector);
        router.bridgeFromCaller(_usdcFuel(), _swapData(address(usdc), SLICE, FLOOR), AMOUNT, AMOUNT);
        vm.expectRevert(DepositRouter.InsufficientFuel.selector);
        router.bridgeWithPermit(_usdcFuel(), _swapData(address(usdc), SLICE, FLOOR), AMOUNT, _permit(1));
        vm.stopPrank();
    }

    /// The venue pulls past its exact slice approval, with router residue available to take: the token refuses.
    function test_attack_pullBeyondApproval_reverts() public {
        usdc.mint(address(router), 500e6);
        swap.setHostile(address(0), SLICE + 1, true);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(swap), SLICE, SLICE + 1)
        );
        router.bridgeFromCaller(_usdcFuel(), _swapData(address(usdc), SLICE, FLOOR), AMOUNT, AMOUNT);
    }

    /// A venue (or a hook inside it) hands back more input than it pulled and than it held before: refused, so a
    /// mid-swap transfer can never be passed off as the caller's leftover.
    function test_attack_venueReturnsMoreThanItPulled_refused() public {
        swap.armReenter(address(usdc), abi.encodeCall(MintableERC20.mint, (address(swap), SLICE + 1)));
        vm.prank(user);
        vm.expectRevert(DepositRouter.LeftoverExceedsPull.selector);
        router.bridgeFromCaller(_usdcFuel(), _swapData(address(usdc), SLICE, FLOOR), AMOUNT, AMOUNT);
    }

    /// A skipped deposit step swaps the target's own stray instead of the slice: the exact path refuses, the
    /// caller path keeps the whole pull in the token leg, and the user pays nothing for that fuel.
    function test_attack_skipPullStepSwapsTargetStray_userNeverShort() public {
        bytes memory skip = _swapDataMultiple(address(usdc), SLICE, FLOOR, false);
        usdc.mint(address(swap), 2 * 30e6);
        swap.set(30e6, FJ_OUT);

        vm.prank(user);
        vm.expectRevert(DepositRouter.InexactFuelConsumption.selector);
        router.bridgeWithPermit(_usdcFuel(), skip, AMOUNT, _permit(1));

        vm.prank(user);
        (uint256 tokenAmount, uint256 fuelOut) = router.bridgeFromCaller(_usdcFuel(), skip, AMOUNT, AMOUNT);
        assertEq(tokenAmount, AMOUNT, "the untouched slice joined the token leg");
        assertEq(fuelOut, FJ_OUT);
        assertEq(usdc.balanceOf(user), FUNDS - AMOUNT);
        assertEq(usdc.balanceOf(address(router)), 30e6, "the stray the venue returned is residue");
    }

    /// Residual of the whole-balance model the stray split assumes: a venue that returns its leftover as a delta
    /// while a stray stays at the target has that leftover read as stray, up to the stray's size. The shortfall is
    /// bounded by what someone left at the target and stays owner-sweepable residue; LI.FI's facet and the testnet
    /// swapper never take this shape.
    function test_residual_deltaReturningVenueWithTargetStray_boundedUnderCredit() public {
        usdc.mint(address(swap), 7e6);
        swap.set(60e6, FJ_OUT);
        swap.setHostile(address(0), 0, false);
        vm.prank(user);
        (uint256 tokenAmount,) =
            router.bridgeFromCaller(_usdcFuel(), _swapData(address(usdc), SLICE, FLOOR), AMOUNT, AMOUNT);
        assertEq(tokenAmount, AMOUNT - 60e6 - 7e6, "leftover under-credited by exactly the stray");
        assertEq(usdc.balanceOf(address(router)), 7e6, "the shortfall is residue");
        assertEq(usdc.balanceOf(address(swap)), 7e6, "the stray itself never moved");
    }

    // ─────────────── re-entrancy ───────────────

    /// The venue re-enters both entrypoints and `sweep`. It is made the router's owner so `sweep`'s owner check
    /// passes and only the lock stands between it and the in-flight funds.
    function test_attack_swapReentersEntrypointsAndSweep_failClosed() public {
        vm.prank(owner);
        router.transferOwnership(address(swap));
        vm.prank(address(swap));
        router.acceptOwnership();

        bytes[3] memory inner = [
            abi.encodeCall(DepositRouter.bridgeFromCaller, (_plainIntent(address(usdc), false), "", 1, 1)),
            abi.encodeCall(DepositRouter.bridgeWithPermit, (_plainIntent(address(usdc), false), "", 1, _permit(9))),
            abi.encodeCall(DepositRouter.sweep, (address(usdc), ATTACKER))
        ];
        for (uint256 k; k < inner.length; ++k) {
            swap.armReenter(address(router), inner[k]);
            vm.prank(user);
            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            router.bridgeFromCaller(_usdcFuel(), _swapData(address(usdc), SLICE, FLOOR), AMOUNT, AMOUNT);
        }
        assertEq(usdc.balanceOf(ATTACKER), 0);
    }

    /// The deposit token itself re-enters from its `transferFrom` hook: the inner call is refused, the outer one
    /// settles exactly.
    function test_attack_hostileTokenReentersFromTransferHook_failClosed() public {
        ReenteringToken evil = new ReenteringToken();
        evil.mint(user, 2 * AMOUNT);
        vm.prank(user);
        evil.approve(address(router), type(uint256).max);
        DepositRouter.DepositIntent memory i = _plainIntent(address(evil), false);
        evil.arm(address(router), abi.encodeCall(DepositRouter.bridgeFromCaller, (i, "", 1, AMOUNT)));

        vm.prank(user);
        router.bridgeFromCaller(i, "", AMOUNT, AMOUNT);
        assertEq(evil.innerRevert(), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector, "re-entry ran");
        assertEq(portalBalance(address(evil)), AMOUNT);
        assertEq(evil.balanceOf(address(router)), 0);
    }

    // ─────────────── pulls ───────────────

    /// The Executor holds more than this deposit and max-approves the router: only `maxPull` moves, and its
    /// standing approval is useless to anyone else because the router pulls only from `msg.sender`.
    function test_attack_executorStrayNotSweptBeyondMaxPull() public {
        usdc.mint(address(executor), AMOUNT + 777e6);
        executor.run(router, IERC20(address(usdc)), _plainIntent(address(usdc), false), "", AMOUNT, AMOUNT);
        assertEq(portalBalance(address(usdc)), AMOUNT);
        assertEq(usdc.balanceOf(address(executor)), 777e6, "the Executor's stray stays put");

        vm.prank(ATTACKER);
        vm.expectRevert(DepositRouter.BelowMinimum.selector);
        router.bridgeFromCaller(_plainIntent(address(usdc), false), "", 1, 777e6);
        assertEq(usdc.balanceOf(address(executor)), 777e6);
    }

    /// Submitting someone's intent through the Permit2 path spends only the submitter: the owner is `msg.sender`.
    function test_attack_frontRunPermitIntent_spendsOnlyTheSubmitter() public {
        _fundForPermit(usdc, ATTACKER, AMOUNT);
        vm.prank(ATTACKER);
        router.bridgeWithPermit(_plainIntent(address(usdc), false), "", AMOUNT, _permit(1));
        assertEq(permit2.lastOwner(), ATTACKER);
        assertEq(usdc.balanceOf(user), FUNDS, "the intent's author paid nothing");
    }

    /// A 10 % transfer tax leaves the router short of the pull on both entrypoints.
    function test_attack_feeOnTransferToken_inexactPull() public {
        FeeOnTransferERC20 taxed = new FeeOnTransferERC20(1_000);
        taxed.mint(user, 2 * AMOUNT);
        vm.startPrank(user);
        taxed.approve(address(permit2), type(uint256).max);
        taxed.approve(address(router), type(uint256).max);
        vm.expectRevert(DepositRouter.InexactPull.selector);
        router.bridgeWithPermit(_plainIntent(address(taxed), false), "", AMOUNT, _permit(1));
        vm.expectRevert(DepositRouter.InexactPull.selector);
        router.bridgeFromCaller(_plainIntent(address(taxed), false), "", AMOUNT, AMOUNT);
        vm.stopPrank();
    }

    // ─────────────── atomicity, portals, native value ───────────────

    /// The fuel leg settles first; a token leg the clone refuses (> u128) unwinds it with everything else.
    function test_attack_tokenLegFailureUnwindsFuelLeg() public {
        PlainERC20 big = new PlainERC20("Big", "BIG");
        uint256 amount = uint256(type(uint128).max) + 1 + SLICE;
        big.mint(user, amount);
        vm.prank(user);
        big.approve(address(router), type(uint256).max);

        vm.prank(user);
        vm.expectRevert(TokenPortalImpl.AmountExceedsL2Max.selector);
        router.bridgeFromCaller(
            _fuelIntent(address(big), SLICE, FLOOR, false), _swapData(address(big), SLICE, FLOOR), amount, amount
        );
        assertEq(feePortal.calls(), 0, "no fuel deposit survived");
        assertEq(big.balanceOf(user), amount);
    }

    /// Pre-creating the clone cannot grief the first deposit: the router gets-or-creates the same clone.
    function test_attack_preCreatedClone_cannotGriefFirstDeposit() public {
        vm.prank(ATTACKER);
        address clone = factory.createPortal(address(usdc));
        uint256 sent = inbox.sent();
        vm.prank(user);
        router.bridgeFromCaller(_plainIntent(address(usdc), false), "", AMOUNT, AMOUNT);
        assertEq(factory.portalOf(address(usdc)), clone);
        assertEq(portalBalance(address(usdc)), AMOUNT);
        assertEq(inbox.sent(), sent + 1, "one deposit message, no second register");
    }

    /// A native delivery (Stargate's `value`) cannot land: the router is not payable.
    function test_attack_nativeValue_refused() public {
        vm.deal(user, 1 ether);
        vm.startPrank(user);
        (bool ok,) = address(router).call{value: 1}(
            abi.encodeCall(DepositRouter.bridgeFromCaller, (_plainIntent(address(usdc), false), "", AMOUNT, AMOUNT))
        );
        assertFalse(ok, "payable entrypoint");
        (ok,) = address(router).call{value: 1}("");
        assertFalse(ok, "receive or fallback");
        vm.stopPrank();
        assertEq(address(router).balance, 0);
    }

    // ─────────────── BN254-overflow secret hash, through Aztec's real Inbox ───────────────

    /// A secret hash at the field modulus is unclaimable on L2; Aztec's Inbox refuses it on either leg, so the whole
    /// deposit reverts (into a LI.FI recovery on the caller path). The largest field element still passes.
    function test_attack_bn254OverflowSecretHash_refusedByRealInbox() public {
        SettableInboxRollup rollup = new SettableInboxRollup();
        Inbox realInbox = new Inbox(address(rollup), IERC20(address(fj)), rollup.getVersion(), 512);
        rollup.setInbox(address(realInbox));
        PortalFactory realFactory =
            new PortalFactory(IRegistry(address(new FakeRegistry(address(rollup)))), HUB, guardian);
        address realFeeJuicePortal = realInbox.getFeeAssetPortal();
        DepositRouter real =
            new DepositRouter(address(permit2), realFeeJuicePortal, address(realFactory), address(swap), owner);
        _fundForPermit(fj, user, 10 ether);

        // The identity leg sends both messages without a swap: fuel through the FeeJuicePortal, token through the clone.
        DepositRouter.DepositIntent memory i = _fuelIntent(address(fj), 4 ether, 4 ether, false);
        bytes memory tooLarge = abi.encodeWithSelector(Errors.Inbox__SecretHashTooLarge.selector, bytes32(BN254_P));
        i.tokenSecretHash = bytes32(BN254_P);
        vm.prank(user);
        vm.expectRevert(tooLarge);
        real.bridgeWithPermit(i, "", 10 ether, _permit(1));

        i.tokenSecretHash = SECRET;
        i.fuelSecretHash = bytes32(BN254_P);
        vm.prank(user);
        vm.expectRevert(tooLarge);
        real.bridgeWithPermit(i, "", 10 ether, _permit(2));

        i.tokenSecretHash = bytes32(BN254_P - 1);
        i.fuelSecretHash = bytes32(BN254_P - 1);
        vm.prank(user);
        real.bridgeWithPermit(i, "", 10 ether, _permit(3));
        assertEq(fj.balanceOf(realFeeJuicePortal), 4 ether);
        assertEq(fj.balanceOf(realFactory.predictPortal(address(fj))), 6 ether);
    }
}
