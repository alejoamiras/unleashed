// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {DepositRouter} from "../src/DepositRouter.sol";
import {TestnetFuelSwapper} from "../src/TestnetFuelSwapper.sol";
import {MintableERC20} from "../src/MintableERC20.sol";
import {ILiFiSwap} from "../src/interfaces/ILiFiSwap.sol";
import {DepositRouterFixture} from "./mocks/DepositRouterFixture.sol";
import {FeeAssetHandlerMock} from "./mocks/FeeAssetHandlerMock.sol";

contract TestnetFuelSwapperTest is DepositRouterFixture {
    uint256 internal constant USDC_RATE = 2 ether; // 2 FJ per whole USDC
    uint256 internal constant WETH_RATE = 3000 ether;

    MintableERC20 internal weth;
    FeeAssetHandlerMock internal handler;
    TestnetFuelSwapper internal swapper;
    /// Stands in for the router: the swapper's `msg.sender` and payer.
    address internal payer = address(0xFA7E);
    address internal receiver = address(0x2EC1);

    function setUp() public {
        _deployStack();
        weth = new MintableERC20("WETH", "WETH", 18, 1_000_000);
        handler = new FeeAssetHandlerMock(fj, 1 ether);
        swapper = new TestnetFuelSwapper(address(fj), address(handler), owner);
        vm.startPrank(owner);
        swapper.setRate(address(usdc), USDC_RATE);
        swapper.setRate(address(weth), WETH_RATE);
        vm.stopPrank();

        usdc.mint(payer, 1_000e6);
        weth.mint(payer, 10 ether);
        vm.startPrank(payer);
        usdc.approve(address(swapper), type(uint256).max);
        weth.approve(address(swapper), type(uint256).max);
        vm.stopPrank();
    }

    function _step(address token, address out, uint256 amountIn) internal pure returns (ILiFiSwap.SwapData memory) {
        return ILiFiSwap.SwapData({
            callTo: address(0xDE7),
            approveTo: address(0xDE7),
            sendingAssetId: token,
            receivingAssetId: out,
            fromAmount: amountIn,
            callData: hex"c0ffee",
            requiresDeposit: false
        });
    }

    function _swap(TestnetFuelSwapper s, address token, uint256 amountIn, uint256 minOut) internal {
        vm.prank(payer);
        s.swapTokensSingleV3ERC20ToERC20(
            TX_ID, "unleashed", "", payable(receiver), minOut, _step(token, address(fj), amountIn)
        );
    }

    // ── Quote ───────────────────────────────────────────────────────────────────────────────

    function test_quote_scalesByInputDecimals() public {
        assertEq(swapper.quote(address(usdc), 1.5e6), 3 ether, "6 decimals");
        assertEq(swapper.quote(address(weth), 0.5 ether), 1500 ether, "18 decimals");
        vm.prank(owner);
        swapper.setRate(address(usdc), 3);
        assertEq(swapper.quote(address(usdc), 1e6 - 1), 2, "rounds down");
    }

    function test_quote_unsupportedTokenReverts() public {
        vm.expectRevert(TestnetFuelSwapper.UnsupportedToken.selector);
        swapper.quote(address(fj), 1 ether);
        vm.expectRevert(TestnetFuelSwapper.UnsupportedToken.selector);
        _swap(swapper, address(fj), 1 ether, 0);
    }

    // ── Swap ────────────────────────────────────────────────────────────────────────────────

    /// Pulls exactly `fromAmount` (whatever `requiresDeposit` says), pays the quote to `_receiver`, returns no input.
    function test_swap_pullsExactlyAndPaysTheQuote() public {
        fj.mint(address(swapper), 100 ether);
        vm.expectEmit(address(swapper));
        emit TestnetFuelSwapper.Swapped(TX_ID, address(usdc), receiver, 25e6, 50 ether);
        _swap(swapper, address(usdc), 25e6, 50 ether);

        assertEq(usdc.balanceOf(payer), 975e6, "exactly fromAmount pulled");
        assertEq(usdc.balanceOf(address(swapper)), 25e6);
        assertEq(usdc.balanceOf(receiver), 0, "no input returned");
        assertEq(fj.balanceOf(receiver), 50 ether);
        assertEq(handler.mints(), 0, "inventory sufficed");

        _swap(swapper, address(weth), 0.01 ether, 0);
        assertEq(fj.balanceOf(receiver), 80 ether);
    }

    function test_swap_wrongOutputAssetReverts() public {
        vm.prank(payer);
        vm.expectRevert(TestnetFuelSwapper.WrongOutputAsset.selector);
        swapper.swapTokensSingleV3ERC20ToERC20(
            TX_ID, "", "", payable(receiver), 0, _step(address(usdc), address(weth), 1e6)
        );
    }

    function test_swap_belowMinimumReverts() public {
        fj.mint(address(swapper), 100 ether);
        vm.expectRevert(TestnetFuelSwapper.BelowMinimum.selector);
        _swap(swapper, address(usdc), 1e6, 2 ether + 1);
    }

    function test_swap_inventoryOnly_shortfallReverts() public {
        TestnetFuelSwapper bare = new TestnetFuelSwapper(address(fj), address(0), owner);
        vm.prank(owner);
        bare.setRate(address(usdc), USDC_RATE);
        vm.prank(payer);
        usdc.approve(address(bare), type(uint256).max);

        fj.mint(address(bare), 2 ether - 1);
        vm.expectRevert(TestnetFuelSwapper.InsufficientInventory.selector);
        _swap(bare, address(usdc), 1e6, 0);

        fj.mint(address(bare), 1);
        _swap(bare, address(usdc), 1e6, 0);
        assertEq(fj.balanceOf(receiver), 2 ether);
    }

    /// The faucet tops up one `mintAmount` at a time, stops once covered, and gives up after three.
    function test_swap_faucetTopUp_atMostThreeMints() public {
        fj.mint(address(swapper), 0.5 ether);
        _swap(swapper, address(usdc), 1e6, 0); // needs 2: 0.5 + 2 mints
        assertEq(handler.mints(), 2, "stops once covered");

        _swap(swapper, address(usdc), 1.5e6, 0); // holds 0.5, needs 3: the third mint covers it
        assertEq(handler.mints(), 5);
        assertEq(fj.balanceOf(address(swapper)), 0.5 ether);

        vm.expectRevert(TestnetFuelSwapper.InsufficientInventory.selector);
        _swap(swapper, address(usdc), 2e6, 0); // holds 0.5, needs 4: three mints reach 3.5
    }

    // ── Construction and owner ──────────────────────────────────────────────────────────────

    function test_constructor_refusesMainnetAndZeroFeeAsset() public {
        vm.chainId(1);
        vm.expectRevert(TestnetFuelSwapper.MainnetRefused.selector);
        new TestnetFuelSwapper(address(fj), address(handler), owner);

        vm.chainId(11155111);
        vm.expectRevert(TestnetFuelSwapper.ZeroAddress.selector);
        new TestnetFuelSwapper(address(0), address(handler), owner);
    }

    function test_owner_onlyOwnerSetsRateAndSweeps() public {
        vm.startPrank(payer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payer));
        swapper.setRate(address(usdc), 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payer));
        swapper.sweep(address(usdc), payer);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(TestnetFuelSwapper.ZeroAddress.selector);
        swapper.setRate(address(0), 1);
        vm.expectRevert(TestnetFuelSwapper.ZeroAddress.selector);
        swapper.sweep(address(usdc), address(0));
        vm.expectEmit(address(swapper));
        emit TestnetFuelSwapper.RateSet(address(usdc), 0);
        swapper.setRate(address(usdc), 0);
        vm.stopPrank();
        assertEq(swapper.rate(address(usdc)), 0, "zero unsupports the token");

        weth.mint(address(swapper), 3 ether);
        vm.prank(owner);
        swapper.sweep(address(weth), owner);
        assertEq(weth.balanceOf(owner), 3 ether);
    }

    // ── End to end: the router over the swapper ─────────────────────────────────────────────

    function test_endToEnd_permit_tokenAndFuelLand() public {
        DepositRouter testnetRouter =
            new DepositRouter(address(permit2), address(feePortal), address(factory), address(swapper), owner);
        uint256 amount = 1_000e6;
        uint256 slice = 50e6;
        uint256 fuel = swapper.quote(address(usdc), slice);
        DepositRouter.DepositIntent memory i = _fuelIntent(address(usdc), slice, fuel, false);
        bytes memory swapData = abi.encodeCall(
            ILiFiSwap.swapTokensSingleV3ERC20ToERC20,
            (TX_ID, "unleashed", "", payable(address(testnetRouter)), fuel, _swapStep(address(usdc), slice))
        );
        _fundForPermit(usdc, user, amount);
        handler.setMintAmount(1_000 ether);

        vm.prank(user);
        (uint256 tokenAmount, uint256 fuelOut) = testnetRouter.bridgeWithPermit(i, swapData, amount, _permit(1));

        assertEq(fuel, 100 ether);
        assertEq(tokenAmount, amount - slice);
        assertEq(fuelOut, fuel);
        assertEq(portalBalance(address(usdc)), amount - slice, "token leg in the derived clone");
        assertTrue(lastMintWasPublic(RECIPIENT, amount - slice));
        assertEq(fj.balanceOf(address(feePortal)), fuel, "fuel leg in the FeeJuicePortal");
        assertEq(feePortal.lastTo(), FUEL_RECIPIENT);
        assertEq(usdc.balanceOf(address(swapper)), slice, "the swapper kept exactly the slice");
        assertEq(handler.mints(), 1, "inventory came from the faucet");
        assertEq(usdc.balanceOf(address(testnetRouter)), 0);
        assertEq(fj.balanceOf(address(testnetRouter)), 0);
        assertEq(usdc.allowance(address(testnetRouter), address(swapper)), 0);
    }
}
