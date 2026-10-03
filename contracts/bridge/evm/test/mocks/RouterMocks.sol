// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IUniswapFuelSwap} from "../../src/SwapBridgeRouter.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {ITokenPortal} from "../../src/interfaces/ITokenPortal.sol";
import {IFeeJuicePortal} from "../../src/interfaces/IFeeJuicePortal.sol";
import {IPortalFactory} from "../../src/interfaces/IPortalFactory.sol";
import {SwapBridgeRouter} from "../../src/SwapBridgeRouter.sol";
import {TokenPortalImpl} from "../../src/TokenPortalImpl.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

/// The router's counterparties as dumb, observable fakes — one definition shared by the unit,
/// fuzz, invariant, formal and blackhat suites. None of them hash: halmos 0.3.3 cannot model the
/// sha256 precompile at all (its stub declares the Z3 function with bytes for bits), so the
/// symbolic suites drive the router against these and leave the real clones to forge.

/// Success-always Permit2 that records what it was handed and can be told to reject.
contract MockPermit2 is ISignatureTransfer {
    bytes32 public lastWitness;
    uint256 public lastAmount;
    address public lastOwner;
    uint256 public calls;
    bool public revertNext;

    function setRevert(bool v) external {
        revertNext = v;
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata details,
        address owner,
        bytes32 witness,
        string calldata,
        bytes calldata
    ) external override {
        require(!revertNext, "MockPermit2: bad signature");
        lastWitness = witness;
        lastAmount = details.requestedAmount;
        lastOwner = owner;
        calls++;
        IERC20(permit.permitted.token).transferFrom(owner, details.to, details.requestedAmount);
    }

    function permitTransferFrom(PermitTransferFrom calldata, SignatureTransferDetails calldata, address, bytes calldata)
        external
        pure
        override
    {
        revert("unused");
    }
}

/// Swap target with a configurable (reported, transferred) pair and an optional re-entrant call.
contract MockSwap is IUniswapFuelSwap {
    IERC20 public immutable fj;
    uint256 public outAmount;
    uint256 public transferAmount; // 0 => == outAmount
    address public reenterTarget;
    bytes public reenterCalldata;

    constructor(IERC20 _fj) {
        fj = _fj;
    }

    function setOutput(uint256 out_, uint256 transfer_) external {
        outAmount = out_;
        transferAmount = transfer_;
    }

    function armReenter(address target, bytes calldata call) external {
        reenterTarget = target;
        reenterCalldata = call;
    }

    function swap(address inputToken, uint256 inputAmount, uint256, PoolKey[] calldata, bool[] calldata)
        external
        override
        returns (uint256)
    {
        if (reenterTarget != address(0)) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterCalldata);
            if (!ok) assembly { revert(add(ret, 32), mload(ret)) } // bubble the real reason
        }
        IERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount);
        fj.transfer(msg.sender, transferAmount == 0 ? outAmount : transferAmount);
        return outAmount;
    }
}

/// Satisfies the floor from its own FJ reserve WITHOUT pulling the input token — the
/// residue-theft vector the router's fuel-consumption require must close.
contract MaliciousPrefundSwap is IUniswapFuelSwap {
    IERC20 public immutable fj;

    constructor(IERC20 _fj) {
        fj = _fj;
    }

    function swap(address, uint256, uint256 minOutput, PoolKey[] calldata, bool[] calldata)
        external
        override
        returns (uint256)
    {
        fj.transfer(msg.sender, minOutput);
        return minOutput;
    }
}

/// A swap target whose (consumed, returned, transferred) behavior is set per call, so a fuzzer
/// can sweep the full lattice around the router's three fuel guards.
contract ConfigurableSwap is IUniswapFuelSwap {
    IERC20 public immutable fj;
    uint256 public consumed;
    uint256 public returned;
    uint256 public transferred;

    constructor(IERC20 _fj) {
        fj = _fj;
    }

    function set(uint256 c, uint256 r, uint256 t) external {
        consumed = c;
        returned = r;
        transferred = t;
    }

    function swap(address inputToken, uint256, uint256, PoolKey[] calldata, bool[] calldata)
        external
        override
        returns (uint256)
    {
        if (consumed > 0) IERC20(inputToken).transferFrom(msg.sender, address(this), consumed);
        if (transferred > 0) fj.transfer(msg.sender, transferred);
        return returned;
    }
}

contract MockFeeJuicePortal is IFeeJuicePortal {
    IERC20 public immutable fj;
    uint256 public lastAmount;
    bytes32 public lastTo;
    uint256 public calls;

    constructor(IERC20 _fj) {
        fj = _fj;
    }

    function UNDERLYING() external view override returns (IERC20) {
        return fj;
    }

    function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32) external override returns (bytes32, uint256) {
        fj.transferFrom(msg.sender, address(this), _amount);
        lastAmount = _amount;
        lastTo = _to;
        return (bytes32(uint256(0xFEE)), calls++);
    }
}

/// A non-hashing stand-in for a portal clone: pulls exactly the deposit and records it.
contract MockTokenPortal is ITokenPortal {
    IERC20 public immutable token;
    uint256 public lastAmount;
    bytes32 public lastTo;
    bool public lastPrivate;
    uint256 public callCount;

    constructor(IERC20 _token) {
        token = _token;
    }

    function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32) external override returns (bytes32, uint256) {
        token.transferFrom(msg.sender, address(this), _amount);
        lastAmount = _amount;
        lastTo = _to;
        lastPrivate = false;
        return (bytes32(uint256(0xABCD)), callCount++);
    }

    function depositToAztecPrivate(uint256 _amount, bytes32) external override returns (bytes32, uint256) {
        token.transferFrom(msg.sender, address(this), _amount);
        lastAmount = _amount;
        lastTo = bytes32(0);
        lastPrivate = true;
        return (bytes32(uint256(0x9012)), callCount++);
    }
}

/// The router with its portal rule deleted — a mutant the proofs' canaries run against, so a
/// proof that no longer depends on the guard is caught in forge.
contract RouterWithoutPortalRule is SwapBridgeRouter {
    constructor(address p2, address fjp, address swap, address factory) SwapBridgeRouter(p2, fjp, swap, factory) {}

    function _requireFactoryPortal(address, address) internal override {}
}

/// The clone implementation with its pause checks deleted (same purpose).
contract PortalImplWithoutPause is TokenPortalImpl {
    constructor(IRegistry registry, bytes32 l2Hub) TokenPortalImpl(registry, l2Hub) {}

    function _requireDeposit(uint256 amount) internal pure override {
        if (amount > type(uint128).max) revert AmountExceedsL2Max();
    }

    function _requireWithdraw() internal view override {}
}

/// An honest factory model for the symbolic suites: binds each token to one `MockTokenPortal`.
/// Only the members the router calls have behavior; the rest exist to satisfy the interface.
contract FakePortalFactory is IPortalFactory {
    mapping(address => address) public portalOf;
    mapping(address => address) public tokenOf;
    uint256 public creates;
    bool public depositsPaused;
    bool public withdrawsPaused;

    /// Binds `token` up front so `predictPortal` (a view) can answer before the first create.
    function bind(address token) external returns (address portal) {
        portal = address(new MockTokenPortal(IERC20(token)));
        portalOf[token] = portal;
        tokenOf[portal] = token;
    }

    /// Never zero, like the real CREATE2 prediction — a zero here would let a zero `tokenPortal`
    /// pass the router's equality check for an unbound token.
    function predictPortal(address token) external view returns (address) {
        address p = portalOf[token];
        return p != address(0) ? p : address(uint160(uint256(keccak256(abi.encode(token)))));
    }

    function createPortal(address token) external returns (address portal) {
        portal = portalOf[token];
        require(portal != address(0), "FakePortalFactory: bind first");
        creates++;
    }

    function setPaused(bool deposits, bool withdraws) external {
        depositsPaused = deposits;
        withdrawsPaused = withdraws;
    }

    function IMPLEMENTATION() external pure returns (address) {
        return address(0);
    }

    function L2_HUB() external pure returns (bytes32) {
        return bytes32(0);
    }

    function REGISTER_SECRET_HASH() external pure returns (bytes32) {
        return bytes32(0);
    }

    function salt(address token) external pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }

    function registrationOf(address) external pure returns (Registration memory r) {
        return r;
    }
}
