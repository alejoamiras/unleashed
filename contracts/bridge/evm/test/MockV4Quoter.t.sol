// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IV4Quoter} from "../src/interfaces/IV4Quoter.sol";
import {IUniswapFuelSwap} from "../src/SwapBridgeRouter.sol";
import {MockSwapTarget} from "../src/mocks/MockSwapTarget.sol";
import {MockV4Quoter} from "../src/mocks/MockV4Quoter.sol";
import {MintableERC20} from "../src/MintableERC20.sol";

/// @notice The facade's composed quote must equal MockSwapTarget's settlement for every input the
/// route grammar can produce, or a floor signed from the quote fails at the router.
contract MockV4QuoterTest is Test {
    // Deployed contracts land far above 0x77e7 and far below type(uint160).max, so the two WETH
    // stand-ins put the token on each side of the pool's address ordering.
    address constant WETH_LOW = address(0x77e7);
    address constant WETH_HIGH = address(type(uint160).max);

    MintableERC20 token;
    MintableERC20 feeJuice;
    MockSwapTarget target;
    MockV4Quoter quoter;

    function setUp() public {
        token = new MintableERC20("Test USDC", "USDC", 6, 1e15);
        feeJuice = new MintableERC20("Fee Juice", "FJ", 18, 1e15);
        target = new MockSwapTarget(address(feeJuice));
        target.setRate(1e12, 1);
        feeJuice.mint(address(target), 1e33);
        quoter = new MockV4Quoter(target, WETH_LOW, address(feeJuice));
        quoter.setRoutable(address(token), true);
    }

    function _params(address a, address b, bool zeroForOne, uint128 amount)
        internal
        pure
        returns (IV4Quoter.QuoteExactSingleParams memory)
    {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return IV4Quoter.QuoteExactSingleParams({
            poolKey: PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, 60, IHooks(address(0))),
            zeroForOne: zeroForOne,
            exactAmount: amount,
            hookData: ""
        });
    }

    /// @dev token → WETH then native → FeeJuice, direction derived from the address ordering as buildFuelRoute does.
    function _compose(MockV4Quoter q, address weth, uint128 amountIn) internal view returns (uint256) {
        (uint256 mid,) = q.quoteExactInputSingle(_params(address(token), weth, address(token) < weth, amountIn));
        (uint256 out,) = q.quoteExactInputSingle(_params(address(0), address(feeJuice), true, uint128(mid)));
        return out;
    }

    function _settle(uint256 amountIn) internal returns (uint256) {
        token.mint(address(this), amountIn);
        token.approve(address(target), amountIn);
        IUniswapFuelSwap.PoolKey[] memory path = new IUniswapFuelSwap.PoolKey[](0);
        bool[] memory dirs = new bool[](0);
        return target.swap(address(token), amountIn, 0, path, dirs);
    }

    function test_composedQuoteEqualsSettlement_dust() public {
        assertEq(_compose(quoter, WETH_LOW, 1), _settle(1));
    }

    function test_composedQuoteEqualsSettlement_wholeUnits() public {
        assertEq(_compose(quoter, WETH_LOW, 40e6), _settle(40e6));
        assertEq(_compose(quoter, WETH_LOW, 40e6), 40e18);
    }

    function testFuzz_composedQuoteEqualsSettlement(uint64 amountIn, uint32 num, uint32 den) public {
        vm.assume(den != 0);
        target.setRate(num, den);
        assertEq(_compose(quoter, WETH_LOW, amountIn), _settle(amountIn));
    }

    function test_rateIsReadLive_notCached() public {
        uint256 before = _compose(quoter, WETH_LOW, 1e6);
        target.setRate(2e12, 1);
        assertEq(_compose(quoter, WETH_LOW, 1e6), before * 2);
    }

    function test_bothCurrencyOrderingsQuoteTheSame() public {
        MockV4Quoter high = new MockV4Quoter(target, WETH_HIGH, address(feeJuice));
        high.setRoutable(address(token), true);
        assertTrue(address(token) > WETH_LOW && address(token) < WETH_HIGH, "fixture ordering");
        assertEq(_compose(quoter, WETH_LOW, 7e6), _compose(high, WETH_HIGH, 7e6));
    }

    function test_wethSingleHopIsTheTerminalHop() public view {
        (uint256 out,) = quoter.quoteExactInputSingle(_params(address(0), address(feeJuice), true, 3));
        assertEq(out, 3e12);
    }

    function test_unlistedTokenReverts() public {
        MintableERC20 nort = new MintableERC20("No Route", "NORT", 18, 1);
        vm.expectRevert(bytes("MockV4Quoter: no such pool"));
        quoter.quoteExactInputSingle(_params(address(nort), WETH_LOW, address(nort) < WETH_LOW, 1));
    }

    function test_hookedPoolReverts() public {
        IV4Quoter.QuoteExactSingleParams memory p = _params(address(token), WETH_LOW, address(token) < WETH_LOW, 1);
        p.poolKey.hooks = IHooks(address(0xBEEF));
        vm.expectRevert(bytes("MockV4Quoter: hooked pool"));
        quoter.quoteExactInputSingle(p);
    }

    function test_wrongDirectionReverts() public {
        // WETH → token is not a fuel hop.
        vm.expectRevert(bytes("MockV4Quoter: no such pool"));
        quoter.quoteExactInputSingle(_params(address(token), WETH_LOW, !(address(token) < WETH_LOW), 1));
    }
}
