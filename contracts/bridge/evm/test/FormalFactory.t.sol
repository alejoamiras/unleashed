// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Ownable} from "@oz/access/Ownable.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";

/// SYMBOLIC checks for the factory (run with `halmos`, not forge): function arguments are symbolic,
/// so each check proves its property over the WHOLE input domain.
///
///   check_predictPortal_isCreate2OfInitcode — ∀ token, the prediction is the CREATE2 of the hand-built initcode
///   check_setPaused_revertsForNonOwner     — no caller but the guardian can flip a pause bit
///
/// `createPortal` itself is out of halmos's reach: it hashes the 164-byte register preimage with
/// sha256, and halmos 0.3.3's precompile stub declares that function with a mismatched Z3 sort
/// (setUp fails before any path runs). Front-run identity and idempotence are therefore forge
/// properties (PortalFactory.t.sol, PortalFactoryFuzz.t.sol, PortalFactoryInvariant.t.sol).
///
/// Signal failure with assertions only — halmos cannot observe `revert(string)`. The forge-level
/// canaries below are witnesses that each proof's complementary branch is reachable through the
/// same harness (a proof that pruned to vacuity would have no reachable branch to witness).
contract FormalFactoryTest is Test {
    address internal constant GUARDIAN = address(0x6A);
    PortalFactory internal factory;
    CapturingInbox internal inbox;
    PlainERC20 internal token;

    function setUp() public {
        inbox = new CapturingInbox();
        FakeRegistry registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(new CapturingOutbox()))));
        factory = new PortalFactory(IRegistry(address(registry)), bytes32(uint256(0x4B)), GUARDIAN);
        token = new PlainERC20("Tok", "TOK");
    }

    /// ∀ token: the prediction is CREATE2(factory, bytes32(uint160(token)), keccak(initcode)) with the
    /// OZ immutable-args initcode built by hand — the wiring the router, the app and the keystone rely
    /// on, proven for the whole address space rather than one vector.
    function check_predictPortal_isCreate2OfInitcode(address t) public view {
        bytes memory initcode = abi.encodePacked(
            hex"61",
            uint16(20 + 0x2d),
            hex"3d81600a3d39f3363d3d373d3d3d363d73",
            factory.IMPLEMENTATION(),
            hex"5af43d82803e903d91602b57fd5bf3",
            t
        );
        address expected = address(
            uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(factory), bytes32(uint256(uint160(t))), keccak256(initcode)))))
        );
        assertEq(factory.predictPortal(t), expected, "prediction is not the CREATE2 of the immutable-args initcode");
    }

    /// ∀ caller ≠ guardian, ∀ bits: setPaused reverts with the Ownable error and leaves both bits false.
    function check_setPaused_revertsForNonOwner(address caller, bool d, bool w) public {
        vm.assume(caller != GUARDIAN);
        vm.prank(caller);
        try factory.setPaused(d, w) {
            assertTrue(false, "non-owner flipped a pause bit");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), Ownable.OwnableUnauthorizedAccount.selector, "rejected for the wrong reason");
            assertFalse(factory.depositsPaused(), "deposits bit changed");
            assertFalse(factory.withdrawsPaused(), "withdraws bit changed");
        }
    }

    // ── Canaries (forge) — the complementary case must be observable ────────────────────

    /// The guardian CAN pause: proves the harness is not blind to a successful setPaused.
    function test_canary_guardianCanPause() public {
        vm.prank(GUARDIAN);
        factory.setPaused(true, false);
        assertTrue(factory.depositsPaused());
    }

    /// A different token DOES change the portal: proves `assertEq(portal, predicted)` is not trivially true.
    function test_canary_predictionDependsOnToken() public {
        PlainERC20 other = new PlainERC20("Other", "OTH");
        assertNotEq(factory.predictPortal(address(token)), factory.predictPortal(address(other)));
        assertEq(factory.createPortal(address(other)), factory.predictPortal(address(other)));
    }

    /// The hand-built initcode IS what the factory deploys: proves the CREATE2 proof targets real bytes.
    function test_canary_handBuiltInitcodeMatchesDeployedClone() public {
        address portal = factory.createPortal(address(token));
        bytes memory runtime = abi.encodePacked(
            hex"363d3d373d3d3d363d73", factory.IMPLEMENTATION(), hex"5af43d82803e903d91602b57fd5bf3", address(token)
        );
        assertEq(portal.code, runtime, "clone runtime differs from the initcode's payload");
    }
}
