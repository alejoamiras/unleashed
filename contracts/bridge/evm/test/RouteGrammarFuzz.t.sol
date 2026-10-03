// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {UniswapFuelSwap} from "../src/UniswapFuelSwap.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

/// Exposes the internal _validateRoute for direct probing.
contract GrammarHarness is UniswapFuelSwap {
    constructor(address pm, address fj, address weth_) UniswapFuelSwap(pm, fj, weth_) {}

    function exposeValidate(address inputToken, PoolKey[] calldata path, bool[] calldata dirs) external view {
        _validateRoute(inputToken, path, dirs);
    }
}

/// Route-grammar fuzzing for UniswapFuelSwap._validateRoute (hermetic — no PoolManager).
///
/// Two properties:
///   1. NO FALSE REJECTIONS: every route drawn from the documented valid grammar is accepted.
///      This is the liveness guard for the [F-G] fix — a future tightening of validation that
///      accidentally excludes a legitimate shape (mid /WETH hops, native-final chains) fails here.
///   2. NO FALSE ACCEPTANCES: each single mutation that breaks exactly one documented rule is
///      rejected with THAT rule's message.
contract RouteGrammarFuzzTest is Test {
    address constant USDC = address(uint160(0x05DC));
    address constant WETH = address(uint160(0x4E14));
    address constant FJ = address(uint160(0xF1));

    GrammarHarness h;

    function setUp() public {
        h = new GrammarHarness(address(uint160(0x9001)), FJ, WETH);
    }

    function _key(address c0, address c1) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
    }

    struct Shape {
        PoolKey[] path;
        bool[] dirs;
        address input;
    }

    /// All-ERC20 chain X → … → FJ (Case A): any length ≥ 1, arbitrary mid ERC20s.
    function _ercChain(address sellIn, uint256 seed, uint256 len) internal pure returns (Shape memory s) {
        s.path = new PoolKey[](len);
        s.dirs = new bool[](len);
        s.input = sellIn;
        address cur = sellIn;
        for (uint256 i = 0; i < len; i++) {
            address out = i + 1 == len ? FJ : (seed % 2 == 0 ? WETH : address(uint160(0xA000 + i)));
            if (cur < out) {
                s.path[i] = _key(cur, out);
                s.dirs[i] = true;
            } else {
                s.path[i] = _key(out, cur);
                s.dirs[i] = false;
            }
            cur = out;
        }
    }

    /// Sell-in → WETH, then native/FJ final boundary (Case C). sellIn must differ from WETH:
    /// the first hop must OUTPUT the WETH that the final boundary unwraps.
    function _nativeFinal(address sellIn) internal pure returns (Shape memory s) {
        s.path = new PoolKey[](2);
        s.dirs = new bool[](2);
        s.input = sellIn;
        if (sellIn < WETH) {
            s.path[0] = _key(sellIn, WETH);
            s.dirs[0] = true;
        } else {
            s.path[0] = _key(WETH, sellIn);
            s.dirs[0] = false;
        }
        s.path[1] = _key(address(0), FJ); // sell native for FJ
        s.dirs[1] = true;
    }

    /// Single-hop native (Case B): WETH sold as native into {native/FJ}.
    function _singleNative() internal pure returns (Shape memory s) {
        s.path = new PoolKey[](1);
        s.dirs = new bool[](1);
        s.input = WETH;
        s.path[0] = _key(address(0), FJ);
        s.dirs[0] = true;
    }

    // ─── Property 1: grammar-valid shapes are always ACCEPTED ───

    function testFuzz_validGrammar_alwaysAccepted(uint256 seed, uint8 kind) public view {
        Shape memory s;
        uint256 k = kind % 5;
        if (k == 0) s = _ercChain(USDC, seed, 1);
        else if (k == 1) s = _ercChain(USDC, seed, 2);
        else if (k == 2) s = _ercChain(USDC, seed, 3);
        else if (k == 3) s = _nativeFinal(seed % 2 == 0 ? USDC : address(uint160(0xA000)));
        else s = _singleNative();
        h.exposeValidate(s.input, s.path, s.dirs); // any revert = failure
    }

    // ─── Property 2: rule-breaking mutations are REJECTED with the right reason ───

    function testFuzz_hookMutation_rejected(uint256 seed, uint256 len) public {
        Shape memory s = _ercChain(USDC, seed, bound(len, 1, 3));
        s.path[seed % s.path.length].hooks = IHooks(address(uint160(0xBAD)));
        vm.expectRevert(bytes("UniswapFuelSwap: hooks not allowed"));
        h.exposeValidate(s.input, s.path, s.dirs);
    }

    function testFuzz_firstInputMismatch_rejected(uint256 seed) public {
        Shape memory s = _ercChain(USDC, seed, 1);
        s.input = WETH; // route sells USDC, caller claims WETH
        vm.expectRevert(bytes("UniswapFuelSwap: first hop input mismatch"));
        h.exposeValidate(s.input, s.path, s.dirs);
    }

    function testFuzz_lastOutputMismatch_rejected(uint256 seed) public {
        Shape memory s = _ercChain(USDC, seed, 1);
        PoolKey memory k = s.path[s.path.length - 1];
        if (s.dirs[s.path.length - 1]) k.currency1 = Currency.wrap(WETH);
        else k.currency0 = Currency.wrap(WETH);
        s.path[s.path.length - 1] = k;
        vm.expectRevert(bytes("UniswapFuelSwap: last hop must output feeJuice"));
        h.exposeValidate(s.input, s.path, s.dirs);
    }

    /// The reverse discontinuity (a hop emitting native that a WETH-selling hop then spends)
    /// must be rejected: settlement bridges ONLY WETH→native at the final boundary.
    function testFuzz_reverseNativeUnwrap_rejected() public {
        PoolKey[] memory p = new PoolKey[](2);
        bool[] memory d = new bool[](2);
        // hop0: sell USDC into {native/USDC} → outputs native ETH
        p[0] = _key(address(0), USDC);
        d[0] = false;
        // hop1: sell WETH into {WETH/FJ} → consumes never-funded WETH
        p[1] = _key(WETH, FJ);
        d[1] = true;
        vm.expectRevert(bytes("UniswapFuelSwap: hop discontinuity"));
        h.exposeValidate(USDC, p, d);
    }

    function testFuzz_discontinuity_rejected(uint256 seed) public {
        Shape memory s = _ercChain(USDC, seed, 2);
        // Break the handoff: hop0 now outputs a token hop1 does not sell.
        PoolKey memory k0 = s.path[0];
        if (s.dirs[0]) k0.currency1 = Currency.wrap(address(uint160(0xC0DE)));
        else k0.currency0 = Currency.wrap(address(uint160(0xC0DE)));
        s.path[0] = k0;
        vm.expectRevert(bytes("UniswapFuelSwap: hop discontinuity"));
        h.exposeValidate(s.input, s.path, s.dirs);
    }
}
