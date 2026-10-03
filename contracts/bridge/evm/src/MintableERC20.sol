// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {ERC20} from "@oz/token/ERC20/ERC20.sol";

/**
 * @title MintableERC20
 * @notice Testnet faucet token: permissionless, per-tx-capped mint + canonical
 *         Permit2 pre-approval (so bridging needs no separate approve tx).
 *
 * @dev No allowlist, no owner — infinite-mint BY DESIGN for a testnet faucet,
 *      bounded per call (`maxMintPerTx`) to deter cheap manipulation of our thin
 *      seeded V4 pools. The Permit2 pre-approval is an `allowance()` override
 *      (NOT a constructor approve, which would only cover the deployer): every
 *      holder is treated as having granted Permit2 infinite allowance.
 */
contract MintableERC20 is ERC20 {
    /// @notice Canonical Permit2 — same address on every chain.
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint8 private immutable _decimals;

    /// @notice Maximum amount mintable in a single `mint` call (base units).
    uint256 public immutable maxMintPerTx;

    error MintCapExceeded(uint256 requested, uint256 cap);

    /// @param maxWholePerTx Per-tx cap in WHOLE tokens; scaled by `decimals_`.
    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 maxWholePerTx)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
        maxMintPerTx = maxWholePerTx * (10 ** decimals_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Permissionless mint, capped per call.
    function mint(address to, uint256 amount) external {
        if (amount > maxMintPerTx) revert MintCapExceeded(amount, maxMintPerTx);
        _mint(to, amount);
    }

    /// @notice Pre-approves canonical Permit2 for every holder.
    function allowance(address owner, address spender) public view override returns (uint256) {
        if (spender == PERMIT2) return type(uint256).max;
        return super.allowance(owner, spender);
    }
}
