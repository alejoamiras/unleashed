// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Outbox} from "@aztec/core/messagebridge/Outbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Errors} from "@aztec/core/libraries/Errors.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {CapturingInbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";

/// A clone withdrawing through Aztec's REAL Outbox — membership proof and nullifier bitmap
/// included — instead of the capturing fake, which accepts anything any number of times. On the
/// withdrawal path only the rollup is faked: it is the one party allowed to insert a root.
///
/// The proven epoch holds a four-leaf tree `[alice, bob, 0, 0]`: leaf 0 pays alice 200 and is
/// bound to `relayer` as the L1 caller, leaf 1 pays bob 300 and anyone may deliver it. A
/// bystander who holds the token and has approved the portal closes the books: with alice, bob
/// and the reserve, that is the whole supply.
contract CloneWithdrawRealOutboxTest is Test {
    bytes32 internal constant HUB = bytes32(uint256(0x4B));
    uint256 internal constant VERSION = 4242;
    uint256 internal constant CHECKPOINTS = 3;
    uint256 internal constant RESERVE = 1_000;
    uint256 internal constant BYSTANDER_HOLDS = 1_000;
    Epoch internal constant EPOCH = Epoch.wrap(7);

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal relayer = makeAddr("relayer");
    address internal mallory = makeAddr("mallory");
    address internal bystander = makeAddr("bystander");

    Outbox internal outbox;
    FakeRollup internal rollup;
    PortalFactory internal factory;
    TokenPortalImpl internal portal;
    PlainERC20 internal token;
    bytes32 internal aliceLeaf;
    bytes32 internal bobLeaf;
    bytes32 internal emptyPair;
    bytes32 internal root;

    function setUp() public {
        CapturingInbox inbox = new CapturingInbox();
        // The Outbox and the rollup name each other in their constructors.
        address rollupAddr = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        outbox = new Outbox(rollupAddr, VERSION);
        rollup = new FakeRollup(address(inbox), address(outbox));
        assertEq(address(rollup), rollupAddr, "rollup address prediction");

        factory = new PortalFactory(IRegistry(address(new FakeRegistry(rollupAddr))), HUB, makeAddr("guardian"));
        token = new PlainERC20("Tok", "TOK");
        portal = TokenPortalImpl(factory.createPortal(address(token)));
        assertEq(address(portal.OUTBOX()), address(outbox), "clone is wired to the real outbox");
        token.mint(address(portal), RESERVE);
        token.mint(bystander, BYSTANDER_HOLDS);
        vm.prank(bystander);
        token.approve(address(portal), BYSTANDER_HOLDS);

        aliceLeaf = _leaf(address(portal), alice, 200, relayer);
        bobLeaf = _leaf(address(portal), bob, 300, address(0));
        emptyPair = _parent(bytes32(0), bytes32(0));
        root = _parent(_parent(aliceLeaf, bobLeaf), emptyPair);
        vm.prank(rollupAddr);
        outbox.insert(EPOCH, CHECKPOINTS, root);
    }

    function test_provenMessagesPayOnce() public {
        vm.prank(relayer);
        portal.withdraw(alice, 200, true, EPOCH, CHECKPOINTS, 0, _path(bobLeaf, emptyPair));
        vm.prank(mallory);
        portal.withdraw(bob, 300, false, EPOCH, CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));
        _assertBalances(200, 300);

        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__AlreadyNullified.selector, EPOCH, 4));
        vm.prank(relayer);
        portal.withdraw(alice, 200, true, EPOCH, CHECKPOINTS, 0, _path(bobLeaf, emptyPair));
        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__AlreadyNullified.selector, EPOCH, 5));
        portal.withdraw(bob, 300, false, EPOCH, CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));
        _assertBalances(200, 300);
    }

    /// A longer proof of the same epoch fills a padding leaf, so the same messages sit at the same
    /// positions under a DIFFERENT root. Spent stays spent, in both directions.
    function test_extendingProof_doesNotReopenASpentMessage() public {
        vm.prank(relayer);
        portal.withdraw(alice, 200, true, EPOCH, CHECKPOINTS, 0, _path(bobLeaf, emptyPair));

        bytes32 grownPair = _parent(_leaf(address(portal), makeAddr("carol"), 50, address(0)), bytes32(0));
        // Hashed ahead of the prank: sha256 is a precompile CALL and would consume it.
        bytes32 grownRoot = _parent(_parent(aliceLeaf, bobLeaf), grownPair);
        assertNotEq(grownRoot, root, "the longer proof must publish a different root");
        vm.prank(address(rollup));
        outbox.insert(EPOCH, CHECKPOINTS + 1, grownRoot);

        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__AlreadyNullified.selector, EPOCH, 4));
        vm.prank(relayer);
        portal.withdraw(alice, 200, true, EPOCH, CHECKPOINTS + 1, 0, _path(bobLeaf, grownPair));

        // Bob's delivery under the longer proof is what shows alice's replay path was a valid one.
        portal.withdraw(bob, 300, false, EPOCH, CHECKPOINTS + 1, 1, _path(aliceLeaf, grownPair));
        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__AlreadyNullified.selector, EPOCH, 5));
        portal.withdraw(bob, 300, false, EPOCH, CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));
        _assertBalances(200, 300);
    }

    function test_callerBoundMessage_onlyItsCallerDelivers() public {
        _expectInvalidRoot(_leaf(address(portal), alice, 200, mallory), bobLeaf, 0);
        vm.prank(mallory);
        portal.withdraw(alice, 200, true, EPOCH, CHECKPOINTS, 0, _path(bobLeaf, emptyPair));

        _expectInvalidRoot(_leaf(address(portal), alice, 200, address(0)), bobLeaf, 0);
        vm.prank(mallory);
        portal.withdraw(alice, 200, false, EPOCH, CHECKPOINTS, 0, _path(bobLeaf, emptyPair));
        _assertBalances(0, 0);

        // A refused attempt nullifies nothing: the bound caller still delivers.
        vm.prank(relayer);
        portal.withdraw(alice, 200, true, EPOCH, CHECKPOINTS, 0, _path(bobLeaf, emptyPair));
        _assertBalances(200, 0);
    }

    function test_rejectsWhatTheTreeDoesNotHold() public {
        _expectInvalidRoot(_leaf(address(portal), mallory, 300, address(0)), aliceLeaf, 1);
        portal.withdraw(mallory, 300, false, EPOCH, CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));

        _expectInvalidRoot(_leaf(address(portal), bob, 301, address(0)), aliceLeaf, 1);
        portal.withdraw(bob, 301, false, EPOCH, CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));

        // Bob's leaf presented at alice's position hashes the pair in the wrong order.
        _expectInvalidRoot(bobLeaf, aliceLeaf, 0);
        portal.withdraw(bob, 300, false, EPOCH, CHECKPOINTS, 0, _path(aliceLeaf, emptyPair));

        // Index 5 takes index 1's left/right turns under a different leaf id; the Outbox bounds
        // it, and MerkleLib refuses the leftover high bit behind that.
        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__LeafIndexOutOfBounds.selector, 5, 2));
        portal.withdraw(bob, 300, false, EPOCH, CHECKPOINTS, 5, _path(aliceLeaf, emptyPair));

        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__NothingToConsumeAtEpoch.selector, Epoch.wrap(8)));
        portal.withdraw(bob, 300, false, Epoch.wrap(8), CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));

        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__NothingToConsumeAtEpoch.selector, EPOCH));
        portal.withdraw(bob, 300, false, EPOCH, CHECKPOINTS - 1, 1, _path(aliceLeaf, emptyPair));
        _assertBalances(0, 0);
    }

    /// The message names its portal, so a proof for one clone cannot drain another's reserve.
    function test_anotherClonesProofIsUseless() public {
        PlainERC20 rich = new PlainERC20("Rich", "RICH");
        TokenPortalImpl other = TokenPortalImpl(factory.createPortal(address(rich)));
        rich.mint(address(other), RESERVE);

        _expectInvalidRoot(_leaf(address(other), bob, 300, address(0)), aliceLeaf, 1);
        other.withdraw(bob, 300, false, EPOCH, CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));
        assertEq(rich.balanceOf(address(other)), RESERVE, "other reserve");
        assertEq(rich.balanceOf(bob), 0, "bob in the other token");
    }

    function _leaf(address portal_, address recipient, uint256 amount, address callerOnL1)
        private
        view
        returns (bytes32)
    {
        return Hash.sha256ToField(
            DataStructures.L2ToL1Msg({
                sender: DataStructures.L2Actor(HUB, VERSION),
                recipient: DataStructures.L1Actor(portal_, block.chainid),
                content: Hash.sha256ToField(
                    abi.encodeWithSignature("withdraw(address,uint256,address)", recipient, amount, callerOnL1)
                )
            })
        );
    }

    function _parent(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return Hash.sha256ToField(bytes.concat(left, right));
    }

    function _path(bytes32 sibling, bytes32 uncle) private pure returns (bytes32[] memory path) {
        path = new bytes32[](2);
        path[0] = sibling;
        path[1] = uncle;
    }

    /// For a leaf presented at position 0 or 1 of the first proof.
    function _expectInvalidRoot(bytes32 leaf, bytes32 sibling, uint256 index) private {
        bytes32 pair = index == 0 ? _parent(leaf, sibling) : _parent(sibling, leaf);
        vm.expectRevert(
            abi.encodeWithSelector(Errors.MerkleLib__InvalidRoot.selector, root, _parent(pair, emptyPair), leaf, index)
        );
    }

    function _assertBalances(uint256 aliceHolds, uint256 bobHolds) private view {
        assertEq(token.balanceOf(alice), aliceHolds, "alice");
        assertEq(token.balanceOf(bob), bobHolds, "bob");
        assertEq(token.balanceOf(address(portal)), RESERVE - aliceHolds - bobHolds, "reserve");
        assertEq(token.balanceOf(bystander), BYSTANDER_HOLDS, "bystander");
        assertEq(token.allowance(bystander, address(portal)), BYSTANDER_HOLDS, "bystander allowance");
        assertEq(token.totalSupply(), RESERVE + BYSTANDER_HOLDS, "supply");
    }
}
