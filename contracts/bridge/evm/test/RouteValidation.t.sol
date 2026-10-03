// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {UniswapFuelSwap} from "../src/UniswapFuelSwap.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

/// Exposes the internal _validateRoute for direct testing.
contract Harness is UniswapFuelSwap {
    constructor(address pm, address fj, address weth_) UniswapFuelSwap(pm, fj, weth_) {}

    function exposeValidate(address inputToken, PoolKey[] calldata path, bool[] calldata dirs) external view {
        _validateRoute(inputToken, path, dirs);
    }
}

contract RouteValidationTest is Test {
    Harness h;
    address constant PM = address(uint160(0x9001));
    address constant USDC = address(uint160(0x05DC));
    address constant WETH = address(uint160(0x4E14));
    address constant FJ = address(uint160(0xF1));

    function setUp() public {
        h = new Harness(PM, FJ, WETH);
    }

    function _key(address c0, address c1, address hooks) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: 3000, tickSpacing: 60, hooks: IHooks(hooks)
        });
    }

    function _one(PoolKey memory k, bool dir) internal pure returns (PoolKey[] memory p, bool[] memory d) {
        p = new PoolKey[](1);
        p[0] = k;
        d = new bool[](1);
        d[0] = dir;
    }

    function test_validSingleHopPasses() public view {
        (PoolKey[] memory p, bool[] memory d) = _one(_key(USDC, FJ, address(0)), true);
        h.exposeValidate(USDC, p, d);
    }

    function test_hooksRejected() public {
        (PoolKey[] memory p, bool[] memory d) = _one(_key(USDC, FJ, address(uint160(0xBAD))), true);
        vm.expectRevert(bytes("UniswapFuelSwap: hooks not allowed"));
        h.exposeValidate(USDC, p, d);
    }

    function test_lastHopMustOutputFeeJuice() public {
        (PoolKey[] memory p, bool[] memory d) = _one(_key(USDC, WETH, address(0)), true);
        vm.expectRevert(bytes("UniswapFuelSwap: last hop must output feeJuice"));
        h.exposeValidate(USDC, p, d);
    }

    function test_validTwoHopPasses() public view {
        PoolKey[] memory p = new PoolKey[](2);
        p[0] = _key(USDC, WETH, address(0)); // sell USDC -> WETH
        p[1] = _key(WETH, FJ, address(0)); // sell WETH -> FJ
        bool[] memory d = new bool[](2);
        d[0] = true;
        d[1] = true;
        h.exposeValidate(USDC, p, d);
    }

    function test_discontinuityRejected() public {
        PoolKey[] memory p = new PoolKey[](2);
        p[0] = _key(USDC, WETH, address(0)); // out WETH
        p[1] = _key(USDC, FJ, address(0)); // in USDC (discontinuous)
        bool[] memory d = new bool[](2);
        d[0] = true;
        d[1] = true;
        vm.expectRevert(bytes("UniswapFuelSwap: hop discontinuity"));
        h.exposeValidate(USDC, p, d);
    }

    function test_nativeUnwrapContinuityPasses() public view {
        PoolKey[] memory p = new PoolKey[](2);
        p[0] = _key(USDC, WETH, address(0)); // out WETH
        p[1] = _key(address(0), FJ, address(0)); // in native ETH (WETH<->ETH allowed @ last boundary)
        bool[] memory d = new bool[](2);
        d[0] = true;
        d[1] = true;
        h.exposeValidate(USDC, p, d);
    }

    function test_midRouteUnwrapRejected() public {
        // A 3-hop where the WETH<->ETH unwrap is at a MIDDLE boundary (0->1), not the
        // last — _settle only handles it on the final hop, so _validateRoute must reject
        // it (validate-then-revert otherwise).
        PoolKey[] memory p = new PoolKey[](3);
        p[0] = _key(USDC, WETH, address(0)); // out WETH
        p[1] = _key(address(0), WETH, address(0)); // in native ETH (unwrap @ middle), out WETH
        p[2] = _key(WETH, FJ, address(0)); // in WETH, out FJ
        bool[] memory d = new bool[](3);
        d[0] = true;
        d[1] = true;
        d[2] = true;
        vm.expectRevert(bytes("UniswapFuelSwap: hop discontinuity"));
        h.exposeValidate(USDC, p, d);
    }

    /// [F-G], hermetic. `_validateRoute` accepts `{X/native},{native/FJ}`: the mid-path
    /// native hop reads as continuous because `outI == inNext == address(0)`.
    ///
    /// Lives here rather than only in the fork suite because the function touches no
    /// PoolManager state — it is pure logic over calldata and immutables — so it needs no
    /// SEPOLIA_RPC_URL gate. The fork suite keeps the execution half, which genuinely needs a
    /// live pool.
    function test_FG_validationAcceptsMidNativeRoute() public view {
        PoolKey[] memory p = new PoolKey[](2);
        p[0] = _key(address(0), USDC, address(0)); // sell USDC (currency1), out native
        p[1] = _key(address(0), FJ, address(0)); // sell native (currency0), out FJ
        bool[] memory d = new bool[](2);
        d[0] = false;
        d[1] = true;
        h.exposeValidate(USDC, p, d);
    }

    /// The REVERSE discontinuity (a hop emitting native that a WETH-selling hop then spends) is
    /// rejected: settlement bridges ONLY WETH→native at the final boundary.
    function test_reverseNativeUnwrapRejected() public {
        PoolKey[] memory p = new PoolKey[](2);
        bool[] memory d = new bool[](2);
        p[0] = _key(address(0), USDC, address(0)); // sell USDC (c1) → outputs native ETH
        d[0] = false;
        p[1] = _key(WETH, FJ, address(0)); // sells WETH that nothing ever wrapped
        d[1] = true;
        vm.expectRevert(bytes("UniswapFuelSwap: hop discontinuity"));
        h.exposeValidate(USDC, p, d);
    }
}
