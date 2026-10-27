// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {DepositRouter} from "../src/DepositRouter.sol";
import {MockFeeJuicePortal} from "./mocks/CounterpartyMocks.sol";

/// Pins the Permit2 witness the client signs. A drift on either side invalidates every signature, so the type
/// string, the typehash and one full vector are fixed here and mirrored by the TypeScript witness.
contract DepositWitnessTest is Test {
    string internal constant TYPE_STRING =
        "DepositWitness witness)DepositWitness(bytes32 aztecRecipient,bytes32 tokenSecretHash,bool isPrivate,uint256 fuelSlice,bytes32 fuelRecipient,bytes32 fuelSecretHash,uint256 minFuelOutput,bytes32 swapDataHash)TokenPermissions(address token,uint256 amount)";
    bytes32 internal constant TYPEHASH = 0x106905f54299d4971393cc302e6e9a86a81a2925c8fb4d2a00597a2551eb5745;
    string internal constant WITNESS_PREFIX = "DepositWitness witness)";
    string internal constant TOKEN_PERMISSIONS = "TokenPermissions(address token,uint256 amount)";
    /// Permit2's `PERMIT_WITNESS_TRANSFER_FROM_TYPEHASH_STUB`, to which it appends the witness type string.
    string internal constant PERMIT2_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    // ── Shared vector (the TypeScript witness test copies these inputs and the expected hash) ──
    bytes32 internal constant VECTOR_AZTEC_RECIPIENT =
        0x0000000000000000000000000000000000000000000000000000000000001234;
    bytes32 internal constant VECTOR_TOKEN_SECRET_HASH =
        0x0000000000000000000000000000000000000000000000000000000000005ec7;
    bool internal constant VECTOR_IS_PRIVATE = false;
    uint256 internal constant VECTOR_FUEL_SLICE = 100_000;
    bytes32 internal constant VECTOR_FUEL_RECIPIENT =
        0x0000000000000000000000000000000000000000000000000000000000005678;
    bytes32 internal constant VECTOR_FUEL_SECRET_HASH =
        0x0000000000000000000000000000000000000000000000000000000000000fee;
    uint256 internal constant VECTOR_MIN_FUEL_OUTPUT = 1_000_000_000_000_000_000;
    bytes internal constant VECTOR_SWAP_DATA =
        hex"4666fc80000000000000000000000000000000000000000000000000000000000000007d";
    bytes32 internal constant VECTOR_WITNESS = 0xcda2e450d719bcba586bd091421030f02d669556fb96588ed276ce120b2c5d12;

    DepositRouter internal router;

    function setUp() public {
        MockFeeJuicePortal feePortal = new MockFeeJuicePortal(IERC20(address(0xFEE0)));
        router =
            new DepositRouter(address(0x9E2), address(feePortal), address(0xFAC), address(feePortal), address(this));
    }

    function _vectorIntent() internal pure returns (DepositRouter.DepositIntent memory i) {
        i.token = address(0x05DC);
        i.aztecRecipient = VECTOR_AZTEC_RECIPIENT;
        i.tokenSecretHash = VECTOR_TOKEN_SECRET_HASH;
        i.isPrivate = VECTOR_IS_PRIVATE;
        i.fuelSlice = VECTOR_FUEL_SLICE;
        i.fuelRecipient = VECTOR_FUEL_RECIPIENT;
        i.fuelSecretHash = VECTOR_FUEL_SECRET_HASH;
        i.minFuelOutput = VECTOR_MIN_FUEL_OUTPUT;
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 k; k < out.length; ++k) {
            out[k] = b[from + k];
        }
    }

    /// The struct part of the type string: between the `witness)` prefix and the first `TokenPermissions(`.
    function _structPart() internal pure returns (bytes memory) {
        bytes memory full = bytes(TYPE_STRING);
        bytes memory tp = bytes(TOKEN_PERMISSIONS);
        uint256 at = full.length - tp.length;
        return _slice(full, bytes(WITNESS_PREFIX).length, at);
    }

    function test_typeString_pinnedByteForByte() public view {
        assertEq(router.DEPOSIT_WITNESS_TYPE_STRING(), TYPE_STRING);
    }

    /// Permit2 grammar: `<Name> witness)` + the witness struct + referenced structs in alphabetical order, and only
    /// `TokenPermissions` follows the struct. The typehash is the struct part alone.
    function test_typehash_isTheStructPartOfTheTypeString() public view {
        bytes memory full = bytes(TYPE_STRING);
        bytes memory structPart = _structPart();
        assertEq(string(_slice(full, 0, bytes(WITNESS_PREFIX).length)), WITNESS_PREFIX, "witness prefix");
        assertEq(
            string(_slice(full, full.length - bytes(TOKEN_PERMISSIONS).length, full.length)),
            TOKEN_PERMISSIONS,
            "TokenPermissions closes the string"
        );
        assertEq(string(_slice(structPart, 0, 15)), "DepositWitness(", "struct part starts with its name");
        assertEq(structPart[structPart.length - 1], bytes1(")"), "struct part closes right before TokenPermissions(");
        assertEq(router.DEPOSIT_WITNESS_TYPEHASH(), keccak256(structPart), "typehash");
        assertEq(router.DEPOSIT_WITNESS_TYPEHASH(), TYPEHASH, "typehash literal");

        // An independent EIP-712 encoder agrees: on the struct alone, and on Permit2's full composed type.
        assertEq(vm.eip712HashType(string(structPart)), keccak256(structPart), "canonical struct type");
        bytes memory composed = abi.encodePacked(PERMIT2_STUB, TYPE_STRING);
        assertEq(vm.eip712HashType(string(composed)), keccak256(composed), "canonical Permit2 type");
    }

    function test_sharedVector() public view {
        DepositRouter.DepositIntent memory i = _vectorIntent();
        bytes32 witness = router.hashWitness(i, VECTOR_SWAP_DATA);
        assertEq(witness, VECTOR_WITNESS, "shared vector drift");

        bytes32 independent = vm.eip712HashStruct(
            string(_structPart()),
            abi.encode(
                VECTOR_AZTEC_RECIPIENT,
                VECTOR_TOKEN_SECRET_HASH,
                VECTOR_IS_PRIVATE,
                VECTOR_FUEL_SLICE,
                VECTOR_FUEL_RECIPIENT,
                VECTOR_FUEL_SECRET_HASH,
                VECTOR_MIN_FUEL_OUTPUT,
                keccak256(VECTOR_SWAP_DATA)
            )
        );
        assertEq(witness, independent, "an independent EIP-712 encoder agrees");
    }

    function test_swapDataHashBindsEveryByte() public view {
        DepositRouter.DepositIntent memory i = _vectorIntent();
        bytes memory mutated = VECTOR_SWAP_DATA;
        mutated[mutated.length - 1] = 0x7e;
        assertTrue(router.hashWitness(i, mutated) != router.hashWitness(i, VECTOR_SWAP_DATA));
    }

    /// A plain send signs `fuelSlice = 0` and the hash of empty bytes.
    function test_plainSend_hashesEmptySwapData() public view {
        DepositRouter.DepositIntent memory i;
        i.aztecRecipient = VECTOR_AZTEC_RECIPIENT;
        i.tokenSecretHash = VECTOR_TOKEN_SECRET_HASH;
        bytes32 emptyHash = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470;
        assertEq(keccak256(""), emptyHash);
        assertEq(
            router.hashWitness(i, ""),
            keccak256(
                abi.encode(
                    router.DEPOSIT_WITNESS_TYPEHASH(),
                    VECTOR_AZTEC_RECIPIENT,
                    VECTOR_TOKEN_SECRET_HASH,
                    false,
                    uint256(0),
                    bytes32(0),
                    bytes32(0),
                    uint256(0),
                    emptyHash
                )
            )
        );
    }

    /// Every signed field binds; `token` is deliberately absent, because Permit2 binds it as `permitted.token`.
    function testFuzz_everyFieldBinds_tokenLeftToPermit2(uint256 delta, uint8 whichRaw) public view {
        uint8 which = whichRaw % 8;
        vm.assume(delta != 0);
        DepositRouter.DepositIntent memory i = _vectorIntent();
        bytes32 base = router.hashWitness(i, VECTOR_SWAP_DATA);

        if (which == 0) i.aztecRecipient ^= bytes32(delta);
        else if (which == 1) i.tokenSecretHash ^= bytes32(delta);
        else if (which == 2) i.isPrivate = !i.isPrivate;
        else if (which == 3) i.fuelSlice ^= delta;
        else if (which == 4) i.fuelRecipient ^= bytes32(delta);
        else if (which == 5) i.fuelSecretHash ^= bytes32(delta);
        else if (which == 6) i.minFuelOutput ^= delta;
        else i.token = address(uint160(i.token) ^ uint160(delta));

        bytes32 mutated = router.hashWitness(i, VECTOR_SWAP_DATA);
        if (which == 7) assertEq(mutated, base, "token must not be part of the witness");
        else assertTrue(mutated != base, "a signed field does not bind");
    }
}
