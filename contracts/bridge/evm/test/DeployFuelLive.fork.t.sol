// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {MintableERC20} from "../src/MintableERC20.sol";
import {UniswapFuelSwap} from "../src/UniswapFuelSwap.sol";
import {SwapBridgeRouter, IUniswapFuelSwap} from "../src/SwapBridgeRouter.sol";
import {PoolSetupHelper} from "../script/PoolSetupHelper.sol";
import {DeployFuelLive} from "../script/DeployFuelLive.s.sol";
import {Harness, IPermit2Domain} from "./SwapBridgeRouterPermit2Fork.t.sol";
import {FakePortalFactory} from "./mocks/RouterMocks.sol";

/// Honest factory model binding ONE live token to ONE live portal, so the router's portal
/// derivation resolves to the portal this suite observes.
contract BindingFactory is FakePortalFactory {
    constructor(address token, address portal) {
        portalOf[token] = portal;
        tokenOf[portal] = token;
    }
}

/// Forks Sepolia and rehearses the EXACT live topology before the real broadcast:
/// the LIVE AZLO token (permissionless mint + Permit2 allowance override on the
/// deployed bytecode), the LIVE canonical Token/FeeJuice portals, our own ETH/FJ
/// fee-500 tier at 200k FJ/ETH, and AZLO/WETH at 100 AZLO/WETH — then drives the
/// production two-hop bridgeWithFuel through all of it, both variants, with a
/// REAL minFuelOutput floor. Opt-in: skips unless SEPOLIA_RPC_URL is set.
contract DeployFuelLiveForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant FEE_JUICE = 0x762C132040fdA6183066Fa3B14d985ee55aA3C18;
    address constant FEE_ASSET_HANDLER = 0x5602c39A6E9C5AcE589F64F754927bcDa4f4BFc9;
    address constant FEE_JUICE_PORTAL = 0x5Bb7523A95c1FDF1D2A3DD9fb7d497E7F5142D7F;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant LIVE_AZLO = 0xB8ebd156dC94cdE08ec9E7EF0501232B2DbedEcE;
    address constant LIVE_TOKEN_PORTAL = 0x9c41d1DD627ed53E25702590ab974d9DfA0c11Ea;

    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    uint256 userPk = 0xF0E1;
    address user;

    DeployFuelLive cfg; // production constants, read from the script itself (no drift).
    MintableERC20 azlo;
    UniswapFuelSwap swap;
    Harness router;
    PoolSetupHelper helper;
    PoolKey azloWethKey;
    PoolKey ethFjKey;

    receive() external payable {}

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        user = vm.addr(userPk);

        cfg = new DeployFuelLive();
        azlo = MintableERC20(LIVE_AZLO);
        swap = new UniswapFuelSwap(POOL_MANAGER, FEE_JUICE, WETH);
        router = new Harness(PERMIT2, FEE_JUICE_PORTAL, address(swap), address(new BindingFactory(LIVE_AZLO, LIVE_TOKEN_PORTAL)));
        helper = new PoolSetupHelper(POOL_MANAGER, FEE_ASSET_HANDLER);

        azloWethKey = PoolKey({
            currency0: Currency.wrap(LIVE_AZLO),
            currency1: Currency.wrap(WETH),
            fee: cfg.AZLO_WETH_FEE(),
            tickSpacing: cfg.AZLO_WETH_SPACING(),
            hooks: IHooks(address(0))
        });
        // Fee 987 (not 500): the fee-500 ETH/FJ key is already squatted on live Sepolia at a
        // far-off price - exactly the front-run scenario the deploy script guards against.
        ethFjKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(FEE_JUICE),
            fee: 987,
            tickSpacing: 10,
            hooks: IHooks(address(0))
        });
    }

    /// Seeds both pools exactly as DeployFuelLive does (production constants + defaults).
    function _seedProductionPools() internal {
        vm.deal(address(this), 1 ether);

        // AZLO side is the LIVE token's permissionless mint; WETH side via deal.
        azlo.mint(address(helper), azlo.maxMintPerTx());
        deal(WETH, address(helper), 0.22 ether);
        helper.setup(
            0,
            azloWethKey,
            cfg.AZLO_WETH_SQRT_PRICE(),
            cfg.AZLO_WETH_TICK_LOWER(),
            cfg.AZLO_WETH_TICK_UPPER(),
            int256(32e17)
        );

        helper.setup{value: 0.12 ether}(
            30, ethFjKey, cfg.ETH_FJ_SQRT_PRICE_200K(), cfg.ETH_FJ_TICK_LOWER_200K(), cfg.ETH_FJ_TICK_UPPER_200K(), int256(70e18)
        );
        helper.sweep(address(0));
        helper.sweep(FEE_JUICE);
        helper.sweep(LIVE_AZLO);
        helper.sweep(WETH);
    }

    function _route() internal view returns (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) {
        path = new IUniswapFuelSwap.PoolKey[](2);
        path[0] = IUniswapFuelSwap.PoolKey(LIVE_AZLO, WETH, azloWethKey.fee, azloWethKey.tickSpacing, address(0));
        path[1] = IUniswapFuelSwap.PoolKey(address(0), FEE_JUICE, ethFjKey.fee, ethFjKey.tickSpacing, address(0));
        dirs = new bool[](2);
        dirs[0] = true; // AZLO -> WETH
        dirs[1] = true; // ETH  -> FeeJuice
    }

    // Fuel slices are PRODUCT-SIZED (0.25 AZLO ≈ 500 FJ, the 200-500 FJ design band): the
    // seeded depth absorbs ~1-2% impact per such fill, while an 8x oversize fill (2 AZLO)
    // craters the price by ~25% - which is why the UI enforces a MAX fuel cap.
    function _params(bool isPrivate, uint256 nonce, uint256 minFuelOutput)
        internal
        view
        returns (SwapBridgeRouter.BridgeParams memory p, SwapBridgeRouter.PermitParams memory permit)
    {
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _route();
        p = SwapBridgeRouter.BridgeParams({
            tokenPortal: LIVE_TOKEN_PORTAL,
            bridgeToken: LIVE_AZLO,
            totalAmount: 10e18,
            fuelAmount: 25e16,
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

    function test_liveAzloPermit2AllowanceOverrideAndMint() public {
        // The DEPLOYED bytecode must carry the allowance override - the fueled flow has no approve leg.
        assertEq(azlo.allowance(user, PERMIT2), type(uint256).max, "live AZLO pre-approves Permit2");
        azlo.mint(user, 100e18);
        assertEq(azlo.balanceOf(user), 100e18, "live AZLO permissionless mint");
    }

    function test_productionTopology_publicAndPrivate_realPortals() public {
        _seedProductionPools();
        azlo.mint(user, 100e18);

        // 0.25 AZLO fuel ≈ 0.0025 WETH ≈ 500 FJ at the production rates; floor with ~10%
        // headroom for the double-hop price impact.
        uint256 minFuel = 450e18;
        uint256 fjPortalBefore = IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL);
        uint256 tokenPortalBefore = IERC20(LIVE_AZLO).balanceOf(LIVE_TOKEN_PORTAL);

        (SwapBridgeRouter.BridgeParams memory p, SwapBridgeRouter.PermitParams memory permit) =
            _params(false, 0, minFuel);
        vm.prank(user);
        router.bridgeWithFuel(p, permit);

        uint256 fuelReceived = IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL) - fjPortalBefore;
        assertGe(fuelReceived, minFuel, "fuel >= signed floor through the REAL FJ portal");
        assertLe(fuelReceived, 510e18, "fuel within expected band (no mispriced pool)");
        assertEq(
            IERC20(LIVE_AZLO).balanceOf(LIVE_TOKEN_PORTAL) - tokenPortalBefore,
            975e16,
            "bridge amount deposited into the LIVE canonical TokenPortal"
        );
        assertEq(IERC20(LIVE_AZLO).balanceOf(address(router)), 0, "no AZLO residue in the router");
        assertEq(IERC20(FEE_JUICE).balanceOf(address(router)), 0, "no FJ residue in the router");

        // Private variant: same route, isPrivate witness bit, fresh nonce.
        (p, permit) = _params(true, 1, minFuel);
        vm.prank(user);
        router.bridgeWithFuel(p, permit);
        assertEq(
            IERC20(LIVE_AZLO).balanceOf(LIVE_TOKEN_PORTAL) - tokenPortalBefore,
            195e17,
            "private variant deposited via depositToAztecPrivate"
        );
    }

    function test_repeatPurchasesClearTheFloor() public {
        _seedProductionPools();
        azlo.mint(user, 100e18);

        // Five consecutive design-band fills with NO re-seeding: every fill must clear the
        // provisional MIN_FUEL floor (the product property - the UI re-quotes per fill, so
        // flat pricing is not required; observed decay is ~4.5%/fill at this depth, and a
        // narrower FJ band would deepen in-range liquidity at the same ETH budget).
        for (uint256 i = 0; i < 5; i++) {
            uint256 before = IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL);
            (SwapBridgeRouter.BridgeParams memory p, SwapBridgeRouter.PermitParams memory permit) =
                _params(false, i, 380e18);
            vm.prank(user);
            router.bridgeWithFuel(p, permit);
            uint256 got = IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL) - before;
            assertGe(got, 380e18, "every consecutive fill clears the provisional floor");
        }
    }

    function test_frontRunGuardTripsOnGarbagePrice() public {
        // V4 initialize is permissionless: simulate an attacker pre-initializing our key
        // at half the target price, and pin that the script's tolerance math rejects it.
        IPoolManager(POOL_MANAGER).initialize(azloWethKey, cfg.AZLO_WETH_SQRT_PRICE() / 2);
        (uint160 current,,,) = IPoolManager(POOL_MANAGER).getSlot0(azloWethKey.toId());
        uint160 target = cfg.AZLO_WETH_SQRT_PRICE();
        uint256 diff = current > target ? current - target : target - current;
        assertGt(diff * 10_000, uint256(target) * cfg.SQRT_TOLERANCE_BPS(), "guard math rejects the garbage price");
    }
}
