// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {Clones} from "@oz/proxy/Clones.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {PlainERC20, SkewedERC20} from "./mocks/MetadataERC20s.sol";
import {PortalImplWithoutPause} from "./mocks/CounterpartyMocks.sol";

/// SYMBOLIC checks for a portal clone (halmos). The clone is created concretely in setUp through
/// `Clones` directly, NOT through `createPortal`: the factory hashes the register preimage with
/// sha256, which halmos 0.3.3 cannot model (Z3 sort mismatch in its precompile stub, concrete input
/// included). Every refusal below runs before any hashing (both deposits pull before they hash), so
/// the proofs never reach a sha256 either. The forge canaries run the same actions against a clone
/// whose pause checks are deleted (must succeed) and against the real clone unpaused or with an exact
/// token up to the bound (must succeed), so no proof can pass vacuously.
///
///   check_deposit_revertsWhenPaused        — ∀ (to, amount, secretHash): a paused factory blocks both deposits
///   check_withdraw_revertsWhenPaused       — ∀ (recipient, amount): a paused factory blocks withdrawal
///   check_deposit_refusesInexactPull       — ∀ amount ≤ 1e30, additive skews ≠ (0, 0) (sender extra ≤ 1e30, clone
///                                            short ≤ amount): a sender debit above `amount` or a clone credit
///                                            below it blocks both deposits
///   check_deposit_refusesReservePastL2Max  — ∀ reserve, amount ≤ uint128.max with reserve + amount > uint128.max:
///                                            both deposits are refused
contract FormalCloneTest is Test {
    address internal constant GUARDIAN = address(0x6A);
    PortalFactory internal factory;
    TokenPortalImpl internal portal;
    PlainERC20 internal token;
    CapturingInbox internal inbox;
    SkewedERC20 internal skewed;
    TokenPortalImpl internal skewedPortal;

    function setUp() public {
        inbox = new CapturingInbox();
        FakeRegistry registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(new CapturingOutbox()))));
        factory = new PortalFactory(IRegistry(address(registry)), bytes32(uint256(0x4B)), GUARDIAN);
        token = new PlainERC20("Tok", "TOK");
        portal = TokenPortalImpl(
            Clones.cloneDeterministicWithImmutableArgs(factory.IMPLEMENTATION(), abi.encodePacked(address(token)), factory.salt(address(token)))
        );
        token.mint(address(this), 1e30);
        token.approve(address(portal), type(uint256).max);
        token.mint(address(portal), 1e30); // a reserve to withdraw from

        skewed = new SkewedERC20();
        skewedPortal = TokenPortalImpl(
            Clones.cloneDeterministicWithImmutableArgs(factory.IMPLEMENTATION(), abi.encodePacked(address(skewed)), factory.salt(address(skewed)))
        );
        skewed.approve(address(skewedPortal), type(uint256).max);
    }

    function check_deposit_revertsWhenPaused(bytes32 to, uint256 amount, bytes32 secretHash) public {
        vm.prank(GUARDIAN);
        factory.setPaused(true, false);
        uint256 sent = inbox.sent();
        try portal.depositToAztecPublic(to, amount, secretHash) {
            assertTrue(false, "public deposit succeeded while paused");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortalImpl.DepositsPaused.selector, "public: rejected for the wrong reason");
        }
        try portal.depositToAztecPrivate(amount, secretHash) {
            assertTrue(false, "private deposit succeeded while paused");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortalImpl.DepositsPaused.selector, "private: rejected for the wrong reason");
        }
        assertEq(inbox.sent(), sent, "a message was sent while paused");
    }

    function check_withdraw_revertsWhenPaused(address recipient, uint256 amount) public {
        vm.prank(GUARDIAN);
        factory.setPaused(false, true);
        uint256 reserve = token.balanceOf(address(portal));
        bytes32[] memory path;
        try portal.withdraw(recipient, amount, false, Epoch.wrap(0), 0, 0, path) {
            assertTrue(false, "withdraw succeeded while paused");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortalImpl.WithdrawsPaused.selector, "rejected for the wrong reason");
            assertEq(token.balanceOf(address(portal)), reserve, "reserve moved while paused");
        }
    }

    function check_deposit_refusesInexactPull(
        uint256 senderExtra,
        uint256 recipientShort,
        bytes32 to,
        uint256 amount,
        bytes32 secretHash
    ) public {
        vm.assume(amount <= 1e30 && senderExtra <= 1e30 && recipientShort <= amount);
        vm.assume(senderExtra != 0 || recipientShort != 0);
        skewed.setSkew(senderExtra, recipientShort);
        skewed.mint(address(this), amount + senderExtra);
        uint256 sent = inbox.sent();
        try skewedPortal.depositToAztecPublic(to, amount, secretHash) {
            assertTrue(false, "public deposit succeeded with an inexact pull");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortalImpl.InexactTransfer.selector, "public: rejected for the wrong reason");
        }
        try skewedPortal.depositToAztecPrivate(amount, secretHash) {
            assertTrue(false, "private deposit succeeded with an inexact pull");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortalImpl.InexactTransfer.selector, "private: rejected for the wrong reason");
        }
        assertEq(inbox.sent(), sent, "a message was sent for an inexact pull");
    }

    /// The default 1 ms branching timeout lets halmos follow the infeasible accepting branch into sha256.
    /// @custom:halmos --solver-timeout-branching 0
    function check_deposit_refusesReservePastL2Max(uint256 reserve, uint256 amount, bytes32 to, bytes32 secretHash)
        public
    {
        vm.assume(amount <= type(uint128).max && reserve <= type(uint128).max);
        vm.assume(reserve + amount > type(uint128).max);
        skewed.mint(address(skewedPortal), reserve);
        skewed.mint(address(this), amount);
        uint256 sent = inbox.sent();
        try skewedPortal.depositToAztecPublic(to, amount, secretHash) {
            assertTrue(false, "public deposit succeeded past the L2 max");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortalImpl.AmountExceedsL2Max.selector, "public: rejected for the wrong reason");
        }
        try skewedPortal.depositToAztecPrivate(amount, secretHash) {
            assertTrue(false, "private deposit succeeded past the L2 max");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortalImpl.AmountExceedsL2Max.selector, "private: rejected for the wrong reason");
        }
        assertEq(inbox.sent(), sent, "a message was sent past the L2 max");
    }

    // ── Canaries (forge) ─────────────────────────────────────────────────────────────────

    /// Mutation: a clone of an implementation with the pause checks deleted deposits and withdraws
    /// while the factory says paused — the proofs' failure branches are reachable.
    function test_canary_pauseProofs_failWithoutTheGuards() public {
        PortalImplWithoutPause impl = new PortalImplWithoutPause(
            IRegistry(address(new FakeRegistry(address(new FakeRollup(address(inbox), address(new CapturingOutbox())))))),
            bytes32(uint256(0x4B))
        );
        TokenPortalImpl mutant = TokenPortalImpl(
            Clones.cloneDeterministicWithImmutableArgs(address(impl), abi.encodePacked(address(token)), bytes32(uint256(1)))
        );
        token.approve(address(mutant), type(uint256).max);
        token.mint(address(mutant), 100);
        vm.prank(GUARDIAN);
        factory.setPaused(true, true);

        uint256 sent = inbox.sent();
        mutant.depositToAztecPublic(bytes32(uint256(1)), 5, bytes32(0));
        assertEq(inbox.sent(), sent + 1, "the mutant deposits while paused");
        bytes32[] memory path;
        mutant.withdraw(address(0xB0B), 7, false, Epoch.wrap(0), 0, 0, path);
        assertEq(token.balanceOf(address(0xB0B)), 7, "the mutant withdraws while paused");
    }

    /// Unpaused, the same deposit succeeds and sends a message — the paused proofs are not vacuous.
    function test_canary_unpausedDepositSucceeds() public {
        uint256 sent = inbox.sent();
        portal.depositToAztecPublic(bytes32(uint256(1)), 5, bytes32(0));
        assertEq(inbox.sent(), sent + 1);
    }

    /// An exact token fills the reserve to the L2 max through both deposits: the inexact-pull and the
    /// reserve proofs are not vacuous.
    function test_canary_exactPullUpToL2MaxSucceeds() public {
        uint256 amount = 1_000;
        skewed.mint(address(skewedPortal), type(uint128).max - 2 * amount);
        skewed.mint(address(this), 2 * amount);
        uint256 sent = inbox.sent();
        skewedPortal.depositToAztecPublic(bytes32(uint256(1)), amount, bytes32(0));
        skewedPortal.depositToAztecPrivate(amount, bytes32(0));
        assertEq(inbox.sent(), sent + 2);
        assertEq(skewed.balanceOf(address(skewedPortal)), type(uint128).max);
    }

    /// Unpaused, the same withdrawal moves the reserve.
    function test_canary_unpausedWithdrawSucceeds() public {
        bytes32[] memory path;
        uint256 reserve = token.balanceOf(address(portal));
        portal.withdraw(address(0xB0B), 7, false, Epoch.wrap(0), 0, 0, path);
        assertEq(token.balanceOf(address(portal)), reserve - 7);
    }
}
