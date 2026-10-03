// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestUsdc} from "../src/TestUsdc.sol";
import {MintableERC20} from "../src/MintableERC20.sol";
import {InertSwapTarget} from "../src/InertSwapTarget.sol";

contract TestUsdcTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    TestUsdc token;

    function setUp() public {
        token = new TestUsdc("Test USDC", "USDC", 6, 1000);
    }

    function test_mint_permissionless_and_capped() public {
        token.mint(address(this), 1000e6);
        assertEq(token.balanceOf(address(this)), 1000e6);
        vm.expectRevert(abi.encodeWithSelector(TestUsdc.MintCapExceeded.selector, 1000e6 + 1, 1000e6));
        token.mint(address(this), 1000e6 + 1);
    }

    /// The point of TestUsdc: unlike MintableERC20, holders start at ZERO Permit2 allowance — exactly like
    /// real Circle USDC — so a deposit MUST run the app's one-time approve fallback.
    function test_no_permit2_auto_allowance_unlike_mintableERC20() public {
        token.mint(address(this), 5e6);
        assertEq(token.allowance(address(this), PERMIT2), 0);

        // Contrast pin: MintableERC20 DOES auto-grant (why it can't rehearse the approve).
        MintableERC20 mintable = new MintableERC20("AZLO", "AZLO", 18, 1000);
        assertEq(mintable.allowance(address(this), PERMIT2), type(uint256).max);

        // A normal approve then behaves like any ERC20 (the fallback's exact call).
        token.approve(PERMIT2, type(uint256).max);
        assertEq(token.allowance(address(this), PERMIT2), type(uint256).max);
    }

    function test_decimals_are_constructor_driven() public view {
        assertEq(token.decimals(), 6);
    }

    /// The mainnet swapTarget stub reverts on ANY call (selector or plain value transfer).
    function test_inertSwapTarget_reverts_all_calls() public {
        InertSwapTarget stub = new InertSwapTarget();
        (bool okCall,) = address(stub).call(abi.encodeWithSignature("swap(address,uint256)", address(1), 1));
        assertFalse(okCall);
        (bool okValue,) = address(stub).call{value: 1 wei}("");
        assertFalse(okValue);
    }
}
