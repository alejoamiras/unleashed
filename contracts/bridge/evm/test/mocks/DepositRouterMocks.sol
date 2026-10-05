// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {ILiFiSwap} from "../../src/interfaces/ILiFiSwap.sol";
import {DepositRouter} from "../../src/DepositRouter.sol";

/// A `GenericSwapFacetV3` stand-in with every behavior the router must survive, set per test. By default it
/// matches the real facet: pull `fromAmount` when `requiresDeposit`, spend it, pay `fjOut` to `_receiver`, then
/// return its whole input-token balance (not a delta) to `_receiver`. No hashing, so halmos can drive it.
contract MockLifiSwap {
    using SafeERC20 for IERC20;

    /// Where spent input goes; outside every balance the router or the tests measure.
    address public constant SINK = address(0x5111C);

    IERC20 public immutable fj;
    /// Input actually spent; `type(uint256).max` spends everything pulled.
    uint256 public spend = type(uint256).max;
    uint256 public fjOut;
    /// Zero pays `_receiver`; anything else diverts the output (a selector-valid call that robs the router).
    address public fjTo;
    /// Zero pulls `fromAmount`; otherwise pulls this much (beyond the approval reverts in the token).
    uint256 public pullOverride;
    /// The real facet returns its whole balance; false returns only `pull − spent`.
    bool public returnWholeBalance = true;
    address public reenterTarget;
    bytes public reenterCall;
    uint256 public calls;

    constructor(IERC20 _fj) {
        fj = _fj;
    }

    function set(uint256 spend_, uint256 fjOut_) external {
        spend = spend_;
        fjOut = fjOut_;
    }

    function setHostile(address fjTo_, uint256 pullOverride_, bool returnWholeBalance_) external {
        fjTo = fjTo_;
        pullOverride = pullOverride_;
        returnWholeBalance = returnWholeBalance_;
    }

    function armReenter(address target, bytes calldata call) external {
        reenterTarget = target;
        reenterCall = call;
    }

    function swapTokensSingleV3ERC20ToERC20(
        bytes32,
        string calldata,
        string calldata,
        address payable _receiver,
        uint256 _minAmountOut,
        ILiFiSwap.SwapData calldata _swapData
    ) external {
        _swap(_receiver, _minAmountOut, _swapData);
    }

    /// Only the first step moves anything: enough to model a step that skips its pull.
    function swapTokensMultipleV3ERC20ToERC20(
        bytes32,
        string calldata,
        string calldata,
        address payable _receiver,
        uint256 _minAmountOut,
        ILiFiSwap.SwapData[] calldata _swapData
    ) external {
        _swap(_receiver, _minAmountOut, _swapData[0]);
    }

    function _swap(address receiver, uint256 minOut, ILiFiSwap.SwapData calldata d) internal {
        calls++;
        if (reenterTarget != address(0)) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterCall);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
        IERC20 input = IERC20(d.sendingAssetId);
        uint256 pulled;
        if (d.requiresDeposit) {
            pulled = pullOverride == 0 ? d.fromAmount : pullOverride;
            input.safeTransferFrom(msg.sender, address(this), pulled);
        }
        uint256 spent = spend == type(uint256).max ? pulled : spend;
        if (spent > 0) input.safeTransfer(SINK, spent);
        uint256 back = returnWholeBalance ? input.balanceOf(address(this)) : pulled - spent;
        if (back > 0) input.safeTransfer(receiver, back);
        require(fjOut >= minOut, "MockLifiSwap: below minimum");
        if (fjOut > 0) fj.safeTransfer(fjTo == address(0) ? receiver : fjTo, fjOut);
    }
}

/// Grants the router an allowance it never revokes, then calls `bridgeFromCaller`: the LI.FI Executor's shape
/// (it max-approves `approveTo` and leaves it).
contract MockExecutor {
    function run(
        DepositRouter router,
        IERC20 token,
        DepositRouter.DepositIntent calldata intent,
        bytes calldata swapData,
        uint256 minReceived,
        uint256 maxPull
    ) external returns (uint256 tokenAmount, uint256 fuelOut) {
        token.approve(address(router), type(uint256).max);
        return router.bridgeFromCaller(intent, swapData, minReceived, maxPull);
    }
}
