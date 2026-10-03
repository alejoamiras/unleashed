// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {MintableERC20} from "../src/MintableERC20.sol";

contract MintableERC20Test is Test {
    MintableERC20 usdc;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant ALICE = address(uint160(0xA11CE));
    address constant BOB = address(uint160(0xB0B));

    function setUp() public {
        usdc = new MintableERC20("Test USDC", "USDC", 6, 1000);
    }

    function test_decimalsAndCap() public view {
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.maxMintPerTx(), 1000 * 1e6);
    }

    function test_mintWithinCap() public {
        usdc.mint(ALICE, 1_000_000);
        assertEq(usdc.balanceOf(ALICE), 1_000_000);
    }

    function test_mintExactlyAtCap() public {
        usdc.mint(ALICE, 1000 * 1e6);
        assertEq(usdc.balanceOf(ALICE), 1000 * 1e6);
    }

    function test_mintOverCapReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MintableERC20.MintCapExceeded.selector, 1000 * 1e6 + 1, 1000 * 1e6));
        usdc.mint(ALICE, 1000 * 1e6 + 1);
    }

    function test_mintIsPermissionless() public {
        vm.prank(BOB);
        usdc.mint(BOB, 42);
        assertEq(usdc.balanceOf(BOB), 42);
    }

    function test_permit2IsPreApprovedForEveryHolder() public view {
        assertEq(usdc.allowance(ALICE, PERMIT2), type(uint256).max);
        assertEq(usdc.allowance(BOB, PERMIT2), type(uint256).max);
    }

    function test_nonPermit2AllowanceIsNormal() public view {
        assertEq(usdc.allowance(ALICE, address(uint160(0xCAFE))), 0);
    }
}
