// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";

struct SwapData {
    address callTo;
    address approveTo;
    address sendingAssetId;
    address receivingAssetId;
    uint256 fromAmount;
    bytes callData;
    bool requiresDeposit;
}

struct RelayData {
    bytes32 depositor;
    bytes32 recipient;
    bytes32 exclusiveRelayer;
    bytes32 inputToken;
    bytes32 outputToken;
    uint256 inputAmount;
    uint256 outputAmount;
    uint256 originChainId;
    uint256 depositId;
    uint32 fillDeadline;
    uint32 exclusivityDeadline;
    bytes message;
}

interface ISpoke {
    function fillRelay(RelayData calldata, uint256 repaymentChainId, bytes32 repaymentAddress) external;
}

interface IPatcher {
    function depositAndExecuteWithDynamicPatches(
        address tokenAddress,
        address valueSource,
        bytes calldata valueGetter,
        address finalTarget,
        uint256 value,
        bytes calldata data,
        uint256[] calldata offsets,
        bool delegateCall
    ) external payable returns (bool, bytes memory);
}

contract LifiDest is Test {
    IRegistry constant REGISTRY = IRegistry(0x35b22e09Ee0390539439E24f06Da43D83f90e298);
    IERC20 constant USDC = IERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    address constant SPOKE = 0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    address constant EXECUTOR = 0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88;
    address constant RECV_V3 = 0x81F35E762B6792Eea8781fC52F72e62235A5C416;
    address constant RECV_V4 = 0x07Cc0a0b41641D349240e1988169Fa11b31FC24E;
    address constant PATCHER = 0x98dE828723F8aC654B79b8A1BB8E1E5D737F4F42;
    bytes32 constant HUB = bytes32(uint256(0xA2B1));
    bytes32 constant SECRET_HASH = bytes32(uint256(0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2251)); // < BN254 modulus
    bytes32 constant TXID = keccak256("lifi-tx");
    uint256 constant F = 1_000_000_000; // 1000 USDC (6 dec)

    PortalFactory factory;
    address portal;
    address guardian = makeAddr("guardian");
    address user = makeAddr("aztecUserEthAddr");
    address relayer = makeAddr("relayer");
    uint256 nonce = 1;

    function setUp() public {
        vm.createSelectFork("https://ethereum-rpc.publicnode.com", 26118841);
        factory = new PortalFactory(REGISTRY, HUB, guardian);
        portal = factory.createPortal(address(USDC));
    }

    function _directCall(uint256 amt) internal view returns (bytes memory) {
        return abi.encodeCall(TokenPortalImpl.depositToAztecPrivate, (amt, SECRET_HASH));
    }

    function _plainSwap(uint256 from, uint256 callAmt) internal view returns (SwapData[] memory s) {
        s = new SwapData[](1);
        s[0] = SwapData(portal, portal, address(USDC), address(USDC), from, _directCall(callAmt), true);
    }

    function _patchedSwap(uint256 from) internal view returns (SwapData[] memory s) {
        uint256[] memory offs = new uint256[](1);
        offs[0] = 4; // first arg of depositToAztecPrivate
        bytes memory inner = IPatcher.depositAndExecuteWithDynamicPatches.selector == bytes4(0)
            ? bytes("")
            : abi.encodeCall(
                IPatcher.depositAndExecuteWithDynamicPatches,
                (
                    address(USDC),
                    address(USDC),
                    abi.encodeCall(IERC20.balanceOf, (PATCHER)),
                    portal,
                    0,
                    _directCall(0),
                    offs,
                    false
                )
            );
        s = new SwapData[](1);
        s[0] = SwapData(PATCHER, PATCHER, address(USDC), address(USDC), from, inner, true);
    }

    /// Real SpokePool.fillRelay: relayer pays `delivered` USDC to `recv`, which is called with `message`.
    function _fill(address recv, uint256 delivered, SwapData[] memory swaps) internal returns (uint256 gasUsed) {
        bytes memory message = abi.encode(TXID, swaps, user);
        deal(address(USDC), relayer, delivered);
        vm.startPrank(relayer);
        USDC.approve(SPOKE, delivered);
        RelayData memory r = RelayData({
            depositor: bytes32(uint256(uint160(makeAddr("baseDepositor")))),
            recipient: bytes32(uint256(uint160(recv))),
            exclusiveRelayer: bytes32(0),
            inputToken: bytes32(uint256(uint160(makeAddr("baseUsdc")))),
            outputToken: bytes32(uint256(uint160(address(USDC)))),
            inputAmount: delivered,
            outputAmount: delivered,
            originChainId: 8453,
            depositId: nonce++,
            fillDeadline: uint32(block.timestamp + 1 hours),
            exclusivityDeadline: 0,
            message: message
        });
        uint256 g = gasleft();
        ISpoke(SPOKE).fillRelay(r, 8453, bytes32(uint256(uint160(relayer))));
        gasUsed = g - gasleft();
        vm.stopPrank();
    }

    function _assertClean() internal view {
        assertEq(USDC.balanceOf(RECV_V3), 0, "recvV3 dust");
        assertEq(USDC.balanceOf(RECV_V4), 0, "recvV4 dust");
        assertEq(USDC.balanceOf(EXECUTOR), 0, "executor dust");
        assertEq(USDC.balanceOf(PATCHER), 0, "patcher dust");
    }

    /// Returns (portal event amount, secretHash, inbox MessageSent count).
    function _parse() internal returns (bool found, uint256 amt, bytes32 sh, uint256 inboxMsgs, bool recovered, bool completed) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter == portal && l.topics[0] == TokenPortalImpl.DepositToAztecPrivate.selector) {
                found = true;
                (amt, sh,,) = abi.decode(l.data, (uint256, bytes32, bytes32, uint256));
            }
            if (l.emitter == address(factory.INBOX()) && l.topics[0] == keccak256("MessageSent(uint256,uint256,bytes32,bytes16)")) inboxMsgs++;
            if (l.topics[0] == keccak256("LiFiTransferRecovered(bytes32,address,address,uint256,uint256)")) {
                recovered = true;
                console2.log("LiFiTransferRecovered emitted by", l.emitter);
                (,, uint256 a,) = abi.decode(l.data, (address, address, uint256, uint256));
                console2.log("  recovered amount", a);
            }
            if (l.topics[0] == keccak256("LiFiTransferCompleted(bytes32,address,address,uint256,uint256)")) completed = true;
        }
    }

    function _happy(address recv) internal {
        vm.recordLogs();
        uint256 g = _fill(recv, F, _plainSwap(F, F));
        (bool found, uint256 amt, bytes32 sh, uint256 n, bool rec, bool comp) = _parse();
        console2.log("fillRelay gas", g);
        assertTrue(found, "no portal event");
        assertEq(amt, F);
        assertEq(sh, SECRET_HASH);
        assertEq(n, 1, "inbox msg");
        assertFalse(rec);
        assertTrue(comp);
        assertEq(USDC.balanceOf(portal), F, "portal reserve");
        assertEq(USDC.balanceOf(user), 0);
        _assertClean();
    }

    function test_happy_receiverV3() public { _happy(RECV_V3); }
    function test_happy_receiverV4() public { _happy(RECV_V4); }

    function test_mismatch_plain_plus1() public {
        vm.recordLogs();
        _fill(RECV_V3, F + 1, _plainSwap(F, F));
        (bool found, uint256 amt,, uint256 n, bool rec,) = _parse();
        assertTrue(found);
        assertEq(amt, F);
        assertEq(n, 1);
        assertFalse(rec);
        assertEq(USDC.balanceOf(portal), F);
        assertEq(USDC.balanceOf(user), 1, "1 wei leftover to receiver");
        _assertClean();
    }

    function test_mismatch_plain_minus1() public {
        vm.recordLogs();
        _fill(RECV_V3, F - 1, _plainSwap(F, F));
        (bool found,,, uint256 n, bool rec,) = _parse();
        assertFalse(found);
        assertEq(n, 0);
        assertTrue(rec, "recovered");
        assertEq(USDC.balanceOf(portal), 0);
        assertEq(USDC.balanceOf(user), F - 1, "all to receiver");
        _assertClean();
    }

    function _patched(uint256 delivered) internal returns (bool found, uint256 amt, uint256 n, bool rec) {
        vm.recordLogs();
        _fill(RECV_V3, delivered, _patchedSwap(F));
        (found, amt,, n, rec,) = _parse();
    }

    function test_patched_exact() public {
        (bool found, uint256 amt, uint256 n, bool rec) = _patched(F);
        assertTrue(found); assertEq(amt, F); assertEq(n, 1); assertFalse(rec);
        assertEq(USDC.balanceOf(portal), F); assertEq(USDC.balanceOf(user), 0);
        _assertClean();
    }

    function test_patched_plus1() public {
        (bool found, uint256 amt, uint256 n, bool rec) = _patched(F + 1);
        assertTrue(found); assertEq(amt, F + 1); assertEq(n, 1); assertFalse(rec);
        assertEq(USDC.balanceOf(portal), F + 1); assertEq(USDC.balanceOf(user), 0);
        _assertClean();
    }

    function test_patched_minus1() public {
        (bool found, uint256 amt, uint256 n, bool rec) = _patched(F - 1);
        assertTrue(found); assertEq(amt, F - 1); assertEq(n, 1); assertFalse(rec);
        assertEq(USDC.balanceOf(portal), F - 1); assertEq(USDC.balanceOf(user), 0);
        _assertClean();
    }

    function test_fail_depositsPaused_recoversToReceiver() public {
        vm.prank(guardian);
        factory.setPaused(true, false);
        vm.recordLogs();
        _fill(RECV_V3, F, _plainSwap(F, F));
        (bool found,,, uint256 n, bool rec, bool comp) = _parse();
        assertFalse(found);
        assertEq(n, 0);
        assertTrue(rec);
        assertFalse(comp);
        assertEq(USDC.balanceOf(user), F, "USDC at receiver");
        assertEq(USDC.balanceOf(portal), 0);
        _assertClean();
    }
}
