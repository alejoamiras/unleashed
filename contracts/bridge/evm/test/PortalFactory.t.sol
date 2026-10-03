// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {
    Bytes32MetadataERC20,
    FeeOnTransferERC20,
    HeadlessStringERC20,
    HugeDecimalsERC20,
    HugeNameERC20,
    NoDecimalsERC20,
    NonAsciiNameERC20,
    PlainERC20,
    ReentrantNameERC20,
    SenderSurchargeERC20,
    StringDecimalsERC20,
    WeirdDecimalsERC20
} from "./mocks/MetadataERC20s.sol";

contract PortalFactoryTest is Test {
    bytes32 internal constant HUB = bytes32(uint256(0x4B));
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");

    CapturingInbox internal inbox;
    CapturingOutbox internal outbox;
    FakeRegistry internal registry;
    PortalFactory internal factory;
    PlainERC20 internal usdc;

    function setUp() public {
        inbox = new CapturingInbox();
        outbox = new CapturingOutbox();
        registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(outbox))));
        factory = new PortalFactory(IRegistry(address(registry)), HUB, guardian);
        usdc = new PlainERC20("USD Coin", "USDC");
    }

    function word(string memory s) internal pure returns (bytes32) {
        bytes memory b = bytes(s);
        uint256 acc;
        for (uint256 i = 0; i < 31; i++) {
            acc = (acc << 8) | (i < b.length ? uint8(b[i]) : 0);
        }
        return bytes32(acc);
    }

    function registerHash(address token, address portal, bytes32 n, bytes32 s, uint8 d) internal pure returns (bytes32) {
        return Hash.sha256ToField(
            abi.encodeWithSignature("register(address,address,bytes32,bytes32,uint8)", token, portal, n, s, d)
        );
    }

    // ── The registration tuple: everything the hub will trust agrees ────────────────────────────

    function test_createPortal_registersTheWholeTuple() public {
        address predicted = factory.predictPortal(address(usdc));
        vm.expectEmit(true, true, true, true);
        emit IPortalFactory.PortalCreated(
            address(usdc), predicted, word("USD Coin"), word("USDC"), 18, keccak256(abi.encode(registerHash(address(usdc), predicted, word("USD Coin"), word("USDC"), 18), factory.REGISTER_SECRET_HASH())), 0
        );
        address portal = factory.createPortal(address(usdc));

        assertEq(portal, predicted, "clone landed at the predicted address");
        assertEq(address(TokenPortalImpl(portal).underlying()), address(usdc), "clone's immutable arg is the token");
        assertEq(factory.portalOf(address(usdc)), portal);
        assertEq(factory.tokenOf(portal), address(usdc));

        IPortalFactory.Registration memory r = factory.registrationOf(address(usdc));
        assertEq(r.portal, portal);
        assertEq(r.decimals, 18);
        assertEq(r.nameWord, word("USD Coin"));
        assertEq(r.symbolWord, word("USDC"));
        assertEq(r.registerIndex, 0);
        assertEq(r.registerKey, inbox.lastContentHash() == bytes32(0) ? bytes32(0) : keccak256(abi.encode(inbox.lastContentHash(), inbox.lastSecretHash())));

        assertEq(inbox.lastSender(), address(factory), "the FACTORY is the L1 actor of the register message");
        assertEq(inbox.lastBridge(), HUB, "addressed to the hub");
        assertEq(inbox.lastVersion(), 4242);
        assertEq(inbox.lastContentHash(), registerHash(address(usdc), portal, word("USD Coin"), word("USDC"), 18));
        assertEq(inbox.lastSecretHash(), factory.REGISTER_SECRET_HASH());
        assertEq(TokenPortalImpl(portal).L2_HUB(), HUB);
        assertEq(address(TokenPortalImpl(portal).FACTORY()), address(factory));
    }

    function test_createPortal_isIdempotent() public {
        address first = factory.createPortal(address(usdc));
        uint256 sentBefore = inbox.sent();
        address second = factory.createPortal(address(usdc));
        assertEq(second, first);
        assertEq(inbox.sent(), sentBefore, "no second register message");
    }

    function test_createPortal_frontRunIsIdentityPreserving() public {
        address predicted = factory.predictPortal(address(usdc));
        vm.prank(alice);
        address portal = factory.createPortal(address(usdc));
        assertEq(portal, predicted);
        assertEq(factory.registrationOf(address(usdc)).nameWord, word("USD Coin"));
    }

    // ── Metadata classification ───────────────────────────────────────────────────────

    function test_createPortal_rejectsEOA() public {
        vm.expectRevert(IPortalFactory.NotAContract.selector);
        factory.createPortal(alice);
    }

    function test_createPortal_requiresDecimals() public {
        address none = address(new NoDecimalsERC20());
        address str = address(new StringDecimalsERC20());
        address huge = address(new HugeDecimalsERC20());
        vm.expectRevert(IPortalFactory.NoDecimals.selector);
        factory.createPortal(none);
        vm.expectRevert(IPortalFactory.NoDecimals.selector);
        factory.createPortal(str);
        vm.expectRevert(IPortalFactory.NoDecimals.selector);
        factory.createPortal(huge);
    }

    function test_createPortal_acceptsEveryUint8Decimals() public {
        uint8[5] memory ds = [0, 18, 19, 38, 255];
        for (uint256 i = 0; i < ds.length; i++) {
            WeirdDecimalsERC20 t = new WeirdDecimalsERC20(ds[i]);
            factory.createPortal(address(t));
            assertEq(factory.registrationOf(address(t)).decimals, ds[i]);
        }
    }

    function test_createPortal_readsBytes32Metadata() public {
        Bytes32MetadataERC20 mkr = new Bytes32MetadataERC20();
        factory.createPortal(address(mkr));
        IPortalFactory.Registration memory r = factory.registrationOf(address(mkr));
        assertEq(r.nameWord, word("Maker"));
        assertEq(r.symbolWord, word("MKR"));
    }

    function test_createPortal_sanitizesNonAscii() public {
        NonAsciiNameERC20 t = new NonAsciiNameERC20();
        factory.createPortal(address(t));
        IPortalFactory.Registration memory r = factory.registrationOf(address(t));
        // "Nülo€" is N, 2 bytes, l, o, 3 bytes → every non-ASCII byte becomes `_`.
        assertEq(r.nameWord, word("N__lo___"));
        assertEq(r.symbolWord, word("N___"));
    }

    function test_createPortal_boundsHugeName() public {
        HugeNameERC20 t = new HugeNameERC20();
        uint256 gasBefore = gasleft();
        factory.createPortal(address(t));
        uint256 used = gasBefore - gasleft();
        assertLt(used, 600_000, "a 100 KB name must not be copied into memory");
        // Building a 100 KB return exhausts the metadata gas cap inside the token, so the read fails
        // closed: an empty name, a portal all the same.
        assertEq(factory.registrationOf(address(t)).nameWord, bytes32(0));
        assertEq(factory.registrationOf(address(t)).symbolWord, word("HUGE"));
        assertEq(factory.portalOf(address(t)), factory.predictPortal(address(t)));
    }

    /// A string head with no data word must not sanitize the empty buffer into 31 underscores.
    function test_createPortal_headlessStringFailsClosedToEmpty() public {
        HeadlessStringERC20 t = new HeadlessStringERC20();
        factory.createPortal(address(t));
        assertEq(factory.registrationOf(address(t)).nameWord, bytes32(0));
        assertEq(factory.registrationOf(address(t)).symbolWord, word("HEAD"));
    }

    function test_createPortal_reentrantNameFailsClosed() public {
        ReentrantNameERC20 t = new ReentrantNameERC20();
        t.setFactory(factory);
        factory.createPortal(address(t));
        // The reentrant STATICCALL reverts inside name(), which reports "blocked".
        assertEq(factory.registrationOf(address(t)).nameWord, word("blocked"));
        assertEq(factory.portalOf(address(t)), factory.predictPortal(address(t)));
    }

    // ── Guardian ──────────────────────────────────────────────────────────────────────

    function test_setPaused_isGuardianOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        factory.setPaused(true, true);

        vm.prank(guardian);
        vm.expectEmit(true, true, true, true);
        emit IPortalFactory.PauseChanged(true, false);
        factory.setPaused(true, false);
        assertTrue(factory.depositsPaused());
        assertFalse(factory.withdrawsPaused());
    }

    function test_renounceOwnership_isDisabled() public {
        vm.prank(guardian);
        vm.expectRevert(IPortalFactory.RenounceDisabled.selector);
        factory.renounceOwnership();
    }

    function test_ownership_isTwoStep() public {
        vm.prank(guardian);
        factory.transferOwnership(alice);
        assertEq(factory.owner(), guardian, "pending until accepted");
        vm.prank(alice);
        factory.acceptOwnership();
        assertEq(factory.owner(), alice);
    }

    // ── Clone behaviour ───────────────────────────────────────────────────────────────

    function _fundedPortal(uint256 amount) internal returns (TokenPortalImpl portal) {
        portal = TokenPortalImpl(factory.createPortal(address(usdc)));
        usdc.mint(alice, amount);
        vm.prank(alice);
        usdc.approve(address(portal), amount);
    }

    function test_clone_depositPublic_commitsCanonicalHash() public {
        TokenPortalImpl portal = _fundedPortal(1_000);
        bytes32 to = bytes32(uint256(0x1234));
        vm.prank(alice);
        (bytes32 key, uint256 index) = portal.depositToAztecPublic(to, 1_000, bytes32(uint256(0x5EC)));
        assertEq(index, 1, "register was leaf 0");
        assertEq(key, keccak256(abi.encode(inbox.lastContentHash(), inbox.lastSecretHash())));
        assertEq(inbox.lastSender(), address(portal));
        assertEq(inbox.lastBridge(), HUB);
        assertEq(inbox.lastContentHash(), Hash.sha256ToField(abi.encodeWithSignature("mint_to_public(bytes32,uint256)", to, uint256(1_000))));
        assertEq(usdc.balanceOf(address(portal)), 1_000);
    }

    function test_clone_depositPrivate_commitsCanonicalHash() public {
        TokenPortalImpl portal = _fundedPortal(7);
        vm.prank(alice);
        portal.depositToAztecPrivate(7, bytes32(uint256(0x5EC)));
        assertEq(inbox.lastContentHash(), Hash.sha256ToField(abi.encodeWithSignature("mint_to_private(uint256)", uint256(7))));
    }

    function test_clone_rejectsAmountAboveU128() public {
        TokenPortalImpl portal = _fundedPortal(1);
        vm.prank(alice);
        vm.expectRevert(TokenPortalImpl.AmountExceedsL2Max.selector);
        portal.depositToAztecPrivate(uint256(type(uint128).max) + 1, bytes32(0));
    }

    function test_clone_rejectsFeeOnTransfer() public {
        FeeOnTransferERC20 tax = new FeeOnTransferERC20(100);
        TokenPortalImpl portal = TokenPortalImpl(factory.createPortal(address(tax)));
        tax.mint(alice, 1_000);
        vm.startPrank(alice);
        tax.approve(address(portal), 1_000);
        vm.expectRevert(TokenPortalImpl.InexactTransfer.selector);
        portal.depositToAztecPublic(bytes32(uint256(1)), 1_000, bytes32(0));
        vm.stopPrank();
    }

    function test_clone_pauseBitsGateDepositsAndWithdrawals() public {
        TokenPortalImpl portal = _fundedPortal(10);
        vm.prank(guardian);
        factory.setPaused(true, true);

        vm.prank(alice);
        vm.expectRevert(TokenPortalImpl.DepositsPaused.selector);
        portal.depositToAztecPublic(bytes32(uint256(1)), 10, bytes32(0));

        bytes32[] memory path;
        vm.expectRevert(TokenPortalImpl.WithdrawsPaused.selector);
        portal.withdraw(alice, 1, false, Epoch.wrap(0), 0, 0, path);
    }

    function test_clone_withdraw_consumesAndDebitsExactly() public {
        TokenPortalImpl portal = _fundedPortal(500);
        vm.prank(alice);
        portal.depositToAztecPublic(bytes32(uint256(1)), 500, bytes32(0));

        bytes32[] memory path;
        portal.withdraw(alice, 200, true, Epoch.wrap(3), 9, 5, path);

        DataStructures.L2ToL1Msg memory m = outbox.lastMsg();
        assertEq(m.sender.actor, HUB);
        assertEq(m.sender.version, 4242);
        assertEq(m.recipient.actor, address(portal));
        assertEq(m.recipient.chainId, block.chainid);
        assertEq(m.content, Hash.sha256ToField(abi.encodeWithSignature("withdraw(address,uint256,address)", alice, uint256(200), address(this))));
        assertEq(usdc.balanceOf(alice), 200);
        assertEq(usdc.balanceOf(address(portal)), 300);
    }

    /// The mirror of the deposit check: a token that debits the reserve by more than the message
    /// authorised would bleed every other holder's backing, one withdrawal at a time.
    function test_clone_withdraw_rejectsOverDebit() public {
        SenderSurchargeERC20 sur = new SenderSurchargeERC20(100);
        TokenPortalImpl portal = TokenPortalImpl(factory.createPortal(address(sur)));
        sur.mint(alice, 1_010);
        vm.startPrank(alice);
        sur.approve(address(portal), 1_000);
        portal.depositToAztecPublic(bytes32(uint256(1)), 1_000, bytes32(0));
        vm.stopPrank();
        assertEq(sur.balanceOf(address(portal)), 1_000, "the deposit itself is exact");

        bytes32[] memory path;
        vm.expectRevert(TokenPortalImpl.InexactTransfer.selector);
        portal.withdraw(alice, 500, false, Epoch.wrap(3), 9, 5, path);
    }

    function test_implementation_refusesDirectUse() public {
        TokenPortalImpl impl = TokenPortalImpl(factory.IMPLEMENTATION());
        vm.expectRevert(TokenPortalImpl.ImplementationOnly.selector);
        impl.underlying();
        vm.expectRevert(TokenPortalImpl.ImplementationOnly.selector);
        impl.depositToAztecPrivate(1, bytes32(0));
    }
}
