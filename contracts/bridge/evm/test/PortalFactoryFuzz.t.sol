// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {WeirdDecimalsERC20} from "./mocks/MetadataERC20s.sol";

/// Exposes the word sanitizer so its totality can be fuzzed directly.
contract SanitizeHarness is PortalFactory {
    constructor(IRegistry r, bytes32 hub, address g) PortalFactory(r, hub, g) {}

    function sanitize(bytes32 raw, uint256 n) external pure returns (bytes32) {
        return _sanitize(raw, n);
    }
}

/// A token whose name and symbol are whatever the fuzzer picks.
contract FuzzNameERC20 {
    string private _n;
    string private _s;

    constructor(string memory n, string memory s) {
        _n = n;
        _s = s;
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function name() external view returns (string memory) {
        return _n;
    }

    function symbol() external view returns (string memory) {
        return _s;
    }
}

contract PortalFactoryFuzzTest is Test {
    bytes32 internal constant HUB = bytes32(uint256(0x4B));
    SanitizeHarness internal factory;
    CapturingInbox internal inbox;

    function setUp() public {
        inbox = new CapturingInbox();
        FakeRegistry registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(new CapturingOutbox()))));
        factory = new SanitizeHarness(IRegistry(address(registry)), HUB, makeAddr("guardian"));
    }

    /// Every word the factory commits has a zero top byte and only printable-ASCII or zero bytes —
    /// so it round-trips through `FieldCompressedString` on L2 and through UTF-16 in the app.
    function testFuzz_sanitizeIsTotal(bytes32 raw, uint256 n) public view {
        n = bound(n, 0, 32);
        bytes32 w = factory.sanitize(raw, n);
        assertEq(uint8(w[0]), 0, "top byte must be zero");
        for (uint256 i = 1; i < 32; i++) {
            uint8 b = uint8(w[i]);
            assertTrue(b == 0 || (b >= 0x20 && b <= 0x7e), "non-printable byte survived");
        }
        // Positions past the string are zero, never `_`.
        uint256 len = n > 31 ? 31 : n;
        for (uint256 i = len + 1; i < 32; i++) {
            assertEq(uint8(w[i]), 0, "padding must be zero");
        }
    }

    /// For any name/symbol/decimals the clone lands where `predictPortal` said, the registration
    /// words are the sanitized inputs, the maps are inverses, and the Inbox saw the same tuple.
    function testFuzz_createPortal_registrationAgreesEverywhere(string memory n, string memory s, uint8 d) public {
        vm.assume(bytes(n).length < 200 && bytes(s).length < 200);
        WeirdDecimalsERC20 t = new WeirdDecimalsERC20(d);
        // A second, name-driven token exercises the string path with arbitrary bytes.
        FuzzNameERC20 f = new FuzzNameERC20(n, s);

        address pt = factory.createPortal(address(t));
        assertEq(pt, factory.predictPortal(address(t)));
        assertEq(factory.tokenOf(pt), address(t));
        assertEq(factory.registrationOf(address(t)).decimals, d);
        assertEq(address(TokenPortalImpl(pt).underlying()), address(t));

        address pf = factory.createPortal(address(f));
        assertEq(pf, factory.predictPortal(address(f)));
        bytes32 nw = factory.registrationOf(address(f)).nameWord;
        bytes32 sw = factory.registrationOf(address(f)).symbolWord;
        assertEq(nw, factory.sanitize(_first32(bytes(n)), bytes(n).length));
        assertEq(sw, factory.sanitize(_first32(bytes(s)), bytes(s).length));
        assertEq(
            inbox.lastContentHash(),
            Hash.sha256ToField(
                abi.encodeWithSignature("register(address,address,bytes32,bytes32,uint8)", address(f), pf, nw, sw, uint8(6))
            )
        );
        assertEq(inbox.lastSender(), address(factory));
    }

    function _first32(bytes memory b) private pure returns (bytes32 out) {
        for (uint256 i = 0; i < 32 && i < b.length; i++) {
            out |= bytes32(bytes1(b[i])) >> (8 * i);
        }
    }
}
