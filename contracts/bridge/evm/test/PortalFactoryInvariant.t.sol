// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";

/// Cross-call INVARIANT suite for the factory + clones. A handler drives randomized
/// create/deposit/withdraw/pause sequences from several actors; after every sequence:
///
///   I1  A token's portal address never changes and always equals the prediction.
///   I2  Every clone's reserve equals its cumulative deposits minus its cumulative withdrawals —
///       measured on the real token balance, never ghost against ghost.
///   I3  Only the guardian ever flips a pause bit; the bits equal the guardian's last write.
///   I3b A paused bit is honored by every clone (flags, not reverts: the campaign's
///       fail_on_revert=false would swallow a revert-signalled violation).
///   I4  The factory never sends a second `register` for a token (one Inbox message per portal).
contract PortalFactoryInvariantTest is Test {
    FactoryHandler internal handler;

    function setUp() public {
        handler = new FactoryHandler();
        targetContract(address(handler));
    }

    function invariant_portalAddressIsStable() public view {
        for (uint256 i = 0; i < handler.tokenCount(); i++) {
            address t = handler.tokens(i);
            address seen = handler.firstPortal(t);
            if (seen != address(0)) {
                assertEq(handler.factory().portalOf(t), seen, "portal changed");
                assertEq(handler.factory().predictPortal(t), seen, "prediction drifted");
            }
        }
    }

    function invariant_reserveEqualsNetDeposits() public view {
        for (uint256 i = 0; i < handler.tokenCount(); i++) {
            address t = handler.tokens(i);
            address p = handler.factory().portalOf(t);
            if (p == address(0)) continue;
            assertEq(
                PlainERC20(t).balanceOf(p), handler.ghostDeposited(t) - handler.ghostWithdrawn(t), "reserve != net deposits"
            );
        }
    }

    function invariant_pauseHolds() public view {
        assertFalse(handler.pausedDepositAccepted(), "a deposit landed while paused");
        assertFalse(handler.pausedWithdrawAccepted(), "a withdrawal landed while paused");
    }

    function invariant_onlyGuardianFlipsPause() public view {
        assertEq(handler.factory().depositsPaused(), handler.ghostDepositsPaused(), "deposits bit drifted");
        assertEq(handler.factory().withdrawsPaused(), handler.ghostWithdrawsPaused(), "withdraws bit drifted");
        assertFalse(handler.strangerPaused(), "a non-guardian flipped a bit");
    }

    function invariant_oneRegisterPerPortal() public view {
        assertEq(handler.inbox().sent(), handler.ghostRegisters() + handler.ghostDepositMessages(), "extra Inbox messages");
    }
}

contract FactoryHandler is StdUtils {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    PortalFactory public factory;
    CapturingInbox public inbox;
    CapturingOutbox public outbox;
    address public guardian = address(0x6A);
    address[3] private actors = [address(0xA1), address(0xA2), address(0xA3)];

    address[] public tokens;
    mapping(address => address) public firstPortal;
    mapping(address => uint256) public ghostDeposited;
    mapping(address => uint256) public ghostWithdrawn;
    bool public ghostDepositsPaused;
    bool public ghostWithdrawsPaused;
    bool public strangerPaused;
    bool public pausedDepositAccepted;
    bool public pausedWithdrawAccepted;
    uint256 public ghostRegisters;
    uint256 public ghostDepositMessages;

    constructor() {
        inbox = new CapturingInbox();
        outbox = new CapturingOutbox();
        FakeRegistry registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(outbox))));
        factory = new PortalFactory(IRegistry(address(registry)), bytes32(uint256(0x4B)), guardian);
        for (uint256 i = 0; i < 4; i++) {
            tokens.push(address(new PlainERC20("T", "T")));
        }
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function createPortal(uint256 tokenSeed, uint256 actorSeed) external {
        address t = tokens[tokenSeed % tokens.length];
        bool existed = factory.portalOf(t) != address(0);
        vm.prank(actors[actorSeed % 3]);
        address p = factory.createPortal(t);
        if (!existed) {
            firstPortal[t] = p;
            ghostRegisters++;
        }
    }

    function deposit(uint256 tokenSeed, uint256 actorSeed, uint256 amount, bool isPrivate) external {
        address t = tokens[tokenSeed % tokens.length];
        address p = factory.portalOf(t);
        if (p == address(0)) return;
        amount = bound(amount, 1, 1e24);
        address actor = actors[actorSeed % 3];
        PlainERC20(t).mint(actor, amount);
        vm.startPrank(actor);
        PlainERC20(t).approve(p, amount);
        if (ghostDepositsPaused) {
            try TokenPortalImpl(p).depositToAztecPublic(bytes32(uint256(1)), amount, bytes32(0)) {
                pausedDepositAccepted = true;
            } catch {}
            vm.stopPrank();
            return;
        }
        if (isPrivate) {
            TokenPortalImpl(p).depositToAztecPrivate(amount, bytes32(0));
        } else {
            TokenPortalImpl(p).depositToAztecPublic(bytes32(uint256(1)), amount, bytes32(0));
        }
        vm.stopPrank();
        ghostDeposited[t] += amount;
        ghostDepositMessages++;
    }

    function withdraw(uint256 tokenSeed, uint256 actorSeed, uint256 amount) external {
        address t = tokens[tokenSeed % tokens.length];
        address p = factory.portalOf(t);
        if (p == address(0)) return;
        uint256 reserve = PlainERC20(t).balanceOf(p);
        if (reserve == 0) return;
        amount = bound(amount, 1, reserve);
        bytes32[] memory path;
        address actor = actors[actorSeed % 3];
        // The fake outbox authorises anything; what is under test is the clone's accounting + pause.
        if (ghostWithdrawsPaused) {
            try TokenPortalImpl(p).withdraw(actor, amount, false, Epoch.wrap(0), 0, 0, path) {
                pausedWithdrawAccepted = true;
            } catch {}
            return;
        }
        TokenPortalImpl(p).withdraw(actor, amount, false, Epoch.wrap(0), 0, 0, path);
        ghostWithdrawn[t] += amount;
    }

    function guardianPause(bool d, bool w) external {
        vm.prank(guardian);
        factory.setPaused(d, w);
        ghostDepositsPaused = d;
        ghostWithdrawsPaused = w;
    }

    function strangerPause(uint256 actorSeed, bool d, bool w) external {
        vm.prank(actors[actorSeed % 3]);
        try factory.setPaused(d, w) {
            strangerPaused = true;
        } catch {}
    }
}
