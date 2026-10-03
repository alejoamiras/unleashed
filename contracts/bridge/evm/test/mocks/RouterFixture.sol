// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

import {SwapBridgeRouter, IUniswapFuelSwap} from "../../src/SwapBridgeRouter.sol";
import {PortalFactory} from "../../src/PortalFactory.sol";
import {MintableERC20} from "../../src/MintableERC20.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./AztecFakes.sol";
import {MockPermit2, MockSwap, MockFeeJuicePortal} from "./RouterMocks.sol";

/// The router over the REAL factory: the token leg lands in a genuine portal clone whose deposit
/// message is captured by `inbox`. Observe the token leg through `portalBalance(token)` and
/// `lastMintWas*`; the fuel leg through `feePortal.lastAmount()`.
abstract contract RouterFixture is Test {
    bytes32 internal constant HUB = bytes32(uint256(0x4B));
    bytes32 internal constant RECIPIENT = bytes32(uint256(0x1234));
    bytes32 internal constant FUEL_RECIPIENT = bytes32(uint256(0x5678));
    bytes32 internal constant SECRET = bytes32(uint256(0x5EC7E7));

    MintableERC20 internal usdc;
    MintableERC20 internal fj;
    MockPermit2 internal permit2;
    MockSwap internal swap;
    MockFeeJuicePortal internal feePortal;
    CapturingInbox internal inbox;
    CapturingOutbox internal outbox;
    PortalFactory internal factory;
    SwapBridgeRouter internal router;
    address internal guardian = address(0x6A);

    function _deployStack(uint8 usdcDecimals, uint256 usdcCapWhole) internal {
        usdc = new MintableERC20("USDC", "USDC", usdcDecimals, usdcCapWhole);
        fj = new MintableERC20("FeeJuice", "FJ", 18, 1_000_000_000);
        permit2 = new MockPermit2();
        swap = new MockSwap(IERC20(address(fj)));
        feePortal = new MockFeeJuicePortal(IERC20(address(fj)));
        inbox = new CapturingInbox();
        outbox = new CapturingOutbox();
        FakeRegistry registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(outbox))));
        factory = new PortalFactory(IRegistry(address(registry)), HUB, guardian);
        router = new SwapBridgeRouter(address(permit2), address(feePortal), address(swap), address(factory));
        fj.mint(address(swap), 100_000 ether);
    }

    /// The portal the router will bind `token` to (created on first use).
    function portalFor(address token) internal view returns (address) {
        return factory.predictPortal(token);
    }

    function portalBalance(address token) internal view returns (uint256) {
        return IERC20(token).balanceOf(portalFor(token));
    }

    function _model(bytes memory preimage) internal pure returns (bytes32) {
        return bytes32(uint256(sha256(preimage)) >> 8);
    }

    /// The last Inbox message was a public mint of exactly (to, amount).
    function lastMintWasPublic(bytes32 to, uint256 amount) internal view returns (bool) {
        return inbox.lastContentHash() == _model(abi.encodeWithSignature("mint_to_public(bytes32,uint256)", to, amount));
    }

    /// The last Inbox message was a private mint of exactly `amount`.
    function lastMintWasPrivate(uint256 amount) internal view returns (bool) {
        return inbox.lastContentHash() == _model(abi.encodeWithSignature("mint_to_private(uint256)", amount));
    }

    function _route() internal pure returns (IUniswapFuelSwap.PoolKey[] memory p, bool[] memory d) {
        p = new IUniswapFuelSwap.PoolKey[](1);
        p[0] = IUniswapFuelSwap.PoolKey(address(0), address(0), 3000, 60, address(0));
        d = new bool[](1);
        d[0] = true;
    }

    function _noRoute() internal pure returns (IUniswapFuelSwap.PoolKey[] memory p, bool[] memory d) {
        p = new IUniswapFuelSwap.PoolKey[](0);
        d = new bool[](0);
    }

    function _permit(uint256 nonce) internal pure returns (SwapBridgeRouter.PermitParams memory) {
        return SwapBridgeRouter.PermitParams({nonce: nonce, deadline: type(uint256).max, signature: hex"00"});
    }

    function _fuelParams(address token, uint256 total, uint256 fuel, bool isPrivate)
        internal
        view
        returns (SwapBridgeRouter.BridgeParams memory p)
    {
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _route();
        p = SwapBridgeRouter.BridgeParams({
            tokenPortal: portalFor(token),
            bridgeToken: token,
            totalAmount: total,
            fuelAmount: fuel,
            aztecRecipient: RECIPIENT,
            fuelRecipient: FUEL_RECIPIENT,
            tokenSecretHash: SECRET,
            fuelSecretHash: SECRET,
            minFuelOutput: 1 ether,
            path: path,
            zeroForOnes: dirs,
            isPrivate: isPrivate
        });
    }

    function _simpleParams(address token, uint256 amount, bool isPrivate)
        internal
        view
        returns (SwapBridgeRouter.SimpleBridgeParams memory)
    {
        return SwapBridgeRouter.SimpleBridgeParams({
            tokenPortal: portalFor(token),
            bridgeToken: token,
            amount: amount,
            aztecRecipient: RECIPIENT,
            secretHash: SECRET,
            isPrivate: isPrivate
        });
    }
}
