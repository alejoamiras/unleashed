// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {Clones} from "@oz/proxy/Clones.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";
import {PortalImplWithoutPause} from "./mocks/RouterMocks.sol";

/// SYMBOLIC checks for a portal clone (halmos). The clone is created concretely in setUp through
/// `Clones` directly, NOT through `createPortal`: the factory hashes the register preimage with
/// sha256, which halmos 0.3.3 cannot model (Z3 sort mismatch in its precompile stub). The pause
/// checks run before any hashing, so the proofs below never reach a sha256 either. The forge
/// canaries run the same actions against a clone whose pause checks are deleted (must succeed)
/// and against the real clone unpaused (must succeed), so neither proof can pass vacuously.
///
///   check_deposit_revertsWhenPaused  — ∀ (to, amount, secretHash): a paused factory blocks both deposits
///   check_withdraw_revertsWhenPaused — ∀ (recipient, amount): a paused factory blocks withdrawal
contract FormalCloneTest is Test {
    address internal constant GUARDIAN = address(0x6A);
    PortalFactory internal factory;
    TokenPortalImpl internal portal;
    PlainERC20 internal token;
    CapturingInbox internal inbox;

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

    /// Unpaused, the same withdrawal moves the reserve.
    function test_canary_unpausedWithdrawSucceeds() public {
        bytes32[] memory path;
        uint256 reserve = token.balanceOf(address(portal));
        portal.withdraw(address(0xB0B), 7, false, Epoch.wrap(0), 0, 0, path);
        assertEq(token.balanceOf(address(portal)), reserve - 7);
    }
}
