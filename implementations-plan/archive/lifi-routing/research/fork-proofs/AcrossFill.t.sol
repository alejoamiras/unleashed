// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, Vm, console2} from "forge-std/Test.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IWETH is IERC20 {
    function deposit() external payable;
}

interface IFactory {
    function predictPortal(address) external view returns (address);
    function createPortal(address) external returns (address);
    function depositsPaused() external view returns (bool);
}

interface IPortal {
    function depositToAztecPrivate(uint256, bytes32) external returns (bytes32, uint256);
    function INBOX() external view returns (address);
}

struct Call {
    address target;
    bytes callData;
    uint256 value;
}

struct Instructions {
    Call[] calls;
    address fallbackRecipient;
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

interface ISpokePool {
    function fillRelay(RelayData calldata, uint256 repaymentChainId, bytes32 repaymentAddress) external;
    function getCurrentTime() external view returns (uint256);
}

contract AcrossFillTest is Test {
    ISpokePool constant SPOKE = ISpokePool(0x5ef6C01E11889d86803e0B23e3cB3F9E9d97B662);
    address constant HANDLER = 0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E;
    IFactory constant FACTORY = IFactory(0xd97823e0009c12Ff5771A40ECE505622C449152C);
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    bytes32 constant SECRET_HASH = bytes32(uint256(0xA11CE5EC4E7));

    address relayer = makeAddr("relayer");
    address user = makeAddr("userL1");
    uint256 depositId;

    // Aztec Inbox: event MessageSent(uint256 indexed l2BlockNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)
    // Observed topic0 of the live Inbox's message event (topic1 = message key).
    bytes32 constant INBOX_SIG = 0x6406de2408cbb641d69139ebf977ffd682d709ede2d7b1009509ca5e7426a02e;
    bytes32 constant PORTAL_SIG = keccak256("DepositToAztecPrivate(uint256,bytes32,bytes32,uint256)");

    function _fund(address token, uint256 amount) internal {
        if (token == WETH) {
            vm.deal(relayer, amount);
            vm.prank(relayer);
            IWETH(WETH).deposit{value: amount}();
        } else {
            deal(token, relayer, amount);
        }
        vm.prank(relayer);
        IERC20(token).approve(address(SPOKE), type(uint256).max);
    }

    function _msg(address token, uint256 amount, address fallbackRecipient) internal view returns (bytes memory) {
        address portal = FACTORY.predictPortal(token);
        Call[] memory calls = new Call[](portal.code.length == 0 ? 3 : 2);
        uint256 i;
        if (portal.code.length == 0) calls[i++] = Call(address(FACTORY), abi.encodeCall(IFactory.createPortal, (token)), 0);
        calls[i++] = Call(token, abi.encodeCall(IERC20.approve, (portal, amount)), 0);
        calls[i++] = Call(portal, abi.encodeCall(IPortal.depositToAztecPrivate, (amount, SECRET_HASH)), 0);
        return abi.encode(Instructions(calls, fallbackRecipient));
    }

    function _relay(address token, uint256 amount, bytes memory message) internal returns (RelayData memory r) {
        r = RelayData({
            depositor: bytes32(uint256(uint160(user))),
            recipient: bytes32(uint256(uint160(HANDLER))),
            exclusiveRelayer: bytes32(0),
            inputToken: bytes32(uint256(uint160(token))),
            outputToken: bytes32(uint256(uint160(token))),
            inputAmount: amount,
            outputAmount: amount,
            originChainId: 84532,
            depositId: ++depositId + 777000,
            fillDeadline: uint32(SPOKE.getCurrentTime() + 1 hours),
            exclusivityDeadline: 0,
            message: message
        });
    }

    function _fill(address token, uint256 amount, address fb, bool pause) internal returns (uint256 gasUsed) {
        _fund(token, amount);
        if (pause) vm.mockCall(address(FACTORY), abi.encodeCall(IFactory.depositsPaused, ()), abi.encode(true));
        RelayData memory r = _relay(token, amount, _msg(token, amount, fb));
        vm.recordLogs();
        vm.prank(relayer);
        uint256 g = gasleft();
        SPOKE.fillRelay(r, 84532, bytes32(uint256(uint160(relayer))));
        gasUsed = g - gasleft();
    }

    function _success(address token, uint256 amount) internal {
        address portal = FACTORY.predictPortal(token);
        assertEq(portal.code.length, 0, "portal pre-exists");
        uint256 g = _fill(token, amount, user, false);
        emit log_named_uint("fill gas (fillRelay incl. createPortal)", g);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        address inbox = IPortal(portal).INBOX();
        uint256 inboxMsgs;
        bool portalEvt;
        bytes32 depKey;
        bytes32 inboxKeyMatch;
        for (uint256 k; k < logs.length; k++) {
            if (logs[k].emitter == inbox && logs[k].topics[0] == INBOX_SIG) { inboxMsgs++; }
            if (logs[k].emitter == portal && logs[k].topics[0] == PORTAL_SIG) {
                (uint256 a, bytes32 sh, bytes32 key,) = abi.decode(logs[k].data, (uint256, bytes32, bytes32, uint256));
                depKey = key;
                assertEq(a, amount);
                assertEq(sh, SECRET_HASH);
                portalEvt = true;
            }
        }
        assertTrue(portalEvt, "no DepositToAztecPrivate");
        for (uint256 k; k < logs.length; k++) {
            if (logs[k].emitter == inbox && logs[k].topics[0] == INBOX_SIG && logs[k].topics[1] == depKey) inboxKeyMatch = depKey;
        }
        assertEq(inboxKeyMatch, depKey, "Inbox event for deposit key");
        // register message (createPortal) + deposit message
        assertEq(inboxMsgs, 2, "inbox messages");
        emit log_named_uint("inbox MessageSent count", inboxMsgs);
        assertEq(IERC20(token).balanceOf(portal), amount, "portal reserve");
        assertEq(IERC20(token).balanceOf(HANDLER), 0, "handler token leftover");
        assertEq(HANDLER.balance, 0, "handler ETH leftover");
        assertEq(IERC20(token).balanceOf(relayer), 0, "relayer leftover");
        assertEq(IERC20(token).balanceOf(user), 0);
    }

    function test_success_WETH() public { _success(WETH, 0.01 ether); }
    function test_success_USDC() public { _success(USDC, 5e6); }

    function _failWithFallback(address token, uint256 amount) internal {
        _fill(token, amount, user, true);
        emit log_named_uint("user token balance", IERC20(token).balanceOf(user));
        emit log_named_uint("user ETH balance", user.balance);
        emit log_named_uint("handler token balance", IERC20(token).balanceOf(HANDLER));
        emit log_named_uint("handler ETH balance", HANDLER.balance);
        assertEq(IERC20(token).balanceOf(HANDLER), 0);
    }

    function test_fail_withFallback_USDC() public {
        _failWithFallback(USDC, 5e6);
        assertEq(IERC20(USDC).balanceOf(user), 5e6, "user refunded USDC");
    }

    function test_fail_withFallback_WETH() public {
        _failWithFallback(WETH, 0.01 ether);
        assertEq(IERC20(WETH).balanceOf(user), 0.01 ether, "user refunded WETH");
        assertEq(HANDLER.balance, 0);
    }

    function _failNoFallback(address token, uint256 amount) internal {
        _fund(token, amount);
        vm.mockCall(address(FACTORY), abi.encodeCall(IFactory.depositsPaused, ()), abi.encode(true));
        RelayData memory r = _relay(token, amount, _msg(token, amount, address(0)));
        uint256 relayerBal = IERC20(token).balanceOf(relayer);
        vm.prank(relayer);
        vm.expectRevert();
        SPOKE.fillRelay(r, 84532, bytes32(uint256(uint160(relayer))));
        assertEq(IERC20(token).balanceOf(relayer), relayerBal, "relayer funds untouched");
    }

    function test_fail_noFallback_USDC() public { _failNoFallback(USDC, 5e6); }
    function test_fail_noFallback_WETH() public { _failNoFallback(WETH, 0.01 ether); }
}
