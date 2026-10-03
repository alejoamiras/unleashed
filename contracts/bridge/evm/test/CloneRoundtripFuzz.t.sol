// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";

/// The content-hash model — sha256 with the top byte dropped, over `encodeWithSignature` —
/// replayed against a factory-made CLONE: a clone must put exactly the canonical portal's bytes on
/// the wire (content, secret hash, version, the hub as the L2 actor), or the L2 side never matches.
contract CloneRoundtripFuzzTest is Test {
    bytes32 internal constant HUB = bytes32(uint256(0x4B));
    CapturingInbox internal inbox;
    CapturingOutbox internal outbox;
    TokenPortalImpl internal portal;
    PlainERC20 internal token;

    function _model(bytes memory preimage) internal pure returns (bytes32) {
        return bytes32(uint256(sha256(preimage)) >> 8);
    }

    function setUp() public {
        inbox = new CapturingInbox();
        outbox = new CapturingOutbox();
        FakeRegistry registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(outbox))));
        PortalFactory factory = new PortalFactory(IRegistry(address(registry)), HUB, makeAddr("guardian"));
        token = new PlainERC20("Tok", "TOK");
        portal = TokenPortalImpl(factory.createPortal(address(token)));
        token.mint(address(this), 1e30);
        token.approve(address(portal), type(uint256).max);
        token.mint(address(portal), 1e30);
    }

    function testFuzz_depositPublic_contentHashMatchesIndependentModel(bytes32 to, uint256 amount, bytes32 secret) public {
        amount = bound(amount, 1, 1e30);
        (bytes32 key, uint256 index) = portal.depositToAztecPublic(to, amount, secret);
        assertEq(inbox.lastContentHash(), _model(abi.encodeWithSignature("mint_to_public(bytes32,uint256)", to, amount)));
        assertEq(inbox.lastSecretHash(), secret, "secret hash not forwarded");
        assertEq(inbox.lastVersion(), portal.ROLLUP_VERSION(), "rollup version not forwarded");
        assertEq(inbox.lastBridge(), HUB, "the L2 actor must be the hub");
        assertEq(inbox.lastSender(), address(portal), "the clone must be the L1 sender");
        assertEq(key, keccak256(abi.encode(inbox.lastContentHash(), secret)), "returned key");
        assertEq(index, 1, "returned index (the register message took 0)");
    }

    function testFuzz_depositPrivate_contentHashMatchesIndependentModel(uint256 amount, bytes32 secret) public {
        amount = bound(amount, 1, 1e30);
        portal.depositToAztecPrivate(amount, secret);
        assertEq(inbox.lastContentHash(), _model(abi.encodeWithSignature("mint_to_private(uint256)", amount)));
        assertEq(inbox.lastSecretHash(), secret, "secret hash not forwarded");
        assertEq(inbox.lastBridge(), HUB, "the L2 actor must be the hub");
    }

    function testFuzz_withdraw_messageReconstructionMatchesIndependentModel(
        address recipient,
        uint256 amount,
        bool withCaller,
        address callerOnL1
    ) public {
        _withdrawMatchesModel(recipient, amount, withCaller, callerOnL1);
    }

    /// The fuzzer's dictionary holds every address the run has seen, this contract's included, and
    /// `setUp` mints it 1e30: a payout is what the recipient GAINED, never what it holds.
    function test_withdraw_toAnAlreadyFundedRecipient() public {
        _withdrawMatchesModel(address(this), 1e22, false, address(0x20cE));
    }

    function _withdrawMatchesModel(address recipient, uint256 amount, bool withCaller, address callerOnL1) internal {
        amount = bound(amount, 1, 1e30);
        recipient = address(uint160(bound(uint160(recipient), 1, type(uint160).max)));
        vm.assume(recipient != address(portal));
        address caller = withCaller ? callerOnL1 : address(0);
        uint256 heldBefore = token.balanceOf(recipient);
        vm.prank(caller);
        portal.withdraw(recipient, amount, withCaller, Epoch.wrap(7), 3, 42, new bytes32[](0));

        DataStructures.L2ToL1Msg memory m = outbox.lastMsg();
        assertEq(m.content, _model(abi.encodeWithSignature("withdraw(address,uint256,address)", recipient, amount, caller)));
        assertEq(m.sender.actor, HUB, "sender must be the hub");
        assertEq(m.sender.version, portal.ROLLUP_VERSION(), "sender version");
        assertEq(m.recipient.actor, address(portal), "recipient must be the clone");
        assertEq(m.recipient.chainId, block.chainid, "recipient chain");
        assertEq(token.balanceOf(recipient) - heldBefore, amount, "payout");
    }
}
