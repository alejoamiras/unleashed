// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@oz/proxy/Clones.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

/// KEYSTONE (Solidity leg) for the any-ERC-20 generation. Three values the L1 factory commits must
/// equal what bridge-core (TS) and the Noir hub/keystone crate compute independently:
///   - the portal address: an OZ immutable-args clone at CREATE2(salt = bytes32(uint160(token)));
///   - the `register` content hash the factory sends through the Inbox;
///   - the public registration secret hash (Poseidon2, computed by Noir/TS, pinned here as a literal).
/// The other legs: packages/bridge-core/src/{portal-address,register-hash}.test.ts and
/// contracts/bridge/aztec/keystone/src/main.nr. A drift in any leg strands deposits of that token.
contract KeystoneTest is Test {
    address constant FACTORY = 0x3333333333333333333333333333333333333333;
    address constant IMPL = 0x1111111111111111111111111111111111111111;
    address constant ERC20 = 0x2222222222222222222222222222222222222222;

    address constant TOKEN = address(uint160(0xe2c20));
    address constant PORTAL = address(uint160(0x9017a1));
    bytes32 constant NAME_WORD = 0x005465737420546f6b656e000000000000000000000000000000000000000000;
    bytes32 constant SYMBOL_WORD = 0x0054535400000000000000000000000000000000000000000000000000000000;

    /// `compute_secret_hash([0])` — Poseidon2 has no Solidity implementation here; the factory embeds
    /// this literal and the Noir + TS legs recompute it.
    bytes32 constant REGISTER_SECRET_HASH = 0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250;

    function salt(address token) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }

    function test_predictPortal_matchesBridgeCore() public pure {
        address predicted =
            Clones.predictDeterministicAddressWithImmutableArgs(IMPL, abi.encodePacked(ERC20), salt(ERC20), FACTORY);
        assertEq(predicted, 0x9E4fc5082E41ec39a0d4a8b624A3baf3289c5Eee);
    }

    function test_registerHash_matchesNoirAndBridgeCore() public pure {
        bytes32 h = Hash.sha256ToField(
            abi.encodeWithSignature(
                "register(address,address,bytes32,bytes32,uint8)", TOKEN, PORTAL, NAME_WORD, SYMBOL_WORD, uint8(18)
            )
        );
        assertEq(h, 0x008c135ab10d3a0b9e221b83dd074a9051612d8bc8a8f6b2330960ba6e8dbda3);
    }

    function test_registerSelector() public pure {
        assertEq(bytes4(keccak256("register(address,address,bytes32,bytes32,uint8)")), bytes4(0xfbc7d0f1));
    }

    function test_registerSecretHash_isPinned() public pure {
        assertEq(REGISTER_SECRET_HASH, 0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250);
    }
}
