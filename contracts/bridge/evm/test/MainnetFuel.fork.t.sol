// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {UniswapFuelSwap} from "../src/UniswapFuelSwap.sol";
import {SwapBridgeRouter, IUniswapFuelSwap} from "../src/SwapBridgeRouter.sol";
import {IV4Quoter} from "../src/interfaces/IV4Quoter.sol";
import {Harness, IPermit2Domain} from "./SwapBridgeRouterPermit2Fork.t.sol";
import {MockTokenPortal, FakePortalFactory} from "./mocks/RouterMocks.sol";

/// Forks ETHEREUM MAINNET and executes the production two-hop fuel route against the CANONICAL
/// liquidity the shipped app will ride (mainnet discovers, never seeds): real Circle USDC in
/// via Permit2 witness-transfer, real Uniswap V4 USDC/WETH 500-tier → native-ETH/AZTEC 10000-tier
/// swap, real fee-asset deposit into the LIVE Aztec FeeJuicePortal. The token leg uses the mock
/// portal (mainnet has no token portal yet — the factory creates one per ERC-20 on first use).
/// Quoting a route is not the same as swapping it; this is the executing proof.
/// Floors are quoted live in-test (canonical pool prices move with the market — a hardcoded FJ
/// floor would rot). Opt-in: skips unless ETH_RPC_URL is set.
contract MainnetFuelForkTest is Test {
    // The canonical mainnet pins; `discover-mainnet-fuel.ts` is what finds and re-checks them.
    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address constant V4_QUOTER = 0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant CIRCLE_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant FEE_JUICE_PORTAL = 0xaf73Dd51D1eb8a079BB097f39c832cDD00ac691c;
    address constant FEE_JUICE_ASSET = 0xA27EC0006e59f245217Ff08CD52A7E8b169E62D2;
    // Discovery winners (discover-mainnet-fuel.ts).
    uint24 constant TOKEN_WETH_FEE = 500;
    int24 constant TOKEN_WETH_SPACING = 10;
    uint24 constant ETH_FJ_FEE = 10000;
    int24 constant ETH_FJ_SPACING = 200;

    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    uint256 userPk = 0xF0E1;
    address user;

    UniswapFuelSwap swap;
    Harness router;
    MockTokenPortal tokenPortal;
    // Deploy-address ETH BEFORE we deploy: forge's deterministic addresses can carry real
    // pre-existing mainnet balance on a fork (observed: 5.77e14 wei of stray dust), so residue
    // assertions must be deltas, never absolutes.
    uint256 swapEthBefore;
    uint256 routerEthBefore;

    receive() external payable {}

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        user = vm.addr(userPk);

        swap = new UniswapFuelSwap(POOL_MANAGER, FEE_JUICE_ASSET, WETH);
        // The token leg is out of scope here (it is the clone suites' job); an honest factory
        // model binds Circle USDC to a recording portal so the router's portal derivation passes.
        FakePortalFactory factory = new FakePortalFactory();
        tokenPortal = MockTokenPortal(factory.bind(CIRCLE_USDC));
        router = new Harness(PERMIT2, FEE_JUICE_PORTAL, address(swap), address(factory));
        swapEthBefore = address(swap).balance;
        routerEthBefore = address(router).balance;

        // Circle USDC grants NO automatic Permit2 allowance (unlike our test tokens) — the app's
        // ensurePermit2Allowance step is a real one-time approve; mirror it here.
        deal(CIRCLE_USDC, user, 100e6);
        vm.prank(user);
        IERC20(CIRCLE_USDC).approve(PERMIT2, type(uint256).max);
    }

    function _route() internal pure returns (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) {
        path = new IUniswapFuelSwap.PoolKey[](2);
        path[0] = IUniswapFuelSwap.PoolKey(CIRCLE_USDC, WETH, TOKEN_WETH_FEE, TOKEN_WETH_SPACING, address(0));
        path[1] = IUniswapFuelSwap.PoolKey(address(0), FEE_JUICE_ASSET, ETH_FJ_FEE, ETH_FJ_SPACING, address(0));
        dirs = new bool[](2);
        dirs[0] = true; // USDC -> WETH (USDC sorts below WETH).
        dirs[1] = true; // ETH  -> AZTEC (native is always currency0).
    }

    /// Live floor: quote the exact slice through the canonical pools, then take 97% (the app
    /// signs quote − slippageBps the same way).
    function _liveFloor(uint128 fuelSlice) internal returns (uint256) {
        (uint256 wethOut,) = IV4Quoter(V4_QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: PoolKey({
                    currency0: Currency.wrap(CIRCLE_USDC),
                    currency1: Currency.wrap(WETH),
                    fee: TOKEN_WETH_FEE,
                    tickSpacing: TOKEN_WETH_SPACING,
                    hooks: IHooks(address(0))
                }),
                zeroForOne: true,
                exactAmount: fuelSlice,
                hookData: ""
            })
        );
        (uint256 fjOut,) = IV4Quoter(V4_QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: PoolKey({
                    currency0: Currency.wrap(address(0)),
                    currency1: Currency.wrap(FEE_JUICE_ASSET),
                    fee: ETH_FJ_FEE,
                    tickSpacing: ETH_FJ_SPACING,
                    hooks: IHooks(address(0))
                }),
                zeroForOne: true,
                exactAmount: uint128(wethOut),
                hookData: ""
            })
        );
        assertGt(fjOut, 0, "live quote is dead - canonical route drained?");
        return (fjOut * 9700) / 10_000;
    }

    function _params(bool isPrivate, uint256 nonce, uint256 minFuelOutput)
        internal
        view
        returns (SwapBridgeRouter.BridgeParams memory p, SwapBridgeRouter.PermitParams memory permit)
    {
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _route();
        p = SwapBridgeRouter.BridgeParams({
            tokenPortal: address(tokenPortal),
            bridgeToken: CIRCLE_USDC,
            totalAmount: 10e6, // 10 USDC in, 1 USDC of it as fuel.
            fuelAmount: 1e6,
            aztecRecipient: bytes32(uint256(0x3333)),
            fuelRecipient: bytes32(uint256(0x4444)),
            tokenSecretHash: bytes32(uint256(0x5555)),
            fuelSecretHash: bytes32(uint256(0x6666)),
            minFuelOutput: minFuelOutput,
            path: path,
            zeroForOnes: dirs,
            isPrivate: isPrivate
        });
        uint256 deadline = block.timestamp + 30 minutes;
        bytes memory sig = _sign(p, nonce, deadline);
        permit = SwapBridgeRouter.PermitParams({nonce: nonce, deadline: deadline, signature: sig});
    }

    function _sign(SwapBridgeRouter.BridgeParams memory p, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 witnessHash = router.hWitness(
            SwapBridgeRouter.BridgeWitness({
                tokenPortal: p.tokenPortal,
                bridgeToken: p.bridgeToken,
                totalAmount: p.totalAmount,
                fuelAmount: p.fuelAmount,
                aztecRecipient: p.aztecRecipient,
                fuelRecipient: p.fuelRecipient,
                tokenSecretHash: p.tokenSecretHash,
                fuelSecretHash: p.fuelSecretHash,
                minFuelOutput: p.minFuelOutput,
                routeHash: keccak256(abi.encode(p.path, p.zeroForOnes)),
                isPrivate: p.isPrivate,
                swapTarget: address(router.swapTarget())
            })
        );
        bytes32 permitTypehash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                router.BRIDGE_WITNESS_TYPE_STRING()
            )
        );
        bytes32 tokenPermissions = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.bridgeToken, p.totalAmount));
        bytes32 structHash =
            keccak256(abi.encode(permitTypehash, tokenPermissions, address(router), nonce, deadline, witnessHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_canonicalRoute_publicAndPrivate_realFeeJuicePortal() public {
        uint256 minFuel = _liveFloor(1e6);
        uint256 fjPortalBefore = IERC20(FEE_JUICE_ASSET).balanceOf(FEE_JUICE_PORTAL);

        (SwapBridgeRouter.BridgeParams memory p, SwapBridgeRouter.PermitParams memory permit) =
            _params(false, 0, minFuel);
        vm.prank(user);
        router.bridgeWithFuel(p, permit);

        uint256 fuelReceived = IERC20(FEE_JUICE_ASSET).balanceOf(FEE_JUICE_PORTAL) - fjPortalBefore;
        assertGe(fuelReceived, minFuel, "fuel >= signed floor through the LIVE mainnet FJ portal");
        // Executed price must sit near the quoted price (floor/0.97 is the quote itself).
        assertLe(fuelReceived, (minFuel * 105) / 97, "execution way above quote - mispriced pool?");
        assertEq(tokenPortal.lastAmount(), 9e6, "bridge remainder deposited to the token portal");
        assertEq(IERC20(CIRCLE_USDC).balanceOf(address(router)), 0, "no USDC residue in the router");
        assertEq(IERC20(FEE_JUICE_ASSET).balanceOf(address(router)), 0, "no fee-asset residue in the router");
        // ≤1 wei tolerance: V4 native-currency exact-input rounding can strand a wei per fill.
        assertLe(address(router).balance - routerEthBefore, 1, "ETH gained beyond rounding dust in the router");
        assertEq(IERC20(CIRCLE_USDC).balanceOf(address(swap)), 0, "no USDC residue in the swap target");
        assertLe(address(swap).balance - swapEthBefore, 1, "ETH gained beyond rounding dust in the swap target");

        // Private variant: same route, isPrivate witness bit, fresh nonce, fresh live floor.
        (p, permit) = _params(true, 1, _liveFloor(1e6));
        vm.prank(user);
        router.bridgeWithFuel(p, permit);
        assertEq(tokenPortal.lastAmount(), 9e6, "private variant deposited via depositToAztecPrivate");
    }
}
