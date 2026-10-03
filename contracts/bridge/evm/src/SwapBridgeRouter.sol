// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@oz/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@oz/utils/ReentrancyGuard.sol";
import {IFeeJuicePortal} from "./interfaces/IFeeJuicePortal.sol";
import {ITokenPortal} from "./interfaces/ITokenPortal.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";
import {IPortalFactory} from "./interfaces/IPortalFactory.sol";

// ─── Minimal UniswapFuelSwap Interface ───────────────────────────────

interface IUniswapFuelSwap {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function swap(
        address inputToken,
        uint256 inputAmount,
        uint256 minOutput,
        PoolKey[] calldata path,
        bool[] calldata zeroForOnes
    ) external returns (uint256 output);
}

/**
 * @title SwapBridgeRouter
 * @notice Permit2-enabled periphery that atomically:
 *   1. Resolves the token's portal from the factory (creating it on first use)
 *   2. Pulls tokens from the user via Permit2 SignatureTransfer (witness-bound)
 *   3. Swaps a portion for FeeJuice via UniswapFuelSwap (or passes FeeJuice through as-is)
 *   4. Deposits FeeJuice to L2 via the canonical FeeJuicePortal
 *   5. Deposits the remaining tokens to L2 via the token's portal clone (public OR private)
 *
 * All in one L1 transaction (one signature + one tx).
 *
 * The legal `tokenPortal` is DERIVED from `bridgeToken`, never trusted from calldata: a signed
 * intent can only ever route a token into the portal the factory binds to it. The one exception
 * is the canonical FeeJuicePortal, accepted for a public `bridge()` of the fee asset (direct gas).
 *
 * @dev Stripped of the reference bridge's identity-attestation layer. The
 *      `isPrivate` flag is retained and witness-bound: when true the token side
 *      is deposited via `depositToAztecPrivate` (no recipient in the content
 *      hash → the L2 claim chooses the recipient). The swap target is called
 *      through a typed interface with route data as structured args, and is
 *      owner-updatable for pool migrations.
 */
contract SwapBridgeRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 internal constant BRIDGE_WITNESS_TYPEHASH = keccak256(
        "BridgeWitness(address tokenPortal,address bridgeToken,uint256 totalAmount,uint256 fuelAmount,bytes32 aztecRecipient,bytes32 fuelRecipient,bytes32 tokenSecretHash,bytes32 fuelSecretHash,uint256 minFuelOutput,bytes32 routeHash,bool isPrivate,address swapTarget)"
    );
    string public constant BRIDGE_WITNESS_TYPE_STRING =
        "BridgeWitness witness)BridgeWitness(address tokenPortal,address bridgeToken,uint256 totalAmount,uint256 fuelAmount,bytes32 aztecRecipient,bytes32 fuelRecipient,bytes32 tokenSecretHash,bytes32 fuelSecretHash,uint256 minFuelOutput,bytes32 routeHash,bool isPrivate,address swapTarget)TokenPermissions(address token,uint256 amount)";

    // ─── State ───────────────────────────────────────────────────────
    ISignatureTransfer public immutable permit2;
    IFeeJuicePortal public immutable feeJuicePortal;
    IPortalFactory public immutable FACTORY;
    /// @dev The FeeJuice ERC-20 — the only token whose fuel leg may skip the swap.
    address public immutable FEE_ASSET;
    IUniswapFuelSwap public swapTarget;

    // ─── Errors ──────────────────────────────────────────────────────
    /// @dev `tokenPortal` is not the portal the factory binds to `bridgeToken`.
    error ForeignPortal();
    /// @dev A fuel-only intent (`fuelAmount == totalAmount`) carried token-leg fields.
    error FuelOnlyLeg();
    /// @dev An empty route is only the identity swap of the fee asset.
    error RouteRequired();
    error AmountExceedsL2Max();
    /// @dev The Permit2 pull delivered less than the signed amount (fee-on-transfer token).
    error InexactPull();

    // ─── Events ──────────────────────────────────────────────────────
    event BridgeWithFuel(
        bytes32 indexed aztecRecipient,
        bytes32 tokenKey,
        uint256 tokenIndex,
        uint256 tokenAmount,
        bytes32 tokenSecretHash,
        bytes32 fuelKey,
        uint256 fuelIndex,
        uint256 fuelAmount,
        bytes32 fuelSecretHash,
        bool isPrivate
    );

    event Bridge(bytes32 indexed aztecRecipient, bytes32 key, uint256 index, uint256 amount, bytes32 secretHash, bool isPrivate);

    event SwapTargetUpdated(address indexed oldTarget, address indexed newTarget);

    // ─── Structs ─────────────────────────────────────────────────────

    struct BridgeParams {
        address tokenPortal;
        address bridgeToken;
        uint256 totalAmount;
        uint256 fuelAmount;
        bytes32 aztecRecipient;
        bytes32 fuelRecipient; // L2 address that receives FeeJuice (user for public fuel, FPC for private fuel)
        bytes32 tokenSecretHash;
        bytes32 fuelSecretHash;
        uint256 minFuelOutput;
        IUniswapFuelSwap.PoolKey[] path;
        bool[] zeroForOnes;
        bool isPrivate;
    }

    struct SimpleBridgeParams {
        address tokenPortal;
        address bridgeToken;
        uint256 amount;
        bytes32 aztecRecipient;
        bytes32 secretHash;
        bool isPrivate;
    }

    struct PermitParams {
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    struct BridgeWitness {
        address tokenPortal;
        address bridgeToken;
        uint256 totalAmount;
        uint256 fuelAmount;
        bytes32 aztecRecipient;
        bytes32 fuelRecipient;
        bytes32 tokenSecretHash;
        bytes32 fuelSecretHash;
        uint256 minFuelOutput;
        bytes32 routeHash;
        bool isPrivate;
        address swapTarget;
    }

    // ─── Constructor ─────────────────────────────────────────────────

    constructor(address _permit2, address _feeJuicePortal, address _swapTarget, address _factory)
        Ownable(msg.sender)
    {
        require(_permit2 != address(0), "SwapBridgeRouter: zero permit2");
        require(_feeJuicePortal != address(0), "SwapBridgeRouter: zero feeJuicePortal");
        require(_swapTarget != address(0), "SwapBridgeRouter: zero swapTarget");
        require(_factory != address(0), "SwapBridgeRouter: zero factory");

        permit2 = ISignatureTransfer(_permit2);
        feeJuicePortal = IFeeJuicePortal(_feeJuicePortal);
        swapTarget = IUniswapFuelSwap(_swapTarget);
        FACTORY = IPortalFactory(_factory);
        FEE_ASSET = address(IFeeJuicePortal(_feeJuicePortal).UNDERLYING());
    }

    // ─── Governance ──────────────────────────────────────────────────

    /// @notice Update the swap target (e.g. after a pool migration). `nonReentrant`: the witness
    /// binds the target the user signed for, so a rotation must never land between the Permit2
    /// pull (a hostile token's hook) and the swap.
    function setSwapTarget(address _newSwapTarget) external onlyOwner nonReentrant {
        require(_newSwapTarget != address(0), "SwapBridgeRouter: zero swapTarget");
        address old = address(swapTarget);
        swapTarget = IUniswapFuelSwap(_newSwapTarget);
        emit SwapTargetUpdated(old, _newSwapTarget);
    }

    // ─── Core Logic ──────────────────────────────────────────────────

    /// @notice Bridge tokens to Aztec L2, swapping a portion for Fee Juice gas, in one tx.
    /// `fuelAmount == totalAmount` is a fuel-only intent (no token leg); an empty `path` is the
    /// identity swap, legal only when `bridgeToken` is the fee asset itself.
    function bridgeWithFuel(BridgeParams calldata p, PermitParams calldata permit) external nonReentrant {
        require(p.totalAmount > 0, "SwapBridgeRouter: zero amount");
        if (p.totalAmount > type(uint128).max) revert AmountExceedsL2Max();
        require(p.fuelAmount > 0 && p.fuelAmount <= p.totalAmount, "SwapBridgeRouter: invalid fuelAmount");
        require(p.path.length == p.zeroForOnes.length, "SwapBridgeRouter: path/direction mismatch");
        bool identity = p.path.length == 0;
        if (identity && p.bridgeToken != FEE_ASSET) revert RouteRequired();

        bool fuelOnly = p.fuelAmount == p.totalAmount;
        if (fuelOnly) {
            if (p.tokenPortal != address(0) || p.aztecRecipient != bytes32(0) || p.tokenSecretHash != bytes32(0)) {
                revert FuelOnlyLeg();
            }
        } else {
            _requireFactoryPortal(p.tokenPortal, p.bridgeToken);
        }

        _pullTokensWithWitness(
            msg.sender,
            p.bridgeToken,
            p.totalAmount,
            permit,
            _hashBridgeWitness(
                BridgeWitness({
                    tokenPortal: p.tokenPortal,
                    bridgeToken: p.bridgeToken,
                    totalAmount: p.totalAmount,
                    fuelAmount: p.fuelAmount,
                    aztecRecipient: p.aztecRecipient,
                    fuelRecipient: p.fuelRecipient,
                    tokenSecretHash: p.tokenSecretHash,
                    fuelSecretHash: p.fuelSecretHash,
                    minFuelOutput: p.minFuelOutput,
                    routeHash: _hashRoute(p.path, p.zeroForOnes),
                    isPrivate: p.isPrivate,
                    swapTarget: address(swapTarget)
                })
            )
        );

        uint256 fuelReceived = identity ? p.fuelAmount : _swapFuel(IERC20(p.bridgeToken), p);
        // The user's SIGNED slippage floor is enforced by the router itself - the swap target is
        // owner-replaceable, so its own minOutput check cannot be the binding one.
        require(fuelReceived >= p.minFuelOutput, "SwapBridgeRouter: insufficient fuel");

        (bytes32 fuelKey, uint256 fuelIndex) = _depositFuel(p.fuelRecipient, fuelReceived, p.fuelSecretHash);

        uint256 bridgeAmount = p.totalAmount - p.fuelAmount;
        (bytes32 tokenKey, uint256 tokenIndex) = fuelOnly
            ? (bytes32(0), uint256(0))
            : _depositTokens(
                p.tokenPortal, IERC20(p.bridgeToken), bridgeAmount, p.aztecRecipient, p.tokenSecretHash, p.isPrivate
            );

        emit BridgeWithFuel(
            p.aztecRecipient,
            tokenKey,
            tokenIndex,
            bridgeAmount,
            p.tokenSecretHash,
            fuelKey,
            fuelIndex,
            fuelReceived,
            p.fuelSecretHash,
            p.isPrivate
        );
    }

    /// @notice Bridge tokens to Aztec L2 without a fuel swap (public or private).
    function bridge(SimpleBridgeParams calldata p, PermitParams calldata permit) external nonReentrant {
        require(p.amount > 0, "SwapBridgeRouter: zero amount");
        if (p.amount > type(uint128).max) revert AmountExceedsL2Max();
        // Direct gas: the fee asset may go straight into the canonical FeeJuicePortal, which only
        // has a public deposit.
        bool directGas = p.bridgeToken == FEE_ASSET && p.tokenPortal == address(feeJuicePortal) && !p.isPrivate;
        if (!directGas) _requireFactoryPortal(p.tokenPortal, p.bridgeToken);

        _pullTokensWithWitness(
            msg.sender,
            p.bridgeToken,
            p.amount,
            permit,
            _hashBridgeWitness(
                BridgeWitness({
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
                    swapTarget: address(swapTarget)
                })
            )
        );

        (bytes32 key, uint256 index) =
            _depositTokens(p.tokenPortal, IERC20(p.bridgeToken), p.amount, p.aztecRecipient, p.secretHash, p.isPrivate);

        emit Bridge(p.aztecRecipient, key, index, p.amount, p.secretHash, p.isPrivate);
    }

    // ─── Emergency Sweep ─────────────────────────────────────────────

    /// @notice Sweep stuck tokens or ETH. Owner-only safety valve. The router
    /// holds zero balance between calls (forceApprove-to-zero discipline).
    function sweep(address token, address to) external onlyOwner nonReentrant {
        require(to != address(0), "SwapBridgeRouter: zero recipient");

        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) {
                (bool ok,) = payable(to).call{value: bal}("");
                require(ok, "SwapBridgeRouter: ETH transfer failed");
            }
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(to, bal);
        }
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev The only legal token portal is the one the factory binds to `bridgeToken`, created here
    /// on first use. Runs before the Permit2 pull, so a rejected intent moves nothing.
    function _requireFactoryPortal(address tokenPortal, address bridgeToken) internal virtual {
        if (tokenPortal != FACTORY.predictPortal(bridgeToken)) revert ForeignPortal();
        FACTORY.createPortal(bridgeToken);
    }

    function _swapFuel(IERC20 token, BridgeParams calldata p) internal returns (uint256 fuelReceived) {
        IERC20 feeJuiceToken = IERC20(FEE_ASSET);
        uint256 fjBalBefore = feeJuiceToken.balanceOf(address(this));
        uint256 tokenBalBefore = token.balanceOf(address(this));

        token.forceApprove(address(swapTarget), p.fuelAmount);
        fuelReceived = swapTarget.swap(p.bridgeToken, p.fuelAmount, p.minFuelOutput, p.path, p.zeroForOnes);
        token.forceApprove(address(swapTarget), 0);

        // Defense-in-depth against swap bugs: verify the actual balance change.
        require(
            feeJuiceToken.balanceOf(address(this)) - fjBalBefore >= fuelReceived, "SwapBridgeRouter: balance mismatch"
        );
        // The slice must actually have been CONSUMED by the swap. Without this, a hostile target
        // can satisfy the floor from prefunded FeeJuice without pulling the input token, stranding
        // the user's slice in the router as owner-sweepable residue (theft, not slippage). The
        // approval caps the pull at fuelAmount, so strict equality is sound.
        require(tokenBalBefore - token.balanceOf(address(this)) == p.fuelAmount, "SwapBridgeRouter: fuel not consumed");
    }

    function _depositFuel(bytes32 recipient, uint256 amount, bytes32 secretHash) internal returns (bytes32, uint256) {
        IERC20 feeJuiceToken = IERC20(FEE_ASSET);
        feeJuiceToken.forceApprove(address(feeJuicePortal), amount);
        (bytes32 key, uint256 index) = feeJuicePortal.depositToAztecPublic(recipient, amount, secretHash);
        feeJuiceToken.forceApprove(address(feeJuicePortal), 0);
        return (key, index);
    }

    function _depositTokens(
        address portal,
        IERC20 token,
        uint256 amount,
        bytes32 recipient,
        bytes32 secretHash,
        bool isPrivate
    ) internal returns (bytes32 key, uint256 index) {
        token.forceApprove(portal, amount);
        if (isPrivate) {
            (key, index) = ITokenPortal(portal).depositToAztecPrivate(amount, secretHash);
        } else {
            (key, index) = ITokenPortal(portal).depositToAztecPublic(recipient, amount, secretHash);
        }
        token.forceApprove(portal, 0);
    }

    function _pullTokensWithWitness(
        address owner,
        address token,
        uint256 amount,
        PermitParams calldata permit,
        bytes32 witness
    ) internal {
        uint256 before = IERC20(token).balanceOf(address(this));
        permit2.permitWitnessTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: token, amount: amount}),
                nonce: permit.nonce,
                deadline: permit.deadline
            }),
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
            owner,
            witness,
            BRIDGE_WITNESS_TYPE_STRING,
            permit.signature
        );
        // A short pull would be topped up from router residue downstream — a donor's loss, and a
        // message minting more than the reserve holds. Refused here, before any leg runs.
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert InexactPull();
    }

    function _hashBridgeWitness(BridgeWitness memory witness) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                BRIDGE_WITNESS_TYPEHASH,
                witness.tokenPortal,
                witness.bridgeToken,
                witness.totalAmount,
                witness.fuelAmount,
                witness.aztecRecipient,
                witness.fuelRecipient,
                witness.tokenSecretHash,
                witness.fuelSecretHash,
                witness.minFuelOutput,
                witness.routeHash,
                witness.isPrivate,
                witness.swapTarget
            )
        );
    }

    function _hashRoute(IUniswapFuelSwap.PoolKey[] calldata path, bool[] calldata zeroForOnes)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(path, zeroForOnes));
    }
}
