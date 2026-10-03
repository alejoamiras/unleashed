// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

// ─────────────────────────────────────────────────────────────────────────────
// BLACKHAT SUITE — adversarial PoCs against PortalFactory + TokenPortalImpl clones.
// Every test is an ATTACK attempt; PASS = the outcome asserted in its name.
//   [F-1] front-running createPortal for an honest token → identity-preserving (nothing to gain)
//   [F-2] metadata callbacks re-entering the factory → fail closed (STATICCALL, no second portal)
//   [F-3] returndata bombs / gas-burning metadata → caller's cost bounded by METADATA_GAS
//   [F-4] metadata mutated after creation → registration frozen
//   [F-5] two tokens with identical metadata → distinct portals, distinct register hashes
//   [F-6] portal-of-a-portal / factory / implementation as "token" → refused
//   [F-7] ERC-777-style transfer hook re-entering deposit → rejected, one message, exact reserve
//   [F-8] guardian pending-ownership hijack → only the pending owner can accept
//   [F-9] ERC-777-style transfer hook re-entering withdraw → rejected, one payout, exact reserve
// ─────────────────────────────────────────────────────────────────────────────

import {Test} from "forge-std/Test.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {ERC20} from "@oz/token/ERC20/ERC20.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {HugeNameERC20, PlainERC20, ReentrantNameERC20} from "./mocks/MetadataERC20s.sol";

// ═══════════════════════════ hostile tokens ═══════════════════════════

/// `decimals()` re-enters the factory (a state-changing call under STATICCALL).
contract ReentrantDecimalsERC20 {
    IPortalFactory public factory;

    function setFactory(IPortalFactory f) external {
        factory = f;
    }

    function decimals() external returns (uint8) {
        factory.createPortal(address(this));
        return 6;
    }
}

/// `name()` burns every unit of gas it is given.
contract GasBurnerERC20 is ERC20 {
    constructor() ERC20("", "BURN") {}

    function name() public pure override returns (string memory) {
        uint256 x;
        while (true) x++;
        return "";
    }
}

/// Metadata the owner can rewrite after the portal exists.
contract MutableMetadataERC20 is ERC20 {
    uint8 private _d = 6;
    string private _n = "Before";

    constructor() ERC20("", "MUT") {}

    function set(string memory n, uint8 d) external {
        _n = n;
        _d = d;
    }

    function name() public view override returns (string memory) {
        return _n;
    }

    function decimals() public view override returns (uint8) {
        return _d;
    }
}

/// `transferFrom` re-enters the portal's deposit from inside the pull, and `transfer` re-enters
/// `withdraw` from inside the payout (ERC-777 hook shape).
contract HookERC20 is ERC20 {
    TokenPortalImpl public portal;
    bytes4 public hookRevert;
    bytes4 public withdrawHookRevert;

    constructor() ERC20("Hook", "HOOK") {}

    function setPortal(TokenPortalImpl p) external {
        portal = p;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        bool ok = super.transferFrom(from, to, value);
        if (to == address(portal)) {
            try portal.depositToAztecPublic(bytes32(uint256(0xBAD)), 1, bytes32(0)) {
                hookRevert = 0xffffffff;
            } catch (bytes memory reason) {
                hookRevert = bytes4(reason);
            }
        }
        return ok;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        bool ok = super.transfer(to, value);
        if (msg.sender == address(portal)) {
            try portal.withdraw(to, value, false, Epoch.wrap(0), 1, 0, new bytes32[](0)) {
                withdrawHookRevert = 0xffffffff;
            } catch (bytes memory reason) {
                withdrawHookRevert = bytes4(reason);
            }
        }
        return ok;
    }
}

// ═══════════════════════════ suite ═══════════════════════════

contract BlackhatFactoryTest is Test {
    address internal constant GUARDIAN = address(0x6A);
    address internal constant MALLORY = address(0xBAD);
    address internal constant ALICE = address(0xA11CE);
    uint256 internal constant METADATA_GAS = 100_000;

    PortalFactory internal factory;
    CapturingInbox internal inbox;

    function setUp() public {
        inbox = new CapturingInbox();
        FakeRegistry registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(new CapturingOutbox()))));
        factory = new PortalFactory(IRegistry(address(registry)), bytes32(uint256(0x4B)), GUARDIAN);
    }

    /// [F-1] Mallory creates the portal for Alice's token first. Every observable — portal address,
    /// registration tuple, the Inbox message and its sender — is byte-identical to the honest run.
    function test_F1_frontRunCreate_isIdentityPreserving() public {
        PlainERC20 t = new PlainERC20("USD Coin", "USDC");
        uint256 snap = vm.snapshotState();

        vm.prank(ALICE);
        address honestPortal = factory.createPortal(address(t));
        IPortalFactory.Registration memory honest = factory.registrationOf(address(t));
        bytes32 honestContent = inbox.lastContentHash();
        address honestSender = inbox.lastSender();

        vm.revertToState(snap);
        vm.prank(MALLORY);
        address portal = factory.createPortal(address(t));
        vm.prank(ALICE);
        assertEq(factory.createPortal(address(t)), portal, "alice's create diverged");

        assertEq(portal, honestPortal, "portal address depends on the creator");
        assertEq(keccak256(abi.encode(factory.registrationOf(address(t)))), keccak256(abi.encode(honest)), "registration");
        assertEq(inbox.lastContentHash(), honestContent, "register message differs");
        assertEq(inbox.lastSender(), honestSender, "message sender differs");
        assertEq(inbox.sent(), 1, "front-run produced an extra message");
    }

    /// [F-2] `name()` re-enters `createPortal`. The read runs under STATICCALL, so the nested create
    /// reverts, the word falls back, and exactly one portal + one message exist afterwards.
    function test_F2_reentrantName_cannotCreateTwice() public {
        ReentrantNameERC20 t = new ReentrantNameERC20();
        t.setFactory(factory);
        address portal = factory.createPortal(address(t));
        assertEq(inbox.sent(), 1, "reentrant create sent a message");
        assertEq(factory.portalOf(address(t)), portal);
        assertEq(factory.tokenOf(portal), address(t));
        assertEq(uint8(factory.registrationOf(address(t)).nameWord[1]), uint8(bytes1("b")), "name was not the fallback");
    }

    /// [F-2] `decimals()` re-enters. `decimals` is mandatory, so the failed STATICCALL refuses the
    /// portal outright — a token that cannot answer honestly gets nothing.
    function test_F2_reentrantDecimals_refused() public {
        ReentrantDecimalsERC20 t = new ReentrantDecimalsERC20();
        t.setFactory(factory);
        vm.expectRevert(IPortalFactory.NoDecimals.selector);
        factory.createPortal(address(t));
        assertEq(inbox.sent(), 0);
        assertEq(factory.portalOf(address(t)), address(0));
    }

    /// [F-3] A 100 KB `name()` and an infinite-loop `name()` both cost the caller at most the two
    /// capped metadata reads more than a plain token — no returndata copy, no unbounded burn.
    function test_F3_hostileMetadata_gasBounded() public {
        PlainERC20 plain = new PlainERC20("Plain", "PLN");
        HugeNameERC20 huge = new HugeNameERC20();
        GasBurnerERC20 burner = new GasBurnerERC20();

        uint256 g = gasleft();
        factory.createPortal(address(plain));
        uint256 plainCost = g - gasleft();

        g = gasleft();
        factory.createPortal(address(huge));
        uint256 hugeCost = g - gasleft();

        g = gasleft();
        factory.createPortal(address(burner));
        uint256 burnCost = g - gasleft();

        assertLt(hugeCost, plainCost + 2 * METADATA_GAS, "returndata bomb billed the caller");
        assertLt(burnCost, plainCost + 2 * METADATA_GAS, "gas burner billed the caller");
        assertEq(factory.registrationOf(address(burner)).nameWord, bytes32(0), "burner name must fail closed");
        assertEq(inbox.sent(), 3, "every token still got its one register message");
    }

    /// [F-4] Rewriting metadata after creation changes nothing the bridge relies on: the registration
    /// and the register message were frozen at create, and a second create returns the old portal.
    function test_F4_mutatedMetadata_registrationFrozen() public {
        MutableMetadataERC20 t = new MutableMetadataERC20();
        address portal = factory.createPortal(address(t));
        IPortalFactory.Registration memory before = factory.registrationOf(address(t));
        bytes32 content = inbox.lastContentHash();

        t.set("After", 18);
        assertEq(factory.createPortal(address(t)), portal);
        assertEq(keccak256(abi.encode(factory.registrationOf(address(t)))), keccak256(abi.encode(before)));
        assertEq(before.decimals, 6);
        assertEq(inbox.lastContentHash(), content);
        assertEq(inbox.sent(), 1);
    }

    /// [F-5] A look-alike token (same name/symbol/decimals) gets its own portal and its own register
    /// hash — the token ADDRESS is in both. Spoofing is a display concern for the app, never a
    /// collision on chain.
    function test_F5_identicalMetadata_noCollision() public {
        PlainERC20 real = new PlainERC20("USD Coin", "USDC");
        PlainERC20 fake = new PlainERC20("USD Coin", "USDC");
        address pr = factory.createPortal(address(real));
        bytes32 hr = inbox.lastContentHash();
        address pf = factory.createPortal(address(fake));
        bytes32 hf = inbox.lastContentHash();

        assertNotEq(pr, pf);
        assertNotEq(hr, hf);
        assertEq(factory.registrationOf(address(real)).nameWord, factory.registrationOf(address(fake)).nameWord);
        assertEq(factory.tokenOf(pr), address(real));
        assertEq(factory.tokenOf(pf), address(fake));
        assertEq(address(TokenPortalImpl(pf).underlying()), address(fake));
    }

    /// [F-6] Contracts without a sane `decimals()` — a clone, the factory, the implementation — are
    /// refused as tokens, so the registry cannot be polluted with portals of portals.
    function test_F6_bridgeContractsAsTokens_refused() public {
        PlainERC20 t = new PlainERC20("Tok", "TOK");
        address portal = factory.createPortal(address(t));

        vm.expectRevert(IPortalFactory.NoDecimals.selector);
        factory.createPortal(portal);
        vm.expectRevert(IPortalFactory.NoDecimals.selector);
        factory.createPortal(address(factory));
        address impl = factory.IMPLEMENTATION();
        vm.expectRevert(IPortalFactory.NoDecimals.selector);
        factory.createPortal(impl);
        assertEq(inbox.sent(), 1);
    }

    /// [F-7] The token's `transferFrom` re-enters `depositToAztecPublic` mid-pull. The transient
    /// guard rejects it; the outer deposit completes with one message and an exact reserve.
    function test_F7_transferHookReentersDeposit_rejected() public {
        HookERC20 t = new HookERC20();
        TokenPortalImpl portal = TokenPortalImpl(factory.createPortal(address(t)));
        t.setPortal(portal);
        t.mint(ALICE, 100);
        uint256 registers = inbox.sent();

        vm.startPrank(ALICE);
        t.approve(address(portal), 100);
        portal.depositToAztecPublic(bytes32(uint256(1)), 100, bytes32(0));
        vm.stopPrank();

        assertEq(t.hookRevert(), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector, "hook was not rejected");
        assertEq(inbox.sent(), registers + 1, "the nested deposit sent a message");
        assertEq(t.balanceOf(address(portal)), 100, "reserve drifted");
    }

    /// [F-9] The token's `transfer` re-enters `withdraw` mid-payout. The capturing outbox would
    /// accept the nested message, so the transient guard is all that refuses it.
    function test_F9_transferHookReentersWithdraw_rejected() public {
        HookERC20 t = new HookERC20();
        TokenPortalImpl portal = TokenPortalImpl(factory.createPortal(address(t)));
        t.setPortal(portal);
        t.mint(address(portal), 100);

        portal.withdraw(ALICE, 40, false, Epoch.wrap(0), 1, 0, new bytes32[](0));

        assertEq(t.withdrawHookRevert(), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector, "hook was not rejected");
        assertEq(t.balanceOf(ALICE), 40, "the nested withdrawal paid out");
        assertEq(t.balanceOf(address(portal)), 60, "reserve drifted");
    }

    /// [F-8] A pending ownership transfer cannot be accepted by anyone but the nominee, and the
    /// guardian keeps the pause bits until then.
    function test_F8_pendingOwnershipHijack_rejected() public {
        vm.prank(GUARDIAN);
        factory.transferOwnership(ALICE);

        vm.prank(MALLORY);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, MALLORY));
        factory.acceptOwnership();

        vm.prank(MALLORY);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, MALLORY));
        factory.setPaused(true, true);

        assertEq(factory.owner(), GUARDIAN);
        vm.prank(GUARDIAN);
        factory.setPaused(true, false);
        assertTrue(factory.depositsPaused());
    }
}
