// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {Ownable2Step, Ownable} from "@oz/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";
import {IFeeJuicePortal} from "./interfaces/IFeeJuicePortal.sol";
import {ITokenPortal} from "./interfaces/ITokenPortal.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";
import {IPortalFactory} from "./interfaces/IPortalFactory.sol";

/**
 * @title DepositRouter
 * @notice Deposits a token into Aztec through its factory portal clone and, optionally, swaps a slice of it into
 * Fee Juice for the same recipient's gas. Two entrypoints settle through one path: `bridgeWithPermit` for an
 * Ethereum EOA's Permit2 witness signature, and `bridgeFromCaller` for any caller that already holds the funds
 * (LI.FI's Executor after a bridge delivers them).
 *
 * Invariants:
 * - Funds come only from `msg.sender` (the Permit2 owner is `msg.sender`) and leave only to the token's derived
 *   clone, the FeeJuicePortal, or `SWAP_TARGET` (at most `fuelSlice`). No approval survives a call.
 * - Accounting is by deltas: a balance the router held before a call (a donation) is never deposited, never
 *   reverts a deposit, and stays sweepable.
 * - The swap call is fixed at construction: an immutable `SWAP_TARGET`, two pinned `GenericSwapFacetV3` selectors,
 *   `_receiver` equal to this router, and a non-zero floor on the router's own Fee Juice delta. LI.FI's
 *   `_minAmountOut` is not relied on: the facet checks it against its whole balance, not a delta.
 * - `FACTORY.depositsPaused()` stops every leg, fuel-only included.
 */
contract DepositRouter is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct DepositIntent {
        address token;
        /// @dev Public token leg only; zero when private or fuel-only.
        bytes32 aztecRecipient;
        /// @dev Zero means fuel-only: no token leg.
        bytes32 tokenSecretHash;
        bool isPrivate;
        /// @dev Token units into the swap (or straight to the FeeJuicePortal when `token` is the fee asset).
        uint256 fuelSlice;
        bytes32 fuelRecipient;
        bytes32 fuelSecretHash;
        /// @dev Floor on the router's own Fee Juice delta; must be non-zero whenever a swap runs.
        uint256 minFuelOutput;
    }

    struct PermitParams {
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    /// @dev Permit2 itself binds the token, the amount, this router as spender, the nonce and the deadline.
    string public constant DEPOSIT_WITNESS_TYPE_STRING =
        "DepositWitness witness)DepositWitness(bytes32 aztecRecipient,bytes32 tokenSecretHash,bool isPrivate,uint256 fuelSlice,bytes32 fuelRecipient,bytes32 fuelSecretHash,uint256 minFuelOutput,bytes32 swapDataHash)TokenPermissions(address token,uint256 amount)";
    bytes32 public constant DEPOSIT_WITNESS_TYPEHASH = keccak256(
        "DepositWitness(bytes32 aztecRecipient,bytes32 tokenSecretHash,bool isPrivate,uint256 fuelSlice,bytes32 fuelRecipient,bytes32 fuelSecretHash,uint256 minFuelOutput,bytes32 swapDataHash)"
    );

    /// @dev `swapTokensSingleV3ERC20ToERC20` and `swapTokensMultipleV3ERC20ToERC20`.
    bytes4 internal constant SWAP_SINGLE = 0x4666fc80;
    bytes4 internal constant SWAP_MULTIPLE = 0x5fd9ae2e;
    /// @dev Selector, `bytes32 _transactionId` and two string offsets precede `_receiver` in both heads.
    uint256 internal constant RECEIVER_OFFSET = 100;
    /// @dev Through `_minAmountOut`, the last fixed head word before the swap data's offset.
    uint256 internal constant MIN_SWAP_DATA = 164;

    ISignatureTransfer public immutable PERMIT2;
    IFeeJuicePortal public immutable FEE_JUICE_PORTAL;
    IPortalFactory public immutable FACTORY;
    address public immutable FEE_ASSET;
    /// @dev The LI.FI Diamond on mainnet, `TestnetFuelSwapper` elsewhere; also the slice's only spender.
    address public immutable SWAP_TARGET;

    error ZeroAddress();
    error NotAContract();
    error DepositsPaused();
    error FuelOnlyShape();
    error PrivateWithRecipient();
    error FuelFieldsWithoutSlice();
    error IdentityWithSwapData();
    error SwapDataTooShort();
    error UnpinnedSelector();
    error ForeignReceiver();
    error ZeroFuelFloor();
    error SliceOutOfBounds();
    error BadBounds();
    error BelowMinimum();
    error InexactPull();
    error LeftoverExceedsPull();
    error InexactFuelConsumption();
    error InsufficientFuel();

    event Deposited(
        bytes32 indexed tokenSecretHash,
        bytes32 indexed fuelSecretHash,
        address indexed token,
        address payer,
        uint256 received,
        uint256 tokenAmount,
        bytes32 tokenKey,
        uint256 tokenIndex,
        uint256 fuelIn,
        uint256 fuelOut,
        bytes32 fuelKey,
        uint256 fuelIndex,
        bool isPrivate
    );

    constructor(address permit2, address feeJuicePortal, address factory, address swapTarget, address owner)
        Ownable(owner)
    {
        if (permit2 == address(0) || feeJuicePortal == address(0) || factory == address(0)) revert ZeroAddress();
        if (swapTarget.code.length == 0) revert NotAContract();
        PERMIT2 = ISignatureTransfer(permit2);
        FEE_JUICE_PORTAL = IFeeJuicePortal(feeJuicePortal);
        FACTORY = IPortalFactory(factory);
        FEE_ASSET = address(IFeeJuicePortal(feeJuicePortal).UNDERLYING());
        if (FEE_ASSET == address(0)) revert ZeroAddress();
        SWAP_TARGET = swapTarget;
    }

    /**
     * @notice Pulls exactly `amount` of `intent.token` from the signer (`msg.sender`) through a Permit2 witness
     * transfer and settles it. Fuel consumption is exact: a swap that leaves part of the slice unspent reverts.
     * @dev Fuel-only requires `fuelSlice == amount`; otherwise `fuelSlice < amount`. "Unspent" is measured by
     * `_swapFuel`'s stray split, which attributes returned input to the target's prior balance first: a venue that
     * returned only its own leftover while holding a prior balance would see that leftover kept as residue, not
     * reverted. LI.FI's facet returns its whole balance and the testnet swapper returns nothing, so neither can.
     */
    function bridgeWithPermit(
        DepositIntent calldata intent,
        bytes calldata swapData,
        uint256 amount,
        PermitParams calldata permit
    ) external nonReentrant returns (uint256 tokenAmount, uint256 fuelOut) {
        bool fuelOnly = _checkShape(intent, swapData);
        if (fuelOnly ? intent.fuelSlice != amount : intent.fuelSlice >= amount) revert SliceOutOfBounds();

        IERC20 token = IERC20(intent.token);
        uint256 before = token.balanceOf(address(this));
        PERMIT2.permitWitnessTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: intent.token, amount: amount}),
                nonce: permit.nonce,
                deadline: permit.deadline
            }),
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
            msg.sender,
            hashWitness(intent, swapData),
            DEPOSIT_WITNESS_TYPE_STRING,
            permit.signature
        );
        if (token.balanceOf(address(this)) - before != amount) revert InexactPull();
        return _settle(intent, swapData, amount, true);
    }

    /**
     * @notice Pulls `min(balance, allowance, maxPull)` of `intent.token` from `msg.sender`, requiring at least
     * `minReceived`, and settles it. With a token leg, slice input the swap leaves unspent joins the token leg;
     * a fuel-only intent requires `minReceived == maxPull == fuelSlice` and exact consumption.
     * @dev Permissionless and unsigned: it only ever spends the caller's own funds.
     */
    function bridgeFromCaller(
        DepositIntent calldata intent,
        bytes calldata swapData,
        uint256 minReceived,
        uint256 maxPull
    ) external nonReentrant returns (uint256 tokenAmount, uint256 fuelOut) {
        bool fuelOnly = _checkShape(intent, swapData);
        if (minReceived == 0 || minReceived > maxPull) revert BadBounds();
        if (fuelOnly ? minReceived != intent.fuelSlice || maxPull != intent.fuelSlice : intent.fuelSlice >= minReceived)
        {
            revert SliceOutOfBounds();
        }

        IERC20 token = IERC20(intent.token);
        uint256 amount =
            Math.min(Math.min(token.balanceOf(msg.sender), token.allowance(msg.sender, address(this))), maxPull);
        if (amount < minReceived) revert BelowMinimum();
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - before != amount) revert InexactPull();
        return _settle(intent, swapData, amount, fuelOnly);
    }

    /// @notice Moves a balance the router held outside any call (a donation or a stray return) to `to`.
    function sweep(address token, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) IERC20(token).safeTransfer(to, balance);
    }

    /// @notice The EIP-712 struct hash of the Permit2 witness for `intent` and `swapData`.
    function hashWitness(DepositIntent calldata intent, bytes calldata swapData) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DEPOSIT_WITNESS_TYPEHASH,
                intent.aztecRecipient,
                intent.tokenSecretHash,
                intent.isPrivate,
                intent.fuelSlice,
                intent.fuelRecipient,
                intent.fuelSecretHash,
                intent.minFuelOutput,
                keccak256(swapData)
            )
        );
    }

    /// @dev Every rule that does not depend on the amount, checked before anything moves.
    function _checkShape(DepositIntent calldata intent, bytes calldata swapData) internal view returns (bool fuelOnly) {
        _requireDepositsOpen();
        fuelOnly = intent.tokenSecretHash == bytes32(0);
        if (fuelOnly && (intent.aztecRecipient != bytes32(0) || intent.fuelSlice == 0)) revert FuelOnlyShape();
        if (intent.isPrivate && intent.aztecRecipient != bytes32(0)) revert PrivateWithRecipient();

        if (intent.fuelSlice == 0) {
            if (
                swapData.length != 0 || intent.fuelRecipient != bytes32(0) || intent.fuelSecretHash != bytes32(0)
                    || intent.minFuelOutput != 0
            ) revert FuelFieldsWithoutSlice();
        } else if (intent.token == FEE_ASSET) {
            if (swapData.length != 0) revert IdentityWithSwapData();
        } else {
            _requirePinnedSwap(swapData, intent.minFuelOutput);
        }
    }

    /// @dev Virtual so the proofs' canaries can delete it; production never overrides it.
    function _requireDepositsOpen() internal view virtual {
        if (FACTORY.depositsPaused()) revert DepositsPaused();
    }

    /// @dev Virtual so the proofs' canaries can delete it; production never overrides it.
    function _requirePinnedSwap(bytes calldata swapData, uint256 minFuelOutput) internal view virtual {
        if (swapData.length < MIN_SWAP_DATA) revert SwapDataTooShort();
        bytes4 selector = bytes4(swapData[:4]);
        if (selector != SWAP_SINGLE && selector != SWAP_MULTIPLE) revert UnpinnedSelector();
        // A full-word compare, so dirty upper bits cannot alias this address.
        if (bytes32(swapData[RECEIVER_OFFSET:RECEIVER_OFFSET + 32]) != bytes32(uint256(uint160(address(this))))) {
            revert ForeignReceiver();
        }
        // Without a floor, a selector-valid call that sends the output elsewhere passes every delta check.
        if (minFuelOutput == 0) revert ZeroFuelFloor();
    }

    /// @dev The token's derived clone, created on first use. Virtual so the proofs' canaries can redirect it.
    function _tokenPortal(address token) internal virtual returns (address) {
        return FACTORY.createPortal(token);
    }

    /// @dev Virtual so the proofs' canaries can skip it; production never overrides it.
    function _revokeApproval(IERC20 token, address spender) internal virtual {
        token.forceApprove(spender, 0);
    }

    function _settle(DepositIntent calldata intent, bytes calldata swapData, uint256 received, bool exactFuel)
        internal
        returns (uint256 tokenAmount, uint256 fuelOut)
    {
        // Created before the swap, approved after it: the swap hands control to third-party venues.
        address portal = intent.tokenSecretHash == bytes32(0) ? address(0) : _tokenPortal(intent.token);

        uint256 fuelIn;
        bytes32 fuelKey;
        uint256 fuelIndex;
        if (intent.fuelSlice > 0) {
            if (intent.token == FEE_ASSET) {
                (fuelIn, fuelOut) = (intent.fuelSlice, intent.fuelSlice);
            } else {
                (fuelIn, fuelOut) = _swapFuel(IERC20(intent.token), intent.fuelSlice, swapData, exactFuel);
            }
            if (fuelOut < intent.minFuelOutput) revert InsufficientFuel();
            (fuelKey, fuelIndex) = _approveAndCall(
                IERC20(FEE_ASSET),
                address(FEE_JUICE_PORTAL),
                fuelOut,
                abi.encodeCall(
                    IFeeJuicePortal.depositToAztecPublic, (intent.fuelRecipient, fuelOut, intent.fuelSecretHash)
                )
            );
        }

        tokenAmount = received - fuelIn;
        bytes32 tokenKey;
        uint256 tokenIndex;
        if (portal != address(0)) {
            (tokenKey, tokenIndex) = _approveAndCall(
                IERC20(intent.token),
                portal,
                tokenAmount,
                intent.isPrivate
                    ? abi.encodeCall(ITokenPortal.depositToAztecPrivate, (tokenAmount, intent.tokenSecretHash))
                    : abi.encodeCall(
                        ITokenPortal.depositToAztecPublic, (intent.aztecRecipient, tokenAmount, intent.tokenSecretHash)
                    )
            );
        }

        emit Deposited(
            intent.tokenSecretHash,
            intent.fuelSecretHash,
            intent.token,
            msg.sender,
            received,
            tokenAmount,
            tokenKey,
            tokenIndex,
            fuelIn,
            fuelOut,
            fuelKey,
            fuelIndex,
            intent.isPrivate
        );
    }

    /**
     * @dev Runs the swap against an exact `slice` approval and measures what it really took. `GenericSwapFacetV3`
     * returns its whole input-token balance to `_receiver`, so a balance the target held beforehand (`stray`) can
     * come back too: it is residue, never part of the deposit. `pull` comes from the allowance the target left,
     * read before it is zeroed.
     * @return consumed The slice input actually spent; the rest of the slice joins the token leg.
     * @return fuelOut The router's own Fee Juice delta.
     */
    function _swapFuel(IERC20 token, uint256 slice, bytes calldata swapData, bool exact)
        internal
        returns (uint256 consumed, uint256 fuelOut)
    {
        IERC20 feeAsset = IERC20(FEE_ASSET);
        uint256 targetBefore = token.balanceOf(SWAP_TARGET);
        uint256 tokenBefore = token.balanceOf(address(this));
        uint256 feeBefore = feeAsset.balanceOf(address(this));

        token.forceApprove(SWAP_TARGET, slice);
        (bool ok, bytes memory ret) = SWAP_TARGET.call(swapData);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        uint256 pull = slice - token.allowance(address(this), SWAP_TARGET);
        _revokeApproval(token, SWAP_TARGET);

        uint256 returned = token.balanceOf(address(this)) + pull - tokenBefore;
        uint256 stray = Math.min(returned, targetBefore);
        uint256 leftover = returned - stray;
        if (leftover > pull) revert LeftoverExceedsPull();
        consumed = pull - leftover;
        if (exact && consumed != slice) revert InexactFuelConsumption();
        fuelOut = feeAsset.balanceOf(address(this)) - feeBefore;
    }

    /// @dev Exact approval for one portal call, zeroed after it.
    function _approveAndCall(IERC20 token, address portal, uint256 amount, bytes memory call)
        internal
        returns (bytes32 key, uint256 index)
    {
        token.forceApprove(portal, amount);
        (bool ok, bytes memory ret) = portal.call(call);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        (key, index) = abi.decode(ret, (bytes32, uint256));
        _revokeApproval(token, portal);
    }
}
