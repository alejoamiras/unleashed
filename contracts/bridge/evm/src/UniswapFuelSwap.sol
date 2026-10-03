// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@oz/access/Ownable2Step.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/**
 * @title UniswapFuelSwap
 * @notice Swaps ERC-20 tokens for FeeJuice (AZTEC) via Uniswap V4 PoolManager.
 *         Designed to be called by SwapBridgeRouter via a typed interface.
 *
 *         Supported routes:
 *           - Single-hop ERC-20:  WETH → AZTEC  (WETH/AZTEC pool)
 *           - Single-hop native:  WETH → ETH → AZTEC  (native ETH/AZTEC pool, auto-unwrap)
 *           - Multi-hop ERC-20:   USDC → WETH → AZTEC
 *           - Multi-hop native:   USDC → WETH → ETH → AZTEC  (last pool uses native ETH)
 *
 * @dev    Implements IUnlockCallback for V4's flash-accounting pattern.
 *         Only the PoolManager may call unlockCallback.
 */
contract UniswapFuelSwap is IUnlockCallback, Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Immutables ──────────────────────────────────────────────────
    IPoolManager public immutable poolManager;
    address public immutable feeJuice;
    address public immutable weth;

    // ─── Reentrancy guard ────────────────────────────────────────────
    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "UniswapFuelSwap: reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    // ─── Events ──────────────────────────────────────────────────────
    event SwapExecuted(address indexed caller, address indexed inputToken, uint256 inputAmount, uint256 outputAmount);

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _poolManager, address _feeJuice, address _weth) Ownable(msg.sender) {
        require(_poolManager != address(0), "UniswapFuelSwap: zero poolManager");
        require(_feeJuice != address(0), "UniswapFuelSwap: zero feeJuice");
        require(_weth != address(0), "UniswapFuelSwap: zero weth");

        poolManager = IPoolManager(_poolManager);
        feeJuice = _feeJuice;
        weth = _weth;
    }

    /// @dev Accept ETH from WETH.withdraw() and PoolManager.take() for native ETH routes.
    receive() external payable {}

    // ─── External API ────────────────────────────────────────────────

    /**
     * @notice Swap inputToken for FeeJuice via one or more Uniswap V4 pools.
     * @param inputToken  The ERC-20 token to sell (caller must have approved this contract).
     * @param inputAmount Exact amount of inputToken to swap.
     * @param minOutput   Minimum FeeJuice output (slippage protection).
     * @param path        Ordered PoolKey array describing the swap route.
     * @param zeroForOnes Swap direction per hop (true = sell currency0 for currency1).
     * @return output     Amount of FeeJuice received.
     */
    function swap(
        address inputToken,
        uint256 inputAmount,
        uint256 minOutput,
        PoolKey[] calldata path,
        bool[] calldata zeroForOnes
    ) external nonReentrant returns (uint256 output) {
        require(path.length > 0, "UniswapFuelSwap: empty path");
        require(path.length == zeroForOnes.length, "UniswapFuelSwap: path/direction mismatch");
        require(inputAmount > 0, "UniswapFuelSwap: zero input");
        require(minOutput > 0, "UniswapFuelSwap: zero minOutput");
        require(inputAmount <= uint256(type(int256).max), "UniswapFuelSwap: input overflow");
        _validateRoute(inputToken, path, zeroForOnes);

        // Pull input tokens from caller (SwapBridgeRouter approved this contract)
        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);

        // Encode callback context and initiate V4 unlock
        bytes memory data = abi.encode(inputToken, inputAmount, path, zeroForOnes);
        bytes memory result = poolManager.unlock(data);
        output = abi.decode(result, (uint256));

        require(output >= minOutput, "UniswapFuelSwap: insufficient output");

        // Transfer FeeJuice to caller (SwapBridgeRouter)
        IERC20(feeJuice).safeTransfer(msg.sender, output);

        emit SwapExecuted(msg.sender, inputToken, inputAmount, output);
    }

    // ─── V4 Callback ─────────────────────────────────────────────────

    /**
     * @notice PoolManager callback — executes swaps inside the unlock context.
     * @dev Only callable by the PoolManager. Performs multi-hop swaps using flash accounting, then
     *      settles EXACTLY the accumulated per-currency deltas. Deriving settlement from the
     *      deltas (instead of pattern-matching on route shape) is what makes every validated
     *      route settle correctly: mid-path native handoffs net to zero and need no transfer, and
     *      a WETH→native final boundary is bridged by unwrapping only what the last hop owes.
     */
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "UniswapFuelSwap: unauthorized callback");

        (address inputToken, uint256 inputAmount, PoolKey[] memory path, bool[] memory zeroForOnes) =
            abi.decode(data, (address, uint256, PoolKey[], bool[]));

        // Touched currencies and their net deltas (positive = PM owes us, negative = we owe PM).
        // A route touches at most 2*path.length + 1 distinct currencies; bound accordingly.
        address[] memory currencies = new address[](2 * path.length + 1);
        int256[] memory deltas = new int256[](currencies.length);
        uint256 touched;

        uint256 currentAmount = inputAmount;

        // ── Execute each hop ─────────────────────────────────────────
        for (uint256 i = 0; i < path.length; i++) {
            // Exact input swap: negative amountSpecified = exact input
            uint256 wanted = currentAmount;
            BalanceDelta delta = poolManager.swap(
                path[i],
                IPoolManager.SwapParams({
                    zeroForOne: zeroForOnes[i],
                    amountSpecified: -int256(wanted),
                    sqrtPriceLimitX96: zeroForOnes[i] ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );

            // V4 may return EARLY with unconsumed input (price limit reached). Our limits are
            // the extreme bounds so that should be unreachable, but a drained/thin pool must
            // never let a partial fill strand the unconsumed remainder in this contract:
            // assert the input side was consumed EXACTLY.
            int128 inputDelta = zeroForOnes[i] ? delta.amount0() : delta.amount1();
            require(uint256(int256(-inputDelta)) == wanted, "UniswapFuelSwap: partial fill");

            // Output is the positive delta (token we receive from the pool)
            int128 outputDelta = zeroForOnes[i] ? delta.amount1() : delta.amount0();
            require(outputDelta > 0, "UniswapFuelSwap: non-positive output");
            currentAmount = uint256(int256(outputDelta));

            bool zfo = zeroForOnes[i];
            touched = _accumulate(
                currencies, deltas, touched, _side(path[i], zfo, true), int256(zfo ? delta.amount0() : delta.amount1())
            );
            touched = _accumulate(
                currencies, deltas, touched, _side(path[i], zfo, false), int256(zfo ? delta.amount1() : delta.amount0())
            );
        }

        // ── Settlement: takes first (so bridged WETH is in hand), then pays ──
        for (uint256 i = 0; i < touched; i++) {
            if (deltas[i] > 0) poolManager.take(Currency.wrap(currencies[i]), address(this), uint256(deltas[i]));
        }
        for (uint256 i = 0; i < touched; i++) {
            if (deltas[i] >= 0) continue;
            uint256 owed = uint256(-deltas[i]);
            if (currencies[i] == address(0)) {
                // Native ETH owed: bridge from taken WETH when the route's final boundary was the
                // sanctioned WETH unwrap; validation guarantees WETH coverage whenever native is
                // owed by a first hop (input must be WETH) or a final boundary.
                require(IERC20(weth).balanceOf(address(this)) >= owed, "UniswapFuelSwap: weth bridge shortfall");
                IWETH(weth).withdraw(owed);
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(Currency.wrap(currencies[i]));
                IERC20(currencies[i]).safeTransfer(address(poolManager), owed);
                poolManager.settle();
            }
        }

        return abi.encode(currentAmount);
    }

    /// @dev Input/output currency of hop `i` given its direction.
    function _side(PoolKey memory key, bool zeroForOne, bool inputSide) internal pure returns (address) {
        bool pickZero = inputSide ? zeroForOne : !zeroForOne;
        return Currency.unwrap(pickZero ? key.currency0 : key.currency1);
    }

    /// @dev Append `delta` to `currency`'s running total; registers the currency on first touch.
    function _accumulate(
        address[] memory currencies,
        int256[] memory deltas,
        uint256 touched,
        address currency,
        int256 delta
    ) internal pure returns (uint256) {
        if (delta == 0) return touched;
        for (uint256 i = 0; i < touched; i++) {
            if (currencies[i] == currency) {
                deltas[i] += delta;
                return touched;
            }
        }
        currencies[touched] = currency;
        deltas[touched] = delta;
        return touched + 1;
    }

    // ─── Route Validation ──────────────────────────────────────────

    /**
     * @dev Validate that the swap route is well-formed:
     *      1. First hop sells inputToken (or WETH for native-ETH single-hop).
     *      2. Last hop outputs feeJuice.
     *      3. Native ETH single-hop requires inputToken == weth.
     *      4. Every hop uses a hookless pool (hooks == address(0)).
     *      5. Each hop's output feeds the next hop's input (WETH<->ETH allowed).
     */
    function _validateRoute(address inputToken, PoolKey[] calldata path, bool[] calldata zeroForOnes) internal view {
        // First hop must sell inputToken
        PoolKey calldata first = path[0];
        address firstInput = zeroForOnes[0] ? Currency.unwrap(first.currency0) : Currency.unwrap(first.currency1);

        // For native ETH pools, the input side is address(0) which maps to WETH
        if (firstInput == address(0)) {
            require(inputToken == weth, "UniswapFuelSwap: native route requires WETH input");
        } else {
            require(firstInput == inputToken, "UniswapFuelSwap: first hop input mismatch");
        }

        // Last hop must output feeJuice
        PoolKey calldata last = path[path.length - 1];
        address lastOutput =
            zeroForOnes[path.length - 1] ? Currency.unwrap(last.currency1) : Currency.unwrap(last.currency0);
        require(lastOutput == feeJuice, "UniswapFuelSwap: last hop must output feeJuice");

        // Every hop must use a hookless pool — we only route through our own
        // seeded pools; a non-zero hooks address is an untrusted pool that the
        // minFuelOutput slippage bound does not protect against. And each hop's
        // output must feed the next hop's input; the WETH<->native-ETH unwrap
        // is the one allowed discontinuity (settlement handles it).
        for (uint256 i = 0; i < path.length; i++) {
            require(address(path[i].hooks) == address(0), "UniswapFuelSwap: hooks not allowed");
            if (i + 1 < path.length) {
                address outI = zeroForOnes[i] ? Currency.unwrap(path[i].currency1) : Currency.unwrap(path[i].currency0);
                address inNext = zeroForOnes[i + 1]
                    ? Currency.unwrap(path[i + 1].currency0)
                    : Currency.unwrap(path[i + 1].currency1);
                // The ONLY sanctioned discontinuity is WETH→native on the FINAL boundary:
                // settlement bridges exactly that direction (take WETH, unwrap, settle ETH), and
                // only the last hop's output leaves the contract. The reverse — a hop emitting
                // native that a WETH-selling hop then "spends" — would pass naive continuity
                // while nothing ever wraps the owed WETH.
                bool nativeUnwrap = outI == weth && inNext == address(0);
                bool continuous = outI == inNext || (nativeUnwrap && i + 1 == path.length - 1);
                require(continuous, "UniswapFuelSwap: hop discontinuity");
            }
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    // ─── Emergency Sweep ─────────────────────────────────────────────

    /**
     * @notice Sweep stuck tokens or ETH to a recipient. Owner-only safety valve.
     * @param token Address of token to sweep (address(0) for ETH).
     * @param to    Recipient address.
     */
    function sweep(address token, address to) external onlyOwner {
        require(to != address(0), "UniswapFuelSwap: zero recipient");

        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) {
                (bool ok,) = payable(to).call{value: bal}("");
                require(ok, "UniswapFuelSwap: ETH transfer failed");
            }
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(to, bal);
        }
    }
}
