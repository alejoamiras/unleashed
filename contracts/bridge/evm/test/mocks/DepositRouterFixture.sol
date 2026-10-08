// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

import {DepositRouter} from "../../src/DepositRouter.sol";
import {PortalFactory} from "../../src/PortalFactory.sol";
import {MintableERC20} from "../../src/MintableERC20.sol";
import {ILiFiSwap} from "../../src/interfaces/ILiFiSwap.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./AztecFakes.sol";
import {MockPermit2, MockFeeJuicePortal} from "./RouterMocks.sol";
import {MockLifiSwap, MockExecutor} from "./DepositRouterMocks.sol";

/// `DepositRouter` over the REAL factory, a LI.FI-shaped swap target and a mock Permit2. The token leg lands in a
/// genuine clone whose deposit message `inbox` captures: observe it through `portalBalance(token)` and
/// `lastMintWas*`; the fuel leg through `feePortal.lastAmount()`.
abstract contract DepositRouterFixture is Test {
    bytes32 internal constant HUB = bytes32(uint256(0x4B));
    bytes32 internal constant RECIPIENT = bytes32(uint256(0x1234));
    bytes32 internal constant FUEL_RECIPIENT = bytes32(uint256(0x5678));
    bytes32 internal constant SECRET = bytes32(uint256(0x5EC7E7));
    bytes32 internal constant FUEL_SECRET = bytes32(uint256(0xF5EC7E7));
    bytes32 internal constant TX_ID = bytes32(uint256(0x7D));

    MintableERC20 internal usdc;
    MintableERC20 internal fj;
    MockPermit2 internal permit2;
    MockLifiSwap internal swap;
    MockFeeJuicePortal internal feePortal;
    MockExecutor internal executor;
    CapturingInbox internal inbox;
    PortalFactory internal factory;
    DepositRouter internal router;
    address internal guardian = address(0x6A);
    address internal owner = address(0x0A11);
    address internal user = address(0xB0B);

    function _deployStack() internal {
        usdc = new MintableERC20("USDC", "USDC", 6, 1_000_000_000);
        fj = new MintableERC20("FeeJuice", "FJ", 18, 1_000_000_000);
        permit2 = new MockPermit2();
        swap = new MockLifiSwap(IERC20(address(fj)));
        feePortal = new MockFeeJuicePortal(IERC20(address(fj)));
        executor = new MockExecutor();
        inbox = new CapturingInbox();
        FakeRegistry registry =
            new FakeRegistry(address(new FakeRollup(address(inbox), address(new CapturingOutbox()))));
        factory = new PortalFactory(IRegistry(address(registry)), HUB, guardian);
        router = new DepositRouter(address(permit2), address(feePortal), address(factory), address(swap), owner);
        fj.mint(address(swap), 100_000 ether);
    }

    function portalFor(address token) internal view returns (address) {
        return factory.predictPortal(token);
    }

    function portalBalance(address token) internal view returns (uint256) {
        return IERC20(token).balanceOf(portalFor(token));
    }

    function _model(bytes memory preimage) internal pure returns (bytes32) {
        return bytes32(uint256(sha256(preimage)) >> 8);
    }

    function lastMintWasPublic(bytes32 to, uint256 amount) internal view returns (bool) {
        return inbox.lastContentHash() == _model(abi.encodeWithSignature("mint_to_public(bytes32,uint256)", to, amount));
    }

    function lastMintWasPrivate(uint256 amount) internal view returns (bool) {
        return inbox.lastContentHash() == _model(abi.encodeWithSignature("mint_to_private(uint256)", amount));
    }

    function _permit(uint256 nonce) internal pure returns (DepositRouter.PermitParams memory) {
        return DepositRouter.PermitParams({nonce: nonce, deadline: type(uint256).max, signature: hex"00"});
    }

    /// A token-only intent: no fuel leg, empty swap data.
    function _plainIntent(address token, bool isPrivate) internal pure returns (DepositRouter.DepositIntent memory i) {
        i.token = token;
        i.aztecRecipient = isPrivate ? bytes32(0) : RECIPIENT;
        i.tokenSecretHash = SECRET;
        i.isPrivate = isPrivate;
    }

    /// Token plus a fuel slice; `minFuelOutput` floors the router's own Fee Juice delta.
    function _fuelIntent(address token, uint256 slice, uint256 minFuel, bool isPrivate)
        internal
        pure
        returns (DepositRouter.DepositIntent memory i)
    {
        i = _plainIntent(token, isPrivate);
        i.fuelSlice = slice;
        i.fuelRecipient = FUEL_RECIPIENT;
        i.fuelSecretHash = FUEL_SECRET;
        i.minFuelOutput = minFuel;
    }

    /// Fuel only: no token leg, so no recipient and no token secret hash.
    function _fuelOnlyIntent(address token, uint256 slice, uint256 minFuel)
        internal
        pure
        returns (DepositRouter.DepositIntent memory i)
    {
        i.token = token;
        i.fuelSlice = slice;
        i.fuelRecipient = FUEL_RECIPIENT;
        i.fuelSecretHash = FUEL_SECRET;
        i.minFuelOutput = minFuel;
    }

    function _swapStep(address token, uint256 slice) internal view returns (ILiFiSwap.SwapData memory) {
        return ILiFiSwap.SwapData({
            callTo: address(0xDE7),
            approveTo: address(0xDE7),
            sendingAssetId: token,
            receivingAssetId: address(fj),
            fromAmount: slice,
            callData: "",
            requiresDeposit: true
        });
    }

    /// `swapTokensSingleV3ERC20ToERC20` paying the router, the shape the client builds.
    function _swapData(address token, uint256 slice, uint256 minOut) internal view returns (bytes memory) {
        return abi.encodeCall(
            ILiFiSwap.swapTokensSingleV3ERC20ToERC20,
            (TX_ID, "unleashed", "", payable(address(router)), minOut, _swapStep(token, slice))
        );
    }

    function _swapDataMultiple(address token, uint256 slice, uint256 minOut, bool requiresDeposit)
        internal
        view
        returns (bytes memory)
    {
        ILiFiSwap.SwapData[] memory steps = new ILiFiSwap.SwapData[](1);
        steps[0] = _swapStep(token, slice);
        steps[0].requiresDeposit = requiresDeposit;
        return abi.encodeCall(
            ILiFiSwap.swapTokensMultipleV3ERC20ToERC20,
            (TX_ID, "unleashed", "", payable(address(router)), minOut, steps)
        );
    }

    /// Mints `amount` to `who` and approves the mock Permit2 (the real one is pre-approved by `MintableERC20`).
    function _fundForPermit(MintableERC20 token, address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(permit2), type(uint256).max);
    }
}
