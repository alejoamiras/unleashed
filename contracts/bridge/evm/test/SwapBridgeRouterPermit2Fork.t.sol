// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {MintableERC20} from "../src/MintableERC20.sol";
import {UniswapFuelSwap} from "../src/UniswapFuelSwap.sol";
import {SwapBridgeRouter, IUniswapFuelSwap} from "../src/SwapBridgeRouter.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {PoolSetupHelper} from "../script/PoolSetupHelper.sol";

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// Exposes the router's internal witness hash so a test can build the Permit2 digest the
/// contract will re-derive (cross-pinned to BRIDGE_WITNESS_TYPEHASH by WitnessHash.t.sol).
contract Harness is SwapBridgeRouter {
    constructor(address p2, address fjp, address swap, address factory) SwapBridgeRouter(p2, fjp, swap, factory) {}

    function hWitness(BridgeWitness calldata w) external pure returns (bytes32) {
        return _hashBridgeWitness(w);
    }
}

/// Forks Sepolia and drives the REAL Permit2, the REAL Uniswap V4 pools, the REAL Aztec
/// registry/Inbox and the REAL canonical FeeJuicePortal through the router: the token leg lands
/// in a factory clone the router creates on first use, the fuel leg is either a live V4 swap or
/// the fee asset's identity pass-through. Opt-in: skips unless SEPOLIA_RPC_URL and
/// AZTEC_REGISTRY (the network's canonical registry) are both set.
contract SwapBridgeRouterPermit2ForkTest is Test {
    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant FEE_JUICE = 0x762C132040fdA6183066Fa3B14d985ee55aA3C18;
    address constant FEE_ASSET_HANDLER = 0x5602c39A6E9C5AcE589F64F754927bcDa4f4BFc9;
    address constant FEE_JUICE_PORTAL = 0x5Bb7523A95c1FDF1D2A3DD9fb7d497E7F5142D7F;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 constant HUB = bytes32(uint256(0x4B));

    uint24 constant FEE = 3000;
    int24 constant TICK_SPACING = 60;
    uint160 constant ETH_FJ_SQRT_PRICE = 7922816251426433759354395033600;
    int24 constant ETH_FJ_TICK_LOWER = 69060;
    int24 constant ETH_FJ_TICK_UPPER = 115140;
    uint160 constant USDC_WETH_SQRT_PRICE = 1728916962386276374966316084832192;
    int24 constant USDC_WETH_TICK_LOWER = 169800;
    int24 constant USDC_WETH_TICK_UPPER = 229800;

    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant RECIPIENT = bytes32(uint256(0x3333));
    bytes32 constant FUEL_RECIPIENT = bytes32(uint256(0x4444));

    // Not a well-known test key: famous ones (0xA11CE, 0xB0B, …) carry EIP-7702 delegations on live
    // Sepolia, which turns Permit2's EOA signature check into an `isValidSignature` call that reverts.
    uint256 userPk = 0x5EC12E7_A11CE_0BEEF;
    address user;

    MintableERC20 usdc;
    UniswapFuelSwap swap;
    PortalFactory factory;
    Harness router;
    IInbox inbox;
    PoolSetupHelper helper;

    receive() external payable {}

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        address registryAddr = vm.envOr("AZTEC_REGISTRY", address(0));
        if (bytes(rpc).length == 0 || registryAddr == address(0)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        user = vm.addr(userPk);
        require(user.code.length == 0, "signer must be a plain EOA on this fork");

        usdc = new MintableERC20("Test USDC", "USDC", 6, 1000);
        require(address(usdc) < WETH, "usdc must sort below WETH");
        swap = new UniswapFuelSwap(POOL_MANAGER, FEE_JUICE, WETH);
        IRegistry registry = IRegistry(registryAddr);
        factory = new PortalFactory(registry, HUB, address(this));
        router = new Harness(PERMIT2, FEE_JUICE_PORTAL, address(swap), address(factory));
        inbox = IRollup(address(registry.getCanonicalRollup())).getInbox();
        helper = new PoolSetupHelper(POOL_MANAGER, FEE_ASSET_HANDLER);
        _seedPools();

        vm.startPrank(user);
        usdc.approve(PERMIT2, type(uint256).max);
        IERC20(FEE_JUICE).approve(PERMIT2, type(uint256).max);
        vm.stopPrank();
    }

    function _seedPools() internal {
        vm.deal(address(this), 2 ether);
        PoolKey memory ethFj = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(FEE_JUICE),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        helper.setup{value: 0.5 ether}(100, ethFj, ETH_FJ_SQRT_PRICE, ETH_FJ_TICK_LOWER, ETH_FJ_TICK_UPPER, 1e18);
        helper.sweep(address(0));
        helper.sweep(FEE_JUICE);

        for (uint256 i = 0; i < 10; i++) {
            usdc.mint(address(helper), usdc.maxMintPerTx());
        }
        deal(WETH, address(helper), 2 ether);
        PoolKey memory usdcWeth = PoolKey({
            currency0: Currency.wrap(address(usdc)),
            currency1: Currency.wrap(WETH),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        helper.setup(0, usdcWeth, USDC_WETH_SQRT_PRICE, USDC_WETH_TICK_LOWER, USDC_WETH_TICK_UPPER, 6e13);
    }

    // Route USDC -> WETH (our pool) -> ETH (unwrap at last boundary) -> FeeJuice (live pool).
    function _route() internal view returns (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) {
        path = new IUniswapFuelSwap.PoolKey[](2);
        path[0] = IUniswapFuelSwap.PoolKey(address(usdc), WETH, FEE, TICK_SPACING, address(0));
        path[1] = IUniswapFuelSwap.PoolKey(address(0), FEE_JUICE, FEE, TICK_SPACING, address(0));
        dirs = new bool[](2);
        dirs[0] = true; // USDC -> WETH
        dirs[1] = true; // ETH  -> FeeJuice
    }

    function _noRoute() internal pure returns (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) {
        path = new IUniswapFuelSwap.PoolKey[](0);
        dirs = new bool[](0);
    }

    // ─── Signing (the Permit2 digest the router re-derives) ───────────────────

    function _digest(SwapBridgeRouter.BridgeWitness memory w, address token, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 permitTypehash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                router.BRIDGE_WITNESS_TYPE_STRING()
            )
        );
        bytes32 tokenPermissions = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, token, amount));
        bytes32 structHash =
            keccak256(abi.encode(permitTypehash, tokenPermissions, address(router), nonce, deadline, router.hWitness(w)));
        return keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fuelParams(address token, address portal, uint256 total, uint256 fuel, bool isPrivate, bool identity)
        internal
        view
        returns (SwapBridgeRouter.BridgeParams memory p)
    {
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = identity ? _noRoute() : _route();
        p = SwapBridgeRouter.BridgeParams({
            tokenPortal: portal,
            bridgeToken: token,
            totalAmount: total,
            fuelAmount: fuel,
            aztecRecipient: fuel == total ? bytes32(0) : RECIPIENT,
            fuelRecipient: FUEL_RECIPIENT,
            tokenSecretHash: fuel == total ? bytes32(0) : bytes32(uint256(0x5555)),
            fuelSecretHash: bytes32(uint256(0x6666)),
            minFuelOutput: identity ? fuel : 1,
            path: path,
            zeroForOnes: dirs,
            isPrivate: isPrivate
        });
    }

    function _signFuel(SwapBridgeRouter.BridgeParams memory p, uint256 nonce, uint256 deadline)
        internal
        view
        returns (SwapBridgeRouter.PermitParams memory)
    {
        SwapBridgeRouter.BridgeWitness memory w = SwapBridgeRouter.BridgeWitness({
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
        });
        bytes memory sig = _sign(_digest(w, p.bridgeToken, p.totalAmount, nonce, deadline));
        return SwapBridgeRouter.PermitParams({nonce: nonce, deadline: deadline, signature: sig});
    }

    function _simple(address token, address portal, uint256 amount, bool isPrivate)
        internal
        pure
        returns (SwapBridgeRouter.SimpleBridgeParams memory)
    {
        return SwapBridgeRouter.SimpleBridgeParams({
            tokenPortal: portal,
            bridgeToken: token,
            amount: amount,
            aztecRecipient: RECIPIENT,
            secretHash: bytes32(uint256(0x5555)),
            isPrivate: isPrivate
        });
    }

    function _signSimple(SwapBridgeRouter.SimpleBridgeParams memory p, uint256 nonce, uint256 deadline)
        internal
        view
        returns (SwapBridgeRouter.PermitParams memory)
    {
        SwapBridgeRouter.BridgeWitness memory w = SwapBridgeRouter.BridgeWitness({
            tokenPortal: p.tokenPortal,
            bridgeToken: p.bridgeToken,
            totalAmount: p.amount,
            fuelAmount: 0,
            aztecRecipient: p.aztecRecipient,
            fuelRecipient: bytes32(0),
            tokenSecretHash: p.secretHash,
            fuelSecretHash: bytes32(0),
            minFuelOutput: 0,
            routeHash: bytes32(0),
            isPrivate: p.isPrivate,
            swapTarget: address(router.swapTarget())
        });
        bytes memory sig = _sign(_digest(w, p.bridgeToken, p.amount, nonce, deadline));
        return SwapBridgeRouter.PermitParams({nonce: nonce, deadline: deadline, signature: sig});
    }

    function _usdcPortal() internal view returns (address) {
        return factory.predictPortal(address(usdc));
    }

    // ─── bridgeWithFuel: real Permit2 + real V4 + clone created on first use ───

    function test_bridgeWithFuel_realSwapAndPermit2_createsClone() public {
        usdc.mint(user, 10e6);
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), _usdcPortal(), 10e6, 2e6, false, false);
        SwapBridgeRouter.PermitParams memory permit = _signFuel(p, 0, block.timestamp + 1 hours);
        assertEq(factory.portalOf(address(usdc)), address(0));

        uint256 before = usdc.balanceOf(user);
        uint256 fjBefore = IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL);
        vm.prank(user);
        router.bridgeWithFuel(p, permit);

        assertEq(before - usdc.balanceOf(user), 10e6, "pulled totalAmount via Permit2");
        assertEq(factory.portalOf(address(usdc)), _usdcPortal(), "router created the clone");
        assertEq(usdc.balanceOf(_usdcPortal()), 8e6, "bridged totalAmount - fuelAmount into the clone");
        assertGt(IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL) - fjBefore, 0, "swapped fuel landed in the real FeeJuicePortal");
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(IERC20(FEE_JUICE).balanceOf(address(router)), 0);
    }

    function test_bridgeWithFuelPrivate_realSwap() public {
        usdc.mint(user, 10e6);
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), _usdcPortal(), 10e6, 2e6, true, false);
        SwapBridgeRouter.PermitParams memory permit = _signFuel(p, 0, block.timestamp + 1 hours);
        vm.prank(user);
        router.bridgeWithFuel(p, permit);
        assertEq(usdc.balanceOf(_usdcPortal()), 8e6, "private: bridged remainder into the clone");
    }

    function test_fuelOnly_realSwap() public {
        usdc.mint(user, 10e6);
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), address(0), 10e6, 10e6, false, false);
        SwapBridgeRouter.PermitParams memory permit = _signFuel(p, 0, block.timestamp + 1 hours);

        uint256 fjBefore = IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL);
        vm.prank(user);
        router.bridgeWithFuel(p, permit);

        assertGt(IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL) - fjBefore, 0, "fuel landed");
        assertEq(factory.portalOf(address(usdc)), address(0), "fuel-only creates no clone");
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_permit2NonceReplayReverts() public {
        usdc.mint(user, 20e6);
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), _usdcPortal(), 10e6, 2e6, false, false);
        SwapBridgeRouter.PermitParams memory permit = _signFuel(p, 0, block.timestamp + 1 hours);
        vm.prank(user);
        router.bridgeWithFuel(p, permit); // consumes nonce 0
        vm.prank(user);
        vm.expectRevert(); // Permit2 InvalidNonce — the bitmap bit is already set
        router.bridgeWithFuel(p, permit);
    }

    function test_permit2ExpiredDeadlineReverts() public {
        usdc.mint(user, 10e6);
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), _usdcPortal(), 10e6, 2e6, false, false);
        SwapBridgeRouter.PermitParams memory permit = _signFuel(p, 1, block.timestamp - 1);
        vm.prank(user);
        vm.expectRevert(); // Permit2 SignatureExpired
        router.bridgeWithFuel(p, permit);
    }

    function test_witnessTamperReverts() public {
        usdc.mint(user, 10e6);
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), _usdcPortal(), 10e6, 2e6, false, false);
        SwapBridgeRouter.PermitParams memory permit = _signFuel(p, 0, block.timestamp + 1 hours);
        // Re-aim after signing — the router re-derives the witness from p, so the Permit2
        // signature no longer matches: no relayer can redirect funds after the user signs.
        p.aztecRecipient = bytes32(uint256(0xDEAD));
        vm.prank(user);
        vm.expectRevert();
        router.bridgeWithFuel(p, permit);
    }

    // ─── Identity swap: the fee asset through the real FeeJuicePortal + its own clone ───

    function test_identity_partialAztecPlusGas() public {
        deal(FEE_JUICE, user, 20 ether);
        address fjClone = factory.predictPortal(FEE_JUICE);
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(FEE_JUICE, fjClone, 20 ether, 16 ether, true, true);
        SwapBridgeRouter.PermitParams memory permit = _signFuel(p, 0, block.timestamp + 1 hours);

        uint256 fjBefore = IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL);
        vm.prank(user);
        router.bridgeWithFuel(p, permit);

        assertEq(IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL) - fjBefore, 16 ether, "fuel passed through 1:1");
        assertEq(IERC20(FEE_JUICE).balanceOf(fjClone), 4 ether, "remainder into the fee asset's clone");
        assertEq(factory.portalOf(FEE_JUICE), fjClone, "router created the fee asset's clone");
        assertEq(IERC20(FEE_JUICE).balanceOf(address(router)), 0);
    }

    function test_identity_fuelOnly() public {
        deal(FEE_JUICE, user, 20 ether);
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(FEE_JUICE, address(0), 16 ether, 16 ether, false, true);
        SwapBridgeRouter.PermitParams memory permit = _signFuel(p, 0, block.timestamp + 1 hours);

        uint256 fjBefore = IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL);
        vm.prank(user);
        router.bridgeWithFuel(p, permit);
        assertEq(IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL) - fjBefore, 16 ether);
        assertEq(factory.portalOf(FEE_JUICE), address(0), "fuel-only creates no clone");
    }

    // ─── bridge(): real Permit2, clone token leg, direct gas ───

    function test_bridge_realPermit2Public() public {
        usdc.mint(user, 5e6);
        SwapBridgeRouter.SimpleBridgeParams memory p = _simple(address(usdc), _usdcPortal(), 5e6, false);
        SwapBridgeRouter.PermitParams memory permit = _signSimple(p, 0, block.timestamp + 1 hours);

        uint256 before = usdc.balanceOf(user);
        vm.prank(user);
        router.bridge(p, permit);
        assertEq(before - usdc.balanceOf(user), 5e6, "pulled amount via Permit2");
        assertEq(usdc.balanceOf(_usdcPortal()), 5e6, "bridged full amount into the clone");
    }

    function test_bridge_realPermit2Private() public {
        usdc.mint(user, 5e6);
        SwapBridgeRouter.SimpleBridgeParams memory p = _simple(address(usdc), _usdcPortal(), 5e6, true);
        SwapBridgeRouter.PermitParams memory permit = _signSimple(p, 0, block.timestamp + 1 hours);
        vm.prank(user);
        router.bridge(p, permit);
        assertEq(usdc.balanceOf(_usdcPortal()), 5e6, "private: bridged full amount");
    }

    function test_bridge_nonceReplayReverts() public {
        usdc.mint(user, 10e6);
        SwapBridgeRouter.SimpleBridgeParams memory p = _simple(address(usdc), _usdcPortal(), 5e6, false);
        SwapBridgeRouter.PermitParams memory permit = _signSimple(p, 0, block.timestamp + 1 hours);
        vm.prank(user);
        router.bridge(p, permit); // consumes nonce 0
        vm.prank(user);
        vm.expectRevert(); // Permit2 InvalidNonce
        router.bridge(p, permit);
    }

    function test_bridge_expiredDeadlineReverts() public {
        usdc.mint(user, 5e6);
        SwapBridgeRouter.SimpleBridgeParams memory p = _simple(address(usdc), _usdcPortal(), 5e6, false);
        SwapBridgeRouter.PermitParams memory permit = _signSimple(p, 1, block.timestamp - 1);
        vm.prank(user);
        vm.expectRevert(); // Permit2 SignatureExpired
        router.bridge(p, permit);
    }

    function test_bridge_witnessTamperReverts() public {
        usdc.mint(user, 5e6);
        SwapBridgeRouter.SimpleBridgeParams memory p = _simple(address(usdc), _usdcPortal(), 5e6, false);
        SwapBridgeRouter.PermitParams memory permit = _signSimple(p, 0, block.timestamp + 1 hours);
        p.aztecRecipient = bytes32(uint256(0xDEAD)); // re-aim after signing → witness mismatch
        vm.prank(user);
        vm.expectRevert();
        router.bridge(p, permit);
    }

    /// A signed foreign portal is refused by the router itself, before Permit2 ever sees the
    /// signature — so a phishing intent cannot even burn the nonce.
    function test_bridge_foreignPortalRefusedBeforePermit2() public {
        usdc.mint(user, 5e6);
        SwapBridgeRouter.SimpleBridgeParams memory p = _simple(address(usdc), address(0xDEAD), 5e6, false);
        SwapBridgeRouter.PermitParams memory permit = _signSimple(p, 0, block.timestamp + 1 hours);
        vm.prank(user);
        vm.expectRevert(SwapBridgeRouter.ForeignPortal.selector);
        router.bridge(p, permit);

        // The nonce is still free: the honest intent with the same nonce goes through.
        SwapBridgeRouter.SimpleBridgeParams memory ok = _simple(address(usdc), _usdcPortal(), 5e6, false);
        SwapBridgeRouter.PermitParams memory okPermit = _signSimple(ok, 0, block.timestamp + 1 hours);
        vm.prank(user);
        router.bridge(ok, okPermit);
        assertEq(usdc.balanceOf(_usdcPortal()), 5e6);
    }

    /// Direct gas: `bridge()` with the canonical FeeJuicePortal as the fee asset's portal.
    function test_bridge_directGas_realFeeJuicePortal() public {
        deal(FEE_JUICE, user, 20 ether);
        SwapBridgeRouter.SimpleBridgeParams memory p = _simple(FEE_JUICE, FEE_JUICE_PORTAL, 16 ether, false);
        SwapBridgeRouter.PermitParams memory permit = _signSimple(p, 0, block.timestamp + 1 hours);

        uint256 before = IERC20(FEE_JUICE).balanceOf(user);
        uint256 portalBefore = IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL);
        vm.prank(user);
        router.bridge(p, permit);
        assertEq(before - IERC20(FEE_JUICE).balanceOf(user), 16 ether, "pulled fee asset via Permit2");
        assertEq(IERC20(FEE_JUICE).balanceOf(FEE_JUICE_PORTAL) - portalBefore, 16 ether, "landed in the real portal");
        assertEq(IERC20(FEE_JUICE).balanceOf(address(router)), 0, "no fee-asset residue in the router");
    }
}
