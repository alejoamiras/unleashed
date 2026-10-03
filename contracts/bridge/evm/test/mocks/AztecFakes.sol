// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

/// The Aztec-side fakes every portal/factory/router suite drives: an Inbox and an Outbox that
/// capture exactly what was put on the wire, behind a registry → rollup pair with a pinned
/// version. Shared so one shape of "what the L2 sees" serves every suite.

contract CapturingInbox {
    bytes32 public lastContentHash;
    bytes32 public lastSecretHash;
    bytes32 public lastBridge;
    uint256 public lastVersion;
    address public lastSender;
    uint256 public sent;
    uint256 private nextIndex;

    function sendL2Message(DataStructures.L2Actor calldata actor, bytes32 contentHash, bytes32 secretHash)
        external
        returns (bytes32 key, uint256 index)
    {
        lastContentHash = contentHash;
        lastSecretHash = secretHash;
        lastBridge = actor.actor;
        lastVersion = actor.version;
        lastSender = msg.sender;
        sent++;
        key = keccak256(abi.encode(contentHash, secretHash));
        index = nextIndex++;
    }
}

contract CapturingOutbox {
    DataStructures.L2ToL1Msg private stored;

    // Explicit accessor: a public struct var's auto-getter flattens members instead of
    // returning the struct.
    function lastMsg() external view returns (DataStructures.L2ToL1Msg memory) {
        return stored;
    }

    function consume(DataStructures.L2ToL1Msg calldata message, Epoch, uint256, uint256, bytes32[] calldata) external {
        stored = message;
    }
}

contract FakeRollup {
    address public immutable inbox;
    address public immutable outbox;

    constructor(address inbox_, address outbox_) {
        inbox = inbox_;
        outbox = outbox_;
    }

    function getInbox() external view returns (address) {
        return inbox;
    }

    function getOutbox() external view returns (address) {
        return outbox;
    }

    function getVersion() external pure returns (uint256) {
        return 4242;
    }
}

contract FakeRegistry {
    address public rollup;

    constructor(address rollup_) {
        rollup = rollup_;
    }

    function getCanonicalRollup() external view returns (address) {
        return rollup;
    }
}
