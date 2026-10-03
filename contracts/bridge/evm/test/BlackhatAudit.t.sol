// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

// ─────────────────────────────────────────────────────────────────────────────
// BLACKHAT AUDIT SUITE — adversarial PoCs against the router (over the REAL factory + clones).
// Every test is an ATTACK attempt; PASS = the attack outcome asserted in its name.
// Findings legend:
//   [F-A] deploy-then-initialize portal first-init front-run → brick + (if address published) full drain
//   [F-B] donation-grief NEUTRALIZED by delta checks (defense holds)
//   [F-C] hostile swapTarget: inflated report / short transfer / no-consume → caught
//   [F-D] hostile swapTarget reentrancy into router → fail-closed
//   [F-E] fee-on-transfer bridgeToken → DoS (informational)
//   [F-F] swapTarget migration invalidates pending signatures (fail-closed liveness)
//   [F-G] UniswapFuelSwap accepts a route it cannot settle ({X/native},{native/FJ})
//         → CurrencyNotSettled at unlock exit (fail-closed, self-DoS only)
//   [F-H] minFuelOutput=0 is signable → contract permits dust fuel (user-signed)
//   [F-I] a look-alike portal (a genuine clone of ANOTHER token, or a hand-rolled fake) → refused
//         before any pull
//   [F-J] partial "AZTEC + gas" aimed at the FeeJuicePortal → refused (would mint gas)
//   [F-K] a fuel-only intent smuggling a token leg → refused
//   [F-L] a hostile bridge token re-entering the router from its transfer hook → fail-closed
//   [F-M] a hostile bridge token (made router owner) rotating the swap target mid-bridge → refused;
//         the fuel slice goes to the target the user signed for
// ─────────────────────────────────────────────────────────────────────────────

import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {ERC20} from "@oz/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@oz/utils/ReentrancyGuard.sol";

import {SwapBridgeRouter, IUniswapFuelSwap} from "../src/SwapBridgeRouter.sol";
import {ITokenPortal} from "../src/interfaces/ITokenPortal.sol";
import {MintableERC20} from "../src/MintableERC20.sol";
import {RouterFixture} from "./mocks/RouterFixture.sol";
import {MockSwap, MaliciousPrefundSwap} from "./mocks/RouterMocks.sol";
import {FeeOnTransferERC20} from "./mocks/MetadataERC20s.sol";

uint256 constant MAX_UINT = type(uint256).max;

// ═══════════════════════════ hostile actors ═══════════════════════════

/// A portal that reports success and pulls nothing — the residue-strand shape of a
/// caller-named-portal phishing surface.
contract FakePortal is ITokenPortal {
    function depositToAztecPublic(bytes32, uint256, bytes32) external pure override returns (bytes32, uint256) {
        return (bytes32(uint256(0xDEAD)), 0);
    }

    function depositToAztecPrivate(uint256, bytes32) external pure override returns (bytes32, uint256) {
        return (bytes32(uint256(0xDEAD)), 0);
    }
}

/// A bridge token whose `transferFrom` re-enters the router mid-pull. `acceptOwnership` is exposed so
/// the token can be made the router's owner (a compromised-owner scenario).
contract ReenteringERC20 is ERC20 {
    SwapBridgeRouter public router;
    bytes public payload;
    bytes4 public innerRevert;

    constructor() ERC20("Reenter", "RE") {}

    function arm(SwapBridgeRouter r, bytes calldata call) external {
        router = r;
        payload = call;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function acceptOwnership() external {
        router.acceptOwnership();
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        bool ok = super.transferFrom(from, to, value);
        if (to == address(router) && payload.length > 0) {
            (bool success, bytes memory ret) = address(router).call(payload);
            innerRevert = success ? bytes4(0xffffffff) : bytes4(ret);
            payload = "";
        }
        return ok;
    }
}

// ═══════════════════ attacker infra for the deploy-then-initialize portal front-run ═══════════════════

contract AttackerInbox {
    uint256 public nextIndex;

    function sendL2Message(DataStructures.L2Actor calldata, bytes32 contentHash, bytes32 secretHash)
        external
        returns (bytes32 key, uint256 index)
    {
        key = keccak256(abi.encode(contentHash, secretHash));
        index = nextIndex++;
    }
}

contract AttackerOutbox {
    // Accepts ANY consume — the attacker fully controls their fake rollup's outbox.
    function consume(DataStructures.L2ToL1Msg calldata, Epoch, uint256, uint256, bytes32[] calldata) external pure {}
}

contract AttackerRollup {
    AttackerInbox public inbox = new AttackerInbox();
    AttackerOutbox public outbox = new AttackerOutbox();

    function getInbox() external view returns (address) {
        return address(inbox);
    }

    function getOutbox() external view returns (address) {
        return address(outbox);
    }

    function getVersion() external pure returns (uint256) {
        return 1;
    }
}

contract AttackerRegistry {
    address public rollup;

    constructor() {
        rollup = address(new AttackerRollup());
    }

    function getCanonicalRollup() external view returns (address) {
        return rollup;
    }
}

// ═══════════════════════ THE SUITE ═══════════════════════

contract BlackhatAuditTest is RouterFixture {
    function setUp() public {
        _deployStack(6, 1_000_000_000);
        usdc.mint(address(this), 10_000 * 1e6);
        usdc.approve(address(permit2), type(uint256).max);
        fj.mint(address(this), 1_000 ether);
        fj.approve(address(permit2), type(uint256).max);
        swap.setOutput(1 ether, 0); // honest default: report == transfer
    }

    function _fuel(bool isPrivate) internal view returns (SwapBridgeRouter.BridgeParams memory) {
        return _fuelParams(address(usdc), 1000 * 1e6, 100 * 1e6, isPrivate);
    }

    // ─────────────────────── [F-B] donation-grief neutrality ───────────────────────

    function test_FB_donationGriefIsNeutralized() public {
        usdc.mint(address(0xBAD), 500 * 1e6);
        vm.prank(address(0xBAD));
        usdc.transfer(address(router), 500 * 1e6);
        fj.mint(address(0xBAD), 3 ether);
        vm.prank(address(0xBAD));
        IERC20(address(fj)).transfer(address(router), 3 ether);

        uint256 feePortalBefore = fj.balanceOf(address(feePortal));
        router.bridgeWithFuel(_fuel(false), _permit(1));

        assertEq(portalBalance(address(usdc)), 900 * 1e6, "token leg exact despite donation");
        assertEq(fj.balanceOf(address(feePortal)) - feePortalBefore, 1 ether, "fuel leg exact despite donation");
        assertEq(usdc.balanceOf(address(router)), 500 * 1e6, "donated residue untouched (owner-sweepable)");
    }

    // ─────────────────────── [F-C] hostile swapTarget accounting ───────────────────────

    function test_FC_inflatedReportShortTransfer_reverts() public {
        swap.setOutput(2 ether, 0.5 ether);
        SwapBridgeRouter.BridgeParams memory hp = _fuel(false);
        vm.expectRevert(bytes("SwapBridgeRouter: balance mismatch"));
        router.bridgeWithFuel(hp, _permit(1));
    }

    function test_FC_prefundedNoConsume_reverts() public {
        MaliciousPrefundSwap hostile = new MaliciousPrefundSwap(IERC20(address(fj)));
        router.setSwapTarget(address(hostile));
        fj.mint(address(hostile), 10 ether);
        SwapBridgeRouter.BridgeParams memory hp = _fuel(false);
        vm.expectRevert(bytes("SwapBridgeRouter: fuel not consumed"));
        router.bridgeWithFuel(hp, _permit(1));
    }

    // ─────────────────────── [F-D] reentrancy via swap target ───────────────────────

    function test_FD_swapTargetReentersBridge_failClosed() public {
        bytes memory inner = abi.encodeWithSelector(
            router.bridge.selector,
            _simpleParams(address(usdc), 50 * 1e6, false),
            SwapBridgeRouter.PermitParams({nonce: 7, deadline: MAX_UINT, signature: hex"00"})
        );
        swap.armReenter(address(router), inner);

        SwapBridgeRouter.BridgeParams memory hp = _fuel(false);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        router.bridgeWithFuel(hp, _permit(1));
    }

    // ─────────────────────── [F-E] fee-on-transfer DoS ───────────────────────

    /// A 10 % tax leaves the router short of the signed amount at the Permit2 pull; the router's
    /// own exact-in check refuses it before the swap or either portal sees a wei — pinned to that
    /// error, not a bare expectRevert, so failing for any other reason cannot pass as this.
    function test_FE_feeOnTransferToken_DoS() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20(1_000);
        fot.mint(address(this), 10_000 ether);
        fot.approve(address(permit2), MAX_UINT);

        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(fot), 1000 ether, 100 ether, false);
        vm.expectRevert(SwapBridgeRouter.InexactPull.selector);
        router.bridgeWithFuel(p, _permit(2));
        assertEq(fot.balanceOf(address(this)), 10_000 ether, "nothing left the user");
        assertEq(fot.balanceOf(address(router)), 0, "no residue");
    }

    // ─────────────────────── [F-F] migration changes the signed witness ───────────────────────

    /// `MockPermit2` records the witness it is handed and never verifies a signature against it,
    /// so this proves only that `swapTarget` is one of the hashed witness fields — rotating it
    /// changes what a user would have to sign.
    function test_FF_migrationChangesSignedWitness() public {
        router.bridgeWithFuel(_fuel(false), _permit(1));
        bytes32 witnessBefore = permit2.lastWitness();

        MockSwap newSwap = new MockSwap(IERC20(address(fj)));
        fj.mint(address(newSwap), 100_000 ether);
        newSwap.setOutput(1 ether, 0);
        router.setSwapTarget(address(newSwap));

        router.bridgeWithFuel(_fuel(false), _permit(9));
        assertTrue(witnessBefore != permit2.lastWitness(), "witness must drift with swapTarget");
    }

    // ─────────────────────── [F-H] minFuelOutput=0 is signable ───────────────────────

    function test_FH_zeroMinFuelOutput_permitsDust() public {
        SwapBridgeRouter.BridgeParams memory p = _fuel(false);
        p.minFuelOutput = 0;
        swap.setOutput(1 wei, 0);
        router.bridgeWithFuel(p, _permit(1));
        assertEq(fj.balanceOf(address(feePortal)), 1 wei, "dust fuel deposited");
    }

    // ─────────────────────── [F-I] look-alike portals ───────────────────────

    /// A GENUINE clone — of a different token — is still foreign for this token; so is a
    /// hand-rolled portal that reports success and pulls nothing. Both are refused before the
    /// Permit2 pull, so the strand-in-router phishing surface no longer exists.
    function test_FI_lookAlikePortals_refusedBeforePull() public {
        MintableERC20 other = new MintableERC20("Other", "OTH", 6, 1_000_000_000);
        address otherClone = factory.createPortal(address(other));
        FakePortal fake = new FakePortal();

        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(usdc), 500 * 1e6, false);
        p.tokenPortal = otherClone;
        vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
        router.bridge(p, _permit(1));

        p.tokenPortal = address(fake);
        vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
        router.bridge(p, _permit(2));

        SwapBridgeRouter.BridgeParams memory fp = _fuel(false);
        fp.tokenPortal = address(fake);
        vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
        router.bridgeWithFuel(fp, _permit(3));

        assertEq(permit2.calls(), 0, "a look-alike portal reached Permit2");
        assertEq(usdc.balanceOf(address(router)), 0, "residue stranded");
        assertEq(usdc.balanceOf(address(this)), 10_000 * 1e6, "victim funds moved");
    }

    // ─────────────────────── [F-J] partial AZTEC + gas into the FeeJuicePortal ───────────────────────

    /// Naming the FeeJuicePortal for a partial fee-asset intent would mint the remainder as gas
    /// (and its private variant does not even exist there). Refused on the split, not the portal:
    /// the same portal is legal for a full public `bridge()`.
    function test_FJ_partialFeeAssetIntoFeeJuicePortal_refused() public {
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _noRoute();
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(fj), 10 ether, 4 ether, false);
        p.path = path;
        p.zeroForOnes = dirs;
        p.minFuelOutput = 4 ether;
        p.tokenPortal = address(feePortal);
        vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
        router.bridgeWithFuel(p, _permit(1));

        p.isPrivate = true;
        vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
        router.bridgeWithFuel(p, _permit(2));
        assertEq(permit2.calls(), 0);

        SwapBridgeRouter.SimpleBridgeParams memory sp = _simpleParams(address(fj), 10 ether, false);
        sp.tokenPortal = address(feePortal);
        router.bridge(sp, _permit(3));
        assertEq(feePortal.lastAmount(), 10 ether, "full public direct gas is the legal shape");
    }

    // ─────────────────────── [F-K] fuel-only smuggling a token leg ───────────────────────

    /// `fuelAmount == totalAmount` leaves no remainder, so any token-leg field is an attempt to
    /// sign one thing and have the router do another. Every combination is refused.
    function test_FK_fuelOnlySmugglingTokenLeg_refused() public {
        SwapBridgeRouter.BridgeParams memory p = _fuel(false);
        p.fuelAmount = p.totalAmount;
        vm.expectRevert(SwapBridgeRouter.FuelOnlyLeg.selector);
        router.bridgeWithFuel(p, _permit(1));

        p.tokenPortal = address(0);
        p.tokenSecretHash = bytes32(0);
        vm.expectRevert(SwapBridgeRouter.FuelOnlyLeg.selector); // recipient still set
        router.bridgeWithFuel(p, _permit(2));

        p.aztecRecipient = bytes32(0);
        router.bridgeWithFuel(p, _permit(3));
        assertEq(feePortal.lastAmount(), 1 ether);
        assertEq(factory.portalOf(address(usdc)), address(0), "fuel-only must not create a portal");
    }

    // ─────────────────────── [F-L] hostile bridge token re-enters the router ───────────────────────

    function test_FM_ownerTokenRotatesSwapTargetMidBridge_refused() public {
        ReenteringERC20 evil = new ReenteringERC20();
        evil.mint(address(this), 1000 ether);
        evil.approve(address(permit2), MAX_UINT);
        MockSwap other = new MockSwap(IERC20(address(fj)));
        fj.mint(address(other), 100 ether);
        other.setOutput(50 ether, 0);
        evil.arm(router, abi.encodeWithSelector(router.setSwapTarget.selector, address(other)));
        router.transferOwnership(address(evil));
        evil.acceptOwnership();

        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(evil), 100 ether, 10 ether, false);
        router.bridgeWithFuel(p, _permit(1));

        assertEq(evil.innerRevert(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "rotation was not refused");
        assertEq(address(router.swapTarget()), address(swap), "target changed mid-bridge");
        assertEq(feePortal.lastAmount(), 1 ether, "fuel came from the signed target");
        assertEq(evil.balanceOf(address(swap)), 10 ether, "the slice went to the signed target");
    }

    function test_FL_bridgeTokenReentersRouter_failClosed() public {
        ReenteringERC20 evil = new ReenteringERC20();
        evil.mint(address(this), 1000 ether);
        evil.approve(address(permit2), MAX_UINT);
        SwapBridgeRouter.SimpleBridgeParams memory p = _simpleParams(address(evil), 100 ether, false);
        evil.arm(router, abi.encodeWithSelector(router.bridge.selector, p, _permit(9)));

        router.bridge(p, _permit(1));

        assertEq(evil.innerRevert(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "re-entry was not refused");
        assertEq(portalBalance(address(evil)), 100 ether, "outer deposit exact");
        assertEq(evil.balanceOf(address(router)), 0, "residue");
        assertEq(inbox.sent(), 2, "one register + one deposit, nothing from the re-entry");
    }
}
